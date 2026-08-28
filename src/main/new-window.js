// ============================================================
//  NEW WINDOW — Kairon Browser
//  Additional normal (non-Incognito) browser windows opened via
//  Ctrl+N or the app menu. Each window is a fully independent
//  browser instance with its own tabs, overlay, and layout,
//  sharing the same session (cookies, history, bookmarks) as the
//  main window.
// ============================================================

const { BrowserWindow, BrowserView, ipcMain } = require('electron');
const path = require('path');

const CHROME_FILE = path.join(__dirname, '../renderer/index.html');
const HOME_FILE = path.join(__dirname, '../renderer/home.html');
const SETTINGS_PAGE_FILE = path.join(__dirname, '../renderer/settings.html');
const DOWNLOADS_PAGE_FILE = path.join(__dirname, '../renderer/downloads.html');
const OVERLAY_FILE = path.join(__dirname, '../renderer/overlay.html');
const ERROR_PAGE_FILE = path.join(__dirname, "../renderer/can't_be_reached.html");
const IP_NOT_FOUND_FILE = path.join(__dirname, '../renderer/ip_not_found.html');

const HOME_URL = 'kairon://home';
const SETTINGS_URL = 'kairon://settings';
const DOWNLOADS_URL = 'kairon://downloads';
const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const DNS_RESOLUTION_ERROR_CODES = new Set([-105, -137]);

// Track all additional normal windows. Each entry is a self-contained state
// object holding its BrowserWindow, overlay, tabs, etc.
const extraWindows = new Map();
let nextWindowId = 1;

// Shared services injected by main.js (avoids a circular require).
let services = {
  getCurrentThemeMode: () => 'dark',
  getThemeQuery: () => ({ theme: 'dark' }),
  featureStore: null,
  store: null,
  emitSettingsState: () => {},
  reconfigureAdblocker: () => Promise.resolve(),
  logError: () => {},
  getAppIcon: () => undefined,
  getHistoryService: () => null,
  getBookmarkService: () => null,
  getQuickAccessService: () => null,
  getDownloadManager: () => null,
};

function registerNewWindow(deps) {
  if (deps) services = { ...services, ...deps };
}

// ── WINDOW LIFECYCLE ─────────────────────────────────────────

function openNewWindow() {
  const themeMode = services.getCurrentThemeMode();
  const winId = nextWindowId++;

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: themeMode === 'light' ? '#f0f0f0' : '#080810',
    icon: services.getAppIcon(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  const state = {
    id: winId,
    win,
    overlay: null,
    tabs: new Map(),
    activeTabId: null,
    nextTabId: 1,
    chromeUiFocused: false,
    activeOverlaySuggestions: null,
    activeDownloadsPanel: null,
    activeAppMenu: null,
    activeStarPopup: null,
    activeAboutDialog: false,
    lastOverlayBounds: null,
    lastSuggestionBounds: null,
    lastPanelBounds: null,
    lastAppMenuBounds: null,
    lastStarPopupBounds: null,
    overlayClosePending: false,
    bounds: null,
    closed: false,
  };

  extraWindows.set(winId, state);

  // Load the same Kairon chrome as the main window, with the newWindow flag
  // so the preload routes IPC to nw-* channels (same pattern as incognito).
  win.loadFile(CHROME_FILE, { query: { theme: themeMode, newWindow: '1' } });

  win.once('ready-to-show', () => {
    try {
      win.webContents.setZoomFactor(1.0);
    } catch (e) { }
    try {
      win.show();
      win.maximize();
    } catch (e) { }
  });

  win.webContents.on('dom-ready', () => {
    try { win.webContents.setZoomFactor(1.0); } catch (e) { }
  });
  win.webContents.on('did-finish-load', () => {
    try { win.webContents.setZoomFactor(1.0); } catch (e) { }
  });

  win.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // Keyboard shortcuts in the chrome
  win.webContents.on('before-input-event', (event, input) => {
    handleNewWindowChromeShortcut(state, event, input);
  });

  const onGeometryChange = () => {
    applyNewWindowBounds(state);
    updateNewWindowOverlayBounds(state);
  };
  win.on('resize', onGeometryChange);
  win.on('move', onGeometryChange);

  win.on('focus', () => {
    if (state.chromeUiFocused) return;
    focusNewWindowActiveTab(state);
  });

  // Fullscreen support
  win.on('enter-html-full-screen', () => {
    try { if (!win.isFullScreen()) win.setFullScreen(true); } catch (e) { }
  });
  win.on('leave-html-full-screen', () => {
    try { if (win.isFullScreen()) win.setFullScreen(false); } catch (e) { }
  });

  win.on('closed', () => {
    shutdownNewWindow(state);
  });

  // Create overlay and first tab
  createNewWindowOverlay(state);
  const firstTabId = createNewWindowTab(state);
  switchNewWindowTab(state, firstTabId);
}

function shutdownNewWindow(state) {
  if (state.closed) return;
  state.closed = true;

  if (state.overlay && !state.overlay.isDestroyed()) {
    try { state.overlay.destroy(); } catch (e) { }
  }
  state.overlay = null;
  state.activeOverlaySuggestions = null;
  state.activeDownloadsPanel = null;
  state.activeAppMenu = null;
  state.activeStarPopup = null;
  state.activeAboutDialog = false;

  for (const tabId of Array.from(state.tabs.keys())) {
    destroyNewWindowTab(state, tabId, false);
  }
  state.tabs.clear();
  state.activeTabId = null;
  extraWindows.delete(state.id);
}

// ── OVERLAY ──────────────────────────────────────────────────

function createNewWindowOverlay(state) {
  if (!state.win || state.win.isDestroyed()) return;
  if (state.overlay && !state.overlay.isDestroyed()) return;

  state.overlay = new BrowserWindow({
    parent: state.win,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  state.overlay.loadFile(OVERLAY_FILE, { query: { theme: services.getCurrentThemeMode(), newWindow: '1' } })
    .then(() => {
      if (state.overlay && !state.overlay.isDestroyed()) {
        state.overlay.show();
        state.overlay.setIgnoreMouseEvents(true, { forward: true });
        updateNewWindowOverlayBounds(state);
      }
    })
    .catch((err) => services.logError('new-window-overlay-load-failed', err));

  state.overlay.on('blur', () => {
    if (state.activeDownloadsPanel) hideNewWindowDownloadsPanel(state);
  });
}

function updateNewWindowOverlayBounds(state) {
  if (!state.win || state.win.isDestroyed() || !state.overlay || state.overlay.isDestroyed()) return;

  if (state.activeOverlaySuggestions) {
    updateNewWindowSuggestionBounds(state, state.activeOverlaySuggestions);
    return;
  }
  if (state.activeDownloadsPanel) {
    updateNewWindowPanelBounds(state);
    return;
  }
  if (state.activeAppMenu) {
    updateNewWindowAppMenuBounds(state);
    return;
  }

  const bounds = state.win.getContentBounds();
  if (!state.lastOverlayBounds ||
      bounds.x !== state.lastOverlayBounds.x || bounds.y !== state.lastOverlayBounds.y ||
      bounds.width !== state.lastOverlayBounds.width || bounds.height !== state.lastOverlayBounds.height) {
    state.lastOverlayBounds = bounds;
    try { state.overlay.setBounds(bounds); } catch (e) { }
  }
}

function updateNewWindowSuggestionBounds(state, payload) {
  if (!state.win || state.win.isDestroyed() || !state.overlay || state.overlay.isDestroyed()) return null;
  const { rect, items } = payload || {};
  if (!rect || !Array.isArray(items) || !items.length) return null;

  const winBounds = state.win.getContentBounds();
  const [currentW] = state.win.getContentSize();

  const clampedRectLeft = Math.min(Math.max(0, Math.round(rect.left)), Math.max(0, currentW - 20));
  const clampedRectWidth = Math.min(Math.max(1, Math.round(rect.width)), currentW - clampedRectLeft);

  const left = Math.round(winBounds.x + clampedRectLeft);
  const top = Math.round(winBounds.y + rect.bottom);
  const width = Math.max(1, clampedRectWidth);
  const itemHeight = 44;
  const borderHeight = 1;
  const height = Math.max(1, Math.round(items.length * itemHeight + borderHeight));
  const maxWidth = Math.max(1, winBounds.x + winBounds.width - left);
  const maxHeight = Math.max(1, winBounds.y + winBounds.height - top);

  const bounds = {
    x: left,
    y: top,
    width: Math.min(width, maxWidth),
    height: Math.min(height, maxHeight),
  };

  if (!state.lastSuggestionBounds ||
      bounds.x !== state.lastSuggestionBounds.x || bounds.y !== state.lastSuggestionBounds.y ||
      bounds.width !== state.lastSuggestionBounds.width || bounds.height !== state.lastSuggestionBounds.height) {
    state.lastSuggestionBounds = bounds;
    try { state.overlay.setBounds(bounds); } catch (e) { }
  }

  return {
    ...payload,
    rect: { top: 0, bottom: 0, left: 0, right: bounds.width, width: bounds.width, height: 0 },
  };
}

function updateNewWindowPanelBounds(state) {
  if (!state.win || state.win.isDestroyed() || !state.overlay || state.overlay.isDestroyed()) return;
  if (!state.activeDownloadsPanel) return;
  const rect = state.activeDownloadsPanel.rect;
  if (!rect || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) return;

  const winBounds = state.win.getContentBounds();
  const [currentW] = state.win.getContentSize();
  const PAD = 8;

  const panelW = Math.min(376, Math.max(240, currentW - PAD * 2));
  let left = Math.round(winBounds.x + rect.right - panelW);
  left = Math.max(winBounds.x + PAD, Math.min(left, winBounds.x + currentW - panelW - PAD));
  const top = Math.round(winBounds.y + rect.bottom + 6);
  const maxH = Math.max(120, winBounds.y + winBounds.height - top - PAD);

  const dm = services.getDownloadManager();
  const count = dm ? dm.getDownloads().length : 0;
  const headerH = 46;
  const footerH = 46;
  const rowH = 60;
  const listH = count > 0 ? Math.min(count, 7) * rowH : 84;
  const panelH = Math.min(Math.round(headerH + listH + footerH + 2), Math.round(maxH), 480);

  const bounds = { x: left, y: top, width: Math.round(panelW), height: Math.round(panelH) };
  if (!state.lastPanelBounds ||
      bounds.x !== state.lastPanelBounds.x || bounds.y !== state.lastPanelBounds.y ||
      bounds.width !== state.lastPanelBounds.width || bounds.height !== state.lastPanelBounds.height) {
    state.lastPanelBounds = bounds;
    try { state.overlay.setBounds(bounds); } catch (e) { }
  }
}

function updateNewWindowAppMenuBounds(state) {
  if (!state.win || state.win.isDestroyed() || !state.overlay || state.overlay.isDestroyed()) return;
  if (!state.activeAppMenu) return;
  const rect = state.activeAppMenu.rect;
  if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return;

  const APP_MENU_WIDTH = 284;
  const PAD = 8;
  const GAP = 6;
  const APP_MENU_HEIGHT = 690;

  const winBounds = state.win.getContentBounds();
  const [currentW] = state.win.getContentSize();

  let left = Math.round(winBounds.x + rect.left);
  left = Math.max(winBounds.x + PAD, Math.min(left, winBounds.x + Math.max(PAD, currentW - APP_MENU_WIDTH - PAD)));
  const top = Math.round(winBounds.y + rect.bottom + GAP);
  const maxH = Math.max(120, winBounds.y + winBounds.height - top - PAD);
  const desiredH = state.activeAppMenu.measuredHeight || APP_MENU_HEIGHT;

  const bounds = { x: left, y: top, width: APP_MENU_WIDTH, height: Math.min(desiredH, maxH) };
  if (!state.lastAppMenuBounds ||
      bounds.x !== state.lastAppMenuBounds.x || bounds.y !== state.lastAppMenuBounds.y ||
      bounds.width !== state.lastAppMenuBounds.width || bounds.height !== state.lastAppMenuBounds.height) {
    state.lastAppMenuBounds = bounds;
    try { state.overlay.setBounds(bounds); } catch (e) { }
  }
}

function hideNewWindowDownloadsPanel(state) {
  state.activeDownloadsPanel = null;
  state.lastPanelBounds = null;
  if (!state.overlay || state.overlay.isDestroyed()) return;
  try { state.overlay.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
  try { if (state.overlay.setFocusable) state.overlay.setFocusable(false); } catch (e) { }
  try { state.overlay.webContents.send(NW + 'downloads-panel-hide'); } catch (e) { }
  if (state.win && !state.win.isDestroyed()) {
    try { state.win.webContents.send(NW + 'downloads-panel-hide'); } catch (e) { }
  }
  state.lastOverlayBounds = null;
  updateNewWindowOverlayBounds(state);
}

function hideNewWindowAppMenu(state) {
  if (!state.activeAppMenu) return;
  state.activeAppMenu = null;
  state.lastAppMenuBounds = null;
  if (!state.overlay || state.overlay.isDestroyed()) return;
  try { state.overlay.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
  try { if (state.overlay.setFocusable) state.overlay.setFocusable(false); } catch (e) { }
  try { state.overlay.webContents.send(NW + 'app-menu-hide'); } catch (e) { }
  if (state.win && !state.win.isDestroyed()) {
    try { state.win.webContents.send(NW + 'app-menu-hide'); } catch (e) { }
  }
  state.overlayClosePending = true;
}

// ── TABS ─────────────────────────────────────────────────────

function createNewWindowTab(state, initialTarget = HOME_URL) {
  const id = state.nextTabId++;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:browser',
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const tab = {
    id,
    view,
    title: 'New Tab',
    url: 'about:blank',
    loading: false,
    zoomFactor: 1.0,
    pinned: false,
    isInternalHome: false,
    sleeping: false,
    favicon: '',
    lastActiveAt: Date.now(),
    listeners: [],
    _lastBounds: null,
  };
  state.tabs.set(id, tab);

  const wc = view.webContents;

  wc.on('did-finish-load', () => {
    try { wc.setZoomFactor(tab.zoomFactor || 1.0); } catch (e) { }
  });
  wc.on('dom-ready', () => {
    try { wc.setZoomFactor(tab.zoomFactor || 1.0); } catch (e) { }
  });

  const onDidNavigate = (_, url) => {
    tab.url = tab.isInternalHome ? (tab.url || HOME_URL) : (url || tab.url);
    if (state.activeTabId === id) sendNewWindowActiveSignals(state);
    emitNewWindowTabsState(state);
  };
  const onDidNavigateInPage = (_, url) => {
    tab.url = tab.isInternalHome ? (tab.url || HOME_URL) : (url || tab.url);
    if (state.activeTabId === id) sendNewWindowActiveSignals(state);
    emitNewWindowTabsState(state);
  };
  const onPageTitleUpdated = (_, title) => {
    tab.title = title || 'Untitled';
    if (state.activeTabId === id) sendNewWindowActiveSignals(state);
    emitNewWindowTabsState(state);
  };
  const onDidStartLoading = () => {
    tab.loading = true;
    if (state.activeTabId === id) sendNewWindowActiveSignals(state);
    emitNewWindowTabsState(state);
  };
  const onDidStopLoading = () => {
    tab.loading = false;
    if (state.activeTabId === id) sendNewWindowActiveSignals(state);
    emitNewWindowTabsState(state);
  };
  const onDidFailLoad = (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return;
    const query = { theme: services.getCurrentThemeMode(), url: validatedURL, error: String(errorCode), desc: errorDescription };
    const errorFile = DNS_RESOLUTION_ERROR_CODES.has(errorCode) ? IP_NOT_FOUND_FILE : ERROR_PAGE_FILE;
    try {
      tab.view.webContents.loadFile(errorFile, { query }).catch((err) => services.logError(`new-window-tab-${id}-error-page`, err));
    } catch (e) { }
  };
  const onWillNavigate = (event, url) => {
    try {
      const parsed = new URL(url);
      const allowed = ALLOWED_PROTOCOLS.has(parsed.protocol) || parsed.protocol === 'about:';
      if (!allowed) { event.preventDefault(); return; }
    } catch (e) { event.preventDefault(); return; }
    tab.isInternalHome = false;
  };
  const onBeforeInputEvent = (event, input) => {
    if (input.type !== 'keyDown') return;
    const isMod = process.platform === 'darwin' ? input.meta : input.control;
    if (input.key === 'F11' || input.code === 'F11') {
      if (input.isAutoRepeat) return;
      event.preventDefault();
      try { state.win.setFullScreen(!state.win.isFullScreen()); } catch (e) { }
      return;
    }
    if (!isMod) return;
    if ((input.key === 'Tab' || input.code === 'Tab') && !input.alt) {
      event.preventDefault();
      cycleNewWindowTab(state, input.shift ? -1 : 1);
      return;
    }
    if ((input.key === 't' || input.key === 'T' || input.code === 'KeyT') && !input.alt) {
      event.preventDefault();
      const newId = createNewWindowTab(state);
      switchNewWindowTab(state, newId);
      return;
    }
    if ((input.key === 'n' || input.key === 'N' || input.code === 'KeyN') && input.shift && !input.alt) {
      event.preventDefault();
      openNewWindow();
      return;
    }
    // Ctrl+N — open a new normal window while a webpage has focus.
    if ((input.key === 'n' || input.key === 'N' || input.code === 'KeyN') && !input.shift && !input.alt) {
      event.preventDefault();
      openNewWindow();
      return;
    }
    if ((input.key === 'w' || input.key === 'W' || input.code === 'KeyW') && !input.alt && !input.shift) {
      event.preventDefault();
      closeNewWindowTab(state, state.activeTabId);
      return;
    }
    if (input.key === '=' || input.key === '+' || input.code === 'Equal' || input.code === 'NumpadAdd') {
      event.preventDefault();
      setNewWindowTabZoom(state, tab, (tab.zoomFactor || 1.0) + 0.1);
      return;
    }
    if (input.key === '-' || input.key === '_' || input.code === 'Minus' || input.code === 'NumpadSubtract') {
      event.preventDefault();
      setNewWindowTabZoom(state, tab, (tab.zoomFactor || 1.0) - 0.1);
      return;
    }
    if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') {
      event.preventDefault();
      setNewWindowTabZoom(state, tab, 1.0);
      return;
    }
  };

  wc.setWindowOpenHandler(({ url }) => {
    const target = normalizeNewWindowTarget(url);
    if (!target) return { action: 'deny' };
    const newId = createNewWindowTab(state, target);
    switchNewWindowTab(state, newId);
    return { action: 'deny' };
  });

  const listenerPairs = [
    ['did-navigate', onDidNavigate],
    ['did-navigate-in-page', onDidNavigateInPage],
    ['page-title-updated', onPageTitleUpdated],
    ['did-start-loading', onDidStartLoading],
    ['did-stop-loading', onDidStopLoading],
    ['did-fail-load', onDidFailLoad],
    ['will-navigate', onWillNavigate],
    ['before-input-event', onBeforeInputEvent],
  ];
  for (const [eventName, listener] of listenerPairs) {
    try { wc.on(eventName, listener); } catch (e) { }
  }
  tab.listeners = listenerPairs;

  // Initial content
  if (initialTarget === null || initialTarget === HOME_URL || initialTarget === 'kairon://home') {
    tab.isInternalHome = true;
    tab.url = HOME_URL;
    tab.title = 'New Tab';
    try {
      tab.view.webContents.loadFile(HOME_FILE, { query: { theme: services.getCurrentThemeMode() } })
        .catch((err) => services.logError(`new-window-tab-${id}-home-load`, err));
    } catch (e) { }
  } else if (initialTarget === SETTINGS_URL || initialTarget.startsWith(SETTINGS_URL + '/') || initialTarget === DOWNLOADS_URL) {
    navigateNewWindowTab(state, tab, initialTarget);
  } else {
    try { tab.view.webContents.loadURL(initialTarget).catch((err) => services.logError(`new-window-tab-${id}-load`, err)); } catch (e) { }
  }

  return id;
}

function destroyNewWindowTab(state, tabId, recordForRestore = true) {
  const tab = state.tabs.get(tabId);
  if (!tab) return false;
  if (state.win && !state.win.isDestroyed() && state.win.getBrowserView() === tab.view) {
    try { state.win.setBrowserView(null); } catch (e) { }
  }
  for (const [eventName, listener] of tab.listeners) {
    try { tab.view.webContents.removeListener(eventName, listener); } catch (e) { }
  }
  try { tab.view.webContents.close({ waitForBeforeUnload: false }); } catch (e) { }
  try { tab.view.webContents.destroy(); } catch (e) { }
  state.tabs.delete(tabId);
  return true;
}

function switchNewWindowTab(state, tabId) {
  if (!state.win || state.win.isDestroyed()) return false;
  const tab = state.tabs.get(tabId);
  if (!tab) return false;
  if (tabId === state.activeTabId && state.win.getBrowserView() === tab.view) return true;

  state.activeTabId = tabId;
  try { state.win.setBrowserView(tab.view); } catch (e) { return false; }
  try { tab.view.webContents.setZoomFactor(tab.zoomFactor || 1.0); } catch (e) { }
  tab._lastBounds = null;
  applyNewWindowBounds(state);
  try { tab.view.webContents.focus(); } catch (e) { }
  sendNewWindowActiveSignals(state);
  emitNewWindowTabsState(state);
  return true;
}

function cycleNewWindowTab(state, direction) {
  const order = Array.from(state.tabs.keys());
  if (order.length < 2) return false;
  let index = order.indexOf(state.activeTabId);
  if (index === -1) index = direction > 0 ? -1 : 0;
  const targetIndex = (index + direction + order.length) % order.length;
  return switchNewWindowTab(state, order[targetIndex]);
}

function closeNewWindowTab(state, tabId) {
  if (!Number.isInteger(tabId) || !state.tabs.has(tabId)) return;
  const ids = Array.from(state.tabs.keys());
  const closedIndex = ids.indexOf(tabId);
  const wasActive = state.activeTabId === tabId;
  destroyNewWindowTab(state, tabId);
  if (state.tabs.size === 0) {
    const newId = createNewWindowTab(state);
    switchNewWindowTab(state, newId);
    return;
  }
  if (wasActive) {
    const remaining = Array.from(state.tabs.keys());
    switchNewWindowTab(state, remaining[Math.min(closedIndex, remaining.length - 1)]);
    return;
  }
  emitNewWindowTabsState(state);
}

function setNewWindowTabZoom(state, tab, factor) {
  const clamped = Math.min(3.0, Math.max(0.25, factor));
  tab.zoomFactor = clamped;
  try { tab.view.webContents.setZoomFactor(clamped); } catch (e) { }
  emitNewWindowTabsState(state);
}

// ── NAVIGATION ───────────────────────────────────────────────

function navigateNewWindowTab(state, tab, target) {
  if (target === HOME_URL) {
    tab.isInternalHome = true;
    tab.url = HOME_URL;
    tab.title = 'New Tab';
    try {
      tab.view.webContents.loadFile(HOME_FILE, { query: { theme: services.getCurrentThemeMode() } })
        .catch((err) => services.logError(`new-window-tab-${tab.id}-home-nav`, err));
    } catch (e) { }
    if (state.activeTabId === tab.id) sendNewWindowActiveSignals(state);
    emitNewWindowTabsState(state);
    return;
  }
  if (target === SETTINGS_URL || target.startsWith(SETTINGS_URL + '/')) {
    tab.isInternalHome = true;
    tab.url = target;
    tab.title = 'Settings';
    const query = { theme: services.getCurrentThemeMode() };
    const section = target === SETTINGS_URL ? null : target.slice(SETTINGS_URL.length + 1);
    if (section) query.section = section;
    try {
      tab.view.webContents.loadFile(SETTINGS_PAGE_FILE, { query }).catch((err) => services.logError(`new-window-tab-${tab.id}-settings-nav`, err));
    } catch (e) { }
    if (state.activeTabId === tab.id) sendNewWindowActiveSignals(state);
    emitNewWindowTabsState(state);
    return;
  }
  if (target === DOWNLOADS_URL) {
    tab.isInternalHome = true;
    tab.url = DOWNLOADS_URL;
    tab.title = 'Downloads';
    try {
      tab.view.webContents.loadFile(DOWNLOADS_PAGE_FILE, { query: { theme: services.getCurrentThemeMode() } })
        .catch((err) => services.logError(`new-window-tab-${tab.id}-downloads-nav`, err));
    } catch (e) { }
    if (state.activeTabId === tab.id) sendNewWindowActiveSignals(state);
    emitNewWindowTabsState(state);
    return;
  }
  const normalized = normalizeNewWindowTarget(target);
  if (normalized === HOME_URL) {
    navigateNewWindowTab(state, tab, HOME_URL);
    return;
  }
  if (!normalized) {
    try {
      if (state.win && !state.win.isDestroyed()) state.win.webContents.send(NW + 'navigation-invalid');
    } catch (e) { }
    return;
  }
  tab.isInternalHome = false;
  try {
    tab.view.webContents.loadURL(normalized).catch((err) => services.logError(`new-window-tab-${tab.id}-nav`, err));
  } catch (e) { }
}

function normalizeNewWindowTarget(input) {
  if (typeof input !== 'string' || input.length > MAX_URL_LENGTH) return null;
  const s = input.trim();
  if (!s) return HOME_URL;
  const lower = s.toLowerCase();
  if (lower === HOME_URL || lower === 'kairon://home' || lower === 'home') return HOME_URL;
  if (lower === 'kairon://history' || lower === 'kairon://history/') return HOME_URL;
  if (lower === SETTINGS_URL || lower === 'kairon://settings/' || /^kairon:\/\/settings\/[a-z0-9-]+$/.test(lower)) {
    return /^kairon:\/\/settings\/[a-z0-9-]+$/.test(lower) ? `kairon://settings/${lower.split('/').pop()}` : SETTINGS_URL;
  }
  if (lower === DOWNLOADS_URL || lower === 'kairon://downloads/') return DOWNLOADS_URL;
  if (lower === 'kairon://bookmarks' || lower === 'kairon://bookmarks/') return 'kairon://bookmarks';
  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(s);
  const candidate = hasProtocol
    ? s
    : (s.includes('.') && !s.includes(' ') && s.length < 100 ? `https://${s}` : `https://search.brave.com/search?q=${encodeURIComponent(s)}`);
  try {
    const parsed = new URL(candidate);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
    return candidate;
  } catch (e) {
    return null;
  }
}

// ── BOUNDS ───────────────────────────────────────────────────

function applyNewWindowBounds(state) {
  if (!state.win || state.win.isDestroyed() || !state.bounds) return;
  const tab = state.tabs.get(state.activeTabId);
  if (!tab || !tab.view) return;
  const [currentW, currentH] = state.win.getContentSize();
  const x = Math.max(0, Math.min(Math.round(state.bounds.x), Math.max(0, currentW - 100)));
  const y = Math.max(0, Math.min(Math.round(state.bounds.y), Math.max(0, currentH - 100)));
  const width = Math.min(Math.round(state.bounds.width), currentW, Math.max(100, currentW - x));
  const height = Math.min(Math.round(state.bounds.height), currentH, Math.max(100, currentH - y));
  const bounds = { x, y, width: Math.max(1, width), height: Math.max(1, height) };
  const prev = tab._lastBounds;
  if (!prev || prev.x !== bounds.x || prev.y !== bounds.y || prev.width !== bounds.width || prev.height !== bounds.height) {
    tab._lastBounds = bounds;
    try { tab.view.setBounds(bounds); } catch (e) { }
  }
}

// ── STATE BROADCAST ──────────────────────────────────────────

function getNewWindowTabPublicState(tab) {
  let canGoBack = false;
  let canGoForward = false;
  try {
    canGoBack = tab.view.webContents.navigationHistory.canGoBack();
    canGoForward = tab.view.webContents.navigationHistory.canGoForward();
  } catch (e) { }
  return {
    id: tab.id,
    title: tab.title || 'New Tab',
    url: tab.url || 'about:blank',
    loading: !!tab.loading,
    sleeping: false,
    pinned: false,
    canGoBack,
    canGoForward,
    zoomFactor: typeof tab.zoomFactor === 'number' ? tab.zoomFactor : 1.0,
  };
}

function emitNewWindowTabsState(state) {
  if (!state.win || state.win.isDestroyed()) return;
  try {
    state.win.webContents.send(NW + 'tabs-state', {
      activeTabId: state.activeTabId,
      tabs: Array.from(state.tabs.values()).map(getNewWindowTabPublicState),
    });
  } catch (e) { }
}

function sendNewWindowActiveSignals(state) {
  const tab = state.tabs.get(state.activeTabId);
  if (!tab || !state.win || state.win.isDestroyed()) return;
  try {
    state.win.webContents.send(NW + 'url-changed', tab.url || '');
    state.win.webContents.send(NW + 'title-changed', tab.title || 'New Tab');
    state.win.webContents.send(NW + 'loading', !!tab.loading);
  } catch (e) { }
}

function focusNewWindowActiveTab(state) {
  const tab = state.tabs.get(state.activeTabId);
  if (!tab || !tab.view || tab.view.webContents.isDestroyed()) return;
  try { tab.view.webContents.focus(); } catch (e) { }
}

function getAppMenuStateForWindow(state) {
  const tab = state.tabs.get(state.activeTabId);
  let canGoBack = false;
  let canGoForward = false;
  let zoomFactor = 1.0;
  if (tab && tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
    try { canGoBack = tab.view.webContents.navigationHistory.canGoBack(); } catch (e) { }
    try { canGoForward = tab.view.webContents.navigationHistory.canGoForward(); } catch (e) { }
    zoomFactor = typeof tab.zoomFactor === 'number' ? tab.zoomFactor : 1.0;
  }
  let isFullscreen = false;
  if (state.win && !state.win.isDestroyed()) {
    try { isFullscreen = state.win.isFullScreen(); } catch (e) { }
  }
  let updater = null;
  try { updater = services.getUpdaterState ? services.getUpdaterState() : null; } catch (e) { }
  return { canGoBack, canGoForward, zoomFactor, isFullscreen, updater };
}

// ── SHORTCUTS (chrome) ───────────────────────────────────────

function handleNewWindowChromeShortcut(state, event, input) {
  if (input.type !== 'keyDown') return;
  const isMod = process.platform === 'darwin' ? input.meta : input.control;
  if (input.key === 'F11' || input.code === 'F11') {
    if (input.isAutoRepeat) return;
    event.preventDefault();
    try { state.win.setFullScreen(!state.win.isFullScreen()); } catch (e) { }
    return;
  }
  // Ctrl+Shift+N — new window from within a new window
  if ((input.key === 'n' || input.key === 'N' || input.code === 'KeyN') && input.shift && !input.alt &&
      (process.platform === 'darwin' ? input.meta : input.control)) {
    event.preventDefault();
    openIncognitoFromNewWindow();
    return;
  }
  // Ctrl+N — another new window
  if ((input.key === 'n' || input.key === 'N' || input.code === 'KeyN') && !input.shift && !input.alt &&
      (process.platform === 'darwin' ? input.meta : input.control)) {
    event.preventDefault();
    openNewWindow();
    return;
  }
  if (!isMod) return;
  if ((input.key === 'Tab' || input.code === 'Tab') && !input.alt) {
    event.preventDefault();
    cycleNewWindowTab(state, input.shift ? -1 : 1);
    return;
  }
  if ((input.key === 't' || input.key === 'T' || input.code === 'KeyT') && !input.alt) {
    event.preventDefault();
    const newId = createNewWindowTab(state);
    switchNewWindowTab(state, newId);
    return;
  }
  if ((input.key === 'w' || input.key === 'W' || input.code === 'KeyW') && !input.alt && !input.shift) {
    event.preventDefault();
    closeNewWindowTab(state, state.activeTabId);
  }
  if ((input.key === 'f' || input.key === 'F' || input.code === 'KeyF') && !input.alt && !input.shift) {
    event.preventDefault();
    if (state.win && !state.win.isDestroyed()) {
      state.win.webContents.send(NW + 'find-bar-show');
    }
    return;
  }
  if ((input.key === 'd' || input.key === 'D' || input.code === 'KeyD') && !input.alt && !input.shift) {
    event.preventDefault();
    // Bookmark toggle — delegated to the tab
    return;
  }
}

// Lazy-load incognito to avoid circular require
let _openIncognitoWindow = null;
function openIncognitoFromNewWindow() {
  if (!_openIncognitoWindow) {
    try { _openIncognitoWindow = require('./incognito').openIncognitoWindow; } catch (e) { }
  }
  if (_openIncognitoWindow) _openIncognitoWindow();
}

// ── IPC ──────────────────────────────────────────────────────

function isNewWindowChromeSender(event) {
  if (!event || !event.sender) return false;
  for (const state of extraWindows.values()) {
    if (state.win && !state.win.isDestroyed() && state.win.webContents === event.sender) return true;
  }
  return false;
}

function isNewWindowOverlaySender(event) {
  if (!event || !event.sender) return false;
  for (const state of extraWindows.values()) {
    if (state.overlay && !state.overlay.isDestroyed() && state.overlay.webContents === event.sender) return true;
  }
  return false;
}

function isNewWindowTabWebContents(wc) {
  if (!wc) return false;
  for (const state of extraWindows.values()) {
    for (const tab of state.tabs.values()) {
      if (tab.view && tab.view.webContents === wc) return true;
    }
  }
  return false;
}

function findNewWindowByChromeSender(sender) {
  for (const state of extraWindows.values()) {
    if (state.win && !state.win.isDestroyed() && state.win.webContents === sender) return state;
  }
  return null;
}

function findNewWindowByOverlaySender(sender) {
  for (const state of extraWindows.values()) {
    if (state.overlay && !state.overlay.isDestroyed() && state.overlay.webContents === sender) return state;
  }
  return null;
}

function findNewWindowBySender(event) {
  const state = findNewWindowByChromeSender(event.sender);
  if (state) return state;
  return findNewWindowByOverlaySender(event.sender);
}

const NW = 'nw-';

function registerNewWindowIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!isNewWindowChromeSender(event) && !isNewWindowOverlaySender(event) && !isNewWindowTabWebContents(event.sender)) {
      throw new Error('Unauthorized IPC sender');
    }
    return fn(event, ...args);
  });

  const onChannel = (channel, fn) => ipcMain.on(channel, (event, ...args) => {
    const state = findNewWindowByChromeSender(event.sender);
    if (!state) return;
    fn(state, event, ...args);
  });

  const onTrustedChannel = (channel, fn) => ipcMain.on(channel, (event, ...args) => {
    const state = findNewWindowBySender(event);
    if (!state) return;
    fn(state, event, ...args);
  });

  // Navigation
  onTrustedChannel('nw-navigate', (state, event, url) => {
    const tab = state.tabs.get(state.activeTabId);
    if (tab) navigateNewWindowTab(state, tab, url);
  });

  onChannel('nw-go-back', (state) => {
    const tab = state.tabs.get(state.activeTabId);
    if (tab) { try { tab.view.webContents.navigationHistory.goBack(); } catch (e) { } }
  });

  onChannel('nw-go-forward', (state) => {
    const tab = state.tabs.get(state.activeTabId);
    if (tab) { try { tab.view.webContents.navigationHistory.goForward(); } catch (e) { } }
  });

  onChannel('nw-reload', (state) => {
    const tab = state.tabs.get(state.activeTabId);
    if (tab) { try { tab.view.webContents.reload(); } catch (e) { } }
  });

  onChannel('nw-stop-loading', (state) => {
    const tab = state.tabs.get(state.activeTabId);
    if (tab) { try { tab.view.webContents.stop(); } catch (e) { } }
  });

  // Tabs
  onChannel('nw-tab-create', (state, event, url) => {
    const newId = createNewWindowTab(state, url);
    switchNewWindowTab(state, newId);
  });

  onChannel('nw-tab-switch', (state, event, tabId) => {
    if (Number.isInteger(tabId)) switchNewWindowTab(state, tabId);
  });

  onChannel('nw-tab-close', (state, event, tabId) => {
    if (Number.isInteger(tabId)) closeNewWindowTab(state, tabId);
  });

  onChannel('nw-tab-reorder', (state, event, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { sourceId, targetIndex } = payload;
    if (!Number.isInteger(sourceId) || !Number.isInteger(targetIndex)) return;
    if (!state.tabs.has(sourceId)) return;
    const keys = Array.from(state.tabs.keys());
    const sourceIndex = keys.indexOf(sourceId);
    if (sourceIndex === -1) return;
    const clamped = Math.max(0, Math.min(targetIndex, keys.length - 1));
    if (clamped === sourceIndex) return;
    const entries = Array.from(state.tabs.entries());
    const [entry] = entries.splice(sourceIndex, 1);
    entries.splice(clamped, 0, entry);
    state.tabs = new Map(entries);
    emitNewWindowTabsState(state);
  });

  // Zoom
  onChannel('nw-zoom-in', (state) => {
    const tab = state.tabs.get(state.activeTabId);
    if (tab) setNewWindowTabZoom(state, tab, (tab.zoomFactor || 1.0) + 0.1);
  });

  onChannel('nw-zoom-out', (state) => {
    const tab = state.tabs.get(state.activeTabId);
    if (tab) setNewWindowTabZoom(state, tab, (tab.zoomFactor || 1.0) - 0.1);
  });

  onChannel('nw-zoom-reset', (state) => {
    const tab = state.tabs.get(state.activeTabId);
    if (tab) setNewWindowTabZoom(state, tab, 1.0);
  });

  // Layout
  onChannel('nw-layout-metrics', (state, event, metrics) => {
    if (metrics && typeof metrics === 'object') {
      const x = Math.round(Number(metrics.x));
      const y = Math.round(Number(metrics.y));
      const width = Math.round(Number(metrics.width));
      const height = Math.round(Number(metrics.height));
      if ([x, y, width, height].every(Number.isFinite)) {
        state.bounds = { x: Math.max(0, x), y: Math.max(0, y), width: Math.max(1, width), height: Math.max(1, height) };
        applyNewWindowBounds(state);
      }
    }
  });

  onChannel('nw-chrome-ui-focus', (state, event, focused) => {
    state.chromeUiFocused = focused === true;
  });

  // Window controls
  onChannel('nw-window-minimize', (state) => { try { state.win.minimize(); } catch (e) { } });
  onChannel('nw-window-maximize', (state) => {
    try {
      if (state.win.isMaximized()) state.win.unmaximize();
      else state.win.maximize();
    } catch (e) { }
  });
  onChannel('nw-window-close', (state) => { try { state.win.close(); } catch (e) { } });

  // Fullscreen toggle (F11)
  onChannel('nw-toggle-fullscreen', (state) => {
    try {
      if (state.win.isFullScreen()) state.win.setFullScreen(false);
      else state.win.setFullScreen(true);
    } catch (e) { }
  });

  // Open incognito from new window
  onChannel('nw-open-incognito-window', () => { openIncognitoFromNewWindow(); });

  // Open another new window
  onChannel('nw-open-new-window', () => { openNewWindow(); });

  // Exit app
  onChannel('nw-app-exit', () => {
    try { require('electron').app.quit(); } catch (e) { }
  });

  // Zoom get (for app menu display)
  handle('nw-zoom-get', (event) => {
    const state = findNewWindowByChromeSender(event.sender);
    if (!state) return { zoomFactor: 1.0 };
    const tab = state.tabs.get(state.activeTabId);
    if (!tab) return { zoomFactor: 1.0 };
    return { zoomFactor: typeof tab.zoomFactor === 'number' ? tab.zoomFactor : 1.0 };
  });

  // Focus page
  onChannel('nw-focus-page', (state) => {
    focusNewWindowActiveTab(state);
  });

  // App menu
  onChannel('nw-show-app-menu', (state, event, payload) => {
    if (!state.overlay || state.overlay.isDestroyed()) return;
    const rect = payload && payload.rect && typeof payload.rect === 'object' ? payload.rect : null;
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return;

    state.overlayClosePending = false;
    state.activeOverlaySuggestions = null;
    state.lastSuggestionBounds = null;
    state.activeAboutDialog = false;
    state.activeStarPopup = null;
    state.lastStarPopupBounds = null;
    try { state.overlay.webContents.send(NW + 'overlay-hide'); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'about-hide'); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'star-popup-hide'); } catch (e) { }
    try { state.win.webContents.send(NW + 'star-popup-hide'); } catch (e) { }

    state.activeAppMenu = { rect, at: Date.now() };
    try { state.overlay.hide(); } catch (e) { }
    updateNewWindowAppMenuBounds(state);
    try { state.overlay.show(); } catch (e) { }
    try { state.overlay.setIgnoreMouseEvents(false); } catch (e) { }
    try { if (state.overlay.setFocusable) state.overlay.setFocusable(true); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'app-menu-show', { rect, state: getAppMenuStateForWindow(state) }); } catch (e) { }
    try { state.win.webContents.send(NW + 'app-menu-show', { rect }); } catch (e) { }
    try { state.overlay.focus(); } catch (e) { }
  });

  onChannel('nw-hide-app-menu', (state) => {
    hideNewWindowAppMenu(state);
  });

  onChannel('nw-app-menu-measure', (state, event, payload) => {
    if (!state.activeAppMenu) return;
    const height = payload && Number.isFinite(payload.height) ? Math.round(payload.height) : 0;
    if (height > 0 && height !== state.activeAppMenu.measuredHeight) {
      state.activeAppMenu.measuredHeight = height;
      updateNewWindowAppMenuBounds(state);
    }
  });

  // Overlay suggestions
  onChannel('nw-show-overlay-suggestions', (state, event, payload) => {
    if (!state.overlay || state.overlay.isDestroyed()) return;
    const { rect, items } = payload || {};
    let overlayPayload = payload;
    if (rect && items) {
      state.activeOverlaySuggestions = payload;
      overlayPayload = updateNewWindowSuggestionBounds(state, payload) || payload;
      try { state.overlay.setIgnoreMouseEvents(false); } catch (e) { }
    }
    state.overlay.webContents.send(NW + 'overlay-suggestions', overlayPayload);
  });

  onChannel('nw-hide-overlay-suggestions', (state) => {
    if (!state.overlay || state.overlay.isDestroyed()) return;
    state.activeOverlaySuggestions = null;
    try { state.overlay.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
    state.overlay.webContents.send(NW + 'overlay-hide');
    state.lastOverlayBounds = null;
    state.lastSuggestionBounds = null;
    updateNewWindowOverlayBounds(state);
  });

  onTrustedChannel('nw-navigate-to-suggestion', (state, event, url) => {
    const tab = state.tabs.get(state.activeTabId);
    if (!tab) return;
    const target = normalizeNewWindowTarget(url);
    if (!target) {
      try {
        if (state.win && !state.win.isDestroyed()) state.win.webContents.send(NW + 'navigation-invalid');
      } catch (e) { }
      return;
    }
    if (state.overlay && !state.overlay.isDestroyed()) {
      state.activeOverlaySuggestions = null;
      try { state.overlay.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
      state.overlay.webContents.send(NW + 'overlay-hide');
      state.lastOverlayBounds = null;
      state.lastSuggestionBounds = null;
      updateNewWindowOverlayBounds(state);
    }
    navigateNewWindowTab(state, tab, target);
  });

  // Downloads panel
  onChannel('nw-show-downloads-panel', (state, event, payload) => {
    if (!state.overlay || state.overlay.isDestroyed()) return;
    const rect = payload && payload.rect && typeof payload.rect === 'object' ? payload.rect : null;
    if (!rect || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) return;

    state.activeOverlaySuggestions = null;
    state.lastSuggestionBounds = null;
    try { state.overlay.webContents.send(NW + 'overlay-hide'); } catch (e) { }

    state.activeDownloadsPanel = { rect, at: Date.now() };
    try { state.overlay.setIgnoreMouseEvents(false); } catch (e) { }
    try { if (state.overlay.setFocusable) state.overlay.setFocusable(true); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'downloads-panel-show', { rect }); } catch (e) { }
    try { state.win.webContents.send(NW + 'downloads-panel-show', { rect }); } catch (e) { }
    updateNewWindowPanelBounds(state);
    try { state.overlay.focus(); } catch (e) { }
  });

  onTrustedChannel('nw-hide-downloads-panel', (state) => {
    hideNewWindowDownloadsPanel(state);
  });

  // Star popup
  onChannel('nw-show-star-popup', (state, event, payload) => {
    if (!state.overlay || state.overlay.isDestroyed()) return;
    const rect = payload && payload.rect && typeof payload.rect === 'object' ? payload.rect : null;
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return;

    state.activeOverlaySuggestions = null;
    state.lastSuggestionBounds = null;
    state.activeDownloadsPanel = null;
    state.lastPanelBounds = null;
    state.activeAppMenu = null;
    state.lastAppMenuBounds = null;
    try { state.overlay.webContents.send(NW + 'overlay-hide'); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'app-menu-hide'); } catch (e) { }

    state.activeStarPopup = { rect, at: Date.now() };
    try { state.overlay.hide(); } catch (e) { }
    updateNewWindowStarPopupBounds(state);
    try { state.overlay.show(); } catch (e) { }
    try { state.overlay.setIgnoreMouseEvents(false); } catch (e) { }
    try { if (state.overlay.setFocusable) state.overlay.setFocusable(true); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'star-popup-show', { rect, state: payload.state }); } catch (e) { }
    try { state.win.webContents.send(NW + 'star-popup-show', { rect }); } catch (e) { }
    try { state.overlay.focus(); } catch (e) { }
  });

  onChannel('nw-hide-star-popup', (state) => {
    if (!state.activeStarPopup) return;
    state.activeStarPopup = null;
    state.lastStarPopupBounds = null;
    if (!state.overlay || state.overlay.isDestroyed()) return;
    try { state.overlay.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
    try { if (state.overlay.setFocusable) state.overlay.setFocusable(false); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'star-popup-hide'); } catch (e) { }
    if (state.win && !state.win.isDestroyed()) {
      try { state.win.webContents.send(NW + 'star-popup-hide'); } catch (e) { }
    }
    state.overlayClosePending = true;
  });

  // Popup close finished
  onTrustedChannel('nw-popup-close-finished', (state) => {
    state.overlayClosePending = false;
    if (state.activeAppMenu || state.activeDownloadsPanel || state.activeStarPopup || state.activeAboutDialog || state.activeOverlaySuggestions) return;
    if (state.overlay && !state.overlay.isDestroyed()) {
      try { state.overlay.hide(); } catch (e) { }
    }
    state.lastOverlayBounds = null;
    updateNewWindowOverlayBounds(state);
  });

  // About dialog
  onChannel('nw-show-about', (state) => {
    if (!state.overlay || state.overlay.isDestroyed()) return;
    state.overlayClosePending = false;
    state.activeAppMenu = null;
    state.lastAppMenuBounds = null;
    state.activeOverlaySuggestions = null;
    state.lastSuggestionBounds = null;
    state.activeStarPopup = null;
    state.lastStarPopupBounds = null;
    try { state.overlay.webContents.send(NW + 'overlay-hide'); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'app-menu-hide'); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'star-popup-hide'); } catch (e) { }
    try { state.win.webContents.send(NW + 'app-menu-hide'); } catch (e) { }
    try { state.win.webContents.send(NW + 'star-popup-hide'); } catch (e) { }

    state.activeAboutDialog = true;
    try { state.overlay.hide(); } catch (e) { }
    state.lastOverlayBounds = null;
    updateNewWindowOverlayBounds(state);
    try { state.overlay.show(); } catch (e) { }
    try { state.overlay.setIgnoreMouseEvents(false); } catch (e) { }
    try { if (state.overlay.setFocusable) state.overlay.setFocusable(true); } catch (e) { }
    let version = '1.0.0';
    try { const { app } = require('electron'); version = app.getVersion(); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'about-show', { version }); } catch (e) { }
    try { state.overlay.focus(); } catch (e) { }
  });

  onChannel('nw-hide-about', (state) => {
    if (!state.activeAboutDialog) return;
    state.activeAboutDialog = false;
    if (!state.overlay || state.overlay.isDestroyed()) return;
    try { state.overlay.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
    try { if (state.overlay.setFocusable) state.overlay.setFocusable(false); } catch (e) { }
    try { state.overlay.webContents.send(NW + 'about-hide'); } catch (e) { }
    if (state.win && !state.win.isDestroyed()) {
      try { state.win.webContents.send(NW + 'about-hide'); } catch (e) { }
    }
    state.overlayClosePending = true;
  });

  // Star popup state
  onChannel('nw-star-popup-state', (state) => {
    const tab = state.tabs.get(state.activeTabId);
    if (!tab || !state.overlay || state.overlay.isDestroyed()) return;
    const url = tab.url || '';
    const bookmarks = services.getBookmarkService ? services.getBookmarkService() : null;
    const qa = services.getQuickAccessService ? services.getQuickAccessService() : null;
    const isBookmarked = bookmarks ? bookmarks.isBookmarked(url) : false;
    const inQuickAccess = qa ? qa.hasEntry(url) : false;
    try {
      state.overlay.webContents.send(NW + 'star-popup-state', { isBookmarked, inQuickAccess });
    } catch (e) { }
  });

  // Tab context menu
  onChannel('nw-tab-context-menu', (state, event, tabId) => {
    if (!Number.isInteger(tabId) || !state.tabs.has(tabId)) return;
    const { setupTabContextMenu } = require('./tab-context-menu');
    setupTabContextMenu(tabId, {
      onNewTab: () => {
        const newId = createNewWindowTab(state);
        switchNewWindowTab(state, newId);
      },
      onReloadTab: (clickedTabId) => {
        const tab = state.tabs.get(clickedTabId);
        if (tab && tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
          try { tab.view.webContents.reload(); } catch (e) { }
        }
      },
      onDuplicateTab: (clickedTabId) => {
        const tab = state.tabs.get(clickedTabId);
        if (!tab) return;
        const url = (tab.url && tab.url !== HOME_URL && tab.url !== 'about:blank') ? tab.url : null;
        const newId = createNewWindowTab(state, url);
        switchNewWindowTab(state, newId);
      },
      onCloseTab: (clickedTabId) => closeNewWindowTab(state, clickedTabId),
      onCloseOtherTabs: (clickedTabId) => {
        const ids = Array.from(state.tabs.keys());
        for (const id of ids) {
          if (id === clickedTabId) continue;
          destroyNewWindowTab(state, id);
        }
        if (state.activeTabId === clickedTabId || !state.tabs.has(state.activeTabId)) {
          switchNewWindowTab(state, clickedTabId);
        } else {
          emitNewWindowTabsState(state);
        }
      },
      onCloseTabsToTheRight: (clickedTabId) => {
        const ids = Array.from(state.tabs.keys());
        const sourceIndex = ids.indexOf(clickedTabId);
        if (sourceIndex === -1) return;
        for (let i = sourceIndex + 1; i < ids.length; i++) {
          destroyNewWindowTab(state, ids[i]);
        }
        if (state.tabs.has(state.activeTabId)) {
          emitNewWindowTabsState(state);
        } else {
          switchNewWindowTab(state, clickedTabId);
        }
      },
      hasClosedTabs: false,
    }, { isPinned: false, hasClosedTabs: false, isSleeping: false });
  });

  // Shared store
  handle('nw-store-get', (event, key) => {
    if (typeof key !== 'string' || !key || key.length > 256) throw new Error('Invalid store key');
    return services.store ? services.store.get(key) : undefined;
  });

  handle('nw-store-set', (event, key, value) => {
    if (typeof key !== 'string' || !key || key.length > 256) throw new Error('Invalid store key');
    if (services.store) services.store.set(key, value);
    return true;
  });

  // Settings
  handle('nw-settings-set-feature-enabled', (event, featureId, enabled) => {
    if (typeof featureId !== 'string' || featureId.length > 128 || typeof enabled !== 'boolean') {
      throw new Error('Invalid settings payload');
    }
    if (!services.featureStore) return false;
    const ok = services.featureStore.setFeatureEnabled(featureId, enabled);
    if (!ok) throw new Error('Unknown feature');
    try { if (typeof services.emitSettingsState === 'function') services.emitSettingsState(event.sender.id); } catch (e) { }
    setImmediate(() => { try { services.reconfigureAdblocker().catch(() => { }); } catch (e) { } });
    return true;
  });

  handle('nw-settings-update-feature-config', (event, featureId, patch) => {
    if (typeof featureId !== 'string' || featureId.length > 128 || !patch || typeof patch !== 'object') {
      throw new Error('Invalid settings payload');
    }
    if (!services.featureStore) return false;
    const ok = services.featureStore.updateFeatureConfig(featureId, patch);
    if (!ok) throw new Error('Unknown feature');
    try { if (typeof services.emitSettingsState === 'function') services.emitSettingsState(event.sender.id); } catch (e) { }
    setImmediate(() => { try { services.reconfigureAdblocker().catch(() => { }); } catch (e) { } });
    return true;
  });

  handle('nw-settings-get-state', () => {
    return services.featureStore ? services.featureStore.getPublicSnapshot() : { registry: [], state: {} };
  });

  handle('nw-log-error', (event, payload) => {
    if (!payload || typeof payload.source !== 'string' || typeof payload.message !== 'string') return true;
    services.logError(`renderer-${payload.source}`, payload.message);
    return true;
  });

  // History autocomplete (shares the normal history service)
  handle('nw-history-autocomplete', (event, query, limit) => {
    if (typeof query !== 'string') return [];
    const hs = services.getHistoryService();
    return hs ? hs.getAutocompleteSuggestions(query, limit || 8) : [];
  });

  // History data (for the internal history page)
  handle('nw-history-get', (event, limit, offset) => {
    const hs = services.getHistoryService();
    return hs ? hs.getHistory(limit || 50, offset || 0) : [];
  });

  handle('nw-history-search', (event, query, limit, offset) => {
    if (typeof query !== 'string') return [];
    const hs = services.getHistoryService();
    return hs ? hs.searchHistory(query, limit || 50, offset || 0) : [];
  });

  handle('nw-history-delete-entry', (event, id) => {
    const hs = services.getHistoryService();
    return hs ? hs.deleteHistoryEntry(id) : false;
  });

  handle('nw-history-clear', () => {
    const hs = services.getHistoryService();
    if (hs) hs.clearHistory();
  });

  handle('nw-history-get-count', () => {
    const hs = services.getHistoryService();
    return hs ? hs.getEntryCount() : 0;
  });

  // Bookmarks
  handle('nw-bookmarks-get', () => {
    const bs = services.getBookmarkService();
    return bs ? bs.getBookmarks() : [];
  });

  handle('nw-bookmarks-add', (event, url, title) => {
    const bs = services.getBookmarkService();
    if (!bs || typeof url !== 'string') return null;
    return bs.addBookmark(url, title || '');
  });

  handle('nw-bookmarks-delete', (event, id) => {
    const bs = services.getBookmarkService();
    if (!bs || !Number.isInteger(id)) return false;
    return bs.deleteBookmark(id);
  });

  handle('nw-bookmarks-is-bookmarked', (event, url) => {
    const bs = services.getBookmarkService();
    return bs ? bs.isBookmarked(url) : false;
  });

  handle('nw-bookmarks-toggle', (event, url, title) => {
    const bs = services.getBookmarkService();
    if (!bs || typeof url !== 'string') return null;
    return bs.toggleBookmark(url, title || '');
  });

  // Quick Access
  handle('nw-quick-access-get', () => {
    const qa = services.getQuickAccessService();
    return qa ? qa.getEntries() : [];
  });

  handle('nw-quick-access-delete', (event, id) => {
    const qa = services.getQuickAccessService();
    if (!qa || !Number.isInteger(id)) return false;
    return qa.deleteEntry(id);
  });

  handle('nw-quick-access-toggle-active', (event, url) => {
    const qa = services.getQuickAccessService();
    if (!qa || typeof url !== 'string') return null;
    return qa.toggleEntry(url);
  });

  // Downloads
  handle('nw-downloads-get', () => {
    const dm = services.getDownloadManager();
    return dm ? dm.getDownloads() : [];
  });

  handle('nw-downloads-clear', () => {
    const dm = services.getDownloadManager();
    return dm ? dm.clearCompleted() : false;
  });

  // Open downloads folder
  onTrustedChannel('nw-open-downloads-folder', async (state) => {
    try {
      const dm = services.getDownloadManager();
      if (dm) await dm.openDownloadsFolder();
    } catch (e) { }
  });

  // Tab sleep (no-op for new windows — tabs don't sleep in additional windows)
  handle('nw-tab-sleep-status', () => ({ enabled: false }));
}

// ── SETTINGS SYNC ────────────────────────────────────────────

function broadcastSettingsToNewWindows(snapshot, senderId) {
  for (const state of extraWindows.values()) {
    if (state.win && !state.win.isDestroyed() && state.win.webContents.id !== senderId) {      try { state.win.webContents.send(NW + 'settings-updated', snapshot); } catch (e) { }
  }
  if (state.overlay && !state.overlay.isDestroyed() && state.overlay.webContents.id !== senderId) {
    try { state.overlay.webContents.send(NW + 'settings-updated', snapshot); } catch (e) { }
  }
  // Tabs showing internal pages
  for (const tab of state.tabs.values()) {
    try {
      const wc = tab.view && tab.view.webContents;
      if (!wc || wc.isDestroyed() || wc.id === senderId) continue;
      const url = wc.getURL();
      if (!url.startsWith('file:')) continue;
      if (url.includes('settings.html') || url.includes('home.html') ||
          url.includes("can't_be_reached.html") || url.includes('ip_not_found.html')) {
        wc.send('settings-updated', snapshot);
        }
      } catch (e) { }
    }
  }
}

function broadcastBookmarksToNewWindows() {
  for (const state of extraWindows.values()) {
    if (state.win && !state.win.isDestroyed()) {
      try { state.win.webContents.send(NW + 'bookmarks-updated'); } catch (e) { }
    }
  }
}

function broadcastDownloadsToNewWindows(list) {
  for (const state of extraWindows.values()) {
    if (state.win && !state.win.isDestroyed()) {
      try { state.win.webContents.send(NW + 'downloads-updated', list); } catch (e) { }
    }
    if (state.overlay && !state.overlay.isDestroyed()) {
      try { state.overlay.webContents.send(NW + 'downloads-updated', list); } catch (e) { }
    }
  }
}

function updateNewWindowStarPopupBounds(state) {
  if (!state.win || state.win.isDestroyed() || !state.overlay || state.overlay.isDestroyed()) return;
  if (!state.activeStarPopup) return;
  const rect = state.activeStarPopup.rect;
  if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return;

  const STAR_POPUP_WIDTH = 280;
  const PAD = 8;
  const GAP = 6;

  const winBounds = state.win.getContentBounds();
  const [currentW] = state.win.getContentSize();

  let left = Math.round(winBounds.x + rect.left);
  left = Math.max(winBounds.x + PAD, Math.min(left, winBounds.x + Math.max(PAD, currentW - STAR_POPUP_WIDTH - PAD)));
  const top = Math.round(winBounds.y + rect.bottom + GAP);

  const bounds = { x: left, y: top, width: STAR_POPUP_WIDTH, height: 200 };
  if (!state.lastStarPopupBounds ||
      bounds.x !== state.lastStarPopupBounds.x || bounds.y !== state.lastStarPopupBounds.y) {
    state.lastStarPopupBounds = bounds;
    try { state.overlay.setBounds(bounds); } catch (e) { }
  }
}

module.exports = {
  openNewWindow,
  registerNewWindow,
  broadcastSettingsToNewWindows,
  broadcastBookmarksToNewWindows,
  broadcastDownloadsToNewWindows,
  isNewWindowChromeSender,
  isNewWindowOverlaySender,
  isNewWindowTabWebContents,
  registerNewWindowIpc,
};
