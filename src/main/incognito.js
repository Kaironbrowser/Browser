// ============================================================
//  INCOGNITO BROWSER — Kairon Browser
//  Incognito is NOT a separate mini-browser: it is the exact same
//  Kairon browser chrome (src/renderer/index.html + renderer.js +
//  ui.js + style.css) loaded with an `incognito` state. The window
//  reuses every piece of the normal chrome — tab strip, omnibox,
//  navigation controls, zoom controls, downloads button, menu
//  button, sidebar/topbar layout, window controls, animations and
//  theme system — and only differs by:
//    - a dedicated non-persistent (in-memory) session partition,
//    - no browsing history recording,
//    - an in-memory download list (files still save automatically),
//    - an "Incognito" badge in the chrome,
//    - kairon://incognito as the home/new-tab page,
//    - full cleanup of session data when the window closes.
//
//  Isolation model:
//    - The Incognito window uses a dedicated non-persistent
//      Electron session partition (in-memory only; nothing is
//      ever written to disk: cookies, localStorage, IndexedDB,
//      cache, etc. all live in RAM).
//    - No browsing history is recorded (the history service is
//      never called for Incognito tabs).
//    - Downloads keep the existing automatic behavior (files are
//      saved to the configured directory) but the in-window
//      download list is kept in-memory only.
//    - Closing the window clears the session storage/cache and
//      drops every reference, so the next Incognito window
//      starts with a completely fresh session.
//
//  Privacy boundary: Incognito only stops Kairon from retaining
//  normal local browsing data after the session closes. It does
//  NOT provide anonymity, IP hiding, or protection from
//  websites / ISPs / network administrators.
// ============================================================

const { BrowserWindow, BrowserView, session, ipcMain } = require('electron');
const path = require('path');

// The Incognito window loads the SAME chrome as the normal browser. The
// shared preload detects ?incognito=1 and prefixes every IPC channel with
// incognito-*, routing it to the Incognito browser below so the two windows
// never touch each other's state.
const CHROME_FILE = path.join(__dirname, '../renderer/index.html');
// The Incognito home/new-tab page (kept as the dedicated Incognito page).
const HOME_FILE = path.join(__dirname, '../renderer/incognito_mode.html');
// Internal pages shared with the normal browser. Settings runs with the plain
// preload (its IPC is global browser settings); the downloads page runs with
// ?incognito=1 so it talks to the in-memory Incognito download manager.
const SETTINGS_PAGE_FILE = path.join(__dirname, '../renderer/settings.html');
const DOWNLOADS_PAGE_FILE = path.join(__dirname, '../renderer/downloads.html');
// Floating overlay (omnibox suggestions + downloads panel), same renderer as
// the normal browser, loaded with ?incognito=1 so its IPC is prefixed too.
const OVERLAY_FILE = path.join(__dirname, '../renderer/overlay.html');
const ERROR_PAGE_FILE = path.join(__dirname, "../renderer/can't_be_reached.html");
const IP_NOT_FOUND_FILE = path.join(__dirname, '../renderer/ip_not_found.html');

// Non-persistent partition: no `persist:` prefix, so all session data is
// in-memory only and discarded when the window closes.
const INC_PARTITION = 'incognito';
const INC_HOME_URL = 'kairon://incognito';
const INC_SETTINGS_URL = 'kairon://settings';
const INC_DOWNLOADS_URL = 'kairon://downloads';
const MAX_URL_LENGTH = 2048;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const DNS_RESOLUTION_ERROR_CODES = new Set([-105, -137]);

let incognitoWindow = null;
let incognitoOverlay = null;
let incognitoTabs = new Map();
let incognitoActiveTabId = null;
let incognitoNextTabId = 1;
let incognitoSession = null;
let incognitoDownloadManager = null;
let incognitoBounds = null;
let chromeUiFocused = false;
let registered = false;

// Overlay (suggestions + downloads panel) state — mirrors the normal
// browser's overlay bookkeeping so the two share one code path.
let incActiveOverlaySuggestions = null;
let incActiveDownloadsPanel = null;
let incLastOverlayBounds = null;
let incLastSuggestionBounds = null;
let incLastPanelBounds = null;

// Shared browser services injected by main.js (avoids a circular require).
let services = {
  getCurrentThemeMode: () => 'dark',
  getThemeQuery: () => ({ theme: 'dark' }),
  featureStore: null,
  store: null,
  emitSettingsState: () => {},
  reconfigureAdblocker: () => Promise.resolve(),
  logError: () => {},
  getAppIcon: () => undefined,
};

function registerIncognitoBrowser(deps) {
  if (deps) services = { ...services, ...deps };
  if (!registered) {
    registered = true;
    registerIpc();
  }
}

// ── TRUST HELPERS (used by main.js's sender-trust model) ────

function isIncognitoChromeWebContents(wc) {
  return !!incognitoWindow && !incognitoWindow.isDestroyed() && incognitoWindow.webContents === wc;
}

function isIncognitoTabWebContents(wc) {
  if (!wc) return false;
  for (const tab of incognitoTabs.values()) {
    if (tab.view && tab.view.webContents === wc) return true;
  }
  return false;
}

function isIncognitoOverlayWebContents(wc) {
  return !!incognitoOverlay && !incognitoOverlay.isDestroyed() && incognitoOverlay.webContents === wc;
}

function getIncognitoWindow() {
  return incognitoWindow;
}

// ── WINDOW LIFECYCLE ─────────────────────────────────────────

function openIncognitoWindow() {
  if (incognitoWindow && !incognitoWindow.isDestroyed()) {
    try { incognitoWindow.focus(); } catch (e) { }
    return;
  }

  const themeMode = services.getCurrentThemeMode();

  // Fresh in-memory session for this Incognito session. clearStorageData /
  // clearCache are belt-and-suspenders: even though the partition is
  // non-persistent (never written to disk), this drops any in-memory residue
  // so a reopened Incognito window always starts clean.
  incognitoSession = session.fromPartition(INC_PARTITION, { cache: false });
  try { incognitoSession.clearStorageData().catch(() => { }); } catch (e) { }
  try { incognitoSession.clearCache().catch(() => { }); } catch (e) { }

  incognitoWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: themeMode === 'light' ? '#f0f0f0' : '#080810',
    icon: services.getAppIcon(),
    show: false,
    webPreferences: {
      partition: INC_PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });

  // Load the REAL Kairon chrome (?incognito=1 makes the shared preload prefix
  // its IPC channels so this window talks only to the Incognito browser). The
  // only visual difference is the Incognito badge, driven by body[data-incognito].
  incognitoWindow.loadFile(CHROME_FILE, { query: { theme: themeMode, incognito: '1' } });

  incognitoWindow.once('ready-to-show', () => {
    if (incognitoWindow && !incognitoWindow.isDestroyed()) {
      try {
        incognitoWindow.show();
        incognitoWindow.maximize();
      } catch (e) { }
    }
  });

  const onWindowGeometryChange = () => {
    applyIncognitoBounds();
    updateIncognitoOverlayBounds();
  };
  incognitoWindow.on('resize', onWindowGeometryChange);
  incognitoWindow.on('move', onWindowGeometryChange);
  incognitoWindow.on('closed', shutdownIncognitoWindow);

  // Minimal content-fullscreen support (video sites etc.): put the window in
  // fullscreen while the page uses the HTML Fullscreen API.
  incognitoWindow.on('enter-html-full-screen', () => {
    try { if (incognitoWindow && !incognitoWindow.isFullScreen()) incognitoWindow.setFullScreen(true); } catch (e) { }
  });
  incognitoWindow.on('leave-html-full-screen', () => {
    try { if (incognitoWindow && incognitoWindow.isFullScreen()) incognitoWindow.setFullScreen(false); } catch (e) { }
  });

  incognitoWindow.webContents.on('before-input-event', (event, input) => {
    handleChromeShortcut(event, input);
  });

  // Incognito downloads: same automatic behavior (files save to the
  // configured directory without any prompt), but the in-window download
  // list is kept in memory only — nothing is persisted to disk.
  try {
    incognitoDownloadManager = new (require('./downloads').DownloadManager)({
      store: { get: () => undefined, set: () => { } }, // in-memory stub — never persisted
      featureStore: services.featureStore,
      onStateChange: broadcastIncognitoDownloads,
    });
    incognitoDownloadManager.attach(incognitoSession);
  } catch (e) {
    services.logError('incognito-downloads-init', e);
  }

  incognitoBounds = null;
  createIncognitoOverlay();
  const firstTabId = createIncognitoTab();
  switchIncognitoTab(firstTabId);
}

function shutdownIncognitoWindow() {
  if (incognitoOverlay && !incognitoOverlay.isDestroyed()) {
    try { incognitoOverlay.destroy(); } catch (e) { }
  }
  incognitoOverlay = null;
  incActiveOverlaySuggestions = null;
  incActiveDownloadsPanel = null;
  incLastOverlayBounds = null;
  incLastSuggestionBounds = null;
  incLastPanelBounds = null;
  for (const tabId of Array.from(incognitoTabs.keys())) destroyIncognitoTab(tabId, false);
  incognitoTabs.clear();
  incognitoActiveTabId = null;
  incognitoBounds = null;
  if (incognitoSession) {
    try { incognitoSession.clearStorageData().catch(() => { }); } catch (e) { }
    try { incognitoSession.clearCache().catch(() => { }); } catch (e) { }
  }
  incognitoSession = null;
  incognitoDownloadManager = null;
  incognitoWindow = null;
}

// ── OVERLAY (omnibox suggestions + downloads panel) ─────────
// The same floating overlay architecture as the normal browser: a transparent,
// always-on-top child window rendering overlay.html, shared by the omnibox
// suggestions dropdown and the Downloads panel. Loaded with ?incognito=1 so its
// preload prefixes its IPC to the Incognito browser.

function createIncognitoOverlay() {
  if (!incognitoWindow || incognitoWindow.isDestroyed()) return;
  if (incognitoOverlay && !incognitoOverlay.isDestroyed()) return;
  incLastOverlayBounds = null;
  incLastSuggestionBounds = null;
  incLastPanelBounds = null;

  incognitoOverlay = new BrowserWindow({
    parent: incognitoWindow,
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
      partition: INC_PARTITION,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Pass the persisted theme (and the incognito flag for prefixed IPC) so the
  // overlay renders the theme before first paint; live changes arrive via the
  // incognito-settings-updated push from broadcastSettingsToIncognito.
  incognitoOverlay.loadFile(OVERLAY_FILE, { query: { theme: services.getCurrentThemeMode(), incognito: '1' } })
    .then(() => {
      if (incognitoOverlay && !incognitoOverlay.isDestroyed()) {
        incognitoOverlay.show();
        incognitoOverlay.setIgnoreMouseEvents(true, { forward: true });
        updateIncognitoOverlayBounds();
      }
    })
    .catch((err) => services.logError('incognito-overlay-load-failed', err));

  // When the user clicks a webpage (or any other surface) while the downloads
  // panel is open, the overlay loses focus — close the panel (idempotent).
  incognitoOverlay.on('blur', () => {
    if (incActiveDownloadsPanel) hideIncognitoDownloadsPanel();
  });
}

function updateIncognitoOverlayBounds() {
  if (!incognitoWindow || incognitoWindow.isDestroyed() || !incognitoOverlay || incognitoOverlay.isDestroyed()) return;
  if (incActiveOverlaySuggestions) {
    updateIncognitoSuggestionBounds(incActiveOverlaySuggestions);
    return;
  }
  if (incActiveDownloadsPanel) {
    updateIncognitoPanelBounds();
    return;
  }
  const bounds = incognitoWindow.getContentBounds();
  if (!incLastOverlayBounds ||
      bounds.x !== incLastOverlayBounds.x || bounds.y !== incLastOverlayBounds.y ||
      bounds.width !== incLastOverlayBounds.width || bounds.height !== incLastOverlayBounds.height) {
    incLastOverlayBounds = bounds;
    try { incognitoOverlay.setBounds(bounds); } catch (e) { }
  }
}

// Size the overlay to exactly the suggestion dropdown area (renderer CSS
// pixels, converted to screen bounds). Returns the rewritten payload so the
// overlay renderer positions the list at its own (0,0).
function updateIncognitoSuggestionBounds(payload) {
  if (!incognitoWindow || incognitoWindow.isDestroyed() || !incognitoOverlay || incognitoOverlay.isDestroyed()) return null;
  const { rect, items } = payload || {};
  if (!rect || !Array.isArray(items) || !items.length) return null;

  const incBounds = incognitoWindow.getContentBounds();
  const [currentW, currentH] = incognitoWindow.getContentSize();

  const clampedRectLeft = Math.min(Math.max(0, Math.round(rect.left)), Math.max(0, currentW - 20));
  const clampedRectWidth = Math.min(
    Math.max(1, Math.round(rect.width)),
    currentW - clampedRectLeft,
    Math.max(1, currentW - clampedRectLeft)
  );

  const left = Math.round(incBounds.x + clampedRectLeft);
  const top = Math.round(incBounds.y + rect.bottom);
  const width = Math.max(1, clampedRectWidth);
  const itemHeight = 44;
  const borderHeight = 1;
  const height = Math.max(1, Math.round(items.length * itemHeight + borderHeight));
  const maxWidth = Math.max(1, incBounds.x + incBounds.width - left);
  const maxHeight = Math.max(1, incBounds.y + incBounds.height - top);

  const bounds = {
    x: left,
    y: top,
    width: Math.min(width, maxWidth),
    height: Math.min(height, maxHeight),
  };

  if (!incLastSuggestionBounds ||
      bounds.x !== incLastSuggestionBounds.x || bounds.y !== incLastSuggestionBounds.y ||
      bounds.width !== incLastSuggestionBounds.width || bounds.height !== incLastSuggestionBounds.height) {
    incLastSuggestionBounds = bounds;
    try { incognitoOverlay.setBounds(bounds); } catch (e) { }
  }

  return {
    ...payload,
    rect: {
      top: 0,
      bottom: 0,
      left: 0,
      right: bounds.width,
      width: bounds.width,
      height: 0,
    },
  };
}

// Size the overlay to exactly the Downloads panel (anchored to the toolbar
// button rect reported by the chrome renderer).
function updateIncognitoPanelBounds() {
  if (!incognitoWindow || incognitoWindow.isDestroyed() || !incognitoOverlay || incognitoOverlay.isDestroyed()) return;
  if (!incActiveDownloadsPanel) return;
  const rect = incActiveDownloadsPanel.rect;
  if (!rect || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) return;

  const incBounds = incognitoWindow.getContentBounds();
  const [currentW, currentH] = incognitoWindow.getContentSize();
  const PAD = 8;

  // Right-align the panel with the button's right edge; clamp inside the window.
  const panelW = Math.min(376, Math.max(240, currentW - PAD * 2));
  let left = Math.round(incBounds.x + rect.right - panelW);
  left = Math.max(incBounds.x + PAD, Math.min(left, incBounds.x + currentW - panelW - PAD));
  const top = Math.round(incBounds.y + rect.bottom + 6);
  const maxH = Math.max(120, incBounds.y + incBounds.height - top - PAD);

  const count = incognitoDownloadManager ? incognitoDownloadManager.getDownloads().length : 0;
  const headerH = 46;
  const footerH = 46;
  const rowH = 60;
  const listH = count > 0 ? Math.min(count, 7) * rowH : 84;
  const panelH = Math.min(Math.round(headerH + listH + footerH + 2), Math.round(maxH), 480);

  const bounds = { x: left, y: top, width: Math.round(panelW), height: Math.round(panelH) };
  if (!incLastPanelBounds ||
      bounds.x !== incLastPanelBounds.x || bounds.y !== incLastPanelBounds.y ||
      bounds.width !== incLastPanelBounds.width || bounds.height !== incLastPanelBounds.height) {
    incLastPanelBounds = bounds;
    try { incognitoOverlay.setBounds(bounds); } catch (e) { }
  }
}

function hideIncognitoDownloadsPanel() {
  incActiveDownloadsPanel = null;
  incLastPanelBounds = null;
  if (!incognitoOverlay || incognitoOverlay.isDestroyed()) return;
  try { incognitoOverlay.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
  try { if (incognitoOverlay.setFocusable) incognitoOverlay.setFocusable(false); } catch (e) { }
  try { incognitoOverlay.webContents.send('incognito-downloads-panel-hide'); } catch (e) { }
  // Echo to the chrome so the toolbar button's open state stays in sync when
  // the panel is closed from the overlay side (Escape / webpage click).
  if (incognitoWindow && !incognitoWindow.isDestroyed()) {
    try { incognitoWindow.webContents.send('incognito-downloads-panel-hide'); } catch (e) { }
  }
  incLastOverlayBounds = null;
  updateIncognitoOverlayBounds();
}

// ── TABS ─────────────────────────────────────────────────────

function createIncognitoTab(initialTarget = null) {
  const id = incognitoNextTabId++;
  const view = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: INC_PARTITION,
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
    isInternalHome: false,
    _canGoBack: false,
    _canGoForward: false,
    _lastBounds: null,
    listeners: [],
  };
  incognitoTabs.set(id, tab);

  const wc = view.webContents;

  const onDidNavigate = (_, url) => {
    // Internal Kairon pages keep their kairon:// URL in the address bar (the
    // file URL underneath is never shown), matching the normal browser.
    tab.url = tab.isInternalHome ? (tab.url || INC_HOME_URL) : (url || tab.url);
    if (incognitoActiveTabId === id) sendIncognitoActiveSignals();
    emitIncognitoTabsState();
  };
  const onDidNavigateInPage = (_, url) => {
    tab.url = tab.isInternalHome ? (tab.url || INC_HOME_URL) : (url || tab.url);
    if (incognitoActiveTabId === id) sendIncognitoActiveSignals();
    emitIncognitoTabsState();
  };
  const onPageTitleUpdated = (_, title) => {
    tab.title = title || 'Untitled';
    if (incognitoActiveTabId === id) sendIncognitoActiveSignals();
    emitIncognitoTabsState();
  };
  const onDidStartLoading = () => {
    tab.loading = true;
    if (incognitoActiveTabId === id) sendIncognitoActiveSignals();
    emitIncognitoTabsState();
  };
  const onDidStopLoading = () => {
    tab.loading = false;
    if (incognitoActiveTabId === id) sendIncognitoActiveSignals();
    emitIncognitoTabsState();
  };
  const onDidFailLoad = (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    if (errorCode === -3) return; // aborted
    const query = { theme: services.getCurrentThemeMode(), url: validatedURL, error: String(errorCode), desc: errorDescription };
    const errorFile = DNS_RESOLUTION_ERROR_CODES.has(errorCode) ? IP_NOT_FOUND_FILE : ERROR_PAGE_FILE;
    try {
      tab.view.webContents.loadFile(errorFile, { query }).catch((err) => services.logError(`incognito-tab-${id}-error-page`, err));
    } catch (e) { }
  };
  const onWillNavigate = (event, url) => {
    try {
      const parsed = new URL(url);
      const allowed = ALLOWED_PROTOCOLS.has(parsed.protocol) || parsed.protocol === 'about:';
      if (!allowed) {
        event.preventDefault();
        return;
      }
    } catch (e) {
      event.preventDefault();
      return;
    }
    // A real navigation out of an internal page drops the internal-home flag
    // so did-navigate records the actual URL (mirrors the normal browser).
    tab.isInternalHome = false;
  };
  const onBeforeInputEvent = (event, input) => {
    if (input.type !== 'keyDown') return;
    const isMod = process.platform === 'darwin' ? input.meta : input.control;
    if (input.key === 'F11' || input.code === 'F11') {
      if (input.isAutoRepeat) return;
      event.preventDefault();
      try { incognitoWindow.setFullScreen(!incognitoWindow.isFullScreen()); } catch (e) { }
      return;
    }
    if (!isMod) return;
    if ((input.key === 'Tab' || input.code === 'Tab') && !input.alt) {
      event.preventDefault();
      cycleIncognitoTab(input.shift ? -1 : 1);
      return;
    }
    if ((input.key === 't' || input.key === 'T' || input.code === 'KeyT') && !input.alt) {
      event.preventDefault();
      const newId = createIncognitoTab();
      switchIncognitoTab(newId);
      return;
    }
    if ((input.key === 'n' || input.key === 'N' || input.code === 'KeyN') && input.shift && !input.alt) {
      event.preventDefault();
      openIncognitoWindow();
      return;
    }
    if ((input.key === 'w' || input.key === 'W' || input.code === 'KeyW') && !input.alt && !input.shift) {
      event.preventDefault();
      closeIncognitoTab(incognitoActiveTabId);
      return;
    }
    if (input.key === '=' || input.key === '+' || input.code === 'Equal' || input.code === 'NumpadAdd') {
      event.preventDefault();
      setIncognitoTabZoom(tab, (tab.zoomFactor || 1.0) + 0.1);
      return;
    }
    if (input.key === '-' || input.key === '_' || input.code === 'Minus' || input.code === 'NumpadSubtract') {
      event.preventDefault();
      setIncognitoTabZoom(tab, (tab.zoomFactor || 1.0) - 0.1);
      return;
    }
    if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') {
      event.preventDefault();
      setIncognitoTabZoom(tab, 1.0);
      return;
    }
  };

  wc.setWindowOpenHandler(({ url }) => {
    const target = normalizeTarget(url);
    if (!target) return { action: 'deny' };
    const newId = createIncognitoTab(target);
    switchIncognitoTab(newId);
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

  // Initial content: the Incognito home/new-tab page, or the given URL.
  if (initialTarget === null || initialTarget === INC_HOME_URL || initialTarget === 'kairon://home') {
    tab.isInternalHome = true;
    tab.url = INC_HOME_URL;
    tab.title = 'New Tab';
    try {
      tab.view.webContents.loadFile(HOME_FILE, { query: { theme: services.getCurrentThemeMode() } })
        .catch((err) => services.logError(`incognito-tab-${id}-home-load`, err));
    } catch (e) { }
  } else if (initialTarget === INC_SETTINGS_URL || initialTarget.startsWith(INC_SETTINGS_URL + '/') || initialTarget === INC_DOWNLOADS_URL) {
    navigateIncognitoTab(tab, initialTarget);
  } else {
    try { tab.view.webContents.loadURL(initialTarget).catch((err) => services.logError(`incognito-tab-${id}-load`, err)); } catch (e) { }
  }

  return id;
}

function destroyIncognitoTab(tabId) {
  const tab = incognitoTabs.get(tabId);
  if (!tab) return false;
  if (incognitoWindow && !incognitoWindow.isDestroyed() && incognitoWindow.getBrowserView() === tab.view) {
    try { incognitoWindow.setBrowserView(null); } catch (e) { }
  }
  for (const [eventName, listener] of tab.listeners) {
    try { tab.view.webContents.removeListener(eventName, listener); } catch (e) { }
  }
  try { tab.view.webContents.close({ waitForBeforeUnload: false }); } catch (e) { }
  try { tab.view.webContents.destroy(); } catch (e) { }
  incognitoTabs.delete(tabId);
  return true;
}

function switchIncognitoTab(tabId) {
  if (!incognitoWindow || incognitoWindow.isDestroyed()) return false;
  const tab = incognitoTabs.get(tabId);
  if (!tab) return false;
  if (tabId === incognitoActiveTabId && incognitoWindow.getBrowserView() === tab.view) return true;

  incognitoActiveTabId = tabId;
  try { incognitoWindow.setBrowserView(tab.view); } catch (e) { return false; }
  try { tab.view.webContents.setZoomFactor(tab.zoomFactor || 1.0); } catch (e) { }
  tab._lastBounds = null;
  applyIncognitoBounds();
  try { tab.view.webContents.focus(); } catch (e) { }
  sendIncognitoActiveSignals();
  emitIncognitoTabsState();
  return true;
}

function cycleIncognitoTab(direction) {
  const order = Array.from(incognitoTabs.keys());
  if (order.length < 2) return false;
  let index = order.indexOf(incognitoActiveTabId);
  if (index === -1) index = direction > 0 ? -1 : 0;
  const targetIndex = (index + direction + order.length) % order.length;
  return switchIncognitoTab(order[targetIndex]);
}

function closeIncognitoTab(tabId) {
  if (!Number.isInteger(tabId) || !incognitoTabs.has(tabId)) return;
  const ids = Array.from(incognitoTabs.keys());
  const closedIndex = ids.indexOf(tabId);
  const wasActive = incognitoActiveTabId === tabId;
  destroyIncognitoTab(tabId);
  if (incognitoTabs.size === 0) {
    const newId = createIncognitoTab();
    switchIncognitoTab(newId);
    return;
  }
  if (wasActive) {
    const remaining = Array.from(incognitoTabs.keys());
    switchIncognitoTab(remaining[Math.min(closedIndex, remaining.length - 1)]);
    return;
  }
  emitIncognitoTabsState();
}

function duplicateIncognitoTab(tabId) {
  const tab = incognitoTabs.get(tabId);
  if (!tab) return;
  const url = (tab.url && tab.url !== INC_HOME_URL && tab.url !== 'about:blank') ? tab.url : null;
  const newId = createIncognitoTab(url);
  switchIncognitoTab(newId);
}

function closeOtherIncognitoTabs(tabId) {
  const ids = Array.from(incognitoTabs.keys());
  for (const id of ids) {
    if (id === tabId) continue;
    destroyIncognitoTab(id);
  }
  if (incognitoActiveTabId === tabId || !incognitoTabs.has(incognitoActiveTabId)) {
    switchIncognitoTab(tabId);
  } else {
    emitIncognitoTabsState();
  }
}

function closeIncognitoTabsToTheRight(tabId) {
  const ids = Array.from(incognitoTabs.keys());
  const sourceIndex = ids.indexOf(tabId);
  if (sourceIndex === -1) return;
  for (let i = sourceIndex + 1; i < ids.length; i++) {
    destroyIncognitoTab(ids[i]);
  }
  if (incognitoTabs.has(incognitoActiveTabId)) {
    emitIncognitoTabsState();
  } else {
    switchIncognitoTab(tabId);
  }
}

// Drag-and-drop reorder from the chrome (single source of truth = this Map,
// which preserves insertion order). Mirrors the normal browser's reorderTab.
function reorderIncognitoTab(sourceId, targetIndex) {
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetIndex)) return;
  const keys = Array.from(incognitoTabs.keys());
  const sourceIndex = keys.indexOf(sourceId);
  if (sourceIndex === -1) return;
  const clamped = Math.max(0, Math.min(targetIndex, keys.length - 1));
  if (clamped === sourceIndex) return;
  const entries = Array.from(incognitoTabs.entries());
  const [entry] = entries.splice(sourceIndex, 1);
  entries.splice(clamped, 0, entry);
  incognitoTabs = new Map(entries);
  emitIncognitoTabsState();
}

function setIncognitoTabZoom(tab, factor) {
  const clamped = Math.min(3.0, Math.max(0.25, factor));
  tab.zoomFactor = clamped;
  try { tab.view.webContents.setZoomFactor(clamped); } catch (e) { }
  emitIncognitoTabsState();
}

// ── NAVIGATION ───────────────────────────────────────────────

function navigateIncognitoTab(tab, target) {
  if (target === INC_HOME_URL) {
    tab.isInternalHome = true;
    tab.url = INC_HOME_URL;
    tab.title = 'New Tab';
    try {
      tab.view.webContents.loadFile(HOME_FILE, { query: { theme: services.getCurrentThemeMode() } })
        .catch((err) => services.logError(`incognito-tab-${tab.id}-home-nav`, err));
    } catch (e) { }
    if (incognitoActiveTabId === tab.id) sendIncognitoActiveSignals();
    emitIncognitoTabsState();
    return;
  }
  if (target === INC_SETTINGS_URL || target.startsWith(INC_SETTINGS_URL + '/')) {
    // Settings is a shared, browser-global page — loaded locally, never remote
    // content. It runs with the plain preload (no ?incognito=1), so its IPC is
    // the shared read-only/global settings API (same as the normal browser).
    tab.isInternalHome = true;
    tab.url = target;
    tab.title = 'Settings';
    const query = { theme: services.getCurrentThemeMode() };
    const section = target === INC_SETTINGS_URL ? null : target.slice(INC_SETTINGS_URL.length + 1);
    if (section) query.section = section;
    try {
      tab.view.webContents.loadFile(SETTINGS_PAGE_FILE, { query }).catch((err) => services.logError(`incognito-tab-${tab.id}-settings-nav`, err));
    } catch (e) { }
    if (incognitoActiveTabId === tab.id) sendIncognitoActiveSignals();
    emitIncognitoTabsState();
    return;
  }
  if (target === INC_DOWNLOADS_URL) {
    // Downloads page — loaded locally. ?incognito=1 keeps this tab's IPC
    // prefixed so it talks only to the in-memory Incognito download manager
    // (never the normal browser's download list).
    tab.isInternalHome = true;
    tab.url = INC_DOWNLOADS_URL;
    tab.title = 'Downloads';
    try {
      tab.view.webContents.loadFile(DOWNLOADS_PAGE_FILE, { query: { theme: services.getCurrentThemeMode(), incognito: '1' } })
        .catch((err) => services.logError(`incognito-tab-${tab.id}-downloads-nav`, err));
    } catch (e) { }
    if (incognitoActiveTabId === tab.id) sendIncognitoActiveSignals();
    emitIncognitoTabsState();
    return;
  }
  const normalized = normalizeTarget(target);
  if (normalized === INC_HOME_URL) {
    navigateIncognitoTab(tab, INC_HOME_URL);
    return;
  }
  if (!normalized) {
    try {
      if (incognitoWindow && !incognitoWindow.isDestroyed()) incognitoWindow.webContents.send('incognito-navigation-invalid');
    } catch (e) { }
    return;
  }
  tab.isInternalHome = false;
  try {
    tab.view.webContents.loadURL(normalized).catch((err) => services.logError(`incognito-tab-${tab.id}-nav`, err));
  } catch (e) { }
}

function normalizeTarget(input) {
  if (typeof input !== 'string' || input.length > MAX_URL_LENGTH) return null;
  const s = input.trim();
  // Empty address bar → the Incognito home page (same as the normal browser).
  if (!s) return INC_HOME_URL;
  const lower = s.toLowerCase();
  if (lower === INC_HOME_URL || lower === 'kairon://home' || lower === 'home') return INC_HOME_URL;
  // No browsing history exists in Incognito — the History entry point falls
  // back to the Incognito home page rather than leaking normal history.
  if (lower === 'kairon://history' || lower === 'kairon://history/') return INC_HOME_URL;
  if (lower === INC_SETTINGS_URL || lower === 'kairon://settings/' || /^kairon:\/\/settings\/[a-z0-9-]+$/.test(lower)) {
    return /^kairon:\/\/settings\/[a-z0-9-]+$/.test(lower) ? `kairon://settings/${lower.split('/').pop()}` : INC_SETTINGS_URL;
  }
  if (lower === INC_DOWNLOADS_URL || lower === 'kairon://downloads/') return INC_DOWNLOADS_URL;
  if (/^kairon:\/\/incognito\/?$/i.test(s)) return INC_HOME_URL;
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

function applyIncognitoBounds() {
  if (!incognitoWindow || incognitoWindow.isDestroyed() || !incognitoBounds) return;
  const tab = incognitoTabs.get(incognitoActiveTabId);
  if (!tab || !tab.view) return;
  const [currentW, currentH] = incognitoWindow.getContentSize();
  const x = Math.max(0, Math.min(Math.round(incognitoBounds.x), Math.max(0, currentW - 100)));
  const y = Math.max(0, Math.min(Math.round(incognitoBounds.y), Math.max(0, currentH - 100)));
  const width = Math.min(Math.round(incognitoBounds.width), currentW, Math.max(100, currentW - x));
  const height = Math.min(Math.round(incognitoBounds.height), currentH, Math.max(100, currentH - y));
  const bounds = { x, y, width: Math.max(1, width), height: Math.max(1, height) };
  const prev = tab._lastBounds;
  if (!prev || prev.x !== bounds.x || prev.y !== bounds.y || prev.width !== bounds.width || prev.height !== bounds.height) {
    tab._lastBounds = bounds;
    try { tab.view.setBounds(bounds); } catch (e) { }
  }
}

// ── STATE BROADCAST ──────────────────────────────────────────

function getIncognitoTabPublicState(tab) {
  let canGoBack = !!tab._canGoBack;
  let canGoForward = !!tab._canGoForward;
  if (tab.id === incognitoActiveTabId) {
    try {
      canGoBack = tab.view.webContents.navigationHistory.canGoBack();
      canGoForward = tab.view.webContents.navigationHistory.canGoForward();
      tab._canGoBack = canGoBack;
      tab._canGoForward = canGoForward;
    } catch (e) { }
  }
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

function emitIncognitoTabsState() {
  if (!incognitoWindow || incognitoWindow.isDestroyed()) return;
  try {
    incognitoWindow.webContents.send('incognito-tabs-state', {
      activeTabId: incognitoActiveTabId,
      tabs: Array.from(incognitoTabs.values()).map(getIncognitoTabPublicState),
    });
  } catch (e) { }
}

function sendIncognitoActiveSignals() {
  const tab = incognitoTabs.get(incognitoActiveTabId);
  if (!tab || !incognitoWindow || incognitoWindow.isDestroyed()) return;
  try {
    incognitoWindow.webContents.send('incognito-url-changed', tab.url || '');
    incognitoWindow.webContents.send('incognito-title-changed', tab.title || 'New Tab');
    incognitoWindow.webContents.send('incognito-loading', !!tab.loading);
  } catch (e) { }
}

function broadcastIncognitoDownloads() {
  if (!incognitoWindow || incognitoWindow.isDestroyed() || !incognitoDownloadManager) return;
  try {
    const snapshot = incognitoDownloadManager.getDownloads();
    // Chrome toolbar badge + floating panel (overlay).
    incognitoWindow.webContents.send('incognito-downloads-updated', snapshot);
    if (incognitoOverlay && !incognitoOverlay.isDestroyed()) {
      incognitoOverlay.webContents.send('incognito-downloads-updated', snapshot);
    }
    // The internal downloads page loaded in an Incognito tab (prefixed IPC).
    for (const tab of incognitoTabs.values()) {
      try {
        const wc = tab.view && tab.view.webContents;
        if (!wc || wc.isDestroyed()) continue;
        if (isIncognitoDownloadsPageUrl(wc.getURL())) wc.send('incognito-downloads-updated', snapshot);
      } catch (e) { }
    }
  } catch (e) { }
}

// Pushed by main.js's emitSettingsState so the Incognito chrome, its overlay,
// and any Incognito tab showing an internal page follow the global theme live.
function broadcastSettingsToIncognito(snapshot, senderId) {
  if (incognitoWindow && !incognitoWindow.isDestroyed() && incognitoWindow.webContents.id !== senderId) {
    try { incognitoWindow.webContents.send('incognito-settings-updated', snapshot); } catch (e) { }
  }
  if (incognitoOverlay && !incognitoOverlay.isDestroyed() && incognitoOverlay.webContents.id !== senderId) {
    try { incognitoOverlay.webContents.send('incognito-settings-updated', snapshot); } catch (e) { }
  }
  // Incognito tabs showing a Kairon-owned internal page. The home page, error
  // pages and the settings page run with the plain preload (shared read-only
  // IPC) and consume the unprefixed settings-updated push; the downloads page
  // runs with ?incognito=1 and consumes the prefixed push.
  const unprefixedMarkers = ['incognito_mode.html', "can't_be_reached.html", 'ip_not_found.html', 'settings.html'];
  for (const tab of incognitoTabs.values()) {
    try {
      const wc = tab.view && tab.view.webContents;
      if (!wc || wc.isDestroyed() || wc.id === senderId) continue;
      const url = wc.getURL();
      if (!url.startsWith('file:')) continue;
      if (isIncognitoDownloadsPageUrl(url)) {
        wc.send('incognito-settings-updated', snapshot);
      } else if (unprefixedMarkers.some((m) => url.includes(m))) {
        wc.send('settings-updated', snapshot);
      }
    } catch (e) { }
  }
}

// ── SHORTCUTS (chrome) ───────────────────────────────────────

function handleChromeShortcut(event, input) {
  if (input.type !== 'keyDown') return;
  const isMod = process.platform === 'darwin' ? input.meta : input.control;
  if (input.key === 'F11' || input.code === 'F11') {
    if (input.isAutoRepeat) return;
    event.preventDefault();
    try { incognitoWindow.setFullScreen(!incognitoWindow.isFullScreen()); } catch (e) { }
    return;
  }
  if (!isMod) return;
  if ((input.key === 'Tab' || input.code === 'Tab') && !input.alt) {
    event.preventDefault();
    cycleIncognitoTab(input.shift ? -1 : 1);
    return;
  }
  if ((input.key === 't' || input.key === 'T' || input.code === 'KeyT') && !input.alt) {
    event.preventDefault();
    const newId = createIncognitoTab();
    switchIncognitoTab(newId);
    return;
  }
  if ((input.key === 'n' || input.key === 'N' || input.code === 'KeyN') && input.shift && !input.alt) {
    event.preventDefault();
    openIncognitoWindow();
    return;
  }
  if ((input.key === 'w' || input.key === 'W' || input.code === 'KeyW') && !input.alt && !input.shift) {
    event.preventDefault();
    closeIncognitoTab(incognitoActiveTabId);
  }
}

// ── IPC ──────────────────────────────────────────────────────

function isIncognitoChromeSender(event) {
  return !!event && !!event.sender && isIncognitoChromeWebContents(event.sender);
}

function isIncognitoOverlaySender(event) {
  return !!event && !!event.sender && isIncognitoOverlayWebContents(event.sender);
}

function isIncognitoTabSender(event) {
  return !!event && !!event.sender && isIncognitoTabWebContents(event.sender);
}

// Trusted sender for the prefixed downloads-data API: the chrome (toolbar /
// settings), the overlay (floating panel), and an Incognito tab currently
// showing the internal downloads page (which runs with ?incognito=1).
// True when the given webContents URL is the internal downloads page loaded in
// an Incognito tab. The file: prefix guarantees only Kairon-owned internal
// pages can match (normal websites are never file: URLs); the filename marker
// matches the same URL-trust style used for the other internal pages.
function isIncognitoDownloadsPageUrl(url) {
  try {
    return typeof url === 'string' && url.startsWith('file:') && url.includes('downloads.html');
  } catch (e) {
    return false;
  }
}

function isIncognitoDownloadsDataSender(event) {
  if (isIncognitoChromeSender(event) || isIncognitoOverlaySender(event)) return true;
  if (!isIncognitoTabSender(event)) return false;
  try {
    return isIncognitoDownloadsPageUrl(event.sender.getURL());
  } catch (e) {
    return false;
  }
}

function notifySettingsChanged(senderId) {
  try {
    if (typeof services.emitSettingsState === 'function') services.emitSettingsState(senderId);
  } catch (e) { }
}

function registerIpc() {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!isIncognitoChromeSender(event)) throw new Error('Unauthorized IPC sender');
    return fn(event, ...args);
  });
  const onChannel = (channel, fn) => ipcMain.on(channel, (event, ...args) => {
    if (!isIncognitoChromeSender(event)) return;
    fn(event, ...args);
  });
  // Channels the floating overlay (omnibox suggestions + downloads panel) can
  // also trigger — the overlay is our own trusted renderer, same as the normal
  // browser's overlay. e.g. picking a suggestion, or the panel's "Show more" /
  // "Open folder" / Escape actions.
  const onTrustedChannel = (channel, fn) => ipcMain.on(channel, (event, ...args) => {
    if (!isIncognitoChromeSender(event) && !isIncognitoOverlaySender(event)) return;
    fn(event, ...args);
  });

  onTrustedChannel('incognito-navigate', (event, url) => {
    const tab = incognitoTabs.get(incognitoActiveTabId);
    if (tab) navigateIncognitoTab(tab, url);
  });
  onChannel('incognito-go-back', () => {
    const tab = incognitoTabs.get(incognitoActiveTabId);
    if (tab) { try { tab.view.webContents.navigationHistory.goBack(); } catch (e) { } }
  });
  onChannel('incognito-go-forward', () => {
    const tab = incognitoTabs.get(incognitoActiveTabId);
    if (tab) { try { tab.view.webContents.navigationHistory.goForward(); } catch (e) { } }
  });
  onChannel('incognito-reload', () => {
    const tab = incognitoTabs.get(incognitoActiveTabId);
    if (tab) { try { tab.view.webContents.reload(); } catch (e) { } }
  });
  onChannel('incognito-stop-loading', () => {
    const tab = incognitoTabs.get(incognitoActiveTabId);
    if (tab) { try { tab.view.webContents.stop(); } catch (e) { } }
  });
  onChannel('incognito-tab-create', (event, url) => {
    const newId = createIncognitoTab(url);
    switchIncognitoTab(newId);
  });
  onChannel('incognito-tab-switch', (event, tabId) => {
    if (Number.isInteger(tabId)) switchIncognitoTab(tabId);
  });
  onChannel('incognito-tab-close', (event, tabId) => {
    if (Number.isInteger(tabId)) closeIncognitoTab(tabId);
  });
  onChannel('incognito-tab-reorder', (event, payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { sourceId, targetIndex } = payload;
    if (!Number.isInteger(sourceId) || !Number.isInteger(targetIndex)) return;
    if (!incognitoTabs.has(sourceId)) return;
    reorderIncognitoTab(sourceId, targetIndex);
  });
  onChannel('incognito-zoom-in', () => {
    const tab = incognitoTabs.get(incognitoActiveTabId);
    if (tab) setIncognitoTabZoom(tab, (tab.zoomFactor || 1.0) + 0.1);
  });
  onChannel('incognito-zoom-out', () => {
    const tab = incognitoTabs.get(incognitoActiveTabId);
    if (tab) setIncognitoTabZoom(tab, (tab.zoomFactor || 1.0) - 0.1);
  });
  onChannel('incognito-zoom-reset', () => {
    const tab = incognitoTabs.get(incognitoActiveTabId);
    if (tab) setIncognitoTabZoom(tab, 1.0);
  });
  onChannel('incognito-layout-metrics', (event, metrics) => {
    if (metrics && typeof metrics === 'object') {
      const x = Math.round(Number(metrics.x));
      const y = Math.round(Number(metrics.y));
      const width = Math.round(Number(metrics.width));
      const height = Math.round(Number(metrics.height));
      if ([x, y, width, height].every(Number.isFinite)) {
        incognitoBounds = { x: Math.max(0, x), y: Math.max(0, y), width: Math.max(1, width), height: Math.max(1, height) };
        applyIncognitoBounds();
      }
    }
  });
  onChannel('incognito-chrome-ui-focus', (event, focused) => {
    chromeUiFocused = focused === true;
  });
  onChannel('incognito-window-minimize', () => { try { incognitoWindow.minimize(); } catch (e) { } });
  onChannel('incognito-window-maximize', () => {
    try {
      if (incognitoWindow.isMaximized()) incognitoWindow.unmaximize();
      else incognitoWindow.maximize();
    } catch (e) { }
  });
  onChannel('incognito-window-close', () => { try { incognitoWindow.close(); } catch (e) { } });
  onTrustedChannel('incognito-open-downloads-folder', async () => {
    try {
      if (incognitoDownloadManager) await incognitoDownloadManager.openDownloadsFolder();
    } catch (e) { }
  });

  // ── TAB CONTEXT MENU (shared native menu, Incognito actions) ──
  onChannel('incognito-tab-context-menu', (event, tabId) => {
    if (!Number.isInteger(tabId) || !incognitoTabs.has(tabId)) return;
    const { setupTabContextMenu } = require('./tab-context-menu');
    setupTabContextMenu(tabId, {
      onNewTab: () => {
        const newId = createIncognitoTab();
        switchIncognitoTab(newId);
      },
      onReloadTab: (clickedTabId) => {
        const tab = incognitoTabs.get(clickedTabId);
        if (tab && tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
          try { tab.view.webContents.reload(); } catch (e) { }
        }
      },
      onDuplicateTab: (clickedTabId) => duplicateIncognitoTab(clickedTabId),
      onCloseTab: (clickedTabId) => closeIncognitoTab(clickedTabId),
      onCloseOtherTabs: (clickedTabId) => closeOtherIncognitoTabs(clickedTabId),
      onCloseTabsToTheRight: (clickedTabId) => closeIncognitoTabsToTheRight(clickedTabId),
      hasClosedTabs: false,
    }, { isPinned: false, hasClosedTabs: false, isSleeping: false });
  });

  // ── OVERLAY (suggestions) ───────────────────────────────────
  onChannel('incognito-show-overlay-suggestions', (event, payload) => {
    if (!incognitoOverlay || incognitoOverlay.isDestroyed()) return;
    const { rect, items } = payload || {};
    let overlayPayload = payload;
    if (rect && items) {
      incActiveOverlaySuggestions = payload;
      overlayPayload = updateIncognitoSuggestionBounds(payload) || payload;
      try { incognitoOverlay.setIgnoreMouseEvents(false); } catch (e) { }
    }
    incognitoOverlay.webContents.send('incognito-overlay-suggestions', overlayPayload);
  });

  onChannel('incognito-hide-overlay-suggestions', () => {
    if (!incognitoOverlay || incognitoOverlay.isDestroyed()) return;
    incActiveOverlaySuggestions = null;
    try { incognitoOverlay.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
    incognitoOverlay.webContents.send('incognito-overlay-hide');
    incLastOverlayBounds = null;
    incLastSuggestionBounds = null;
    updateIncognitoOverlayBounds();
  });

  // A suggestion was picked in the overlay — navigate the active tab.
  onTrustedChannel('incognito-navigate-to-suggestion', (event, url) => {
    const tab = incognitoTabs.get(incognitoActiveTabId);
    if (!tab) return;
    const target = normalizeTarget(url);
    if (!target) {
      try {
        if (incognitoWindow && !incognitoWindow.isDestroyed()) incognitoWindow.webContents.send('incognito-navigation-invalid');
      } catch (e) { }
      return;
    }
    if (incognitoOverlay && !incognitoOverlay.isDestroyed()) {
      incActiveOverlaySuggestions = null;
      try { incognitoOverlay.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
      incognitoOverlay.webContents.send('incognito-overlay-hide');
      incLastOverlayBounds = null;
      incLastSuggestionBounds = null;
      updateIncognitoOverlayBounds();
    }
    navigateIncognitoTab(tab, target);
  });

  // ── OVERLAY (downloads panel) ───────────────────────────────
  onChannel('incognito-show-downloads-panel', (event, payload) => {
    if (!incognitoOverlay || incognitoOverlay.isDestroyed()) return;
    const rect = payload && payload.rect && typeof payload.rect === 'object' ? payload.rect : null;
    if (!rect || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) return;

    // The panel and the omnibox suggestions share the overlay — never both.
    incActiveOverlaySuggestions = null;
    incLastSuggestionBounds = null;
    try { incognitoOverlay.webContents.send('incognito-overlay-hide'); } catch (e) { }

    incActiveDownloadsPanel = { rect, at: Date.now() };
    try { incognitoOverlay.setIgnoreMouseEvents(false); } catch (e) { }
    try { if (incognitoOverlay.setFocusable) incognitoOverlay.setFocusable(true); } catch (e) { }
    try { incognitoOverlay.webContents.send('incognito-downloads-panel-show', { rect }); } catch (e) { }
    // Echo to the chrome so the toolbar button's open state stays in sync.
    try { incognitoWindow.webContents.send('incognito-downloads-panel-show', { rect }); } catch (e) { }
    updateIncognitoPanelBounds();
    try { incognitoOverlay.focus(); } catch (e) { }
  });

  onTrustedChannel('incognito-hide-downloads-panel', () => {
    hideIncognitoDownloadsPanel();
  });

  // ── INVOKE: shared store (AI API key etc.) ──────────────────
  handle('incognito-store-get', (event, key) => {
    if (typeof key !== 'string' || !key || key.length > 256) throw new Error('Invalid store key');
    return services.store ? services.store.get(key) : undefined;
  });
  handle('incognito-store-set', (event, key, value) => {
    if (typeof key !== 'string' || !key || key.length > 256) throw new Error('Invalid store key');
    if (services.store) services.store.set(key, value);
    return true;
  });

  // ── INVOKE: browser-global settings (shields, tab position) ──
  // The Incognito chrome shares the same settings FeatureStore (theme, shields,
  // tab position are browser-wide), so changes made here behave exactly like
  // changes made from the normal browser and reach every window.
  handle('incognito-settings-set-feature-enabled', (event, featureId, enabled) => {
    if (typeof featureId !== 'string' || featureId.length > 128 || typeof enabled !== 'boolean') {
      throw new Error('Invalid settings payload');
    }
    if (!services.featureStore) return false;
    const ok = services.featureStore.setFeatureEnabled(featureId, enabled);
    if (!ok) throw new Error('Unknown feature');
    notifySettingsChanged(event.sender.id);
    // Reconfigure the shared adblocker when shields change from the Incognito
    // chrome — the network blocker is browser-global, same as the normal UI.
    setImmediate(() => { try { services.reconfigureAdblocker().catch(() => { }); } catch (e) { } });
    return true;
  });
  handle('incognito-settings-update-feature-config', (event, featureId, patch) => {
    if (typeof featureId !== 'string' || featureId.length > 128 || !patch || typeof patch !== 'object') {
      throw new Error('Invalid settings payload');
    }
    if (!services.featureStore) return false;
    const ok = services.featureStore.updateFeatureConfig(featureId, patch);
    if (!ok) throw new Error('Unknown feature');
    notifySettingsChanged(event.sender.id);
    setImmediate(() => { try { services.reconfigureAdblocker().catch(() => { }); } catch (e) { } });
    return true;
  });

  // ── INVOKE: settings snapshot / error logging (chrome) ──────
  handle('incognito-settings-state', () => {
    return services.featureStore ? services.featureStore.getPublicSnapshot() : { registry: [], state: {} };
  });
  handle('incognito-log-error', (event, payload) => {
    if (!payload || typeof payload.source !== 'string' || typeof payload.message !== 'string') return true;
    services.logError(`renderer-${payload.source}`, payload.message);
    return true;
  });

  // ── INVOKE: autocomplete (Incognito never queries or persists history) ──
  handle('incognito-history-autocomplete', () => {
    return [];
  });

  // ── INVOKE: downloads data (overlay panel + internal downloads page) ──
  // All reads go through the in-memory Incognito DownloadManager — the normal
  // browser's download list is never exposed here.
  const dlHandle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => {
    if (!isIncognitoDownloadsDataSender(event)) throw new Error('Unauthorized IPC sender');
    if (!incognitoDownloadManager) return null;
    return fn(incognitoDownloadManager, ...args);
  });

  dlHandle('incognito-downloads-get', (dm) => dm.getDownloads());
  dlHandle('incognito-downloads-clear', (dm) => dm.clearCompleted());
  dlHandle('incognito-downloads-pause', (dm, id) => dm.pause(id));
  dlHandle('incognito-downloads-resume', (dm, id) => dm.resume(id));
  dlHandle('incognito-downloads-cancel', (dm, id) => dm.cancel(id));
  dlHandle('incognito-downloads-open', (dm, id) => dm.openFile(id));
  dlHandle('incognito-downloads-show-in-folder', (dm, id) => dm.showInFolder(id));
}

module.exports = {
  openIncognitoWindow,
  registerIncognitoBrowser,
  broadcastSettingsToIncognito,
  isIncognitoChromeWebContents,
  isIncognitoTabWebContents,
  getIncognitoWindow,
};
