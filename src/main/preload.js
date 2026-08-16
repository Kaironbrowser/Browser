const { contextBridge, ipcRenderer } = require('electron');

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
  'history-delete-entry',
  'history-clear',
  'history-get-count',
  'downloads-get',
  'downloads-clear',
  'downloads-pause',
  'downloads-resume',
  'downloads-cancel',
  'downloads-open',
  'downloads-show-in-folder',
  'downloads-open-folder',
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
  ipcRenderer.send(channel, payload);
}

function invoke(channel, ...args) {
  if (!INVOKE_CHANNELS.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
  return ipcRenderer.invoke(channel, ...args);
}

function on(channel, callback) {
  if (!RECEIVE_CHANNELS.has(channel)) throw new Error(`Blocked IPC channel: ${channel}`);
  if (typeof callback !== 'function') throw new Error('IPC callback must be a function');
  const listener = (_, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
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
  deleteHistoryEntry: (id) => invoke('history-delete-entry', id),
  clearHistory: () => invoke('history-clear'),
  getHistoryCount: () => invoke('history-get-count'),

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

  // ── Downloads panel (browser chrome floating panel) ──────
  // The panel is rendered by the existing overlay window; the main renderer
  // anchors it by sending the toolbar button's rect (renderer CSS pixels).
  showDownloadsPanel: (payload) => send('show-downloads-panel', payload),
  hideDownloadsPanel: () => send('hide-downloads-panel'),
  onDownloadsPanelShow: (cb) => on('downloads-panel-show', cb),
  onDownloadsPanelHide: (cb) => on('downloads-panel-hide', cb),
};

contextBridge.exposeInMainWorld('kairon', Object.freeze(api));
