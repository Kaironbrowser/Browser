const { contextBridge, ipcRenderer } = require('electron');

// ── INCOGNITO CHROME DETECTION ────────────────────────────────
// The Incognito window reuses this same preload but talks to a dedicated set
// of incognito-* IPC channels owned by the Incognito browser (src/main/
// incognito.js), so its chrome and tabs never touch the normal browser's
// state. Detection is by query flag: the Incognito window loads its chrome
// via loadFile(..., { query: { incognito: '1' } }). Incognito TAB views load
// websites/internal pages WITHOUT that flag, so they keep the normal (non-
// prefixed) API — those handlers are read-only/global and shared.
const IS_INCOGNITO_CHROME = (() => {
  try {
    return /[?&]incognito=1(&|$)/.test(location.search);
  } catch (e) {
    return false;
  }
})();

// ── NEW WINDOW CHROME DETECTION ──────────────────────────────
// Additional normal windows (Ctrl+N) reuse this same preload but talk to
// dedicated nw-* IPC channels owned by the New Window browser (src/main/
// new-window.js), so each window's chrome and tabs never touch the main
// window's state. Detection is by query flag: new windows load its chrome
// via loadFile(..., { query: { newWindow: '1' } }).
const IS_NEW_WINDOW_CHROME = (() => {
  try {
    return /[?&]newWindow=1(&|$)/.test(location.search);
  } catch (e) {
    return false;
  }
})();

// Channel prefix: incognito-* for Incognito, nw-* for new windows,
// unprefixed for the main browser.
const CHANNEL_PREFIX = IS_INCOGNITO_CHROME ? 'incognito-' : (IS_NEW_WINDOW_CHROME ? 'nw-' : '');

// Strip external preload/preconnect hints in loaded web pages to reduce
// "preloaded but not used" console warnings. This only runs for http(s)
// pages and intentionally skips the app shell files.
async function shouldRunBlockingScripts() {
  try {
    const res = await ipcRenderer.invoke('get-adblock-mode');
    if (!res) return false;
    const enabled = !!res.enabled;
    const mode = (res && typeof res.mode === 'string') ? res.mode : 'off';
    return enabled && (mode === 'cosmetic' || mode === 'full' || mode === 'standard' || mode === 'aggressive');
  } catch (e) {
    return false;
  }
}

// Strip external preloads only when blocking is explicitly enabled and requires it.
(async function maybeStripExternalPreloads() {
  try {
    const href = (typeof window !== 'undefined' && window.location && window.location.href) ? String(window.location.href) : '';
    const isAppShell = href.includes('/src/renderer/') || href.endsWith('/renderer/index.html') || href.endsWith('/index.html') || href.endsWith('/home.html');
    if (isAppShell) return;
    const run = await shouldRunBlockingScripts();
    if (!run) return;
    if (!(typeof location !== 'undefined' && (location.protocol === 'http:' || location.protocol === 'https:'))) return;

    function removeLinks(root) {
      try {
        const parent = root || document.head || document.documentElement;
        if (!parent || !parent.querySelectorAll) return;
        const links = parent.querySelectorAll('link[rel="preload"], link[rel="preconnect"]');
        for (const l of Array.from(links)) {
          try { l.remove(); } catch (e) {}
        }
      } catch (e) {}
    }

    try { removeLinks(document.head || document.documentElement); } catch (e) {}

    try {
      const mo = new MutationObserver((mutations) => {
        for (const m of mutations) {
          for (const n of Array.from(m.addedNodes || [])) {
            try {
              if (!n || n.nodeType !== 1) continue;
              if (n.tagName === 'LINK') {
                const rel = (n.getAttribute && n.getAttribute('rel') || '').toLowerCase();
                if (rel === 'preload' || rel === 'preconnect') n.remove();
              } else if (n.querySelectorAll) {
                removeLinks(n);
              }
            } catch (e) {}
          }
        }
      });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
      document.addEventListener('DOMContentLoaded', () => { try { mo.disconnect(); removeLinks(document.head || document.documentElement); } catch (e) {} }, { once: true });
    } catch (e) {}
  } catch (e) {}
})();

const SEND_CHANNELS = new Set([
  'navigate',
  'go-back',
  'go-forward',
  'reload',
  'stop-loading',
  'tab-create',
  'tab-switch',
  'tab-reorder',
  'tab-close',
  'zoom-in',
  'zoom-out',
  'zoom-reset',
  'toggle-sidebar',
  'layout-metrics',
  'layout-metrics-delayed',
  'display-info',
  'window-minimize',
  'window-maximize',
  'window-close',
  'kairon-dom-changed',
  'show-overlay-suggestions',
  'hide-overlay-suggestions',
  'navigate-to-suggestion',
  'tab-context-menu',
  'open-history-entry',
  'chrome-ui-focus',
  'show-downloads-panel',
  'hide-downloads-panel',
  'show-app-menu',
  'hide-app-menu',
  'app-menu-measure',
  'show-star-popup',
  'hide-star-popup',
  'star-popup-measure',
  'popup-close-finished',
  'toggle-fullscreen',
  'open-incognito-window',
  'open-new-window',
  'app-exit',
  'show-find-bar',
  'find-next',
  'find-prev',
  'find-close',
  'show-about',
  'hide-about',
  'focus-page',
  'bookmarks-context-menu',
  'updater-install',
]);

const INVOKE_CHANNELS = new Set([
  'store-get',
  'store-set',
  'log-error',
  'settings-get-state',
  'settings-set-feature-enabled',
  'settings-update-feature-config',
  'settings-reset-feature',
  'settings-reset-all',
  'settings-export',
  'settings-import',
  'restart-app',
  'get-cosmetic-css',
  'history-get',
  'history-search',
  'history-autocomplete',
  'history-delete-entry',
  'history-clear',
  'history-get-count',
  'bookmarks-get',
  'bookmarks-search',
  'bookmarks-delete',
  'bookmarks-active-state',
  'bookmarks-toggle-active',
  'quick-access-get',
  'quick-access-delete',
  'quick-access-toggle-active',
  'downloads-get',
  'downloads-clear',
  'downloads-pause',
  'downloads-resume',
  'downloads-cancel',
  'downloads-open',
  'downloads-show-in-folder',
  'downloads-open-folder',
  'downloads-get-location',
  'downloads-set-location',
  'downloads-reset-location',
  'zoom-get',
  'updater-get-state',
  'updater-check',
]);
const RECEIVE_CHANNELS = new Set([
  'url-changed',
  'title-changed',
  'loading',
  'blocked',
  'tabs-state',
  'navigation-invalid',
  'settings-updated',
  'adblock-event',
  'adblock-css-updated',
  'overlay-suggestions',
  'overlay-hide',
  'downloads-updated',
  'downloads-panel-show',
  'downloads-panel-hide',
  'app-menu-show',
  'app-menu-hide',
  'find-bar-show',
  'found-in-page',
  'about-show',
  'about-hide',
  'toast-show',
  'toast-hide',
  'bookmarks-updated',
  'bookmark-state-changed',
  'star-popup-show',
  'star-popup-hide',
  'quick-access-updated',
  'updater-state-changed',
]);

// Minimal, safe scriptlets executed at document_start to help neutralize
// basic anti-adblock checks and to create ad placeholders.
(async function maybeRunOrionScriptlets() {
  try {
    const href = (typeof window !== 'undefined' && window.location && window.location.href) ? String(window.location.href) : '';
    const isAppShell = href.includes('/src/renderer/') || href.endsWith('/renderer/index.html') || href.endsWith('/index.html');
    if (isAppShell) return; // don't run scriptlets inside the app UI shell
    const run = await shouldRunBlockingScripts();
    if (!run) return;

    const scriptlets = [
      function disableSendBeacon() {
        try {
          if (navigator && typeof navigator.sendBeacon === 'function') {
            navigator.sendBeacon = function () { return true; };
          }
        } catch (e) {}
      },
      function createAdPlaceholders() {
        try {
          const names = ['adsbygoogle', 'ad', 'advertisement', 'google_ads_iframe'];
          const root = document.documentElement || document;
          for (const cls of names) {
            const el = document.createElement('div');
            el.className = cls;
            el.style.display = 'none';
            el.setAttribute('data-kairon-placeholder', '1');
            if (root && root.appendChild) root.appendChild(el);
          }
        } catch (e) {}
      },
    ];
    for (const s of scriptlets) {
      try { s(); } catch (e) {}
    }
  } catch (e) {}
})();

// Observe DOM changes and notify the main process (debounced).
(async function maybeSetupOrionDomObserver() {
  try {
    const href = (typeof window !== 'undefined' && window.location && window.location.href) ? String(window.location.href) : '';
    const isAppShell = href.includes('/src/renderer/') || href.endsWith('/renderer/index.html') || href.endsWith('/index.html');
    if (isAppShell) return; // don't observe DOM for the app UI shell
    const run = await shouldRunBlockingScripts();
    if (!run) return;

    const STYLE_ID = 'kairon-cosmetic-style';
    const DEBOUNCE_MS = 150;
    let timer = null;

    function debounce(fn, ms) {
      return function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(fn, ms);
      };
    }

    async function applyCssFromMain() {
      try {
        const css = await ipcRenderer.invoke('get-cosmetic-css');
        if (!css) return;
        let style = document.getElementById(STYLE_ID);
        if (!style) {
          style = document.createElement('style');
          style.id = STYLE_ID;
          (document.head || document.documentElement || document).appendChild(style);
        }
        if (style.textContent !== css) style.textContent = css;
      } catch (e) {}
    }

    const sendDomChanged = debounce(() => {
      try { ipcRenderer.send('Kairon-dom-changed'); } catch (e) {}
      applyCssFromMain();
    }, DEBOUNCE_MS);

    const observer = new MutationObserver(() => {
      try {
        // Dispatch a DOM event for in-page listeners
        try { window.dispatchEvent(new Event('Kairon-dom-changed')); } catch (e) {}
        sendDomChanged();
      } catch (e) {}
    });

    function startObserver() {
      try {
        const root = document.documentElement || document;
        observer.observe(root, { childList: true, subtree: true });
      } catch (e) {
        document.addEventListener('DOMContentLoaded', () => {
          try {
            const root = document.documentElement || document;
            observer.observe(root, { childList: true, subtree: true });
          } catch (e) {}
        }, { once: true });
      }
    }

    startObserver();
    // also apply once immediately if CSS exists
    (async () => { try { await applyCssFromMain(); } catch (e) {} })();
  } catch (e) {}
})();

function send(channel, payload) {
  if (!SEND_CHANNELS.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
  ipcRenderer.send(CHANNEL_PREFIX + channel, payload);
}

function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
  return ipcRenderer.invoke(CHANNEL_PREFIX + channel, ...args);
}

function on(channel, callback) {
  if (!RECEIVE_CHANNELS.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
  if (typeof callback !== 'function') throw new Error('IPC callback must be a function');
  const listener = (_, payload) => callback(payload);
  ipcRenderer.on(CHANNEL_PREFIX + channel, listener);
  return () => ipcRenderer.removeListener(CHANNEL_PREFIX + channel, listener);
}

const api = {
  navigate: (url) => send('navigate', url),
  goBack: () => send('go-back'),
  goForward: () => send('go-forward'),
  reload: () => send('reload'),
  stopLoading: () => send('stop-loading'),
  createTab: (url) => send('tab-create', url),
  switchTab: (tabId) => send('tab-switch', tabId),
  reorderTab: (sourceId, targetIndex) => send('tab-reorder', { sourceId, targetIndex }),
  closeTab: (tabId) => send('tab-close', tabId),
  zoomIn: () => send('zoom-in'),
  zoomOut: () => send('zoom-out'),
  resetZoom: () => send('zoom-reset'),
  toggleSidebar: (open) => send('toggle-sidebar', open),
  updateLayoutMetrics: (metrics) => send('layout-metrics', metrics),
  sendLayoutMetricsDelayed: (metrics) => send('layout-metrics-delayed', metrics),
  sendDisplayInfo: (info) => send('display-info', info),
  restartApp: () => invoke('restart-app'),
  showOverlaySuggestions: (payload) => send('show-overlay-suggestions', payload),
  hideOverlaySuggestions: () => send('hide-overlay-suggestions'),
  navigateToSuggestion: (url) => send('navigate-to-suggestion', url),
  openHistoryEntry: (url) => send('open-history-entry', url),
  windowMinimize: () => send('window-minimize'),
  windowMaximize: () => send('window-maximize'),
  windowClose: () => send('window-close'),
  storeGet: (key) => invoke('store-get', key),
  storeSet: (key, val) => invoke('store-set', key, val),
  logError: (source, message) => invoke('log-error', { source, message }),
  onUrlChanged: (cb) => on('url-changed', cb),
  onTitleChanged: (cb) => on('title-changed', cb),
  onLoading: (cb) => on('loading', cb),
  onBlocked: (cb) => on('blocked', cb),
  onAdblockEvent: (cb) => on('adblock-event', cb),
  onAdblockCssUpdated: (cb) => on('adblock-css-updated', cb),
  requestCosmeticCSS: () => invoke('get-cosmetic-css'),
  onCosmeticCSSUpdate: (cb) => on('adblock-css-updated', cb),
  onTabsState: (cb) => on('tabs-state', cb),
  onNavigationInvalid: (cb) => on('navigation-invalid', cb),
  openTabContextMenu: (tabId) => send('tab-context-menu', tabId),
  setChromeUiFocus: (focused) => send('chrome-ui-focus', focused === true),
  on: (channel, cb) => on(channel, cb),
  getSettingsState: () => invoke('settings-get-state'),

  enableFeature: (featureId) => invoke('settings-set-feature-enabled', featureId, true),
  disableFeature: (featureId) => invoke('settings-set-feature-enabled', featureId, false),
  setFeatureEnabled: (featureId, enabled) => invoke('settings-set-feature-enabled', featureId, enabled),
  updateFeatureConfig: (featureId, patch) => invoke('settings-update-feature-config', featureId, patch),
  resetFeature: (featureId) => invoke('settings-reset-feature', featureId),
  resetAllSettings: () => invoke('settings-reset-all'),
  exportSettings: () => invoke('settings-export'),
  importSettings: (jsonText) => invoke('settings-import', jsonText),
  onSettingsUpdated: (cb) => on('settings-updated', cb),

  // ── History API (backend data layer, no UI) ──────────────
  getHistory: (limit, offset) => invoke('history-get', limit, offset),
  searchHistory: (query, limit, offset) => invoke('history-search', query, limit, offset),
  getAutocompleteSuggestions: (query, limit) => invoke('history-autocomplete', query, limit),
  deleteHistoryEntry: (id) => invoke('history-delete-entry', id),
  clearHistory: () => invoke('history-clear'),
  getHistoryCount: () => invoke('history-get-count'),

  // ── Bookmarks API (backend data layer + actions, no UI) ──
  getBookmarks: () => invoke('bookmarks-get'),
  searchBookmarks: (query) => invoke('bookmarks-search', query),
  deleteBookmark: (id) => invoke('bookmarks-delete', id),
  // Opening a bookmark reuses the existing open-history-entry navigation
  // (createTab + switchToTab), so it behaves exactly like any other URL.
  openBookmark: (url) => send('open-history-entry', url),
  onBookmarksUpdated: (cb) => on('bookmarks-updated', cb),

  // ── Bookmark star (browser chrome) ──────────────────────
  // Pull the active tab's bookmark state (render the star) and toggle the
  // active page's bookmark (star click). Same main-process source of truth
  // as Ctrl+D; pushes arrive on bookmark-state-changed.
  getActiveBookmarkState: () => invoke('bookmarks-active-state'),
  toggleActiveBookmark: () => invoke('bookmarks-toggle-active'),
  onBookmarkStateChanged: (cb) => on('bookmark-state-changed', cb),
  // Right-click menu for the bookmarks bar (native menu shown by main).
  showBookmarkContextMenu: (payload) => send('bookmarks-context-menu', payload),

  // ── Quick Access API (home/new-tab page speed dial) ────────
  // Same main-process store model as bookmarks. The home page renders its
  // Quick Access section from this list and stays live via the push.
  getQuickAccess: () => invoke('quick-access-get'),
  deleteQuickAccessEntry: (id) => invoke('quick-access-delete', id),
  // Toggle the active page's Quick Access entry (star popup action). Returns
  // the fresh combined star state, same as toggleActiveBookmark.
  toggleActiveQuickAccess: () => invoke('quick-access-toggle-active'),
  onQuickAccessUpdated: (cb) => on('quick-access-updated', cb),

  // ── Downloads API (backend data layer + actions, no UI) ──
  getDownloads: () => invoke('downloads-get'),
  clearDownloads: () => invoke('downloads-clear'),
  pauseDownload: (id) => invoke('downloads-pause', id),
  resumeDownload: (id) => invoke('downloads-resume', id),
  cancelDownload: (id) => invoke('downloads-cancel', id),
  openDownload: (id) => invoke('downloads-open', id),
  showDownloadInFolder: (id) => invoke('downloads-show-in-folder', id),
  openDownloadsFolder: () => invoke('downloads-open-folder'),
  onDownloadsUpdated: (cb) => on('downloads-updated', cb),

  // ── Downloads location (settings-managed, main-process filesystem) ──
  // Never exposes filesystem APIs to renderers — only the current location
  // plus explicit user actions, all handled in the main process.
  getDownloadsLocation: () => invoke('downloads-get-location'),
  chooseDownloadsLocation: () => invoke('downloads-set-location'),
  resetDownloadsLocation: () => invoke('downloads-reset-location'),

  // ── Downloads panel (browser chrome floating panel) ──────
  // The panel is rendered by the existing overlay window; the main renderer
  // anchors it by sending the toolbar button's rect (renderer CSS pixels).
  showDownloadsPanel: (payload) => send('show-downloads-panel', payload),
  hideDownloadsPanel: () => send('hide-downloads-panel'),
  onDownloadsPanelShow: (cb) => on('downloads-panel-show', cb),
  onDownloadsPanelHide: (cb) => on('downloads-panel-hide', cb),

  // ── Star popup (Quick Access / Bookmarks chooser) ────────
  // Rendered by the existing overlay window; the main renderer anchors it by
  // sending the star button's rect. Main forwards the live page state so the
  // two rows read the current bookmarked / Quick Access membership.
  showStarPopup: (payload) => send('show-star-popup', payload),
  hideStarPopup: () => send('hide-star-popup'),
  // Overlay-only: reports the popup's exact natural height so main sizes the
  // overlay to fit (same pattern as sendAppMenuMeasure).
  sendStarPopupMeasure: (payload) => send('star-popup-measure', payload),
  onStarPopupShow: (cb) => on('star-popup-show', cb),
  onStarPopupHide: (cb) => on('star-popup-hide', cb),

  // ── Application menu (rendered by the existing overlay window) ──
  // The menu button's rect anchors it; main sizes the overlay and forwards the
  // current browser state so actions enable/disable correctly.
  showAppMenu: (payload) => send('show-app-menu', payload),
  hideAppMenu: () => send('hide-app-menu'),
  sendAppMenuMeasure: (payload) => send('app-menu-measure', payload),
  // Overlay-only: signals that a popup's close animation finished so main can
  // safely restore the overlay's default bounds without a visible teleport.
  notifyPopupClosed: () => send('popup-close-finished'),
  onAppMenuShow: (cb) => on('app-menu-show', cb),
  onAppMenuHide: (cb) => on('app-menu-hide', cb),

  // ── Menu actions ─────────────────────────────────────────
  toggleFullscreen: () => send('toggle-fullscreen'),
  openIncognitoWindow: () => send('open-incognito-window'),
  openNewWindow: () => send('open-new-window'),
  exitApp: () => send('app-exit'),
  getZoom: () => invoke('zoom-get'),
  showAbout: () => send('show-about'),
  hideAbout: () => send('hide-about'),

  // ── Overlay toast (bookmark feedback, etc.) ──────────────
  // Overlay-only: main shows the toast by positioning the overlay; the
  // renderer reports when its display cycle finished so main can reclaim it.
  notifyToastHidden: () => send('toast-hide'),

  // ── Find bar (browser chrome) ────────────────────────────
  // The find bar lives in the main renderer; the menu (overlay) and Ctrl+F
  // request it through main. Results stream back to the chrome.
  showFindBar: () => send('show-find-bar'),
  findNext: (text) => send('find-next', text),
  findPrev: (text) => send('find-prev', text),
  findClose: () => send('find-close'),
  onFindBarShow: (cb) => on('find-bar-show', cb),
  onFoundInPage: (cb) => on('found-in-page', cb),
  focusPage: () => send('focus-page'),

  // ── Auto Updater ─────────────────────────────────────────
  getUpdaterState: () => invoke('updater-get-state'),
  installUpdate: () => send('updater-install'),
  checkForUpdates: () => invoke('updater-check'),
  onUpdaterStateChanged: (cb) => on('updater-state-changed', cb),
};

contextBridge.exposeInMainWorld('kairon', Object.freeze(api));
