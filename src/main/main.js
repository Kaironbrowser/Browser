const { app, BrowserWindow, BrowserView, ipcMain, nativeImage, session, screen, webContents, dialog, net, nativeTheme, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const Store = require('electron-store');
const { AdblockerService } = require('./adblocker-service');
const { ContentBlockingRuntime } = require('./content-blocking-runtime');
const { AD_BLOCK_PATTERNS } = require('./features');
const { generateHostPatterns } = require('./aggressive-hosts');
const { FeatureStore } = require('./featureStore');
const { setupContextMenu } = require('./context-menu');
const { setupTabContextMenu } = require('./tab-context-menu');
const { HistoryService } = require('./history');
const { BookmarkService } = require('./bookmarks');
const { QuickAccessService } = require('./quick-access');
const { TabSleepManager } = require('./tab-sleep');
const { DownloadManager } = require('./downloads');
const {
  openIncognitoWindow,
  registerIncognitoBrowser,
  broadcastSettingsToIncognito,
  isIncognitoChromeWebContents,
  isIncognitoTabWebContents,
  isIncognitoOverlayWebContents,
} = require('./incognito');
const {
  openNewWindow,
  registerNewWindow,
  broadcastSettingsToNewWindows,
  broadcastBookmarksToNewWindows,
  broadcastDownloadsToNewWindows,
  isNewWindowChromeSender,
  isNewWindowOverlaySender,
  isNewWindowTabWebContents,
  registerNewWindowIpc,
} = require('./new-window');
const {
  initUpdater,
  checkForUpdates,
  installUpdate,
  getUpdaterState,
} = require('./updater');

const APP_USER_MODEL_ID = 'com.kairon.browser';

app.setName('Kairon Browser');
if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// Disable Chromium telemetry and Google reporting services before app readiness.
const DISABLE_CHROMIUM_SWITCHES = [
  'disable-background-networking',
  'disable-breakpad',
  'disable-cloud-import',
  'disable-component-update',
  'disable-crash-reporter',
  'disable-default-apps',
  'disable-domain-reliability',
  'disable-field-trial-config',
  'disable-first-run-ui',
  'disable-hang-monitor',
  'disable-logging',
  'disable-metrics',
  'disable-metrics-repo',
  'disable-notifications',
  'disable-prompt-on-repost',
  'disable-sync',
  'disable-translate',
  'disable-variations-service',
  'disable-web-resources',
  'no-default-browser-check',
  'no-first-run',
  'no-pings',
  'no-report-upload',
  'no-service-autorun',
];

for (const commandLineSwitch of DISABLE_CHROMIUM_SWITCHES) {
  app.commandLine.appendSwitch(commandLineSwitch);
}

app.commandLine.appendSwitch('password-store', 'basic');
app.commandLine.appendSwitch('use-mock-keychain');
app.commandLine.appendSwitch(
  'disable-features',
  [
    'AutofillServerCommunication',
    'BrowserTaskManager',
    'InterestFeedContentSuggestions',
    'MediaRouter',
    'OptimizationHints',
    'Prerender2',
    'PrivacySandboxSettings4',
    'TranslateUI',
  ].join(',')
);

const DEBUG = !app.isPackaged && process.env.KAIRON_DEBUG_TELEMETRY === '1';

// Diagnostic logging flag. Hot-path debug logs (bounds/sizing/overlay readbacks,
// per-request adblock logs, per-tab console forwarding, diagnostics intervals) are
// gated behind this so production builds emit no unnecessary console output while
// dev builds keep their behavior by default.
const DIAG = !app.isPackaged && process.env.KAIRON_DIAG !== '0';
function diag(...args) { if (DIAG) console.info(...args); }
function diagWarn(...args) { if (DIAG) console.warn(...args); }
const TELEMETRY_URL_PATTERNS = [
  '*://safebrowsing.googleapis.com/*',
  '*://sb-ssl.google.com/*',
  '*://clients2.google.com/*',
  '*://update.googleapis.com/*',
  '*://optimizationguide-pa.googleapis.com/*',
  '*://play.google.com/log*',
];
const TELEMETRY_HOSTS = new Set([
  'safebrowsing.googleapis.com',
  'sb-ssl.google.com',
  'clients2.google.com',
  'update.googleapis.com',
  'optimizationguide-pa.googleapis.com',
]);
const telemetryProtectedSessions = new WeakSet();

function getBlockedTelemetryDomain(requestUrl) {
  try {
    const parsedUrl = new URL(requestUrl);
    const hostname = parsedUrl.hostname.toLowerCase();
    if (TELEMETRY_HOSTS.has(hostname)) return hostname;
    if (hostname === 'play.google.com' && parsedUrl.pathname.startsWith('/log')) return hostname;
  } catch (e) { }
  return null;
}

function installTelemetryRequestBlocker(targetSession) {
  if (!targetSession || telemetryProtectedSessions.has(targetSession)) return;
  telemetryProtectedSessions.add(targetSession);

  const targetWebRequest = targetSession.webRequest;
  const registerNativeListener = targetWebRequest.onBeforeRequest.bind(targetWebRequest);
  let downstreamListener = null;

  const registerDispatcher = () => {
    const filter = downstreamListener ? { urls: ['*://*/*'] } : { urls: TELEMETRY_URL_PATTERNS };
    registerNativeListener(filter, (details, callback) => {
      try {
        // Malformed events must never reach the blocker: allow them.
        if (!details || !details.url) {
          callback({});
          return;
        }
        // SAFETY: the ad blocker must never block, redirect, or stall a
        // main-frame/document navigation. Allow the document unconditionally
        // (fail open) before any blocker decision is consulted.
        if (details.resourceType === 'mainFrame' || details.resourceType === 'document') {
          callback({});
          return;
        }

        const blockedDomain = getBlockedTelemetryDomain(details.url);
        if (blockedDomain) {
          if (DEBUG) console.info('[telemetry] blocked', blockedDomain);
          callback({ cancel: true });
          return;
        }

        if (downstreamListener) {
          // Only http(s)/ws(s) requests can ever match a blocking rule — skip
          // the expensive engine match entirely for internal schemes.
          let scheme = '';
          try { scheme = String(details.url).split(':')[0].toLowerCase(); } catch (e) { }
          if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ws' && scheme !== 'wss') {
            callback({});
            return;
          }

          // Decision cache: the blocker's verdict is deterministic for a given
          // (url, type, referrer-host) triple and its rule set version, so
          // repeated requests skip the engine match entirely. This is the main
          // fix for the per-request CPU cost of matching every request
          // synchronously on the main process.
          const cacheKey = makeNativeCacheKey(details);
          if (cacheKey) {
            const cached = _nativeDecisionCache.get(cacheKey);
            if (cached !== undefined && cached && typeof cached === 'object' && 'blocked' in cached) {
              if (cached.blocked) {
                sendAdblockEvent({
                  url: details.url,
                  blocked: true,
                  rule: cached.rule || '',
                  resourceType: details.resourceType,
                  domain: cached.domain || '',
                });
              }
              if (cached.cancel) callback({ cancel: true });
              else if (cached.redirectURL) callback({ redirectURL: cached.redirectURL });
              else callback({});
              return;
            }
          }

          downstreamListener(details, (result) => {
            if (cacheKey && result) {
              try {
                _nativeDecisionCache.set(cacheKey, {
                  blocked: !!result.cancel,
                  cancel: !!result.cancel,
                  redirectURL: result.redirectURL || '',
                  rule: result.cancel ? 'native' : '',
                  domain: (() => { try { return new URL(details.url).hostname || ''; } catch (e) { return ''; } })(),
                }, result.cancel ? 30 * 60 * 1000 : 0);
              } catch (e) { }
            }
            callback(result);
          });
          return;
        }

        callback({});
      } catch (e) {
        // FAIL OPEN: an internal blocker error must never leave the request
        // hanging (callback never called) or cancel a navigation.
        logError('adblock-dispatcher-error', e);
        try { callback({}); } catch (e2) { }
      }
    });
  };

  // Electron supports one onBeforeRequest listener per session. Preserve the
  // ad blocker's listener behind this always-on telemetry dispatcher.
  targetWebRequest.onBeforeRequest = (filter, listener) => {
    downstreamListener = typeof listener === 'function' ? listener : null;
    registerDispatcher();
  };

  // SAFETY: the ad blocker (cliqz engine) also registers an onHeadersReceived
  // listener that injects CSP headers into main-frame/subframe responses from
  // filter-list $csp rules. An injected CSP on the document itself can break a
  // legitimate page's scripts, so the blocker must never be allowed to modify
  // main-frame/document responses. (Subframe/iframe responses are untouched.)
  const registerNativeHeadersListener = targetWebRequest.onHeadersReceived.bind(targetWebRequest);
  let downstreamHeadersListener = null;
  targetWebRequest.onHeadersReceived = (filter, listener) => {
    downstreamHeadersListener = typeof listener === 'function' ? listener : null;
    registerNativeHeadersListener(filter, (details, callback) => {
      try {
        if (downstreamHeadersListener) {
          const isDocument = !!(details && (details.resourceType === 'mainFrame' || details.resourceType === 'document'));
          downstreamHeadersListener(details, (result) => {
            // Never let the blocker modify or cancel a main-frame/document
            // response (e.g. filter-list $csp rules that would inject a CSP
            // into the page and break its scripts) — fail open for documents.
            if (isDocument) {
              callback({});
              return;
            }
            callback(result);
          });
          return;
        }
        callback({});
      } catch (e) {
        logError('adblock-headers-error', e);
        try { callback({}); } catch (e2) { }
      }
    });
  };

  registerDispatcher();
}

let adblockerService = null;
let contentBlockingRuntime = null;
let _adblockReconfigLock = false;

const store = new Store();
const featureStore = new FeatureStore(store);

const DOH_PROVIDER_TEMPLATES = Object.freeze({
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  quad9: 'https://dns.quad9.net/dns-query',
});

function getDnsOverHttpsTemplate() {
  if (!featureStore.isEnabled('dnsOverHttps')) return null;

  const settings = featureStore.getFeatureSettings('dnsOverHttps');
  if (settings.provider === 'off') return null;
  if (DOH_PROVIDER_TEMPLATES[settings.provider]) {
    return DOH_PROVIDER_TEMPLATES[settings.provider];
  }
  if (settings.provider !== 'custom' || typeof settings.customUrl !== 'string') return null;

  try {
    const customUrl = new URL(settings.customUrl.trim());
    if (customUrl.protocol !== 'https:' || !customUrl.hostname || customUrl.username || customUrl.password) return null;
    return customUrl.toString();
  } catch {
    return null;
  }
}

const dnsOverHttpsTemplate = getDnsOverHttpsTemplate();
if (dnsOverHttpsTemplate) {
  app.commandLine.appendSwitch('enable-features', 'DnsOverHttps');
  app.commandLine.appendSwitch('dns-over-https-templates', dnsOverHttpsTemplate);
  // CRITICAL: Explicitly set "automatic" mode so Chromium falls back to system
  // DNS when the DoH resolver is unreachable or slow. Without this flag,
  // Chromium defaults to "secure" mode (DoH-only, no fallback), causing
  // 10-15 second timeouts on every DNS lookup when the resolver is unavailable.
  app.commandLine.appendSwitch('dns-over-https-mode', 'automatic');
  console.info('[dns-over-https] ✓ enabled with template:', dnsOverHttpsTemplate, '(mode: automatic)');
} else {
  // Explicitly disable DoH mode to prevent any lingering flags from applying
  app.commandLine.appendSwitch('dns-over-https-mode', 'off');
  console.info('[dns-over-https] ✗ disabled (mode: off)');
}

const WEBRTC_PROTECTED_POLICY = 'disable_non_proxied_udp';
const WEBRTC_DEFAULT_POLICY = 'default';

function applyWebRtcProtection(targetWebContents) {
  if (!targetWebContents || targetWebContents.isDestroyed()) return;
  const policy = featureStore.isEnabled('webRtcProtection')
    ? WEBRTC_PROTECTED_POLICY
    : WEBRTC_DEFAULT_POLICY;
  targetWebContents.setWebRTCIPHandlingPolicy(policy);
}

function applyWebRtcProtectionToTabs() {
  for (const tab of tabs.values()) {
    applyWebRtcProtection(tab.view?.webContents);
  }
}

let historyService = null;
let bookmarkService = null;
let quickAccessService = null;
let downloadManager = null;

let mainWindow = null;
let overlayWindow = null;
// Standalone "Open Link in New Window" windows (context-menu action). They are
// tracked here so they can be closed when the main browser window closes: they
// are frameless with no chrome and no close button, and an unclosed one would
// keep `window-all-closed` from ever firing — leaving the app running in the
// background (Task Manager) after the browser UI is gone.
const standaloneWindows = new Set();
let activeOverlaySuggestions = null;
// Current anchor info for the floating downloads panel (or null when closed).
let activeDownloadsPanel = null;
let _lastDownloadsPanelBounds = null;
// Current anchor info for the application menu (or null when closed).
let activeAppMenu = null;
let _lastAppMenuBounds = null;
// Current anchor info for the star popup (Quick Access / Bookmarks chooser,
// or null when closed). Shares the overlay with every other popup.
let activeStarPopup = null;
let _lastStarPopupBounds = null;
// True while the About dialog is shown in the overlay window.
let activeAboutDialog = false;
// Current overlay toast (or null when none is showing) plus its auto-hide
// timer. The toast is a tiny click-through overlay popup used for subtle
// bookmark feedback ("Bookmark added"/"Bookmark removed").
let activeToast = null;
let _toastTimer = null;
// True while a popup's (app menu / downloads panel) close animation is still
// playing in the overlay. While set, the overlay window must not be moved or
// resized: any setBounds would teleport the still-visible popup to a default
// position for a frame. Cleared when the renderer confirms the popup is
// hidden (popup-close-finished) or when a new popup is shown.
let overlayClosePending = false;
let _aggressiveWebRequestHandler = null;
let _aggressiveActive = false;
let _aggressiveBlockedCount = 0;
let _networkRequestCount = 0;
let _networkCountersAttached = false;
let _diagnosticInterval = null;
let _nativeBlockedCount = 0;

// Production-grade fallback blocker structures
const FALLBACK_RULE_VERSION = { value: 0 };
let _cacheHits = 0;
let _cacheMisses = 0;

class FastLRUCache {
  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
    this.cache = new Map();
    this.timestamps = new Map();
    this.cleanupIntervalHandle = null;
  }
  _cleanupExpired() {
    const now = Date.now();
    for (const [key, timestamp] of this.timestamps) {
      const entry = this.cache.get(key);
      if (entry && entry.ttl && now - timestamp > entry.ttl) {
        this.cache.delete(key);
        this.timestamps.delete(key);
      }
    }
  }
  _enforceSize() {
    while (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
      this.timestamps.delete(firstKey);
    }
  }
  get(key) {
    if (!this.cache.has(key)) {
      _cacheMisses++;
      return undefined;
    }
    const entry = this.cache.get(key);
    if (!entry || typeof entry !== 'object' || !entry.hasOwnProperty('value')) {
      this.cache.delete(key);
      this.timestamps.delete(key);
      _cacheMisses++;
      return undefined;
    }
    if (entry.ttl) {
      const elapsed = Date.now() - this.timestamps.get(key);
      if (elapsed > entry.ttl) {
        this.cache.delete(key);
        this.timestamps.delete(key);
        _cacheMisses++;
        return undefined;
      }
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    _cacheHits++;
    return entry.value;
  }
  set(key, value, ttl = 0) {
    if (!value || typeof value !== 'object' || !value.hasOwnProperty('blocked')) return;
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, { value, ttl });
    this.timestamps.set(key, Date.now());
    this._enforceSize();
  }
  clear() {
    this.cache.clear();
    this.timestamps.clear();
    if (this.cleanupIntervalHandle) {
      clearInterval(this.cleanupIntervalHandle);
      this.cleanupIntervalHandle = null;
    }
  }
  invalidate() {
    this.clear();
    FALLBACK_RULE_VERSION.value = (FALLBACK_RULE_VERSION.value + 1) % 1000000;
  }
  startPeriodicCleanup(intervalMs = 60000) {
    if (this.cleanupIntervalHandle) return;
    this.cleanupIntervalHandle = setInterval(() => this._cleanupExpired(), intervalMs);
  }
}

function normalizeUrlForCache(url) {
  try {
    const urlObj = new URL(url);
    let normalized = `${urlObj.hostname}${urlObj.pathname}`;
    if (normalized.endsWith('/')) normalized = normalized.slice(0, -1);
    return normalized.toLowerCase();
  } catch (e) {
    return null;
  }
}

// Rule-set version for the native blocker decision cache. Bumped whenever the
// blocker is torn down/recreated (reconfigureAdblocker) so cached verdicts
// from the previous engine/rules are never replayed.
let _nativeRuleVersion = 0;

// Deterministic decision key for the native/fallback blocker cache. A
// blocker's verdict can depend on the request URL, its resource type, and the
// page that initiated it (referrer), plus the active rule-set version — all
// captured here so a cached verdict is always valid for the current rules.
function makeNativeCacheKey(details) {
  try {
    const urlObj = new URL(details.url);
    let refHost = '';
    try {
      if (details.referrer) refHost = new URL(String(details.referrer)).hostname;
    } catch (e) { }
    const type = details.resourceType || '';
    const urlPart = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}${urlObj.search}`;
    const key = `${urlPart}::${type}::${refHost}::v${_nativeRuleVersion}::f${FALLBACK_RULE_VERSION.value}`;
    // Refuse absurdly long keys (avoid unbounded memory / conflating distinct
    // URLs by truncation); a null key simply disables caching for that request.
    return key.length > 2048 ? null : key;
  } catch (e) {
    return null;
  }
}

function isCriticalResource(resourceType, pathname) {
  if (!resourceType || typeof resourceType !== 'string') return false;
  const critical = ['mainFrame', 'document', 'stylesheet', 'font'];
  if (critical.includes(resourceType)) return true;
  if (resourceType === 'script' && pathname && (
    pathname.includes('/app.') ||
    pathname.includes('/bundle') ||
    pathname.includes('/main.') ||
    pathname.includes('/vendor')
  )) return true;
  return false;
}

let _urlDecisionCache = new FastLRUCache(5000);
// Decision cache for the native engine (and fallback-through-dispatcher)
// path. Caches the blocker verdict per (url, type, referrer-host, rule
// version) so repeated requests skip the synchronous engine match on the
// main process — the measured hot path (~0.3-13ms per request).
let _nativeDecisionCache = new FastLRUCache(5000);
let _trackerDomainSet = new Set();
let _trackerSuffixMap = new Map();
let _pathKeywordSet = new Set();
let _staticHostPatternSet = new Set();
let _staticSuffixMap = new Map();
let _initializationComplete = false;
let _ruleMatchBreakdown = { host: 0, suffix: 0, path: 0, cache: 0, none: 0 };
const tabs = new Map();
let activeTabId = null;
let nextTabId = 1;
let sidebarOpen = false;
let layoutMetrics = null;

// True while the browser chrome (address bar, AI input, buttons) holds keyboard
// focus. Reported by the renderer so window-level focus handling never steals
// focus from chrome UI (e.g. when the user returns to the window with Alt+Tab
// while the address bar was focused).
let chromeUiFocused = false;

// ── FULLSCREEN STATE ──────────────────────────────────────────
// Two independent fullscreen modes that must never fight each other:
//   1. Browser fullscreen (F11)  – toggles the Kairon window itself.
//   2. Content fullscreen        – a website using the HTML Fullscreen API
//                                  (YouTube, HTML5 <video>, etc.).
// When a website enters content fullscreen we put the window into fullscreen
// so the active BrowserView can cover the entire screen, and remember whether
// the window was already fullscreen (F11) so ESC/F11 restore it exactly.
let htmlFullscreenTabId = null;          // tab.id currently in content fullscreen (or null)
let windowFullscreenBeforeHtml = false;  // window was in F11 fullscreen before content fullscreen began
// Whether the window's own fullscreen was explicitly toggled by the user via F11.
// Electron may auto-fullscreen the window when a website requests fullscreen, so
// this flag (not win.isFullScreen()) is the reliable record of user intent.
let userWindowFullscreen = false;
// True from the moment the window starts a fullscreen transition until shortly
// after it settles. During this window the active view must NOT be repositioned
// with chrome-offset layout metrics: Electron auto-fullscreens the window before
// 'enter-html-full-screen' fires, so the renderer's chrome measurements arrive
// while htmlFullscreenTabId is still null — applying them mid-transition jumps
// the view around and corrupts the webpage's fullscreen viewport (leaving a
// stale viewport / black band above the content).
let fullscreenTransitionActive = false;
let fullscreenTransitionTimer = null;

// Tab sleeping manager — puts inactive background tabs to sleep using native
// webContents throttling and wakes them on activation. State changes are
// pushed through the existing tabs-state flow so the renderer reflects them
// (sleeping badge / tooltip) without any polling.
const tabSleepManager = new TabSleepManager({
  getTabs: () => tabs,
  getActiveTabId: () => activeTabId,
  onStateChange: () => emitTabsState(),
});

// ── BATCHED ADBLOCK EVENTS ─────────────────────────────────
// The native adblocker fires onBlocked for every blocked request. Sending
// individual IPCs for each (potentially hundreds per page load) is wasteful
// since the renderer only needs aggregate counts. This batches events and
// flushes every 150ms, sending at most one IPC per flush window.
let _adblockBatch = { blocked: 0, total: 0, lastPayload: null };
let _adblockBatchTimer = null;
function _flushAdblockBatch() {
  _adblockBatchTimer = null;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const { blocked, total, lastPayload } = _adblockBatch;
  _adblockBatch = { blocked: 0, total: 0, lastPayload: null };
  if (total === 0) return;
  // Send a summary event so the renderer can batch-update its counters.
  mainWindow.webContents.send('adblock-event', {
    _batched: true,
    blockedCount: blocked,
    totalCount: total,
    // Include the last individual event so the renderer can still show
    // the flash animation for the most recent block.
    ...(lastPayload || {}),
  });
}
function sendAdblockEvent(payload) {
  const wasBlocked = !!(payload && payload.blocked);
  _adblockBatch.total++;
  if (wasBlocked) _adblockBatch.blocked++;
  _adblockBatch.lastPayload = payload;
  if (!_adblockBatchTimer) {
    _adblockBatchTimer = setTimeout(_flushAdblockBatch, 150);
  }
}

const RAIL_WIDTH = 256; // 10px body padding + 236px left-rail width + 10px gap (matches CSS --rail-w: 236px)
// Application menu overlay sizing — width must match #app-menu in overlay.html.
// The height is an initial estimate; the overlay reports its exact natural
// height after render (app-menu-measure) so the overlay never clips or pads
// the menu regardless of font metrics.
const APP_MENU_WIDTH = 284;
const APP_MENU_HEIGHT = 690;
const CHROME_HEIGHT = 80; // --chrome-h: 52 + --status-h: 28 (matches CSS variables)
const SIDEBAR_WIDTH = 360;
const MAX_URL_LENGTH = 2048;
const MAX_STORE_KEY_LENGTH = 128;
const MAX_LOG_MESSAGE_LENGTH = 4000;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_POPUP_HOSTS = new Set();
const SESSION_STORE_KEY = 'session.tabs.v1';
const MAX_SESSION_TABS = 20;
const MAX_SETTINGS_PAYLOAD_LENGTH = 2_000_000;
const HOME_PAGE_URL = 'kairon://home';
const HOME_PAGE_FILE = path.join(__dirname, '../renderer/home.html');
const HISTORY_PAGE_FILE = path.join(__dirname, '../renderer/history.html');
const DOWNLOAD_PAGE_URL = 'kairon://downloads';
const DOWNLOAD_PAGE_FILE = path.join(__dirname, '../renderer/downloads.html');
const BOOKMARKS_PAGE_URL = 'kairon://bookmarks';
const BOOKMARKS_PAGE_FILE = path.join(__dirname, '../renderer/bookmarks.html');
// The Incognito home/new-tab page — a trusted internal page loaded only by
// the Incognito window (see incognito.js).
const INCOGNITO_PAGE_FILE = path.join(__dirname, '../renderer/incognito_mode.html');
const HTTPS_WARNING_FILE = path.join(__dirname, '../renderer/https-warning.html');
const ERROR_PAGE_FILE = path.join(__dirname, "../renderer/can't_be_reached.html");
const IP_NOT_FOUND_FILE = path.join(__dirname, '../renderer/ip_not_found.html');
const SETTINGS_PAGE_URL = 'kairon://settings';
const SETTINGS_PAGE_FILE = path.join(__dirname, '../renderer/settings.html');
let logFilePath = '';

function getAppIconPath(ext = '.ico') {
  const candidates = [
    path.join(__dirname, `../renderer/assets/favicon${ext}`),
    path.join(__dirname, `../assets/icon${ext}`),
    path.join(__dirname, `../../build/icons/icon${ext}`),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0];
}

function getAppIcon() {
  const icon = nativeImage.createFromPath(getAppIconPath());
  return icon.isEmpty() ? getAppIconPath() : icon;
}

function initializeLogging() {
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  logFilePath = path.join(logDir, 'kairon-errors.log');
}

function toSafeErrorMessage(errorOrMessage) {
  if (!errorOrMessage) return 'Unknown error';
  const value = typeof errorOrMessage === 'string' ? errorOrMessage : (errorOrMessage.stack || errorOrMessage.message || String(errorOrMessage));
  return value.slice(0, MAX_LOG_MESSAGE_LENGTH);
}

function logError(source, errorOrMessage) {
  const line = `[${new Date().toISOString()}] [${source}] ${toSafeErrorMessage(errorOrMessage)}\n`;
  if (!logFilePath) return;
  fs.appendFile(logFilePath, line, (err) => {
    if (err) console.error('Failed to write log file:', err);
  });
}

function isAllowedHttpUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(input);
    return ALLOWED_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function isHomeUrl(input) {
  return typeof input === 'string' && input.trim().toLowerCase() === HOME_PAGE_URL;
}

function isHistoryUrl(input) {
  return typeof input === 'string' && input.trim().toLowerCase() === 'kairon://history';
}

function isDownloadsUrl(input) {
  return typeof input === 'string' && input.trim().toLowerCase() === DOWNLOAD_PAGE_URL;
}

function isBookmarksUrl(input) {
  return typeof input === 'string' && input.trim().toLowerCase() === BOOKMARKS_PAGE_URL;
}

function isSettingsUrl(input) {
  return typeof input === 'string' && /^kairon:\/\/settings(\/|$)/i.test(input.trim());
}

// Normalize kairon://settings and kairon://settings/<section> deep links to
// their canonical form. Anything else returns null so invalid settings paths
// surface the normal "Invalid address" state instead of being navigated.
function normalizeSettingsUrl(input) {
  if (typeof input !== 'string') return null;
  const lower = input.trim().toLowerCase();
  if (lower === SETTINGS_PAGE_URL || lower === 'kairon://settings/') return SETTINGS_PAGE_URL;
  const match = /^kairon:\/\/settings\/([a-z0-9-]+)$/.exec(lower);
  if (match) return `kairon://settings/${match[1]}`;
  return null;
}

function getSettingsSectionFromUrl(url) {
  const match = /^kairon:\/\/settings\/([a-z0-9-]+)$/i.exec(String(url || '').trim());
  return match ? match[1] : null;
}

function isPersistableUrl(input) {
  return isAllowedHttpUrl(input) || isHomeUrl(input);
}

function normalizeNavigationTarget(urlInput) {
  const input = typeof urlInput === 'string' ? urlInput.trim() : '';
  if (!input) return HOME_PAGE_URL;
  if (input.length > MAX_URL_LENGTH) return null;
  if (isHomeUrl(input) || input.toLowerCase() === 'home') return HOME_PAGE_URL;
  if (isHistoryUrl(input)) return 'kairon://history';
  if (isDownloadsUrl(input)) return DOWNLOAD_PAGE_URL;
  if (isBookmarksUrl(input)) return BOOKMARKS_PAGE_URL;
  const settingsTarget = normalizeSettingsUrl(input);
  if (settingsTarget) return settingsTarget;

  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(input);
  const candidate = hasProtocol ? input : (input.includes('.') && !input.includes(' ') && input.length < 100 ? `https://${input}` : `https://search.brave.com/search?q=${encodeURIComponent(input)}`);

  if (!isAllowedHttpUrl(candidate)) return null;
  return candidate;
}

function isTrustedIpcSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || !event) return false;
  // Allow messages only from the normal main renderer and normal overlay renderer
  if (event.sender === mainWindow.webContents) return true;
  if (overlayWindow && !overlayWindow.isDestroyed() && event.sender === overlayWindow.webContents) return true;
  // Additional normal windows (Ctrl+N) are also trusted
  if (isNewWindowChromeSender(event) || isNewWindowOverlaySender(event)) return true;
  return false;
}

/**
 * Check whether the IPC sender is a BrowserView from one of our own tabs.
 * This allows internal pages (history, home, etc.) loaded in BrowserViews
 * to call IPC handlers without weakening isTrustedIpcSender for other handlers.
 */
function isTabBrowserView(event) {
  if (!event || !event.sender) return false;
  for (const tab of tabs.values()) {
    if (tab.view && tab.view.webContents === event.sender) return true;
  }
  // Incognito tabs are BrowserViews from the Incognito window — recognized so
  // their internal pages can use the same shared (unprefixed) read-only IPC.
  if (isIncognitoTabWebContents(event.sender)) return true;
  // Additional normal windows (Ctrl+N) tabs are also recognized
  if (isNewWindowTabWebContents(event.sender)) return true;
  return false;
}

// ── PERMISSION POLICY ───────────────────────────────────────────
// Deny-by-default permission policy for untrusted web content. Trusted
// browser chrome (main window, overlay, additional windows) receives
// all requested permissions. Normal web pages loaded in tabs receive only
// permissions required for standard browsing (clipboard, fullscreen).
// Sensitive permissions (camera, microphone, geolocation, notifications,
// screen capture) are denied for untrusted content.

// Permissions that are always allowed for all sources (clipboard operations
// for copy/paste and fullscreen for the HTML Fullscreen API).
const PERMISSION_ALLOW_ALWAYS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'clipboard-write',
  'fullscreen',
]);

// Permissions that are always denied (sensitive hardware/system access).
const PERMISSION_DENY_ALWAYS = new Set([
  'camera',
  'microphone',
  'geolocation',
  'notifications',
  'display-capture',
  'screen',
  'screen-capture',
  'midi',
  'midi-sysex',
  'sensor',
  'idle-detection',
  'serial',
  'usb',
  'hid',
]);

/**
 * Determine whether a webContents belongs to trusted Kairon browser chrome
 * (as opposed to untrusted web content loaded in a tab). Trusted sources
 * receive all requested permissions; untrusted sources follow the
 * deny-by-default policy.
 *
 * Trust is based on whether the webContents is a known chrome window or
 * overlay — never on whether it simply comes from the browser's session.
 * A normal website loaded in a tab BrowserView is NOT trusted, even though
 * it shares the same Electron session.
 */
function isTrustedBrowserWebContents(wc) {
  if (!wc || wc.isDestroyed()) return false;
  // Main browser chrome
  if (mainWindow && !mainWindow.isDestroyed() && wc === mainWindow.webContents) return true;
  // Main overlay (omnibox suggestions, downloads panel, app menu, etc.)
  if (overlayWindow && !overlayWindow.isDestroyed() && wc === overlayWindow.webContents) return true;
  // Incognito chrome and overlay
  if (isIncognitoChromeWebContents(wc) || isIncognitoOverlayWebContents(wc)) return true;
  // Additional normal windows (Ctrl+N) chrome and overlay
  if (isNewWindowChromeSender({ sender: wc }) || isNewWindowOverlaySender({ sender: wc })) return true;
  return false;
}

/**
 * Install deny-by-default permission handlers on an Electron session.
 * Called once for the main browsing session (persist:browser) and once for
 * the incognito session (incognito). Each session gets its own independent
 * handlers; permission grants are per-session and never cross the boundary.
 */
function setupSessionPermissionHandlers(sess) {
  if (!sess) return;
  try {
    // ── Permission Request Handler ─────────────────────────────
    // Called when a web page requests a permission (camera, microphone, etc.).
    // Deny-by-default: only trusted chrome and explicitly allowed permissions
    // (clipboard, fullscreen) are granted.
    sess.setPermissionRequestHandler((webContents, permission, callback) => {
      try {
        // Always allow explicitly safe permissions (clipboard, fullscreen)
        if (PERMISSION_ALLOW_ALWAYS.has(permission)) {
          // Notify tab-sleep if this is a capture-related permission that we
          // are allowing (clipboard-write is not capture, but be defensive)
          try { tabSleepManager.onCapturePermissionGranted(webContents); } catch (e) { }
          return callback(true);
        }

        // Always deny sensitive permissions
        if (PERMISSION_DENY_ALWAYS.has(permission)) {
          try { tabSleepManager.onCapturePermissionDenied(webContents); } catch (e) { }
          return callback(false);
        }

        // For any other permission: grant only to trusted browser chrome
        const trusted = isTrustedBrowserWebContents(webContents);
        if (trusted) {
          try { tabSleepManager.onCapturePermissionGranted(webContents); } catch (e) { }
          return callback(true);
        }

        // Unknown permission from untrusted source: deny
        try { tabSleepManager.onCapturePermissionDenied(webContents); } catch (e) { }
        callback(false);
      } catch (e) {
        // Fail-closed: deny on internal error
        try { callback(false); } catch (e2) { }
      }
    });

    // ── Permission Check Handler ───────────────────────────────
    // Called when Chromium checks whether a permission is currently granted
    // (e.g. before calling navigator.permissions.query()). Uses the same
    // deny-by-default policy as the request handler.
    sess.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      try {
        // Always allow explicitly safe permissions
        if (PERMISSION_ALLOW_ALWAYS.has(permission)) return true;

        // Always deny sensitive permissions
        if (PERMISSION_DENY_ALWAYS.has(permission)) return false;

        // For any other permission: grant only to trusted browser chrome
        const trusted = isTrustedBrowserWebContents(webContents);
        return !!trusted;
      } catch (e) {
        // Fail-closed: deny on internal error
        return false;
      }
    });
  } catch (e) {
    logError('permission-handler-setup', e);
  }
}

// The internal history page (loaded via loadFile from HISTORY_PAGE_FILE) is
// the only tab-loaded page allowed to use the history IPC. Trust follows the
// currently loaded URL: if the history page navigates to an external site,
// event.sender.getURL() no longer matches and privileges are lost immediately.
// Normal web pages can never match because their URL is never the local
// history.html file URL.
let _downloadsPageFileUrl = null;
function getDownloadsPageFileUrl() {
  if (_downloadsPageFileUrl === null) {
    try {
      _downloadsPageFileUrl = pathToFileURL(DOWNLOAD_PAGE_FILE).href;
    } catch (e) {
      _downloadsPageFileUrl = '';
    }
  }
  return _downloadsPageFileUrl;
}

let _bookmarksPageFileUrl = null;
function getBookmarksPageFileUrl() {
  if (_bookmarksPageFileUrl === null) {
    try {
      _bookmarksPageFileUrl = pathToFileURL(BOOKMARKS_PAGE_FILE).href;
    } catch (e) {
      _bookmarksPageFileUrl = '';
    }
  }
  return _bookmarksPageFileUrl;
}

let _historyPageFileUrl = null;
function getHistoryPageFileUrl() {
  if (_historyPageFileUrl === null) {
    try {
      _historyPageFileUrl = pathToFileURL(HISTORY_PAGE_FILE).href;
    } catch (e) {
      _historyPageFileUrl = '';
    }
  }
  return _historyPageFileUrl;
}

let _settingsPageFileUrl = null;
function getSettingsPageFileUrl() {
  if (_settingsPageFileUrl === null) {
    try {
      _settingsPageFileUrl = pathToFileURL(SETTINGS_PAGE_FILE).href;
    } catch (e) {
      _settingsPageFileUrl = '';
    }
  }
  return _settingsPageFileUrl;
}

let _homePageFileUrl = null;
function getHomePageFileUrl() {
  if (_homePageFileUrl === null) {
    try {
      _homePageFileUrl = pathToFileURL(HOME_PAGE_FILE).href;
    } catch (e) {
      _homePageFileUrl = '';
    }
  }
  return _homePageFileUrl;
}

let _httpsWarningPageFileUrl = null;
function getHttpsWarningPageFileUrl() {
  if (_httpsWarningPageFileUrl === null) {
    try {
      _httpsWarningPageFileUrl = pathToFileURL(HTTPS_WARNING_FILE).href;
    } catch (e) {
      _httpsWarningPageFileUrl = '';
    }
  }
  return _httpsWarningPageFileUrl;
}

let _errorPageFileUrl = null;
function getErrorPageFileUrl() {
  if (_errorPageFileUrl === null) {
    try {
      _errorPageFileUrl = pathToFileURL(ERROR_PAGE_FILE).href;
    } catch (e) {
      _errorPageFileUrl = '';
    }
  }
  return _errorPageFileUrl;
}

// True when the given URL is the local error page file (protocol + host +
// pathname only, so the ?theme/?url/?error query params and any hash are
// ignored; case is normalized for Windows paths). Used to keep the failed
// URL in the address bar while the error page is displayed.
function isErrorPageFileUrl(input) {
  const target = getErrorPageFileUrl();
  if (!target || !input) return false;
  try {
    const norm = (raw) => {
      const parsed = new URL(raw);
      return `${parsed.protocol}${parsed.host}${parsed.pathname}`.toLowerCase();
    };
    return norm(input) === norm(target);
  } catch (e) {
    return false;
  }
}

let _ipNotFoundPageFileUrl = null;
function getIpNotFoundPageFileUrl() {
  if (_ipNotFoundPageFileUrl === null) {
    try {
      _ipNotFoundPageFileUrl = pathToFileURL(IP_NOT_FOUND_FILE).href;
    } catch (e) {
      _ipNotFoundPageFileUrl = '';
    }
  }
  return _ipNotFoundPageFileUrl;
}

// Same trust/recognition model as isErrorPageFileUrl, for the dedicated
// DNS/name-resolution failure page (ip_not_found.html).
function isIpNotFoundPageFileUrl(input) {
  const target = getIpNotFoundPageFileUrl();
  if (!target || !input) return false;
  try {
    const norm = (raw) => {
      const parsed = new URL(raw);
      return `${parsed.protocol}${parsed.host}${parsed.pathname}`.toLowerCase();
    };
    return norm(input) === norm(target);
  } catch (e) {
    return false;
  }
}

// DNS/name-resolution failures — the Chromium net error codes that mean the
// requested hostname could not be resolved to an IP address. Detection is
// based on the numeric net error code from did-fail-load, never on message
// text:
//   -105 ERR_NAME_NOT_RESOLVED      (Chrome shows DNS_PROBE_FINISHED_NXDOMAIN)
//   -137 ERR_NAME_RESOLUTION_FAILED (Chrome shows DNS_PROBE_FINISHED_BAD_CONFIG)
// These are distinct from connection-level failures (ERR_CONNECTION_*, ERR_*
// TIMED_OUT, etc.), which keep the generic error page.
const DNS_RESOLUTION_ERROR_CODES = new Set([-105, -137]);
function isDnsResolutionError(errorCode) {
  return Number.isInteger(errorCode) && DNS_RESOLUTION_ERROR_CODES.has(errorCode);
}

// The persisted theme is the single source of truth for the whole app — the
// browser chrome, every internal page, and generated pages all consume it.
function getCurrentThemeMode() {
  try {
    return featureStore.getFeatureSettings('themeSystem').mode === 'light' ? 'light' : 'dark';
  } catch (e) {
    return 'dark';
  }
}

function getThemeQuery() {
  return { theme: getCurrentThemeMode() };
}

// Kairon's selected Theme Mode is the single source of truth for the whole
// app, including the color scheme that normal websites observe. Electron's
// nativeTheme is the native Chromium media-feature emulation point: setting
// themeSource makes prefers-color-scheme resolve to light/dark in EVERY
// webContents (browser chrome, internal pages, and normal websites alike) —
// websites that support the media feature respond themselves, and websites
// that don't are never touched (no CSS/DOM injection). Per-webContents
// color-scheme overrides are not available in Electron, so this global switch
// is the correct mechanism. Idempotent, so it is safe to call on every
// settings change and on startup.
function syncNativeColorScheme() {
  try {
    nativeTheme.themeSource = getCurrentThemeMode() === 'light' ? 'light' : 'dark';
  } catch (e) { }
}

function isInternalHistoryPage(event) {
  if (!event || !event.sender || typeof event.sender.getURL !== 'function') return false;
  const target = getHistoryPageFileUrl();
  if (!target) return false;
  try {
    const current = event.sender.getURL();
    if (!current) return false;
    // Compare protocol + host + pathname only, so query/hash changes on the
    // internal page keep working, and case is normalized for Windows paths.
    const norm = (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.protocol}${parsed.host}${parsed.pathname}`.toLowerCase();
      } catch (e) {
        return String(raw).toLowerCase();
      }
    };
    return norm(current) === norm(target);
  } catch (e) {
    return false;
  }
}

// The internal settings page (loaded via loadFile from SETTINGS_PAGE_FILE)
// is trusted only while its current URL is the local settings.html file — the
// same trust model as the internal history page. If the page navigates to an
// external site, event.sender.getURL() no longer matches and privileges are
// revoked immediately. Normal web pages can never match.
function isInternalSettingsPage(event) {
  if (!event || !event.sender || typeof event.sender.getURL !== 'function') return false;
  const target = getSettingsPageFileUrl();
  if (!target) return false;
  try {
    const current = event.sender.getURL();
    if (!current) return false;
    // Compare protocol + host + pathname only, so query/hash changes on the
    // internal page keep working, and case is normalized for Windows paths.
    const norm = (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.protocol}${parsed.host}${parsed.pathname}`.toLowerCase();
      } catch (e) {
        return String(raw).toLowerCase();
      }
    };
    return norm(current) === norm(target);
  } catch (e) {
    return false;
  }
}

// The internal downloads page (loaded via loadFile from DOWNLOAD_PAGE_FILE)
// is trusted only while its current URL is the local downloads.html file —
// the same trust model as the history page. If the page navigates away,
// event.sender.getURL() no longer matches and privileges are revoked.
function isInternalDownloadsPage(event) {
  if (!event || !event.sender || typeof event.sender.getURL !== 'function') return false;
  const target = getDownloadsPageFileUrl();
  if (!target) return false;
  try {
    const current = event.sender.getURL();
    if (!current) return false;
    const norm = (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.protocol}${parsed.host}${parsed.pathname}`.toLowerCase();
      } catch (e) {
        return String(raw).toLowerCase();
      }
    };
    return norm(current) === norm(target);
  } catch (e) {
    return false;
  }
}

// The internal bookmarks page (loaded via loadFile from BOOKMARKS_PAGE_FILE)
// follows the exact same trust model as the history/downloads pages: trusted
// only while its current URL is the local bookmarks.html file. If the page
// navigates away, event.sender.getURL() no longer matches and privileges are
// revoked immediately.
function isInternalBookmarksPage(event) {
  if (!event || !event.sender || typeof event.sender.getURL !== 'function') return false;
  const target = getBookmarksPageFileUrl();
  if (!target) return false;
  try {
    const current = event.sender.getURL();
    if (!current) return false;
    const norm = (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.protocol}${parsed.host}${parsed.pathname}`.toLowerCase();
      } catch (e) {
        return String(raw).toLowerCase();
      }
    };
    return norm(current) === norm(target);
  } catch (e) {
    return false;
  }
}

// The internal home page (loaded via loadFile from HOME_PAGE_FILE) follows
// the exact same trust model as the history/bookmarks/downloads pages: trusted
// only while its current URL is the local home.html file. If the page
// navigates away, event.sender.getURL() no longer matches and privileges are
// revoked immediately. Incognito never loads home.html (it uses
// incognito_mode.html instead), so its home page can never reach this.
function isInternalHomePage(event) {
  if (!event || !event.sender || typeof event.sender.getURL !== 'function') return false;
  const target = getHomePageFileUrl();
  if (!target) return false;
  try {
    const current = event.sender.getURL();
    if (!current) return false;
    const norm = (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.protocol}${parsed.host}${parsed.pathname}`.toLowerCase();
      } catch (e) {
        return String(raw).toLowerCase();
      }
    };
    return norm(current) === norm(target);
  } catch (e) {
    return false;
  }
}

let _incognitoPageFileUrl = null;
function getIncognitoPageFileUrl() {
  if (_incognitoPageFileUrl === null) {
    try {
      _incognitoPageFileUrl = pathToFileURL(INCOGNITO_PAGE_FILE).href;
    } catch (e) {
      _incognitoPageFileUrl = '';
    }
  }
  return _incognitoPageFileUrl;
}

// The Incognito home/new-tab page (incognito_mode.html) is a trusted Kairon
// internal page: it consumes the global theme snapshot, and is only ever
// loaded by the Incognito window (normal tabs cannot load file: URLs). Trust
// follows the currently loaded URL, same model as the history/settings pages.
function isInternalIncognitoPage(event) {
  if (!event || !event.sender || typeof event.sender.getURL !== 'function') return false;
  const target = getIncognitoPageFileUrl();
  if (!target) return false;
  try {
    const current = event.sender.getURL();
    if (!current) return false;
    const norm = (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.protocol}${parsed.host}${parsed.pathname}`.toLowerCase();
      } catch (e) {
        return String(raw).toLowerCase();
      }
    };
    return norm(current) === norm(target);
  } catch (e) {
    return false;
  }
}

// True when a webContents is currently showing the internal settings page.
// Used by emitSettingsState so live settings updates only reach pages that
// still have privileged access (trust follows the loaded URL).
function isSettingsPageWebContents(wc) {
  if (!wc || typeof wc.getURL !== 'function' || wc.isDestroyed()) return false;
  return isInternalSettingsPage({ sender: wc });
}

// True when a webContents is currently showing any Kairon-owned internal page
// (home / history / settings / https-warning / error page). These pages consume the public
// feature snapshot to live-sync the global theme; receiving the snapshot is
// harmless (it contains no secrets), and trust follows the loaded URL exactly
// like the settings page. Normal websites can never match.
function isInternalKaironPageWebContents(wc) {
  if (!wc || typeof wc.getURL !== 'function' || wc.isDestroyed()) return false;
  const urls = [getHomePageFileUrl(), getHistoryPageFileUrl(), getDownloadsPageFileUrl(), getBookmarksPageFileUrl(), getSettingsPageFileUrl(), getHttpsWarningPageFileUrl(), getErrorPageFileUrl(), getIpNotFoundPageFileUrl(), getIncognitoPageFileUrl()].filter(Boolean);
  if (!urls.length) return false;
  try {
    const current = wc.getURL();
    if (!current) return false;
    // Compare protocol + host + pathname only, so query/hash changes on the
    // internal page keep working, and case is normalized for Windows paths.
    const norm = (raw) => {
      try {
        const parsed = new URL(raw);
        return `${parsed.protocol}${parsed.host}${parsed.pathname}`.toLowerCase();
      } catch (e) {
        return String(raw).toLowerCase();
      }
    };
    const normCurrent = norm(current);
    return urls.some((u) => norm(u) === normCurrent);
  } catch (e) {
    return false;
  }
}

function isAllowedPopupUrl(url) {
  if (!isAllowedHttpUrl(url)) return false;
  try {
    return ALLOWED_POPUP_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

function wildcardToRegex(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function doesHostMatchPattern(hostname, pattern) {
  if (!pattern || typeof pattern !== 'string') return false;
  const normalized = pattern.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }
  if (normalized.includes('*')) {
    return wildcardToRegex(normalized).test(hostname);
  }
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function isSiteBlocked(url) {
  if (!featureStore.isEnabled('siteBlocker')) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false;
  const hostname = parsed.hostname.toLowerCase();
  const settings = featureStore.getFeatureSettings('siteBlocker');
  const blockedSites = Array.isArray(settings.blockedSites) ? settings.blockedSites : [];
  return blockedSites.some((sitePattern) => doesHostMatchPattern(hostname, sitePattern));
}

function initializeFallbackRuleStructures() {
  if (_initializationComplete) return;
  _trackerDomainSet.clear();
  _trackerSuffixMap.clear();
  _pathKeywordSet.clear();
  _staticHostPatternSet.clear();
  _staticSuffixMap.clear();
  _urlDecisionCache.invalidate();

  const pathKeywords = [
    '/ads/', '/ad/', '/advert', '/banner', '/tracking', '/analytics',
    '/beacon', '/pixel', '/metrics', '/telemetry', '/pagead/',
    '/doubleclick', '/google-analytics', '/googletagmanager', '/googletagservices',
  ];
  for (const kw of pathKeywords) _pathKeywordSet.add(String(kw).toLowerCase());

  const builtinTrackers = [
    'doubleclick.net', 'googlesyndication.com', 'googletagmanager.com', 'google-analytics.com',
    'googletagservices.com', 'adnxs.com', 'advertising.com', 'moatads.com', 'scorecardresearch.com',
    'quantserve.com', 'adsrvr.org', 'pubmatic.com', 'appnexus.com', 'rubiconproject.com', 'criteo.com',
    'turn.com', 'fls.doubleclick.net', 'pagead2.googlesyndication.com', 'ads.google.com',
    'analytics.google.com', 'pagead.google.com', 'cdn.segment.com', 'script.ioam.net',
    'www.googletagmanager.com', 'analytics.google.com/analytics.js',
  ];
  for (const domain of builtinTrackers) {
    const d = String(domain).toLowerCase();
    if (!_trackerDomainSet.has(d)) _trackerDomainSet.add(d);
    if (!d.includes('/') && !_trackerSuffixMap.has(d)) _trackerSuffixMap.set(d, true);
  }

  if (Array.isArray(AD_BLOCK_PATTERNS)) {
    for (const p of AD_BLOCK_PATTERNS) {
      try {
        const afterProto = String(p).includes('://') ? String(p).split('://')[1] : String(p);
        let host = (afterProto.split('/')[0] || '').toLowerCase();
        if (!host) continue;
        if (host.startsWith('*.')) {
          const suffix = host.slice(2);
          if (!_staticSuffixMap.has(suffix)) _staticSuffixMap.set(suffix, true);
        } else {
          if (!_staticHostPatternSet.has(host)) _staticHostPatternSet.add(host);
          if (!_staticSuffixMap.has(host)) _staticSuffixMap.set(host, true);
        }
      } catch (e) { }
    }
  }
  _initializationComplete = true;
}


function attachAggressiveFallbackToSession(sess) {
  if (!sess) return;
  try {
    if (_aggressiveWebRequestHandler) {
      _aggressiveActive = true;
      if (DIAG) console.info('[adblock] reactivating existing aggressive fallback handler');
      return;
    }

    _aggressiveActive = true;
    _aggressiveBlockedCount = 0;
    initializeFallbackRuleStructures();

    _aggressiveWebRequestHandler = (details, callback) => {
      try {
        if (!_aggressiveActive) return callback({});
        if (!details || !details.url) return callback({});

        const type = details.resourceType;
        if (type === 'mainFrame' || type === 'cspReport' || type === 'stylesheet' || type === 'document') {
          return callback({});
        }

        const normalizedKey = normalizeUrlForCache(details.url);
        if (!normalizedKey) return callback({});
        const cacheKey = normalizedKey + '::' + FALLBACK_RULE_VERSION.value;
        const cachedDecision = _urlDecisionCache.get(cacheKey);
        if (cachedDecision !== undefined) {
          // defensive: validate cached shape
          if (!cachedDecision || typeof cachedDecision !== 'object' || !('blocked' in cachedDecision)) {
            // treat as miss
          } else {
            _ruleMatchBreakdown.cache++;
            if (cachedDecision.blocked) {
              _aggressiveBlockedCount++;
              if (mainWindow && !mainWindow.isDestroyed()) {
                sendAdblockEvent( {
                  url: details.url,
                  blocked: true,
                  rule: cachedDecision.rule,
                  resourceType: type,
                  domain: cachedDecision.domain,
                });
              }
              return callback({ cancel: true });
            }
            return callback({});
          }
        }

        let hostname = null;
        let pathname = null;
        try {
          const urlObj = new URL(details.url);
          hostname = urlObj.hostname.toLowerCase();
          pathname = urlObj.pathname.toLowerCase();
        } catch (e) {
          _urlDecisionCache.set(cacheKey, { blocked: false, rule: '', domain: '' }, 0);
          return callback({});
        }

        if (!hostname) {
          _urlDecisionCache.set(cacheKey, { blocked: false, rule: '', domain: '' }, 0);
          return callback({});
        }

        let matchedRule = null;

        if (_staticHostPatternSet.has(hostname)) {
          matchedRule = 'static:' + hostname;
          _ruleMatchBreakdown.host++;
        } else if (!matchedRule) {
          // iterate suffixes but avoid allocations; Map iteration is acceptable small-cost
          for (const [suffix] of _staticSuffixMap) {
            if (hostname === suffix || hostname.endsWith('.' + suffix)) {
              matchedRule = 'static:' + suffix;
              _ruleMatchBreakdown.suffix++;
              break;
            }
          }
        }

        if (!matchedRule && _trackerDomainSet.has(hostname)) {
          matchedRule = 'tracker:' + hostname;
          _ruleMatchBreakdown.host++;
        } else if (!matchedRule) {
          for (const [domain] of _trackerSuffixMap) {
            if (hostname === domain || hostname.endsWith('.' + domain)) {
              matchedRule = 'tracker:' + domain;
              _ruleMatchBreakdown.suffix++;
              break;
            }
          }
        }
        if (!matchedRule && pathname) {
          for (const keyword of _pathKeywordSet) {
            if (pathname.indexOf(keyword) !== -1) {
              matchedRule = 'pattern:' + keyword;
              _ruleMatchBreakdown.path++;
              break;
            }
          }
        }

        const decision = {
          blocked: !!matchedRule,
          rule: matchedRule || '',
          domain: hostname,
        };

        // store with TTL: blocked longer, allowed short/none
        if (matchedRule) {
          _urlDecisionCache.set(cacheKey, decision, 30 * 60 * 1000);
          _aggressiveBlockedCount++;
          if (mainWindow && !mainWindow.isDestroyed()) {
            sendAdblockEvent( {
              url: details.url,
              blocked: true,
              rule: matchedRule,
              resourceType: type,
              domain: hostname,
            });
          }
          return callback({ cancel: true });
        }

        // not matched
        _ruleMatchBreakdown.none++;
        _urlDecisionCache.set(cacheKey, decision, 0);
        return callback({});
      } catch (e) {
        console.error('[adblock] fallback handler error', e && e.stack ? e.stack : e);
        return callback({});
      }
    };

    try {
      sess.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, _aggressiveWebRequestHandler);
      console.info('[adblock] ✓ FALLBACK BLOCKER ATTACHED to webRequest.onBeforeRequest');
    } catch (e) {
      console.error('[adblock] failed to attach fallback blocker:', e && e.stack ? e.stack : e);
      _aggressiveActive = false;
      return;
    }

    // ensure periodic cache cleanup for TTLs
    try { _urlDecisionCache.startPeriodicCleanup(60 * 1000); } catch (e) { }

    (async () => {
      try {
        const listUrls = [
          'https://easylist.to/easylist/easylist.txt',
          'https://easylist.to/easylist/easyprivacy.txt',
        ];
        const generatedPatterns = await generateHostPatterns(listUrls, 5000);
        if (Array.isArray(generatedPatterns) && generatedPatterns.length > 0) {
          for (const p of generatedPatterns) {
            try {
              const m = /\*:\/\/\*\.(.*)\/\*/.exec(p);
              if (m && m[1]) {
                const domain = String(m[1]).toLowerCase();
                if (!_trackerSuffixMap.has(domain)) _trackerSuffixMap.set(domain, true);
              }
            } catch (e) { }
          }
          // new rules -> invalidate cache to avoid stale answers
          _urlDecisionCache.invalidate();
          console.info('[adblock] ✓ loaded', generatedPatterns.length, 'patterns from EasyList; total domains:', _trackerSuffixMap.size);
        } else {
          console.warn('[adblock] EasyList download returned no patterns, using built-in trackers');
        }
      } catch (e) {
        console.error('[adblock] failed to fetch EasyList patterns:', e && e.stack ? e.stack : e);
      }
    })();

    if (!_networkCountersAttached && DIAG) {
      _networkCountersAttached = true;
      try {
        sess.webRequest.onCompleted({ urls: ['*://*/*'] }, (details) => {
          try {
            if (!details || !details.url) return;
            if (details.resourceType === 'mainFrame') return;
            _networkRequestCount += 1;
          } catch (e) { }
        });
        console.info('[adblock] ✓ DIAGNOSTIC COUNTERS ATTACHED (onCompleted)');
      } catch (e) {
        console.error('[adblock] failed to attach network counters', e && e.stack ? e.stack : e);
      }
    }

    if (!_diagnosticInterval && DIAG) {
      _diagnosticInterval = setInterval(() => {
        try {
          const nativeBlocked = _nativeBlockedCount || 0;
          const aggressiveBlocked = _aggressiveBlockedCount || 0;
          const totalBlocked = nativeBlocked + aggressiveBlocked;
          const totalReq = _networkRequestCount || 0;
          const coverage = totalReq > 0 ? Math.round((totalBlocked / totalReq) * 100) : 0;
          console.info('[adblock][diagnostics]', {
            totalRequests: totalReq,
            nativeBlocked,
            aggressiveBlocked,
            totalBlocked,
            coverage: coverage + '%',
            cacheSize: _urlDecisionCache.cache.size,
            ruleVersion: FALLBACK_RULE_VERSION.value,
            timestamp: new Date().toISOString()
          });
        } catch (e) { }
      }, 5000);
      console.info('[adblock] diagnostics interval started (5s)');
    }
  } catch (e) {
    console.error('[adblock] attachAggressiveFallbackToSession error', e && e.stack ? e.stack : e);
  }
}

function deactivateAggressiveFallback() {
  _aggressiveActive = false;
}



function emitSettingsState(senderId = null) {
  const snapshot = featureStore.getPublicSnapshot();
  // Keep Chromium's prefers-color-scheme media feature in lock-step with the
  // persisted Theme Mode for every webContents (chrome, internal pages, and
  // normal websites). Cheap and idempotent, so it runs on every settings
  // change regardless of which feature actually changed.
  syncNativeColorScheme();
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.webContents.id !== senderId) {
      mainWindow.webContents.send('settings-updated', snapshot);
    }
  }
  // Live-sync the omnibox overlay too — it is a trusted window (same preload
  // and trust model as the chrome) and consumes the same theme snapshot so the
  // suggestions dropdown re-skins instantly with the rest of the UI.
  if (overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.webContents.id !== senderId) {
    overlayWindow.webContents.send('settings-updated', snapshot);
  }
  // Live-sync every Kairon-owned internal page loaded in tabs (home, history,
  // settings, https-warning). Trust follows the currently loaded URL: only
  // webContents still on a local internal page receive updates, so a page that
  // navigated away (or any normal website) loses the feed immediately.
  for (const tab of tabs.values()) {
    try {
      const wc = tab.view && tab.view.webContents;
      if (!wc || wc.isDestroyed() || wc.id === senderId) continue;
      if (isInternalKaironPageWebContents(wc)) wc.send('settings-updated', snapshot);
    } catch (e) { }
  }
  // The Incognito window follows the same global theme: its chrome consumes
  // the snapshot over incognito-settings-updated, and its tabs showing the
  // Incognito home page consume it over the standard settings-updated push.
  try {
    broadcastSettingsToIncognito(snapshot, senderId);
  } catch (e) { }
  // Additional normal windows (Ctrl+N) also follow the global theme.
  try {
    broadcastSettingsToNewWindows(snapshot, senderId);
  } catch (e) { }
}

function getActiveTab() {
  if (!activeTabId) return null;
  return tabs.get(activeTabId) || null;
}

/**
 * Give keyboard focus to the active tab's BrowserView webContents. Safe no-op
 * when the tab/window is gone or the webContents is destroyed. Called after the
 * view has been attached and positioned so the page is immediately ready to
 * receive keyboard input (tab switching, Alt+Tab return, new tabs, wake, etc.).
 */
function focusActiveTabWebContents() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const tab = getActiveTab();
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return;
  try {
    tab.view.webContents.focus();
  } catch (e) { }
}

// ── FULLSCREEN HELPERS ────────────────────────────────────────

/** The tab currently in content fullscreen, or null (also null if destroyed). */
function getHtmlFullscreenTab() {
  if (htmlFullscreenTabId == null) return null;
  const tab = tabs.get(htmlFullscreenTabId);
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return null;
  return tab;
}

/**
 * A website requested fullscreen via the Fullscreen API (enter-html-full-screen).
 * Put the window into fullscreen so the BrowserView can cover the whole screen,
 * and remember the prior window state so leaving content fullscreen restores it.
 */
function handleEnterHtmlFullScreen(tabId) {
  if (htmlFullscreenTabId === tabId) return; // idempotent
  const tab = tabs.get(tabId);
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return;
  htmlFullscreenTabId = tabId;
  // Note: Electron may have already auto-fullscreened the window for this
  // request, so base the "was it fullscreen before" decision on the F11 flag
  // rather than win.isFullScreen().
  windowFullscreenBeforeHtml = userWindowFullscreen;
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFullScreen()) {
    mainWindow.setFullScreen(true);
  }
  tab._lastBounds = null;
  updateBounds();
  diag('[fullscreen] enter html full-screen tab', tabId);
}

/**
 * The website left content fullscreen (leave-html-full-screen — ESC or the page
 * calling document.exitFullscreen()). Restore the window to its previous state.
 */
function handleLeaveHtmlFullScreen(tabId) {
  if (htmlFullscreenTabId !== tabId) return;
  htmlFullscreenTabId = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (!windowFullscreenBeforeHtml && mainWindow.isFullScreen()) {
      mainWindow.setFullScreen(false);
    }
  }
  windowFullscreenBeforeHtml = false;
  const tab = tabs.get(tabId);
  if (tab) tab._lastBounds = null;
  updateBounds();
  diag('[fullscreen] leave html full-screen tab', tabId);
}

/**
 * F11 — browser-level shortcut that toggles the Kairon window's own fullscreen.
 * The webpage is never put into fullscreen by F11.
 * If a website is currently in content fullscreen, F11 exits that content
 * fullscreen (same as ESC) instead of toggling the window, so the two
 * fullscreen modes never conflict. The window returns to whatever state it
 * was in before the website entered fullscreen.
 */
function toggleBrowserFullscreen() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (htmlFullscreenTabId != null) {
    const tab = getHtmlFullscreenTab();
    if (tab) {
      try {
        tab.view.webContents.executeJavaScript(
          'if (document.fullscreenElement) { document.exitFullscreen(); }'
        ).catch(() => {});
      } catch (e) { }
    }
    // Exit content fullscreen (same as ESC) and restore the window to whatever
    // state it was in before the website entered fullscreen. We reset state
    // here directly rather than relying solely on the 'leave-html-full-screen'
    // event (historically unreliable for BrowserViews); if the event does fire
    // afterwards, handleLeaveHtmlFullScreen() sees the cleared state and no-ops.
    htmlFullscreenTabId = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!windowFullscreenBeforeHtml && mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
      }
    }
    windowFullscreenBeforeHtml = false;
    const activeTab = getActiveTab();
    if (activeTab) {
      activeTab._lastBounds = null;
      updateBounds();
    }
    return;
  }
  const nextState = !mainWindow.isFullScreen();
  userWindowFullscreen = nextState;
  mainWindow.setFullScreen(nextState);
  // Recompute the active view immediately; the window resize event refines
  // the bounds once the OS finishes the transition.
  const tab = getActiveTab();
  if (tab) {
    tab._lastBounds = null;
    updateBounds();
  }
  diag('[fullscreen] F11 window fullscreen ->', nextState);
}

function sanitizeTabSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isInteger(raw.id) || raw.id <= 0) return null;
  if (typeof raw.url !== 'string' || !isPersistableUrl(raw.url)) return null;
  const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.slice(0, 256) : 'New Tab';
  return { id: raw.id, url: raw.url, title };
}

function getSessionSnapshot() {
  const tabList = Array.from(tabs.values()).map((tab) => ({
    id: tab.id,
    url: isPersistableUrl(tab.url) ? tab.url : HOME_PAGE_URL,
    title: typeof tab.title === 'string' ? tab.title.slice(0, 256) : 'New Tab',
  }));
  const safeActive = tabList.some((tab) => tab.id === activeTabId) ? activeTabId : (tabList[0]?.id || null);
  return { activeTabId: safeActive, tabs: tabList };
}

let _sessionPersistTimer = null;
let _lastSessionSnapshot = null;
function persistSession() {
  // Debounced so rapid tab/navigation events don't cause a synchronous disk
  // write on every emitTabsState(). The latest snapshot is captured eagerly and
  // always flushed on app quit via flushSessionPersist().
  _lastSessionSnapshot = getSessionSnapshot();
  if (_sessionPersistTimer) return;
  _sessionPersistTimer = setTimeout(() => {
    _sessionPersistTimer = null;
    try {
      store.set(SESSION_STORE_KEY, _lastSessionSnapshot);
    } catch (err) {
      logError('session-persist-failed', err);
    }
  }, 500);
}

function flushSessionPersist() {
  // IMPORTANT: The window 'closed' handler clears the `tabs` Map before
  // before-quit fires on the window-close quit path, so we must write the
  // last *captured* snapshot rather than recomputing one from cleared tabs.
  if (_sessionPersistTimer) {
    clearTimeout(_sessionPersistTimer);
    _sessionPersistTimer = null;
  }
  if (!_lastSessionSnapshot) return;
  try {
    store.set(SESSION_STORE_KEY, _lastSessionSnapshot);
  } catch (err) {
    logError('session-persist-failed', err);
  }
}

function restoreSessionState() {
  try {
    const stored = store.get(SESSION_STORE_KEY);
    if (!stored || typeof stored !== 'object' || !Array.isArray(stored.tabs)) return null;
    const sanitizedTabs = stored.tabs.map(sanitizeTabSnapshot).filter(Boolean).slice(0, MAX_SESSION_TABS);
    if (sanitizedTabs.length === 0) return null;
    const activeCandidate = Number.isInteger(stored.activeTabId) ? stored.activeTabId : sanitizedTabs[0].id;
    const active = sanitizedTabs.some((tab) => tab.id === activeCandidate) ? activeCandidate : sanitizedTabs[0].id;
    return { activeTabId: active, tabs: sanitizedTabs };
  } catch (err) {
    logError('session-restore-failed', err);
    return null;
  }
}

function isPlainHttpUrl(input) {
  try {
    return new URL(input).protocol === 'http:';
  } catch {
    return false;
  }
}

function showHttpsOnlyWarning(tab, httpUrl) {
  const normalizedHttpUrl = new URL(httpUrl).href;
  tab.httpsUpgradeAttempt = null;
  tab.httpsOnlyWarningUrl = normalizedHttpUrl;
  tab.httpProceedUrl = normalizedHttpUrl;
  tab.isInternalHome = false;
  tab.view.webContents.loadFile(HTTPS_WARNING_FILE, { query: { url: normalizedHttpUrl, ...getThemeQuery() } })
    .catch((err) => logError(`tab-${tab.id}-https-warning-load-failed`, err));
}

async function upgradeHttpNavigation(tab, httpUrl) {
  const normalizedHttpUrl = new URL(httpUrl).href;
  const httpsUrl = new URL(normalizedHttpUrl);
  httpsUrl.protocol = 'https:';
  const attempt = { httpUrl: normalizedHttpUrl, httpsUrl: httpsUrl.href };
  tab.httpsUpgradeAttempt = attempt;
  tab.httpsOnlyWarningUrl = null;
  tab.httpProceedUrl = null;
  tab.isInternalHome = false;

  try {
    await tab.view.webContents.loadURL(attempt.httpsUrl);
  } catch (err) {
    if (tab.httpsUpgradeAttempt !== attempt) return;
    if (!featureStore.isEnabled('httpsOnlyMode')) {
      tab.httpsUpgradeAttempt = null;
      tab.view.webContents.loadURL(normalizedHttpUrl).catch((loadErr) => logError(`tab-${tab.id}-http-load-failed`, loadErr));
      return;
    }
    logError(`tab-${tab.id}-https-upgrade-failed`, err);
    showHttpsOnlyWarning(tab, normalizedHttpUrl);
  }
}

const ZOOM_STEPS = Object.freeze([
  0.25, 0.33, 0.50, 0.67, 0.75, 0.80, 0.90, 1.00, 1.10, 1.25, 1.50, 1.75, 2.00, 2.50, 3.00, 4.00, 5.00
]);

function setTabZoom(tab, factor) {
  if (!tab) return;
  const clampedFactor = Math.max(0.25, Math.min(5.0, Math.round(factor * 100) / 100));
  tab.zoomFactor = clampedFactor;
  try {
    tab.view.webContents.setZoomFactor(clampedFactor);
    if (clampedFactor === 1.0) {
      tab.view.webContents.executeJavaScript('window.scrollTo(0, 0)').catch(() => { });
    }
  } catch (err) {
    logError(`tab-${tab.id}-set-zoom-failed`, err);
  }
  updateBounds();
  emitTabsState();
}

function zoomInTab(tab) {
  if (!tab) return;
  const current = tab.zoomFactor || 1.0;
  const nextStep = ZOOM_STEPS.find((s) => s > current + 0.005);
  const target = nextStep !== undefined ? nextStep : Math.min(5.0, current + 0.1);
  setTabZoom(tab, target);
}

function zoomOutTab(tab) {
  if (!tab) return;
  const current = tab.zoomFactor || 1.0;
  const prevStep = [...ZOOM_STEPS].reverse().find((s) => s < current - 0.005);
  const target = prevStep !== undefined ? prevStep : Math.max(0.25, current - 0.1);
  setTabZoom(tab, target);
}

function resetTabZoom(tab) {
  if (!tab) return;
  setTabZoom(tab, 1.0);
}

function getTabPublicState(tab) {
  // The renderer only reads canGoBack/canGoForward for the ACTIVE tab (it drives
  // the back/forward buttons). Compute fresh values for the active tab only and
  // reuse cached values for background tabs — those are always recomputed fresh
  // when the tab becomes active via switchToTab() → emitTabsState().
  let canGoBack = !!tab._canGoBack;
  let canGoForward = !!tab._canGoForward;
  if (tab.id === activeTabId) {
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
    sleeping: !!tab.sleeping,
    pinned: !!tab.pinned,
    canGoBack,
    canGoForward,
    zoomFactor: typeof tab.zoomFactor === 'number' ? tab.zoomFactor : 1.0,
  };
}

// Throttled tabs-state emitter: collapses rapid-fire events (did-navigate +
// page-title-updated + loading in <5 ms) into a single IPC + persist cycle.
// Uses a microtask gate so the flush happens before the next frame but after
// the current synchronous call stack drains — perceptible delay = 0.
let _tabsStatePending = false;
function emitTabsState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (_tabsStatePending) return; // already scheduled — skip redundant work
  _tabsStatePending = true;
  queueMicrotask(() => {
    _tabsStatePending = false;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const payload = {
      activeTabId,
      tabs: Array.from(tabs.values()).map(getTabPublicState),
    };
    mainWindow.webContents.send('tabs-state', payload);
    persistSession();
  });
}

function sendActiveTabSignals() {
  const tab = getActiveTab();
  if (!tab || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('url-changed', tab.url || '');
  mainWindow.webContents.send('title-changed', tab.title || 'New Tab');
  mainWindow.webContents.send('loading', !!tab.loading);
  pushActiveBookmarkState();
}

// ── BOOKMARK STAR STATE (chrome) ──────────────────────────────
// Single source of truth for the chrome's bookmark star AND the star popup
// (Quick Access / Bookmarks chooser). Computed here in the main process so
// the renderer never parses URLs or normalizes bookmarks — it just renders
// what main says. Non-bookmarkable pages (internal Kairon pages,
// error/https-warning pages, non-http(s) URLs) always report
// bookmarkable:false so the star disables itself and internal pages can
// never be bookmarked or added to Quick Access.

// The live webContents URL is the ground truth for what page a tab is really
// showing: after ANY committed navigation it reflects the actual document,
// regardless of how the tab's bookkeeping (tab.url / isInternalHome) was
// updated. Star state and the Quick Access / Bookmarks toggles use this so a
// tab that navigated away from an internal page (e.g. a cold-start home tab
// searched from) is never pinned to kairon://home. Falls back to the
// bookkeeping URL only while the webContents isn't usable yet.
function getAuthoritativeTabUrl(tab) {
  if (!tab) return '';
  try {
    const wc = tab.view && tab.view.webContents;
    if (wc && !wc.isDestroyed()) {
      const live = wc.getURL();
      if (typeof live === 'string' && live.trim()) return live;
    }
  } catch (e) { }
  return tab.url || '';
}

function getActiveBookmarkState() {
  const tab = getActiveTab();
  if (!tab || !bookmarkService) {
    return { url: '', title: '', favicon: '', bookmarked: false, bookmarkable: false, inQuickAccess: false };
  }
  const wc = tab.view && tab.view.webContents;
  const isInternal = !!(wc && !wc.isDestroyed()) && isInternalKaironPageWebContents(wc);
  const liveUrl = getAuthoritativeTabUrl(tab);
  // Report the kairon:// URL for internal pages (the chrome renders those as
  // their kairon:// address), and the real http(s) URL for everything else —
  // taken from the live webContents, never from stale restore-time bookkeeping.
  const url = isInternal ? (tab.url || liveUrl || '') : (liveUrl || tab.url || '');
  let bookmarkable = false;
  try {
    bookmarkable = isAllowedHttpUrl(url) && !!(wc && !wc.isDestroyed()) && !isInternal;
  } catch (e) {
    bookmarkable = false;
  }

  const bookmarked = bookmarkable ? !!bookmarkService.isBookmarked(url) : false;
  const inQuickAccess = bookmarkable && quickAccessService ? !!quickAccessService.isInQuickAccess(url) : false;
  return {
    url,
    title: (tab.title && typeof tab.title === 'string') ? tab.title : '',
    favicon: (tab.favicon && typeof tab.favicon === 'string') ? tab.favicon : '',
    bookmarked,
    bookmarkable,
    inQuickAccess,
  };
}

// Push the active tab's bookmark state to the chrome so the star stays in
// sync with Ctrl+D, the button, and bookmark changes made anywhere else.
function pushActiveBookmarkState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('bookmark-state-changed', getActiveBookmarkState());
  } catch (e) { }
}

// ── BOOKMARKS ──────────────────────────────────────────────────
// Ctrl+D toggles the active page's bookmark. Only normal http(s) pages are
// bookmarkable — internal Kairon pages (kairon://*, file:, about:, etc.) are
// silently ignored. Feedback is shown through the overlay toast so it paints
// above BrowserView content no matter where keyboard focus was.
function toggleBookmarkForTab(tab) {
  if (!tab || !bookmarkService) return;
  // The live webContents URL is authoritative (never the URL the tab was
  // restored/created with), so the toggle works on the page actually shown.
  const url = getAuthoritativeTabUrl(tab);
  if (!url || !isAllowedHttpUrl(url)) return;
  const favicon = (tab.favicon && typeof tab.favicon === 'string') ? tab.favicon : '';
  const result = bookmarkService.toggleBookmark(url, tab.title || '', favicon);
  broadcastBookmarksState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    showOverlayToast(result.bookmarked ? 'Bookmark added' : 'Bookmark removed');
  }
}  // Push the current bookmark list to every open Bookmarks page so it stays
  // live (Ctrl+D in another tab, deletes, etc.) without polling, and refresh
  // the chrome star (any mutation can affect the active tab). The normal
  // browser chrome also receives the list to render the bookmarks bar; the
  // Incognito window is deliberately excluded (its prefixed channels can't
  // reach this, and it must never read the normal bookmark store).
function broadcastBookmarksState() {
  if (!bookmarkService) return;
  const list = bookmarkService.getBookmarks();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('bookmarks-updated', list); } catch (e) { }
  }
  for (const tab of tabs.values()) {
    try {
      const wc = tab.view && tab.view.webContents;
      if (!wc || wc.isDestroyed()) continue;
      if (isInternalBookmarksPage({ sender: wc })) wc.send('bookmarks-updated', list);
    } catch (e) {    }
  }
  pushActiveBookmarkState();
  // Additional normal windows (Ctrl+N) also receive bookmark updates.
  try { broadcastBookmarksToNewWindows(); } catch (e) { }
}

// ── QUICK ACCESS (home / new-tab page) ────────────────────────
// The star popup's "Add to Quick Access" / "Remove from Quick Access" action.
// Only normal http(s) pages are eligible — internal Kairon pages are rejected
// upstream (the star is disabled there). Feedback goes through the overlay
// toast, same as bookmark toggles.
function toggleQuickAccessForTab(tab) {
  if (!tab || !quickAccessService) return;
  // Same authoritative URL rule as toggleBookmarkForTab.
  const url = getAuthoritativeTabUrl(tab);
  if (!url || !isAllowedHttpUrl(url)) return;
  const favicon = (tab.favicon && typeof tab.favicon === 'string') ? tab.favicon : '';
  const result = quickAccessService.toggle(url, tab.title || '', favicon);
  broadcastQuickAccessState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    showOverlayToast(result.inQuickAccess ? 'Added to Quick Access' : 'Removed from Quick Access');
  }
}

// Push the current Quick Access list to every open home/new-tab page so it
// reflects changes immediately (no restart, no manual refresh), and refresh
// the chrome star state (Quick Access membership is part of it). The normal
// browser chrome also receives the list for symmetry; the Incognito window
// is deliberately excluded (its prefixed channels can't reach this, and it
// must never read the normal Quick Access store).
function broadcastQuickAccessState() {
  if (!quickAccessService) return;
  const list = quickAccessService.getEntries();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('quick-access-updated', list); } catch (e) { }
  }
  for (const tab of tabs.values()) {
    try {
      const wc = tab.view && tab.view.webContents;
      if (!wc || wc.isDestroyed()) continue;
      if (isInternalHomePage({ sender: wc })) wc.send('quick-access-updated', list);
    } catch (e) { }
  }
  pushActiveBookmarkState();
}

// ── INTERNAL PAGE TRANSITIONS ────────────────────────────────────────────
// Navigating between two Kairon-owned internal pages (home / settings /
// history / downloads) gets a short, subtle cross-fade: the current page dips
// to ~45% opacity over INTERNAL_PAGE_FADE_MS, then the new page is loaded with
// ?transition=1 so it fades in from 45% opacity with a ~5px rise (~150ms).
// First loads (launch, new tabs, restores) and navigation from normal websites
// never animate, and prefers-reduced-motion disables the whole effect.
const INTERNAL_PAGE_FADE_MS = 70;

function prefersReducedMotion() {
  try {
    return nativeTheme.shouldUseReducedMotion === true;
  } catch (e) {
    return false;
  }
}

// Slightly fade the currently displayed internal page just before it is
// replaced by another internal page. Opacity only (compositor-friendly); the
// inline styles die with the document when the new page loads.
// executeJavaScript is async, so the script re-checks that it still runs in
// the same document it was queued for: during rapid navigation the next page
// can commit before the script executes, and without this guard the inline
// fade styles would leak into (and stick on) the newly loaded document.
function fadeOutInternalPage(tab) {
  const wc = tab.view && tab.view.webContents;
  if (!wc || wc.isDestroyed()) return;
  let expectedPath = '';
  try {
    expectedPath = new URL(wc.getURL()).pathname;
  } catch (e) {
    expectedPath = '';
  }
  if (!expectedPath) return;
  try {
    wc.executeJavaScript(
      "(function(){try{var d=document.documentElement;if(!d||!location.pathname||location.pathname!=='" + expectedPath + "')return;d.style.transition='opacity " + INTERNAL_PAGE_FADE_MS + "ms ease-out';d.style.opacity='0.45';}catch(e){}})();"
    ).catch(() => {});
  } catch (e) {}
}

function navigateTabToTarget(tab, target) {
  if (DIAG) console.info('[tab] navigating to', target, 'from', tab.url);
  // Defense in depth: only web schemes (plus the internal home/history pages)
  // may ever reach loadURL(). All current callers normalize first, but this
  // keeps any future caller (e.g. popup handling) from loading local schemes.
  if (!isAllowedHttpUrl(target) && !isHomeUrl(target) && !isHistoryUrl(target) && !isDownloadsUrl(target) && !isBookmarksUrl(target) && !isSettingsUrl(target)) {
    if (DIAG) console.info('[tab] navigation target rejected', target);
    return;
  }
  // Defense in depth: reject blocked sites before loadURL(). Callers are
  // expected to check isSiteBlocked before calling this function, but this
  // guard ensures a blocked URL can never reach loadURL() regardless of
  // how navigateTabToTarget is invoked (popup, redirect, future caller).
  if (isSiteBlocked(target)) {
    if (DIAG) console.info('[tab] navigation target blocked by site-blocker', target);
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendAdblockEvent( {
          url: target,
          blocked: true,
          rule: 'site-blocker',
          resourceType: 'navigation',
          domain: (() => { try { return new URL(target).hostname; } catch { return null; } })(),
        });
      }
    } catch (e) { }
    return;
  }

  // Internal → internal navigation gets the entrance transition. It only
  // fires when the current tab is already showing a Kairon-owned internal
  // page — never on first load, new tabs, session restore, or from normal
  // websites (their webContents URL cannot match an internal file URL).
  const animateTransition = isInternalKaironPageWebContents(tab.view && tab.view.webContents) && !prefersReducedMotion();

  // Load an internal page, optionally with the entrance transition. When
  // animating, the old page fades out first and the new page receives
  // ?transition=1 so its document fades in on top; otherwise it renders
  // instantly (first paint must never animate).
  const loadInternal = (file, extraQuery) => {
    const query = getThemeQuery();
    if (extraQuery) Object.assign(query, extraQuery);
    if (animateTransition) query.transition = '1';
    const doLoad = () => {
      tab.view.webContents.loadFile(file, { query }).catch((err) => logError(`tab-${tab.id}-internal-load-failed`, err));
    };
    if (animateTransition) {
      fadeOutInternalPage(tab);
      setTimeout(doLoad, INTERNAL_PAGE_FADE_MS);
    } else {
      doLoad();
    }
  };

  if (target === HOME_PAGE_URL) {
    tab.isInternalHome = true;
    tab.url = HOME_PAGE_URL;
    tab.title = 'Home';
    // Pass the persisted theme so the page renders it before first paint.
    loadInternal(HOME_PAGE_FILE);
    return;
  }
  if (isHistoryUrl(target)) {
    tab.isInternalHome = true;
    tab.url = 'kairon://history';
    tab.title = 'History';
    // Pass the persisted theme so the page renders it before first paint.
    loadInternal(HISTORY_PAGE_FILE);
    return;
  }
  if (isDownloadsUrl(target)) {
    // Internal downloads page — loaded locally, never remote content.
    tab.isInternalHome = true;
    tab.url = DOWNLOAD_PAGE_URL;
    tab.title = 'Downloads';
    // Pass the persisted theme so the page renders it before first paint.
    loadInternal(DOWNLOAD_PAGE_FILE);
    return;
  }
  if (isBookmarksUrl(target)) {
    // Internal bookmarks page — loaded locally, never remote content.
    tab.isInternalHome = true;
    tab.url = BOOKMARKS_PAGE_URL;
    tab.title = 'Bookmarks';
    // Pass the persisted theme so the page renders it before first paint.
    loadInternal(BOOKMARKS_PAGE_FILE);
    return;
  }
  if (isSettingsUrl(target)) {
    // Internal settings page — loaded locally, never remote content. Deep
    // links (kairon://settings/<section>) are passed through as a query so
    // the page can open the requested category.
    tab.isInternalHome = true;
    tab.url = target;
    tab.title = 'Settings';
    const section = getSettingsSectionFromUrl(target);
    // Pass the persisted theme (and any deep-link section) as query params so
    // the page can render the correct theme before first paint. The page still
    // re-applies the authoritative value from its live snapshot on load.
    loadInternal(SETTINGS_PAGE_FILE, section ? { section } : null);
    return;
  }
  tab.isInternalHome = false;
  if (featureStore.isEnabled('httpsOnlyMode') && isPlainHttpUrl(target)) {
    upgradeHttpNavigation(tab, target);
    return;
  }
  tab.httpsUpgradeAttempt = null;
  tab.httpsOnlyWarningUrl = null;
  tab.httpProceedUrl = null;
  tab.view.webContents.loadURL(target).catch((err) => logError(`tab-${tab.id}-load-failed`, err));
}

/**
 * Open a URL in a new standalone BrowserWindow.
 * Used by the context menu's "Open Link in New Window" action.
 * Creates a simple window without the full Kairon chrome UI.
 */
function openLinkInNewWindow(url) {
  // Validate the URL through the same navigation guards as all other
  // user-initiated navigation paths (address bar, context menu, IPC).
  const target = normalizeNavigationTarget(url);
  if (!target) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('navigation-invalid', { input: typeof url === 'string' ? url : '' });
      }
    } catch (e) { }
    return;
  }
  if (isSiteBlocked(target)) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendAdblockEvent( {
          url: target,
          blocked: true,
          rule: 'site-blocker',
          resourceType: 'navigation',
          domain: (() => { try { return new URL(target).hostname; } catch { return null; } })(),
        });
      }
    } catch (e) { }
    return;
  }
  try {
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      minWidth: 800,
      minHeight: 500,
      // Match the pre-load background to the persisted theme so a Kairon-owned
      // window never flashes the wrong dark/light color before the page paints
      // (same pattern as the main window). The page itself is never restyled.
      backgroundColor: getCurrentThemeMode() === 'light' ? '#f0f0f0' : '#080810',
      icon: getAppIcon(),
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: 'persist:browser',
      },
    });

    standaloneWindows.add(win);
    win.on('closed', () => { standaloneWindows.delete(win); });

    win.loadURL(target).catch((err) => logError('new-window-load', err));
    win.once('ready-to-show', () => {
      try {
        win.show();
        win.maximize();
      } catch (e) { }
    });
  } catch (err) {
    logError('open-link-new-window', err);
  }
}

function createTab(initialTarget = HOME_PAGE_URL) {
  const id = nextTabId++;
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
    httpsUpgradeAttempt: null,
    httpsOnlyWarningUrl: null,
    httpProceedUrl: null,
    sleeping: false,
    // Real page favicon URL captured from page-favicon-updated (used to seed
    // bookmarks with the actual favicon when available).
    favicon: '',
    lastActiveAt: Date.now(),
    listeners: [],
  };
  tabs.set(id, tab);
  tabSleepManager.trackTab(tab);

  const webContents = view.webContents;
  applyWebRtcProtection(webContents);

  webContents.on('did-finish-load', () => {
    try { webContents.setZoomFactor(tab.zoomFactor || 1.0); } catch (e) {}
    if (DIAG) console.info('[tab] did-finish-load', id);
    if (tab.httpsUpgradeAttempt) {
      try {
        if (new URL(webContents.getURL()).protocol === 'https:') tab.httpsUpgradeAttempt = null;
      } catch (e) { }
    }
  });
  webContents.on('dom-ready', () => {
    try { webContents.setZoomFactor(tab.zoomFactor || 1.0); } catch (e) {}
    if (DIAG) console.info('[tab] dom-ready', id);
  });
  webContents.on('did-fail-load', (e, code, desc, url) => console.error('[tab] did-fail-load', id, code, desc, url));
  webContents.on('console-message', (e, level, message, line, sourceId) => { if (DIAG) console.info('[tab][console]', id, message, sourceId, 'L' + line); });
  if (process.env.KAIRON_DEBUG_UI === '1') {
    try { webContents.openDevTools({ mode: 'right' }); } catch (e) { }
  }

  webContents.on('dom-ready', () => {
    try {
      if (contentBlockingRuntime) {
        try { contentBlockingRuntime.applyCssOnDomReady(webContents); } catch (e) { }
      } else if (adblockerService && adblockerService.css) {
        webContents.insertCSS(adblockerService.css).catch((err) => logError('insert-css-failed', err));
      }
    } catch (e) { }
  });

  const onWillNavigate = (event, url) => {
    try {
      // Allow a slightly broader set of navigation schemes that some sites use
      let allowed = false;
      try {
        const parsed = new URL(url);
        allowed = ALLOWED_PROTOCOLS.has(parsed.protocol) || parsed.protocol === 'about:';
      } catch (e) {
        allowed = isAllowedHttpUrl(url);
      }
      if (!allowed || isSiteBlocked(url)) {
        try { if (DIAG) console.info('[tab] will-navigate blocked', id, url, 'allowed=', allowed, 'siteBlocked=', isSiteBlocked(url)); } catch (e) { }
        event.preventDefault();
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            sendAdblockEvent( {
              url,
              blocked: true,
              rule: isSiteBlocked(url) ? 'site-blocker' : 'navigation-invalid',
              resourceType: 'mainFrame',
              domain: (() => { try { return new URL(url).hostname; } catch { return null; } })(),
            });
          }
        } catch (e) { }
        return;
      }

      if (isPlainHttpUrl(url)) {
        const normalizedUrl = new URL(url).href;
        if (tab.httpProceedUrl === normalizedUrl) {
          tab.httpProceedUrl = null;
          tab.httpsOnlyWarningUrl = null;
        } else if (featureStore.isEnabled('httpsOnlyMode')) {
          event.preventDefault();
          navigateTabToTarget(tab, normalizedUrl);
          return;
        }
      }
    } catch (e) { }
    tab.isInternalHome = false;
  };

  const onWillRedirect = (event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    // Site-blocker enforcement: prevent redirects to blocked domains.
    // This check runs regardless of HTTPS-only mode so blocked domains
    // can never be reached through server-side redirects.
    if (isSiteBlocked(url)) {
      event.preventDefault();
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendAdblockEvent( {
            url,
            blocked: true,
            rule: 'site-blocker',
            resourceType: 'navigation',
            domain: (() => { try { return new URL(url).hostname; } catch { return null; } })(),
          });
        }
      } catch (e) { }
      return;
    }
    // HTTPS-only mode: intercept plain-HTTP redirects and either upgrade
    // or show the HTTPS-only warning.
    if (!featureStore.isEnabled('httpsOnlyMode') || !isPlainHttpUrl(url)) return;
    event.preventDefault();
    if (tab.httpsUpgradeAttempt) {
      showHttpsOnlyWarning(tab, tab.httpsUpgradeAttempt.httpUrl);
      return;
    }
    navigateTabToTarget(tab, url);
  };

  const onDidNavigate = (_, url) => {
    if (tab.showingErrorPage) {
      // The error page itself just loaded: keep the originally requested URL in
      // the address bar and never record the local error file in history. Any
      // navigation away (Try again / Go back / address bar) clears the flag and
      // falls through to the normal bookkeeping below.
      if (isErrorPageFileUrl(url) || isIpNotFoundPageFileUrl(url)) {
        tab.url = tab.showingErrorPage.url || url;
        if (activeTabId === id) {
          mainWindow.webContents.send('url-changed', tab.url);
          pushActiveBookmarkState();
        }
        emitTabsState();
        return;
      }
      tab.showingErrorPage = null;
    }
    // The committed document URL is authoritative. A tab still flagged as an
    // internal page (isInternalHome — set at creation/restore for home tabs)
    // that commits a real http(s) page means the will-navigate bookkeeping was
    // missed (cold-start home-tab → search navigation race, programmatic
    // loads, etc.). Clear the stale flag so the tab's URL follows the actual
    // page instead of staying pinned to kairon://home — which would otherwise
    // leave the star disabled and the Bookmark/Quick Access toggles inert.
    if (tab.isInternalHome && isAllowedHttpUrl(url) && !isInternalKaironPageWebContents(tab.view && tab.view.webContents)) {
      tab.isInternalHome = false;
    }
    tab.url = tab.isInternalHome ? (tab.url || HOME_PAGE_URL) : (tab.httpsOnlyWarningUrl || url);
    if (activeTabId === id) {
      mainWindow.webContents.send('url-changed', tab.url);
      pushActiveBookmarkState();
    }
    emitTabsState();

    // Record successful page navigation to history
    try {
      if (!tab.isInternalHome && !tab.httpsOnlyWarningUrl && url && historyService) {
        const currentTitle = tab.title && tab.title !== 'New Tab' ? tab.title : '';
        historyService.addHistoryEntry(url, currentTitle);
      }
    } catch (e) {
      logError(`tab-${id}-history-record`, e);
    }
  };

  const onDidNavigateInPage = (_, url) => {
    // Same stale-internal-flag correction as onDidNavigate: an in-page
    // navigation committing a real http(s) URL on a tab still flagged as an
    // internal page must clear the flag, never keep tab.url pinned to home.
    if (tab.isInternalHome && isAllowedHttpUrl(url) && !isInternalKaironPageWebContents(tab.view && tab.view.webContents)) {
      tab.isInternalHome = false;
    }
    tab.url = tab.isInternalHome ? HOME_PAGE_URL : url;
    if (activeTabId === id) {
      mainWindow.webContents.send('url-changed', tab.url);
      pushActiveBookmarkState();
    }
    emitTabsState();
  };

  const onPageTitleUpdated = (_, title) => {
    tab.title = title || 'Untitled';
    if (activeTabId === id) mainWindow.webContents.send('title-changed', tab.title);
    emitTabsState();

    // Update history entry title when page title loads
    try {
      if (!tab.isInternalHome && tab.url && historyService && tab.url !== 'about:blank') {
        historyService.addHistoryEntry(tab.url, tab.title, undefined, false);
      }
    } catch (e) {
      logError(`tab-${id}-history-title`, e);
    }
  };

  const onDidStartLoading = () => {
    tab.loading = true;
    if (activeTabId === id) mainWindow.webContents.send('loading', true);
    emitTabsState();
  };

  const onDidStopLoading = () => {
    tab.loading = false;
    if (activeTabId === id) {
      mainWindow.webContents.send('loading', false);
      // The page finished loading — re-sync the chrome star (belt and
      // suspenders on top of the did-navigate push).
      pushActiveBookmarkState();
    }
    emitTabsState();
  };

  const onRenderProcessGone = (_, details) => {
    logError(`tab-${id}-render-process-gone`, JSON.stringify(details));
  };

  const onDidFailLoad = (_, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    logError(`tab-${id}-did-fail-load`, `${errorCode} ${errorDescription} ${validatedURL}`);
    console.error('[tab] did-fail-load detailed', id, errorCode, errorDescription, validatedURL, isMainFrame);
    if (errorCode === -3) return;
    if (tab.httpsUpgradeAttempt) {
      const { httpUrl } = tab.httpsUpgradeAttempt;
      if (featureStore.isEnabled('httpsOnlyMode')) {
        showHttpsOnlyWarning(tab, httpUrl);
      } else {
        tab.httpsUpgradeAttempt = null;
        tab.view.webContents.loadURL(httpUrl).catch((err) => logError(`tab-${id}-http-load-failed`, err));
      }
      return;
    }
    // Display a Kairon error page for the failed load. The page receives the
    // failed URL, numeric error code and error-code string as query params and
    // renders them itself.
    tab.showingErrorPage = { url: validatedURL };
    const query = { theme: getCurrentThemeMode(), url: validatedURL, error: String(errorCode), desc: errorDescription };
    // DNS/name-resolution failures get the dedicated ip_not_found.html page;
    // every other Chromium network error keeps the generic error page. Both
    // receive the same query params and share the error-page navigation model.
    const errorFile = isDnsResolutionError(errorCode) ? IP_NOT_FOUND_FILE : ERROR_PAGE_FILE;
    tab.view.webContents.loadFile(errorFile, { query }).catch((err) => logError(`tab-${id}-error-page-load-failed`, err));
  };

  const onBeforeInputEvent = (event, input) => {
    if (input.type !== 'keyDown') return;
    // F11 — browser-level window fullscreen. Prevented here so the page never
    // sees it and the default menu's F11 accelerator ("Toggle Full Screen")
    // is suppressed, keeping it from colliding with website fullscreen.
    if (input.key === 'F11' || input.code === 'F11') {
      if (input.isAutoRepeat) return;
      event.preventDefault();
      toggleBrowserFullscreen();
      return;
    }
    const isMod = process.platform === 'darwin' ? input.meta : input.control;
    if (!isMod) return;

    // Ctrl+Shift+N — open a new Incognito window (or focus the existing one).
    // Exact combo only; does not collide with any existing shortcut.
    if ((input.key === 'n' || input.key === 'N' || input.code === 'KeyN') && input.shift && !input.alt) {
      event.preventDefault();
      openIncognitoWindow();
      return;
    }

    // Ctrl+N — open a new normal window while a webpage has focus.
    // Mirrors the chrome-level handler so the shortcut works identically
    // regardless of where keyboard focus is.
    if ((input.key === 'n' || input.key === 'N' || input.code === 'KeyN') && !input.shift && !input.alt) {
      event.preventDefault();
      openNewWindow();
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab — cycle to the adjacent tab in the current
    // tab order (Map insertion order), wrapping at both ends. Intercepted here
    // and in the main-window chrome handler below so it works whether a webpage
    // or the browser chrome holds keyboard focus. All activation (wake, attach,
    // bounds, focus) flows through switchToTab(). Ctrl+Alt+Tab is left
    // untouched and the event is prevented so the combo never leaks into the
    // page.
    if ((input.key === 'Tab' || input.code === 'Tab') && !input.alt) {
      event.preventDefault();
      cycleTab(input.shift ? -1 : 1);
      return;
    }

    // Ctrl+T / Ctrl+Shift+T — new tab / reopen closed tab while a webpage has
    // focus. The shift variant is handled first so the two never conflict.
    // All activation flows through createTab()/restoreClosedTab() →
    // switchToTab(), and preventDefault() keeps the combo out of the page.
    if ((input.key === 't' || input.key === 'T' || input.code === 'KeyT') && !input.alt) {
      event.preventDefault();
      handleNewTabShortcut(input);
      return;
    }

    // Ctrl+W — close the active tab through the existing close path (identical
    // to the close button: records it for Ctrl+Shift+T restore, wakes nothing,
    // applies the app's last-tab/active-tab fallback, and hands focus to the
    // next tab via switchToTab()). Exact combo only — plain W, Shift, and Alt
    // variants are left untouched.
    if ((input.key === 'w' || input.key === 'W' || input.code === 'KeyW') && !input.alt && !input.shift) {
      event.preventDefault();
      const activeTab = getActiveTab();
      if (activeTab) closeTab(activeTab.id);
      return;
    }

    // Ctrl+F — open the find bar while a webpage has focus.
    if ((input.key === 'f' || input.key === 'F' || input.code === 'KeyF') && !input.alt && !input.shift) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('find-bar-show');
      }
      return;
    }

    // Ctrl+D — bookmark (or un-bookmark) the current page. Exact combo only;
    // preventDefault keeps the page's own Ctrl+D (bookmark this page) from
    // firing, and no existing shortcut (Ctrl+T/W/Shift+N/H/J/F) is touched.
    if ((input.key === 'd' || input.key === 'D' || input.code === 'KeyD') && !input.alt && !input.shift) {
      event.preventDefault();
      toggleBookmarkForTab(tab);
      return;
    }

    if (input.key === '=' || input.key === '+' || input.code === 'Equal' || input.code === 'NumpadAdd') {
      event.preventDefault();
      zoomInTab(tab);
      return;
    }
    if (input.key === '-' || input.key === '_' || input.code === 'Minus' || input.code === 'NumpadSubtract') {
      event.preventDefault();
      zoomOutTab(tab);
      return;
    }
    if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') {
      event.preventDefault();
      resetTabZoom(tab);
      return;
    }
  };

  const onPageFaviconUpdated = (_, favicons) => {
    try {
      const faviconUrl = (favicons && favicons.length > 0 && typeof favicons[0] === 'string') ? favicons[0] : '';
      if (faviconUrl) tab.favicon = faviconUrl;
      if (historyService && faviconUrl && tab.url && !tab.isInternalHome && tab.url !== 'about:blank') {
        // Pass the actual page favicon URL to history
        historyService.addHistoryEntry(tab.url, tab.title, faviconUrl, false);
      }
    } catch (e) { }
  };

  webContents.on('will-navigate', onWillNavigate);
  webContents.on('page-favicon-updated', onPageFaviconUpdated);
  webContents.on('will-redirect', onWillRedirect);
  webContents.setWindowOpenHandler(({ url }) => {
    // Open popups as new tabs by default (better UX than silent deny).
    // Validate the popup URL in the main process BEFORE creating a tab: popup
    // creation calls loadURL() directly and bypasses will-navigate, so a page
    // must never be able to force file:/data:/blob:/other non-web schemes.
    const popupTarget = normalizeNavigationTarget(url);
    const safePopupTarget = popupTarget && isAllowedHttpUrl(popupTarget) ? popupTarget : null;
    if (!safePopupTarget) {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendAdblockEvent( {
            url,
            blocked: true,
            rule: 'popup-blocker',
            resourceType: 'popup',
            domain: (() => { try { return new URL(url).hostname; } catch { return null; } })(),
          });
        }
      } catch (e) { }
      return { action: 'deny' };
    }
    // Site-blocker enforcement: prevent popups to blocked domains.
    if (isSiteBlocked(safePopupTarget)) {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          sendAdblockEvent( {
            url: safePopupTarget,
            blocked: true,
            rule: 'site-blocker',
            resourceType: 'popup',
            domain: (() => { try { return new URL(safePopupTarget).hostname; } catch { return null; } })(),
          });
        }
      } catch (e) { }
      return { action: 'deny' };
    }
    try {
      const newTabId = createTab(safePopupTarget);
      switchToTab(newTabId);
    } catch (e) { }
    return { action: 'deny' };
  });
  webContents.on('did-navigate', onDidNavigate);
  webContents.on('did-navigate-in-page', onDidNavigateInPage);
  webContents.on('page-title-updated', onPageTitleUpdated);
  webContents.on('did-start-loading', onDidStartLoading);
  webContents.on('did-stop-loading', onDidStopLoading);
  webContents.on('render-process-gone', onRenderProcessGone);
  webContents.on('did-fail-load', onDidFailLoad);
  webContents.on('before-input-event', onBeforeInputEvent);

  // Find-in-page results for the active tab are forwarded to the chrome's find
  // bar so the match counter stays live (results from background tabs ignored).
  const onFoundInPage = (_, result) => {
    if (!result || activeTabId !== id) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('found-in-page', {
        activeMatchOrdinal: result.activeMatchOrdinal || 0,
        matches: result.matches || 0,
      });
    }
  };
  webContents.on('found-in-page', onFoundInPage);

  // HTML/content fullscreen (website Fullscreen API): YouTube, <video>, etc.
  // Must be handled per-tab so the window fullscreen (F11) and the website's
  // fullscreen stay independent.
  const onEnterHtmlFullScreen = () => handleEnterHtmlFullScreen(id);
  const onLeaveHtmlFullScreen = () => handleLeaveHtmlFullScreen(id);
  webContents.on('enter-html-full-screen', onEnterHtmlFullScreen);
  webContents.on('leave-html-full-screen', onLeaveHtmlFullScreen);

  tab.listeners = [
    ['will-navigate', onWillNavigate],
    ['will-redirect', onWillRedirect],
    ['did-navigate', onDidNavigate],
    ['did-navigate-in-page', onDidNavigateInPage],
    ['page-title-updated', onPageTitleUpdated],
    ['did-start-loading', onDidStartLoading],
    ['did-stop-loading', onDidStopLoading],
    ['render-process-gone', onRenderProcessGone],
    ['did-fail-load', onDidFailLoad],
    ['before-input-event', onBeforeInputEvent],
    ['page-favicon-updated', onPageFaviconUpdated],
    ['found-in-page', onFoundInPage],
    ['enter-html-full-screen', onEnterHtmlFullScreen],
    ['leave-html-full-screen', onLeaveHtmlFullScreen],
  ];

  // ──────────────────────────────────────────────────────────────
  // CONTEXT MENU: attach the native context-menu listener so that
  // right-clicking inside this tab's webpage displays an OS-native
  // context menu rendered by Electron's Menu API.
  // ──────────────────────────────────────────────────────────────
  setupContextMenu(tab, {
    onSearch: (query) => {
      const searchUrl = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
      const newTabId = createTab(searchUrl);
      switchToTab(newTabId);
    },
    onOpenInCurrentTab: (url) => {
      const target = normalizeNavigationTarget(url);
      if (!target) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('navigation-invalid', { input: typeof url === 'string' ? url : '' });
        }
        return;
      }
      if (isSiteBlocked(target)) {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            sendAdblockEvent( {
              url: target,
              blocked: true,
              rule: 'site-blocker',
              resourceType: 'navigation',
              domain: (() => { try { return new URL(target).hostname; } catch { return null; } })(),
            });
          }
        } catch (e) { }
        return;
      }
      navigateTabToTarget(tab, target);
    },
    onOpenInNewTab: (url) => {
      const newTabId = createTab(url);
      switchToTab(newTabId);
    },
    onOpenInNewWindow: (url) => {
      openLinkInNewWindow(url);
    },
    onSaveImageAs: async (url) => {
      try {
        const defaultName = path.basename(new URL(url).pathname) || 'image';
        const result = await dialog.showSaveDialog(mainWindow, {
          defaultPath: defaultName,
          filters: [
            { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'] },
            { name: 'All Files', extensions: ['*'] },
          ],
        });
        if (result.canceled || !result.filePath) return;
        const response = await net.fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(result.filePath, buffer);
      } catch (err) {
        logError('save-image-as', err);
        console.error('[context-menu] save image as failed:', err);
      }
    },
  });

  const target = normalizeNavigationTarget(initialTarget) || HOME_PAGE_URL;
  navigateTabToTarget(tab, target);
  return id;
}

function createTabFromSnapshot(snapshot) {
  const expectedId = Number.isInteger(snapshot?.id) ? snapshot.id : nextTabId;
  const createdId = createTab(snapshot?.url || HOME_PAGE_URL);
  if (createdId !== expectedId) {
    const createdTab = tabs.get(createdId);
    tabs.delete(createdId);
    createdTab.id = expectedId;
    tabs.set(expectedId, createdTab);
  }
  if (expectedId >= nextTabId) nextTabId = expectedId + 1;
  const restoredTab = tabs.get(expectedId);
  if (restoredTab && typeof snapshot?.title === 'string' && snapshot.title.trim()) {
    restoredTab.title = snapshot.title.slice(0, 256);
  }
  return expectedId;
}

/**
 * Duplicate the given tab: create a new tab with the same URL and zoom level,
 * then place it immediately to the right of the original in the tab order.
 *
 * The tab order is maintained by Map insertion order in the `tabs` Map.
 * This function re-creates the Map with the new entry positioned correctly.
 *
 * @param {number} tabId – The ID of the tab to duplicate
 */
function duplicateTab(tabId) {
  const sourceTab = tabs.get(tabId);
  if (!sourceTab) return;

  const url = sourceTab.url || HOME_PAGE_URL;
  const newTabId = createTab(url);
  const newTab = tabs.get(newTabId);
  if (!newTab) return;

  // Preserve zoom level from source tab
  if (typeof sourceTab.zoomFactor === 'number' && sourceTab.zoomFactor !== 1.0) {
    setTabZoom(newTab, sourceTab.zoomFactor);
  }

  // Reorder the Map so the new tab sits immediately to the right of the source
  const entries = Array.from(tabs.entries());
  const sourceIndex = entries.findIndex(([id]) => id === tabId);
  const newEntryIndex = entries.findIndex(([id]) => id === newTabId);

  if (sourceIndex !== -1 && newEntryIndex !== -1) {
    // Remove new tab entry from its current position
    const newEntry = entries.splice(newEntryIndex, 1)[0];
    // Insert it right after the source tab.
    // If the new entry was originally after the source, the source index
    // is unchanged by the splice, so we insert at sourceIndex + 1.
    // If it was before the source, the source shifted left by one,
    // so we insert at the (now shifted) sourceIndex.
    const insertAt = sourceIndex + (newEntryIndex > sourceIndex ? 1 : 0);
    entries.splice(insertAt, 0, newEntry);

    // Rebuild the Map in the corrected order
    tabs.clear();
    for (const [id, tab] of entries) {
      tabs.set(id, tab);
    }
  }

  // Preserve pinned state from source tab
  if (sourceTab.pinned) {
    newTab.pinned = true;
  }

  // Switch to the duplicated tab (common browser behavior)
  switchToTab(newTabId);
}

// ── RECENTLY CLOSED TABS ────────────────────────────────────
const MAX_RECENTLY_CLOSED = 20;
const recentlyClosedTabs = [];

/**
 * Record a tab's state before it is closed.
 * Only stores user-closed tabs (not shutdown-destroyed).
 * Automatically discards oldest entries when the limit is exceeded.
 *
 * @param {{ url: string, title: string, zoomFactor: number, pinned: boolean, originalIndex: number, pinnedCountAtClose: number }} tabSnapshot
 */
function recordClosedTab(tabSnapshot) {
  if (!tabSnapshot || typeof tabSnapshot.url !== 'string') return;
  recentlyClosedTabs.unshift({
    url: tabSnapshot.url,
    title: tabSnapshot.title || 'Untitled',
    zoomFactor: typeof tabSnapshot.zoomFactor === 'number' ? tabSnapshot.zoomFactor : 1.0,
    pinned: !!tabSnapshot.pinned,
    // Position of the tab in the visual tab ordering (Map insertion order) at
    // the moment it was closed, plus how many pinned tabs led the strip then.
    // Together they let Ctrl+Shift+T return the tab to its original slot within
    // its own group (pinned tabs stay in the pinned section).
    originalIndex: Number.isInteger(tabSnapshot.originalIndex) ? Math.max(0, tabSnapshot.originalIndex) : 0,
    pinnedCountAtClose: Number.isInteger(tabSnapshot.pinnedCountAtClose) ? Math.max(0, tabSnapshot.pinnedCountAtClose) : 0,
  });
  if (recentlyClosedTabs.length > MAX_RECENTLY_CLOSED) {
    recentlyClosedTabs.length = MAX_RECENTLY_CLOSED;
  }
}

/**
 * Restore the most recently closed tab.
 * Returns the restored tab ID, or null if there is nothing to restore.
 *
 * @returns {number|null}
 */
function restoreClosedTab() {
  if (recentlyClosedTabs.length === 0) return null;

  const entry = recentlyClosedTabs.shift();
  // Validate the saved navigation target with the existing navigation
  // normalizer. Invalid/unsupported targets (already shifted off the stack)
  // are discarded so we never reopen an empty or broken tab.
  const target = normalizeNavigationTarget(entry.url);
  if (!target) return null;

  const newTabId = createTab(target);
  const newTab = tabs.get(newTabId);
  if (!newTab) return null;

  // Restore zoom level
  if (entry.zoomFactor !== 1.0) {
    setTabZoom(newTab, entry.zoomFactor);
  }

  // Restore pinned state
  if (entry.pinned) {
    newTab.pinned = true;
  }

  // Restore the saved title so the tab doesn't flash "New Tab" while loading.
  if (typeof entry.title === 'string' && entry.title.trim()) {
    newTab.title = entry.title.slice(0, 256);
  }

  // Return the restored tab to the position it occupied when it was closed
  // (within its own pinned/normal group), clamped safely to the current range.
  insertTabAtRecordedPosition(newTabId, entry);

  // Keep the pinned-tabs-first invariant (a no-op when the position is already correct).
  reorderPinnedTabs();

  switchToTab(newTabId);
  return newTabId;
}

/**
 * Rebuild the tabs Map so `tabId` sits at the position recorded when it was
 * closed, relative to its own group. Pinned tabs always lead the ordering, so
 * a restored pinned tab is placed among the pinned block and a normal tab among
 * the normal block. The recorded index is clamped to the current group size, so
 * restoring after surrounding tabs were closed/reordered never throws — it just
 * lands on the closest valid slot.
 *
 * @param {number} tabId – the freshly created tab to position
 * @param {{ originalIndex: number, pinned: boolean, pinnedCountAtClose: number }} entry – the closed-tab record
 */
function insertTabAtRecordedPosition(tabId, entry) {
  const entries = Array.from(tabs.entries());
  const currentIndex = entries.findIndex(([id]) => id === tabId);
  if (currentIndex === -1) return;
  const moved = entries.splice(currentIndex, 1)[0];

  // Count tabs in the destination group after removing the restored entry, so
  // the clamped index is always a valid insertion point.
  let pinnedCount = 0;
  let unpinnedCount = 0;
  for (const [, tab] of entries) {
    if (tab.pinned) pinnedCount++;
    else unpinnedCount++;
  }

  // Reconstruct the group-relative slot the tab occupied when it was closed.
  // Pinned tabs lead the ordering, so a pinned tab's absolute index was already
  // its slot among pinned tabs; a normal tab sat after every pinned tab.
  const groupSize = entry.pinned ? pinnedCount : unpinnedCount;
  const rawGroupIndex = entry.pinned
    ? (entry.originalIndex || 0)
    : ((entry.originalIndex || 0) - (entry.pinnedCountAtClose || 0));
  const groupIndex = Math.max(0, Math.min(rawGroupIndex, groupSize));

  const insertAt = entry.pinned ? groupIndex : pinnedCount + groupIndex;
  entries.splice(insertAt, 0, moved);

  tabs.clear();
  for (const [id, tab] of entries) tabs.set(id, tab);
}

/**
 * Reorder the tabs Map so all pinned tabs come first,
 * preserving the relative order of pinned and unpinned groups.
 */
function reorderPinnedTabs() {
  const entries = Array.from(tabs.entries());
  const pinned = entries.filter(([, tab]) => tab.pinned);
  const unpinned = entries.filter(([, tab]) => !tab.pinned);
  if (pinned.length === 0) return;

  tabs.clear();
  for (const [id, tab] of pinned) tabs.set(id, tab);
  for (const [id, tab] of unpinned) tabs.set(id, tab);
}

/**
 * Reorder a single tab to a new position in the visual tab order (Map
 * insertion order) — the drag-and-drop commit path from the renderer.
 *
 * The renderer only ever reports a desired FINAL index (the position the
 * dragged tab should occupy after the reorder); it never mutates its own order
 * assumption. This function re-validates every input:
 *  - the sender was already verified by the 'tab-reorder' IPC guard
 *  - the source tab must exist in the Map
 *  - the target index must be an integer and is clamped to a valid range
 *  - pinned tabs stay inside the pinned section, normal tabs stay outside it
 *    (clamped to the pinned/normal boundary), so dragging can never pin or
 *    unpin a tab
 *
 * Afterwards the existing tabs-state broadcast (which also persists the
 * session snapshot in Map order) notifies the renderer of the new
 * authoritative order. The active tab, its BrowserView, sleeping state, zoom,
 * etc. are untouched — only the Map order changes.
 *
 * @param {number} tabId – id of the tab being dragged
 * @param {number} targetIndex – desired final index of that tab in the order
 * @returns {boolean} true if the order changed
 */
function reorderTab(tabId, targetIndex) {
  const tab = tabs.get(tabId);
  if (!tab || !Number.isInteger(targetIndex)) return false;

  const entries = Array.from(tabs.entries());
  const sourceIndex = entries.findIndex(([id]) => id === tabId);
  if (sourceIndex === -1) return false;

  const n = entries.length;
  if (n < 2) return false;

  // Count pinned tabs so the destination range can be clamped per section.
  let pinnedCount = 0;
  for (const [, t] of entries) if (t.pinned) pinnedCount++;

  // Pinned tabs always lead the ordering: a pinned tab may only land inside
  // [0, pinnedCount), a normal tab only inside [pinnedCount, n).
  const minIndex = tab.pinned ? 0 : pinnedCount;
  const maxIndex = tab.pinned ? Math.max(0, pinnedCount - 1) : n - 1;
  const target = Math.max(minIndex, Math.min(maxIndex, targetIndex));

  if (target === sourceIndex) return false; // no-op: dropped back where it started

  const moved = entries.splice(sourceIndex, 1)[0];
  entries.splice(target, 0, moved);

  tabs.clear();
  for (const [id, t] of entries) tabs.set(id, t);

  emitTabsState();
  return true;
}

// ── PIN / UNPIN HELPERS ─────────────────────────────────────

/**
 * Pin a tab, moving it to the pinned section at the beginning of the tab strip.
 *
 * @param {number} tabId
 */
function pinTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab || tab.pinned) return;
  tab.pinned = true;
  reorderPinnedTabs();
  emitTabsState();
}

/**
 * Unpin a tab, returning it to the normal section.
 * Places it as the first unpinned tab (right after all pinned tabs).
 *
 * @param {number} tabId
 */
function unpinTab(tabId) {
  const tab = tabs.get(tabId);
  if (!tab || !tab.pinned) return;
  tab.pinned = false;
  reorderPinnedTabs();
  emitTabsState();
}

/**
 * Toggle the pinned state of a tab.
 *
 * @param {number} tabId
 */
function togglePinned(tabId) {
  const tab = tabs.get(tabId);
  if (!tab) return;
  if (tab.pinned) {
    unpinTab(tabId);
  } else {
    pinTab(tabId);
  }
}

function switchToTab(tabId) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const tab = tabs.get(tabId);
  if (!tab) return false;

  // Fast path: the destination is already the active tab and its BrowserView
  // is still attached. Wake, re-attach, bounds, focus, and state signals are
  // all redundant here (the active tab can never sleep, and the renderer is
  // already synced), so skip them. This keeps rapid re-clicks / redundant
  // tab-switch IPC near-free and never steals focus from chrome UI (e.g. the
  // address bar) when the user clicks the tab they are already on. If the
  // view was detached for any reason, fall through to the full path below.
  if (tabId === activeTabId && mainWindow.getBrowserView() === tab.view) {
    return true;
  }

  activeTabId = tabId;
  tabSleepManager.updateTabActivity(tabId);
  mainWindow.setBrowserView(tab.view);
  try {
    tab.view.webContents.setZoomFactor(tab.zoomFactor || 1.0);
  } catch (e) { }
  // Force a real setBounds() on every switch: after setBrowserView() re-attaches
  // the view we must not trust a cached bounds value.
  tab._lastBounds = null;
  updateBounds();
  // The view is now attached and positioned, and the sleeping tab (if any) was
  // already woken by updateTabActivity() above — make the page keyboard-focus
  // ready so shortcuts (YouTube F/fullscreen, Space, typing) work immediately
  // without requiring a click inside the page.
  focusActiveTabWebContents();
  sendActiveTabSignals();
  emitTabsState();
  return true;
}

/**
 * Cycle to the adjacent tab for Ctrl+Tab / Ctrl+Shift+Tab.
 *
 * "Adjacent" follows the current visual tab order — the insertion order of the
 * `tabs` Map (reordering/pinning mutates that Map, so iteration is always the
 * authoritative order, never numeric tab IDs). Wraps around at both ends, and
 * delegates all activation (waking a sleeping tab, attaching the BrowserView,
 * bounds, focus) to switchToTab() so it stays the single path for activation.
 *
 * @param {number} direction +1 for the next tab, -1 for the previous tab
 * @returns {boolean} true if a tab switch was performed, false otherwise
 */
function cycleTab(direction) {
  const order = Array.from(tabs.keys());
  if (order.length < 2) return false; // no adjacent tab to switch to
  let index = order.indexOf(activeTabId);
  if (index === -1) index = direction > 0 ? -1 : 0; // stale activeTabId: start from an end
  const targetIndex = (index + direction + order.length) % order.length;
  return switchToTab(order[targetIndex]);
}

/**
 * Handle Ctrl+T / Ctrl+Shift+T from the keyboard interception layer.
 *
 * Ctrl+T opens a brand-new tab through the existing createTab()/switchToTab()
 * flow — identical to the new-tab button. Ctrl+Shift+T (checked first) reopens
 * the most recently closed tab from the in-memory closed-tab stack through the
 * existing restoreClosedTab(). All activation (BrowserView attach, bounds,
 * focus, wake) is delegated to switchToTab(); new/reopened tabs start awake.
 *
 * @param {{ shift: boolean }} input – the keyboard input (modifier already verified)
 */
function handleNewTabShortcut(input) {
  if (input.shift) {
    restoreClosedTab();
    return;
  }
  const newTabId = createTab(HOME_PAGE_URL);
  switchToTab(newTabId);
}

function destroyTab(tabId, recordForRestore = true) {
  const tab = tabs.get(tabId);
  if (!tab) return false;

  // Record the tab state before destroying, but only when triggered by the user
  // (not during app shutdown where tabs are cleaned up in bulk).
  if (recordForRestore && tab.url && tab.url !== 'about:blank') {
    // Record the tab's current position in the visual ordering so Ctrl+Shift+T
    // can return it to the same slot (grouped correctly among pinned/normal).
    const order = Array.from(tabs.keys());
    let pinnedCountAtClose = 0;
    for (const [id, t] of tabs) if (t.pinned) pinnedCountAtClose++;
    recordClosedTab({
      url: tab.url,
      title: tab.title,
      zoomFactor: tab.zoomFactor,
      pinned: tab.pinned,
      originalIndex: Math.max(0, order.indexOf(tabId)),
      pinnedCountAtClose,
    });
  }

  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.getBrowserView() === tab.view) {
    mainWindow.setBrowserView(null);
  }

  // If the destroyed tab was in content fullscreen, restore the window state.
  if (tabId === htmlFullscreenTabId) {
    htmlFullscreenTabId = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (!windowFullscreenBeforeHtml && mainWindow.isFullScreen()) {
        mainWindow.setFullScreen(false);
      }
    }
    windowFullscreenBeforeHtml = false;
  }

  for (const [eventName, listener] of tab.listeners) {
    tab.view.webContents.removeListener(eventName, listener);
  }
  tab.view.webContents.close({ waitForBeforeUnload: false });
  tab.view.webContents.destroy();
  tabs.delete(tabId);
  return true;
}

/**
 * Close a tab through the single existing close path — the exact logic the
 * tab close button (renderer → 'tab-close') and the tab context menu use.
 * Destroys the tab (recording it in the recently-closed stack for Ctrl+Shift+T
 * when user-initiated), then applies the app's established fallback: if that
 * was the last tab, a fresh home tab is created; if it was the active tab, the
 * tab at the closed position (or the new last tab) becomes active via
 * switchToTab() so the newly active page receives keyboard focus.
 *
 * @param {number} tabId
 */
function closeTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  if (!tabs.has(tabId)) return;

  const ids = Array.from(tabs.keys());
  const closedIndex = ids.indexOf(tabId);
  const wasActive = activeTabId === tabId;

  destroyTab(tabId);

  if (tabs.size === 0) {
    const newId = createTab(HOME_PAGE_URL);
    switchToTab(newId);
    return;
  }

  if (wasActive) {
    const remainingIds = Array.from(tabs.keys());
    const nextIndex = Math.min(closedIndex, remainingIds.length - 1);
    switchToTab(remainingIds[nextIndex]);
    return;
  }

  emitTabsState();
}

function createWindow() {
  const appIcon = getAppIcon();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    // Match the window's pre-load background to the persisted theme so there
    // is no dark/light flash while the chrome renderer boots.
    backgroundColor: getCurrentThemeMode() === 'light' ? '#f0f0f0' : '#080810',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      sandbox: true,
    },
    show: false,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // WINDOWS: Fix top-right corner click-through via WM_NCHITTEST override
  //
  // Problem: with frame:false + resizable:true, Windows preserves WS_THICKFRAME
  // and reserves ~8 px around the window perimeter for native resize hit-testing
  // (HTTOP, HTRIGHT, HTTOPRIGHT, etc.).  These pixels are intercepted at the OS
  // level — Electron's Chromium renderer never receives the events.  No CSS,
  // pointer-events, -webkit-app-region, or z-index change can fix this because
  // the renderer is simply not involved at those coordinates.
  //
  // Fix: hook WM_NCHITTEST (0x0084) and return HTCLIENT (1) for the top-right
  // win-controls zone (120 × 40 px).  This tells Windows the corner is normal
  // client area, so it forwards the click to the renderer, where the existing
  // -webkit-app-region / pointer-events CSS takes over correctly.  All other
  // edges and corners continue to use native resize hit-testing unmodified.
  // ═══════════════════════════════════════════════════════════════════════════
  if (process.platform === 'win32') {
    const WM_NCHITTEST = 0x0084;
    const HTCLIENT     = 1;

    // Matches body[data-tab-position="top"] #win-controls: width:120px height:40px
    // positioned at top:0 right:0.  In sidebar mode the buttons are not at the
    // corner, so the zone is safely wider than needed there.
    const WIN_CTRL_W = 120;
    const WIN_CTRL_H = 40;

    try {
      mainWindow.hookWindowMessage(WM_NCHITTEST, (_wParam, lParam) => {
        try {
          // lParam carries the cursor screen position packed as two signed
          // 16-bit integers (LOWORD = x, HIWORD = y) — GET_X_LPARAM / GET_Y_LPARAM.
          // Electron passes it as a Node Buffer on 64-bit Windows.
          const cursorX = lParam.readInt16LE(0);
          const cursorY = lParam.readInt16LE(2);

          const bounds  = mainWindow.getBounds();
          const winRight = bounds.x + bounds.width;
          const winTop   = bounds.y;

          if (
            cursorX >= winRight - WIN_CTRL_W &&
            cursorX <= winRight              &&
            cursorY >= winTop                &&
            cursorY <= winTop + WIN_CTRL_H
          ) {
            // Override: treat as client area so the renderer handles it
            return { returnValue: HTCLIENT };
          }
        } catch (e) {
          // Buffer read failed or bounds unavailable — fall through to default
        }
        // Return nothing → let Electron / Windows perform default hit-testing
      });
      diag('[main] WM_NCHITTEST hook installed for top-right win-controls zone');
    } catch (e) {
      // hookWindowMessage not available (non-Windows build or sandboxed env) — safe to ignore
      logError('wm-nchittest-hook-failed', e);
    }
  }

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: getThemeQuery() });

  // ═══════════════════════════════════════════════════════════════
  // CHROME SHELL ZOOM LOCK: Ensure the main window's own webContents
  // (index.html — toolbar, address bar, tabs UI) always renders at
  // zoomFactor 1.0. If Chromium/Electron applies a default zoom on
  // high-DPI displays (the root cause of the 256px innerWidth vs
  // getContentSize discrepancy), this explicitly overrides it.
  // ═══════════════════════════════════════════════════════════════
  mainWindow.webContents.on('dom-ready', () => {
    try {
      mainWindow.webContents.setZoomFactor(1.0);
    } catch (e) { }
    if (DIAG) console.info('[main] mainWindow dom-ready');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    // Reset on every navigation too, in case a sub-frame navigation or
    // internal redirect changes the zoom
    try {
      mainWindow.webContents.setZoomFactor(1.0);
    } catch (e) { }
    if (DIAG) console.info('[main] mainWindow did-finish-load');
  });

  // Log the actual zoom factor in startup diagnostics (diagnostic only)
  const logZoomDiag = () => {
    try {
      const zf = mainWindow.webContents.getZoomFactor();
      if (Math.abs(zf - 1.0) > 0.01) {
        diagWarn('[ZOOM-DIAG] *** CRITICAL: mainWindow zoomFactor is', zf, '— expected 1.0');
      } else {
        diag('[ZOOM-DIAG] mainWindow zoomFactor:', zf, '(OK)');
      }
    } catch (e) { }
  };
  // Diagnostic log: check mainWindow zoom factor after settle
  mainWindow.webContents.once('did-finish-load', logZoomDiag);
  setTimeout(logZoomDiag, 3000); // also check after settle

  // DOM snapshot for debugging (diagnostic only — 'once' handler)
  mainWindow.webContents.once('did-finish-load', () => {
    if (!DIAG) return;
    try {
      mainWindow.webContents.executeJavaScript("document.documentElement.outerHTML.slice(0,800)")
        .then((html) => console.info('[main][DOM-SNIPPET]', String(html).slice(0, 800)))
        .catch((e) => console.error('[main][DOM-SNIPPET-ERROR]', e && e.stack ? e.stack : e));
      try { console.info('[main] loaded-url', mainWindow.webContents.getURL()); } catch (e) { }
    } catch (e) { console.error('[main][DOM-SNIPPET-ERROR]', e && e.stack ? e.stack : e); }
  });
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url) => console.error('[main] mainWindow did-fail-load', code, desc, url));
  mainWindow.webContents.on('console-message', (e, level, message, line, sourceId) => { if (DIAG) console.info('[main][console]', message, sourceId, 'L' + line); });
  mainWindow.webContents.on('will-navigate', (event) => {
    // Renderer should never navigate main app shell.
    event.preventDefault();
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // F11 fullscreen while focus is in the browser chrome (address bar, tabs, AI
  // panel, etc.) — same handling as inside tab webContents.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11' || input.code === 'F11') {
      if (input.isAutoRepeat) return;
      event.preventDefault();
      toggleBrowserFullscreen();
      return;
    }
    // Ctrl+Shift+N — open a new Incognito window (or focus the existing one)
    // while the browser chrome holds focus. Exact combo only.
    if ((input.key === 'n' || input.key === 'N' || input.code === 'KeyN') && input.shift && !input.alt &&
        (process.platform === 'darwin' ? input.meta : input.control)) {
      event.preventDefault();
      openIncognitoWindow();
      return;
    }
    // Ctrl+N — open a new normal window while the browser chrome holds focus.
    if ((input.key === 'n' || input.key === 'N' || input.code === 'KeyN') && !input.shift && !input.alt &&
        (process.platform === 'darwin' ? input.meta : input.control)) {
      event.preventDefault();
      openNewWindow();
      return;
    }
    // Ctrl+Tab / Ctrl+Shift+Tab — cycle tabs while browser chrome holds focus
    // (address bar, AI input, etc.). Mirrors the per-tab handler so the
    // shortcut behaves identically regardless of where keyboard focus is.
    if ((input.key === 'Tab' || input.code === 'Tab') && !input.alt &&
        (process.platform === 'darwin' ? input.meta : input.control)) {
      event.preventDefault();
      cycleTab(input.shift ? -1 : 1);
    }
    // Ctrl+T / Ctrl+Shift+T — new tab / reopen closed tab while browser chrome
    // holds focus (address bar, AI input, etc.). Mirrors the per-tab handler;
    // preventDefault() here also suppresses the renderer's own Ctrl+T listener
    // (which runs after this event), so it can never double-fire.
    if ((input.key === 't' || input.key === 'T' || input.code === 'KeyT') && !input.alt &&
        (process.platform === 'darwin' ? input.meta : input.control)) {
      event.preventDefault();
      handleNewTabShortcut(input);
    }
    // Ctrl+W — close the active tab while browser chrome holds focus. Mirrors
    // the per-tab handler; preventDefault() here also suppresses the renderer's
    // own Ctrl+W listener (which runs after this event), so it can never
    // double-fire.
    if ((input.key === 'w' || input.key === 'W' || input.code === 'KeyW') && !input.alt && !input.shift &&
        (process.platform === 'darwin' ? input.meta : input.control)) {
      event.preventDefault();
      const activeTab = getActiveTab();
      if (activeTab) closeTab(activeTab.id);
    }
    // Ctrl+F — open the find bar while browser chrome holds focus. Mirrors the
    // per-tab handler so the shortcut works whether a webpage or the chrome
    // holds keyboard focus.
    if ((input.key === 'f' || input.key === 'F' || input.code === 'KeyF') && !input.alt && !input.shift &&
        (process.platform === 'darwin' ? input.meta : input.control)) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('find-bar-show');
      }
      return;
    }
    // Ctrl+D — bookmark (or un-bookmark) the active page while browser chrome
    // holds focus (address bar, tabs, etc.). Mirrors the per-tab handler so
    // the shortcut works identically regardless of where keyboard focus is.
    if ((input.key === 'd' || input.key === 'D' || input.code === 'KeyD') && !input.alt && !input.shift &&
        (process.platform === 'darwin' ? input.meta : input.control)) {
      event.preventDefault();
      toggleBookmarkForTab(getActiveTab());
      return;
    }
  });

  // Belt-and-suspenders: some Electron/BrowserView builds surface the HTML
  // fullscreen events on the BrowserWindow instead of (or in addition to) the
  // tab webContents. The handlers are idempotent, so double-firing is a no-op.
  mainWindow.on('enter-html-full-screen', () => {
    const tab = getActiveTab();
    if (tab) handleEnterHtmlFullScreen(tab.id);
  });
  mainWindow.on('leave-html-full-screen', () => {
    const tab = getActiveTab();
    if (tab) handleLeaveHtmlFullScreen(tab.id);
  });

  // Merge ready-to-show: lock zoom BEFORE maximize/show
  mainWindow.once('ready-to-show', () => {
    // Ensure chrome shell zoom is locked before the window is displayed
    try { mainWindow.webContents.setZoomFactor(1.0); } catch (e) { }

    if (DIAG) console.info('[main] ready-to-show');
    if (!mainWindow.isDestroyed()) {
      try {
        ensureWindowVisible(mainWindow);
        mainWindow.maximize();
      } catch (err) { }
    }
    mainWindow.show();
    if (process.env.KAIRON_DEBUG_UI === '1') {
      try { mainWindow.webContents.openDevTools({ mode: 'right' }); } catch (e) { }
    }
    createOverlayWindow();
  });

  mainWindow.on('resize', () => {
    updateBounds();
    updateDownloadsPanelBounds();
    updateAppMenuBounds();
  });
  mainWindow.on('move', () => {
    updateOverlayBounds();
    updateDownloadsPanelBounds();
    updateAppMenuBounds();
  });

  // When the window regains OS focus (Alt+Tab return, settings/overlay closing),
  // hand keyboard focus to the active tab's page so webpage shortcuts work
  // immediately — unless the user was interacting with browser chrome (address
  // bar, AI input, etc.), in which case that focus is preserved. The renderer
  // keeps chromeUiFocused live via focusin/focusout and snapshots it at window
  // blur, so this reliably distinguishes "returning to the page" from
  // "returning to the address bar" without relying on Chromium's flaky
  // BrowserView focus restoration.
  mainWindow.on('focus', () => {
    if (chromeUiFocused) return;
    focusActiveTabWebContents();
  });

  // ── FULLSCREEN TRANSITION SYNCHRONIZATION ───────────────────
  // The window's content size is only trustworthy once it has actually entered
  // fullscreen. Re-assert the content-fullscreen bounds at that point (and on
  // every resize) so the active BrowserView always covers the full window from
  // the top edge — never a stale/chrome-offset measurement. 'enter-full-screen'
  // fires for both F11 and HTML-fullscreen transitions.
  mainWindow.on('enter-full-screen', () => {
    // Mark the transition as in progress so updateBounds() keeps the active view
    // where it is instead of applying chrome-offset metrics mid-transition.
    fullscreenTransitionActive = true;
    if (fullscreenTransitionTimer) clearTimeout(fullscreenTransitionTimer);
    fullscreenTransitionTimer = setTimeout(() => {
      fullscreenTransitionActive = false;
      updateBounds(); // apply the settled layout (F11 mode) once the window settles
    }, 400);
    // If a website is in content fullscreen, re-assert the full-window bounds
    // now that the window has actually reached fullscreen (the content size is
    // only trustworthy at this point) — never a stale/chrome-offset measurement.
    if (htmlFullscreenTabId != null) {
      const tab = getHtmlFullscreenTab();
      if (tab) {
        tab._lastBounds = null;
        updateBounds();
      }
    }
  });
  // Track that an OS-level fullscreen exit was not F11-initiated.
  mainWindow.on('leave-full-screen', () => {
    userWindowFullscreen = false;
    fullscreenTransitionActive = false;
    if (fullscreenTransitionTimer) {
      clearTimeout(fullscreenTransitionTimer);
      fullscreenTransitionTimer = null;
    }
  });
  mainWindow.webContents.on('render-process-gone', (_, details) => {
    logError('main-render-process-gone', JSON.stringify(details));
  });

  mainWindow.on('closed', () => {
    for (const tabId of Array.from(tabs.keys())) destroyTab(tabId, false);
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.close();
      overlayWindow = null;
    }
    // Close every standalone "Open Link in New Window" window too. They are
    // not children of this window, so they would otherwise survive its close:
    // window-all-closed would never fire, app.quit() would never be reached,
    // and the process would stay running in the background (visible in
    // Task Manager) even though the browser UI is gone.
    for (const win of Array.from(standaloneWindows)) {
      if (!win.isDestroyed()) {
        try { win.close(); } catch (e) { }
      }
    }
    standaloneWindows.clear();
    activeTabId = null;
    tabs.clear();
    mainWindow = null;
  });

  const restored = restoreSessionState();
  if (restored) {
    for (const snapshot of restored.tabs) createTabFromSnapshot(snapshot);
    if (!switchToTab(restored.activeTabId)) {
      const fallbackId = tabs.keys().next().value;
      if (Number.isInteger(fallbackId)) switchToTab(fallbackId);
    }
  } else {
    const firstTabId = createTab(HOME_PAGE_URL);
    switchToTab(firstTabId);
  }
}

function updateBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const tab = getActiveTab();
  if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return;

  let bounds;
  if (htmlFullscreenTabId === tab.id) {
    // Content fullscreen (website Fullscreen API): the active view covers the
    // entire window content area so the fullscreen element fills the screen.
    const [fullW, fullH] = mainWindow.getContentSize();
    bounds = { x: 0, y: 0, width: Math.max(100, fullW), height: Math.max(100, fullH) };
  } else if (mainWindow.isFullScreen() && fullscreenTransitionActive) {
    // Window is mid fullscreen-transition with no content-fullscreen tab: keep
    // the view where it is. Repositioning it to chrome-offset metrics now would
    // jump the view during the transition and corrupt the webpage's fullscreen
    // viewport (stale viewport / black band above the content).
    updateOverlayBounds();
    return;
  } else if (layoutMetrics) {
    // SANITY CLAMP: Never let BrowserView exceed current window content area
    const [currentW, currentH] = mainWindow.getContentSize();
    const clampedX = Math.min(Math.max(0, layoutMetrics.x), Math.max(0, currentW - 100));
    const clampedY = Math.min(Math.max(0, layoutMetrics.y), Math.max(0, currentH - 100));

    bounds = {
      x: clampedX,
      y: clampedY,
      // width must be constrained by available space to the right of x
      width: Math.min(Math.max(100, layoutMetrics.width), currentW, Math.max(100, currentW - clampedX)),
      height: Math.min(Math.max(100, layoutMetrics.height), currentH, Math.max(100, currentH - clampedY)),
    };

    // Log if clamping occurred (diagnostic only)
    if (DIAG && (bounds.x !== layoutMetrics.x || bounds.y !== layoutMetrics.y ||
        bounds.width !== layoutMetrics.width || bounds.height !== layoutMetrics.height)) {
      diagWarn('[BOUNDS-DIAG] *** CLAMPED layoutMetrics at apply-time:', {
        stored: layoutMetrics,
        clamped: bounds,
        currentContentSize: { w: currentW, h: currentH }
      });
    }
  } else {
    const [w, h] = mainWindow.getContentSize();
    const rightOffset = sidebarOpen ? SIDEBAR_WIDTH : 0;
    bounds = {
      x: RAIL_WIDTH,
      y: CHROME_HEIGHT,
      width: Math.max(100, w - RAIL_WIDTH - rightOffset),
      height: Math.max(100, h - CHROME_HEIGHT),
    };
  }

  // Skip redundant setBounds() calls when the computed bounds did not change.
  const prev = tab._lastBounds;
  if (!prev || bounds.x !== prev.x || bounds.y !== prev.y || bounds.width !== prev.width || bounds.height !== prev.height) {
    tab._lastBounds = bounds;
    tab.view.setBounds(bounds);
  }

  updateOverlayBounds();

  // Diagnostic-only verification (sync roundtrips) — dev builds only.
  if (DIAG) {
    try {
      const actual = tab.view.getBounds();
      diag('[BOUNDS-DIAG] post-setBounds getBounds:', JSON.stringify(actual));
      if (actual.x !== bounds.x || actual.y !== bounds.y || actual.width !== bounds.width || actual.height !== bounds.height) {
        diagWarn('[BOUNDS-DIAG] *** MISMATCH: setBounds != getBounds');
      }
    } catch (e) { }
    if (!tab._boundsCheckScheduled) {
      tab._boundsCheckScheduled = true;
      const checkId = tab.id;
      const capturedBounds = bounds;
      setTimeout(() => {
        try {
          const settledTab = tabs.get(checkId);
          if (!settledTab || !settledTab.view || !settledTab.view.webContents || settledTab.view.webContents.isDestroyed()) return;
          const settledBounds = settledTab.view.getBounds();
          diag('[BOUNDS-DIAG] *** SETTLED BOUNDS (2s):', JSON.stringify(settledBounds));
          diag('[BOUNDS-DIAG] *** SETTLED vs expected:', JSON.stringify(capturedBounds));
        } catch (e) { }
      }, 2000);
    }
  }
}

let _lastOverlayBounds = null;
function updateOverlayBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !overlayWindow || overlayWindow.isDestroyed()) return;
  if (activeOverlaySuggestions) {
    updateOverlaySuggestionBounds(activeOverlaySuggestions);
    return;
  }
  if (activeStarPopup) {
    updateStarPopupBounds();
    return;
  }
  // Never move the overlay while a popup close animation is still playing —
  // resizing now would teleport the still-visible popup to a default position.
  // The renderer signals popup-close-finished once the popup is hidden; only
  // then are the default bounds restored (invisibly).
  if (overlayClosePending) return;
  const bounds = mainWindow.getContentBounds();
  const prev = _lastOverlayBounds;
  if (!prev || bounds.x !== prev.x || bounds.y !== prev.y || bounds.width !== prev.width || bounds.height !== prev.height) {
    _lastOverlayBounds = bounds;
    overlayWindow.setBounds(bounds);
  }
}

let _lastOverlaySuggestionBounds = null;
function updateOverlaySuggestionBounds(payload) {
  if (!mainWindow || mainWindow.isDestroyed() || !overlayWindow || overlayWindow.isDestroyed()) return null;
  const { rect, items } = payload || {};
  if (!rect || !Array.isArray(items) || !items.length) return null;

  const mainBounds = mainWindow.getContentBounds();
  const [currentW, currentH] = mainWindow.getContentSize();

  // DEFENSE: Re-fetch current content size at apply-time to detect stale renderer
  // measurements captured during a resize/maximize transition before the window settled.
  if (DIAG && rect.left + rect.width > currentW) {
    diagWarn('[OVERLAY-DIAG] *** STALE OVERLAY MEASUREMENT DETECTED:', {
      rectLeft: rect.left,
      rectRight: rect.left + rect.width,
      currentContentW: currentW,
      diff: (rect.left + rect.width) - currentW
    });
  }

  // Clamp renderer rect to current window content dimensions so the overlay never
  // overflows the visible area
  const clampedRectLeft = Math.min(Math.max(0, Math.round(rect.left)), Math.max(0, currentW - 20));
  const clampedRectWidth = Math.min(
    Math.max(1, Math.round(rect.width)),
    currentW - clampedRectLeft,
    Math.max(1, currentW - clampedRectLeft)
  );

  const left = Math.round(mainBounds.x + clampedRectLeft);
  const top = Math.round(mainBounds.y + rect.bottom);
  const width = Math.max(1, clampedRectWidth);
  const itemHeight = 44;
  const borderHeight = 1;
  const height = Math.max(1, Math.round(items.length * itemHeight + borderHeight));
  const maxWidth = Math.max(1, mainBounds.x + mainBounds.width - left);
  const maxHeight = Math.max(1, mainBounds.y + mainBounds.height - top);

  const bounds = {
    x: left,
    y: top,
    width: Math.min(width, maxWidth),
    height: Math.min(height, maxHeight),
  };

  // Skip redundant setBounds() calls when the computed bounds did not change.
  const prev = _lastOverlaySuggestionBounds;
  if (!prev || bounds.x !== prev.x || bounds.y !== prev.y || bounds.width !== prev.width || bounds.height !== prev.height) {
    _lastOverlaySuggestionBounds = bounds;
    overlayWindow.setBounds(bounds);
  }

  // Diagnostic-only readback (sync roundtrip) — dev builds only.
  if (DIAG) {
    try {
      const actualOverlayBounds = overlayWindow.getBounds();
      const dx = Math.abs(actualOverlayBounds.x - bounds.x);
      const dy = Math.abs(actualOverlayBounds.y - bounds.y);
      const dw = Math.abs(actualOverlayBounds.width - bounds.width);
      const dh = Math.abs(actualOverlayBounds.height - bounds.height);
      const maxDiff = Math.max(dx, dy, dw, dh);
      diag('[OVERLAY-DIAG] overlay.getBounds() AFTER setBounds:', JSON.stringify(actualOverlayBounds));
      diag('[OVERLAY-DIAG] diff from requested:', { dx, dy, dw, dh, maxDiff });
      if (maxDiff > 2) {
        diagWarn('[OVERLAY-DIAG] *** OVERLAY MISMATCH (>2px): setBounds != getBounds!');
      }
    } catch (e) { }
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

function ensureWindowVisible(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const bounds = win.getBounds();
    const displays = screen.getAllDisplays();
    const intersects = displays.some((d) => {
      const wa = d.workArea;
      return !(bounds.x + bounds.width <= wa.x || bounds.x >= wa.x + wa.width || bounds.y + bounds.height <= wa.y || bounds.y >= wa.y + wa.height);
    });
    if (!intersects) {
      const primary = screen.getPrimaryDisplay();
      const wa = primary.workArea;
      const width = Math.min(bounds.width, wa.width);
      const height = Math.min(bounds.height, wa.height);
      const x = wa.x + Math.max(0, Math.floor((wa.width - width) / 2));
      const y = wa.y + Math.max(0, Math.floor((wa.height - height) / 2));
      win.setBounds({ x, y, width, height });
    }
  } catch (err) {
    logError('ensure-window-visible', err);
  }
}

function createOverlayWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Fresh window → never trust cached bounds from a previous overlay instance.
  _lastOverlayBounds = null;
  _lastOverlaySuggestionBounds = null;
  overlayWindow = new BrowserWindow({
    parent: mainWindow,
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

  // Pass the persisted theme so the suggestions dropdown renders it before
  // first paint (same pattern as every other Kairon-owned page); live changes
  // arrive via settings-updated from emitSettingsState.
  // The overlay starts HIDDEN: it is transparent and click-through when idle,
  // and it is only revealed (at its final bounds) when a popup opens. Keeping
  // it hidden while its bounds change guarantees a resize can never paint a
  // stale popup frame at an intermediate position.
  overlayWindow.loadFile(path.join(__dirname, '../renderer/overlay.html'), { query: getThemeQuery() })
    .then(() => {
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      updateOverlayBounds();
    })
    .catch((err) => {
      logError('overlay-load-failed', err);
    });

  // When the user clicks a webpage (or any other surface) while the downloads
  // panel / app menu / about dialog is open, the overlay loses focus — close
  // whatever is open (all idempotent).
  //
  // EXCEPTION: clicking a popup's OWN toggle button also moves OS focus away
  // from the overlay before the renderer's click event fires (the blur-close
  // would otherwise race the button's toggle: it closes the popup and resets
  // the renderer's open state, so the click then sees "closed" and reopens it
  // — the close-and-immediately-reopen bug). When the cursor is over the
  // toggle button at blur time, the blur must NOT close the popup: the
  // button's click handler checks the still-open state and performs the
  // close itself. Every other surface (webpage, other chrome, other window)
  // closes the popup here exactly as before.
  overlayWindow.on('blur', () => {
    if (activeDownloadsPanel && !isCursorOverRendererRect(activeDownloadsPanel.rect)) hideDownloadsPanel();
    if (activeAppMenu && !isCursorOverRendererRect(activeAppMenu.rect)) hideAppMenu();
    if (activeStarPopup && !isCursorOverRendererRect(activeStarPopup.rect)) hideStarPopup();
    if (activeAboutDialog) hideAboutDialog();
  });
}

// True when the OS cursor is inside the given rect (renderer CSS pixels
// relative to the main window's content bounds). The chrome is zoom-locked to
// 1.0, so renderer CSS pixels equal DIPs — the same assumption the overlay
// bounds math (updateDownloadsPanelBounds / updateAppMenuBounds) relies on.
function isCursorOverRendererRect(rect) {
  if (!rect || !mainWindow || mainWindow.isDestroyed()) return false;
  try {
    const p = screen.getCursorScreenPoint();
    const b = mainWindow.getContentBounds();
    const left = b.x + rect.left;
    const top = b.y + rect.top;
    const width = Number.isFinite(rect.width) && rect.width > 0 ? rect.width : 1;
    const height = Number.isFinite(rect.height) && rect.height > 0 ? rect.height : 1;
    return p.x >= left && p.x <= left + width && p.y >= top && p.y <= top + height;
  } catch (e) {
    return false;
  }
}

// ── DOWNLOADS PANEL ───────────────────────────────────────────
// The downloads panel is rendered by the existing overlay window (the same
// infrastructure as the omnibox suggestions), anchored to the Downloads
// toolbar button. The main renderer reports the button's rect in renderer
// CSS pixels; main converts it to screen bounds and sizes the overlay to
// exactly the panel rect so it stays above BrowserView content and only
// intercepts mouse events over the panel itself.

// Push the current downloads snapshot to every surface that renders it:
// the main renderer (toolbar badge), the overlay (floating panel), and the
// internal downloads page loaded in any tab. Trust follows the loaded URL,
// same as settings/history live updates.
function broadcastDownloadsState() {
  if (!downloadManager) return;
  let snapshot;
  try { snapshot = downloadManager.getDownloads(); } catch (e) { return; }
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('downloads-updated', snapshot); } catch (e) { }
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.webContents.send('downloads-updated', snapshot); } catch (e) { }
  }
  for (const tab of tabs.values()) {
    try {
      const wc = tab.view && tab.view.webContents;
      if (!wc || wc.isDestroyed()) continue;
      if (isInternalDownloadsPage({ sender: wc })) wc.send('downloads-updated', snapshot);
    } catch (e) { }
  }
  // Additional normal windows (Ctrl+N) also receive download updates.
  try { broadcastDownloadsToNewWindows(snapshot); } catch (e) { }
}

function updateDownloadsPanelBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !overlayWindow || overlayWindow.isDestroyed()) return;
  if (!activeDownloadsPanel) return;
  const rect = activeDownloadsPanel.rect;
  if (!rect || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) return;

  const mainBounds = mainWindow.getContentBounds();
  const [currentW, currentH] = mainWindow.getContentSize();
  const PAD = 8;

  // Right-align the panel with the button's right edge; clamp inside the window.
  const panelW = Math.min(376, Math.max(240, currentW - PAD * 2));
  let left = Math.round(mainBounds.x + rect.right - panelW);
  left = Math.max(mainBounds.x + PAD, Math.min(left, mainBounds.x + currentW - panelW - PAD));
  const top = Math.round(mainBounds.y + rect.bottom + 6);
  const maxH = Math.max(120, mainBounds.y + mainBounds.height - top - PAD);

  // Estimate the desired height from the current list so the overlay sizes
  // exactly to the content; the panel CSS flexes the list to fill the rest.
  const count = downloadManager ? downloadManager.getDownloads().length : 0;
  const headerH = 46;
  const footerH = 46;
  const rowH = 60;
  const listH = count > 0 ? Math.min(count, 7) * rowH : 84;
  const panelH = Math.min(Math.round(headerH + listH + footerH + 2), Math.round(maxH), 480);

  const bounds = { x: left, y: top, width: Math.round(panelW), height: Math.round(panelH) };
  const prev = _lastDownloadsPanelBounds;
  if (!prev || bounds.x !== prev.x || bounds.y !== prev.y || bounds.width !== prev.width || bounds.height !== prev.height) {
    _lastDownloadsPanelBounds = bounds;
    overlayWindow.setBounds(bounds);
  }
}
function hideDownloadsPanel() {
  const wasOpen = !!activeDownloadsPanel;
  activeDownloadsPanel = null;
  _lastDownloadsPanelBounds = null;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try { overlayWindow.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
  try { if (overlayWindow.setFocusable) overlayWindow.setFocusable(false); } catch (e) { }
  try { overlayWindow.webContents.send('downloads-panel-hide'); } catch (e) { }
  // Echo to the main renderer so the toolbar button's open state stays in sync
  // when the panel is closed from the overlay side (Escape / webpage click).
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('downloads-panel-hide'); } catch (e) { }
  }
  // Same rule as the app menu: never move the overlay while the panel is still
  // visible (it hides in the renderer right after this message). Restoring the
  // default bounds here would flash the panel at the far-left for a frame; the
  // renderer signals popup-close-finished once it is hidden, then the default
  // bounds are restored (invisibly).
  if (wasOpen) overlayClosePending = true;
}


// ── APPLICATION MENU ─────────────────────────────────────────
// The application menu is rendered by the existing overlay window (the same
// infrastructure as the omnibox suggestions and the downloads panel) so it
// always paints above BrowserView content. The main renderer anchors it by
// sending the menu button's rect (renderer CSS pixels); main converts it to
// screen bounds, sizes the overlay to exactly the menu rect, and forwards the
// current browser state so the menu can enable/disable actions (Back/Forward,
// zoom, fullscreen) to match the live browser.

// ── STAR POPUP (Quick Access / Bookmarks chooser) ───────────
// The star button in the chrome opens a tiny two-option popdown instead of
// toggling the bookmark directly. Rendered by the existing overlay window
// (same infrastructure as the downloads panel / app menu) so it always paints
// above BrowserView content; anchored to the star button by the main
// renderer. Only bookmarkable pages can open it (the star is disabled
// elsewhere, and the show handler re-validates).
const STAR_POPUP_WIDTH = 236;
const STAR_POPUP_HEIGHT = 120;
const STAR_POPUP_GAP = 6;

function updateStarPopupBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !overlayWindow || overlayWindow.isDestroyed()) return;
  if (!activeStarPopup) return;
  const rect = activeStarPopup.rect;
  if (!rect || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) return;

  const mainBounds = mainWindow.getContentBounds();
  const [currentW] = mainWindow.getContentSize();
  const PAD = 8;

  // Right-align the popup with the star button's right edge (same as the
  // downloads panel); clamp inside the window.
  let left = Math.round(mainBounds.x + rect.right - STAR_POPUP_WIDTH);
  left = Math.max(mainBounds.x + PAD, Math.min(left, mainBounds.x + Math.max(PAD, currentW - STAR_POPUP_WIDTH - PAD)));
  const top = Math.round(mainBounds.y + rect.bottom + STAR_POPUP_GAP);
  const maxH = Math.max(80, mainBounds.y + mainBounds.height - top - PAD);
  const desiredH = activeStarPopup.measuredHeight || STAR_POPUP_HEIGHT;

  const bounds = { x: left, y: top, width: STAR_POPUP_WIDTH, height: Math.min(desiredH, maxH) };
  const prev = _lastStarPopupBounds;
  if (!prev || bounds.x !== prev.x || bounds.y !== prev.y || bounds.width !== prev.width || bounds.height !== prev.height) {
    _lastStarPopupBounds = bounds;
    overlayWindow.setBounds(bounds);
  }
}

function hideStarPopup() {
  if (!activeStarPopup) return;
  activeStarPopup = null;
  _lastStarPopupBounds = null;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try { overlayWindow.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
  try { if (overlayWindow.setFocusable) overlayWindow.setFocusable(false); } catch (e) { }
  try { overlayWindow.webContents.send('star-popup-hide'); } catch (e) { }
  // Echo to the main renderer so the star button's open state stays in sync
  // when the popup is closed from the overlay side (Escape / webpage click).
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('star-popup-hide'); } catch (e) { }
  }
  // Same rule as every popup: never move the overlay while the popup is still
  // visible (its close animation plays in the renderer). The renderer signals
  // popup-close-finished once it is hidden, then the default bounds are
  // restored (invisibly).
  overlayClosePending = true;
}

// ── OVERLAY TOAST ──────────────────────────────────────────
// Subtle, transient feedback (bookmark add/remove). Rendered by the overlay
// window so it paints above BrowserView content; click-through so it never
// intercepts input. Shares the overlay with every other popup — showing a
// toast closes anything else first (all idempotent).
const TOAST_WIDTH = 300;
const TOAST_HEIGHT = 46;
const TOAST_MARGIN = 24;
const TOAST_DURATION_MS = 2200;

function showOverlayToast(message) {
  if (!message || !overlayWindow || overlayWindow.isDestroyed()) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  overlayClosePending = false;
  activeOverlaySuggestions = null;
  _lastOverlaySuggestionBounds = null;
  activeAppMenu = null;
  _lastAppMenuBounds = null;
  activeDownloadsPanel = null;
  activeAboutDialog = false;
  activeStarPopup = null;
  _lastStarPopupBounds = null;
  try { overlayWindow.webContents.send('overlay-hide'); } catch (e) { }
  try { overlayWindow.webContents.send('app-menu-hide'); } catch (e) { }
  try { overlayWindow.webContents.send('about-hide'); } catch (e) { }
  try { overlayWindow.webContents.send('downloads-panel-hide'); } catch (e) { }
  try { overlayWindow.webContents.send('star-popup-hide'); } catch (e) { }
  try { mainWindow.webContents.send('app-menu-hide'); } catch (e) { }
  try { mainWindow.webContents.send('downloads-panel-hide'); } catch (e) { }
  try { mainWindow.webContents.send('star-popup-hide'); } catch (e) { }

  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }

  const mainBounds = mainWindow.getContentBounds();
  const [currentW, currentH] = mainWindow.getContentSize();
  const bounds = {
    x: Math.round(mainBounds.x + (currentW - TOAST_WIDTH) / 2),
    y: Math.round(mainBounds.y + currentH - TOAST_HEIGHT - TOAST_MARGIN),
    width: TOAST_WIDTH,
    height: TOAST_HEIGHT,
  };
  activeToast = { message, at: Date.now() };

  // Hide → position → reveal (same rule as every popup).
  try { overlayWindow.hide(); } catch (e) { }
  _lastOverlayBounds = null;
  try { overlayWindow.setBounds(bounds); } catch (e) { }
  try { overlayWindow.show(); } catch (e) { }
  // The toast is purely informational — clicks pass straight through.
  try { overlayWindow.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
  try { if (overlayWindow.setFocusable) overlayWindow.setFocusable(false); } catch (e) { }
  try { overlayWindow.webContents.send('toast-show', { message }); } catch (e) { }

  _toastTimer = setTimeout(() => { hideOverlayToast(); }, TOAST_DURATION_MS);
}

function hideOverlayToast() {
  if (!activeToast) return;
  activeToast = null;
  if (_toastTimer) { clearTimeout(_toastTimer); _toastTimer = null; }
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try { overlayWindow.webContents.send('toast-hide'); } catch (e) { }
  // Another popup may have taken over the overlay while the toast was up — it
  // owns the bounds now, so don't reclaim them.
  if (activeAppMenu || activeDownloadsPanel || activeStarPopup || activeAboutDialog || activeOverlaySuggestions) return;
  try { overlayWindow.hide(); } catch (e) { }
  _lastOverlayBounds = null;
  updateOverlayBounds();
}

// Snapshot of the current browser state the menu renders against.
function getAppMenuState() {
  const tab = getActiveTab();
  let canGoBack = false;
  let canGoForward = false;
  let zoomFactor = 1.0;
  if (tab && tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
    try { canGoBack = tab.view.webContents.navigationHistory.canGoBack(); } catch (e) { }
    try { canGoForward = tab.view.webContents.navigationHistory.canGoForward(); } catch (e) { }
    zoomFactor = typeof tab.zoomFactor === 'number' ? tab.zoomFactor : 1.0;
  }
  let isFullscreen = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { isFullscreen = mainWindow.isFullScreen(); } catch (e) { }
  }
  let updater = null;
  try { updater = getUpdaterState(); } catch (e) { }
  return { canGoBack, canGoForward, zoomFactor, isFullscreen, updater };
}

function broadcastUpdaterState(state) {
  const s = state || getUpdaterState();
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('updater-state-changed', s); } catch (e) { }
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.webContents.send('updater-state-changed', s); } catch (e) { }
  }
}

function updateAppMenuBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || !overlayWindow || overlayWindow.isDestroyed()) return;
  if (!activeAppMenu) return;
  const rect = activeAppMenu.rect;
  if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return;

  const mainBounds = mainWindow.getContentBounds();
  const [currentW] = mainWindow.getContentSize();
  const GAP = 6;
  const PAD = 8;

  // Left-align the menu with the button's left edge; clamp inside the window.
  let left = Math.round(mainBounds.x + rect.left);
  left = Math.max(mainBounds.x + PAD, Math.min(left, mainBounds.x + Math.max(PAD, currentW - APP_MENU_WIDTH - PAD)));
  const top = Math.round(mainBounds.y + rect.bottom + GAP);
  // Clamp height to the window; the menu scrolls internally when clamped.
  const maxH = Math.max(120, mainBounds.y + mainBounds.height - top - PAD);
  const desiredH = activeAppMenu.measuredHeight || APP_MENU_HEIGHT;

  const bounds = { x: left, y: top, width: APP_MENU_WIDTH, height: Math.min(desiredH, maxH) };
  const prev = _lastAppMenuBounds;
  if (!prev || bounds.x !== prev.x || bounds.y !== prev.y || bounds.width !== prev.width || bounds.height !== prev.height) {
    _lastAppMenuBounds = bounds;
    overlayWindow.setBounds(bounds);
  }
}

function hideAppMenu() {
  if (!activeAppMenu) return;
  activeAppMenu = null;
  _lastAppMenuBounds = null;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try { overlayWindow.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
  try { if (overlayWindow.setFocusable) overlayWindow.setFocusable(false); } catch (e) { }
  try { overlayWindow.webContents.send('app-menu-hide'); } catch (e) { }
  // Echo to the main renderer so the menu button's open state stays in sync
  // when the menu is closed from the overlay side (Escape / item click /
  // webpage click via overlay blur).
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send('app-menu-hide'); } catch (e) { }
  }
  // Keep the overlay window exactly where it is while the menu's close
  // animation plays. Restoring the default full-window bounds here would
  // teleport the still-visible menu to the far-left for a frame; the renderer
  // signals popup-close-finished once the animation completes and only then
  // are the default bounds restored (invisibly).
  overlayClosePending = true;
}

// The About dialog is a centered modal rendered by the overlay at full-window
// size (the overlay covers the whole window when no panel is open).
function hideAboutDialog() {
  if (!activeAboutDialog) return;
  activeAboutDialog = false;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  try { overlayWindow.setIgnoreMouseEvents(true, { forward: true }); } catch (e) { }
  try { if (overlayWindow.setFocusable) overlayWindow.setFocusable(false); } catch (e) { }
  try { overlayWindow.webContents.send('about-hide'); } catch (e) { }
  // Hide before restoring default bounds so the resize never paints a stale
  // About-dialog frame at an intermediate position.
  try { overlayWindow.hide(); } catch (e) { }
  _lastOverlayBounds = null;
  updateOverlayBounds();
}


// Dynamic reconfiguration helper for adblocker: called when settings change.
async function reconfigureAdblocker() {
  if (_adblockReconfigLock) return;
  _adblockReconfigLock = true;
  try {
    const sess = session.fromPartition('persist:browser');
    const adSettings = featureStore.getFeatureSettings('adBlocker') || {};
    const adMode = (adSettings && typeof adSettings.mode === 'string') ? String(adSettings.mode).toLowerCase() : 'off';
    const shouldInit = featureStore.isEnabled('adBlocker') && adMode !== 'off';

    if (!shouldInit) {
      try { if (contentBlockingRuntime) { contentBlockingRuntime.destroy(); } } catch (e) { }
      contentBlockingRuntime = null;
      try { if (adblockerService) { adblockerService.destroy(); } } catch (e) { }
      adblockerService = null;
      _nativeRuleVersion += 1;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('adblock-css-updated', { css: '' });
      return;
    }

    // If already initialized and same mode, no-op
    if (adblockerService && String(adblockerService.mode).toLowerCase() === String(adMode).toLowerCase()) return;

    // Tear down existing
    try { if (contentBlockingRuntime) { contentBlockingRuntime.destroy(); } } catch (e) { }
    contentBlockingRuntime = null;
    try { if (adblockerService) { adblockerService.destroy(); } } catch (e) { }
    adblockerService = null;
    _nativeRuleVersion += 1;

    // Create and initialize new service
    adblockerService = new AdblockerService({
      lists: null,
      updateIntervalMs: 24 * 60 * 60 * 1000,
      mode: adMode,
      onCss: (css) => {
        try {
          if (contentBlockingRuntime) {
            try { contentBlockingRuntime.applyToAll(); } catch (e) { }
          } else {
            for (const t of tabs.values()) {
              try { t.view.webContents.insertCSS(css).catch(() => { }); } catch (e) { }
            }
          }
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('adblock-css-updated', { css });
          }
        } catch (e) { }
      },
      onBlocked: (payload) => {
        try {
          _nativeBlockedCount += 1;
          sendAdblockEvent(payload);
          if (DIAG) console.info('[adblock] blocked', payload && payload.url, 'rule=', payload && payload.rule);
        } catch (e) { }
      }
    });

    try {
      await adblockerService.init(sess);
    } catch (err) {
      logError('adblock-reinit-failed', err);
    }

    // Report whether native network blocking attached
    try {
      const nativeReady = !!(adblockerService && adblockerService.networkAttached);
      const cosmeticReady = !!(adblockerService && adblockerService.css && adblockerService.css.length > 100);
      if (DIAG) console.info('[adblock] initialization complete:', {
        mode: adMode,
        nativeNetworkBlocking: nativeReady,
        cosmeticFilters: cosmeticReady,
        engineConfig: adblockerService._engineConfig
      });

      if (adMode === 'aggressive' && adblockerService && adblockerService._engineConfig && adblockerService._engineConfig.loadNetworkFilters && !adblockerService.networkAttached) {
        console.warn('[adblock] ⚠ native network blocking FAILED - engaging FALLBACK blocker');
        try { attachAggressiveFallbackToSession(sess); } catch (e) { console.error('[adblock] fallback attach failed', e && e.stack ? e.stack : e); }
      } else if (adMode === 'aggressive' && adblockerService && adblockerService.networkAttached) {
        console.info('[adblock] ✓ native network blocking ACTIVE for aggressive mode');
        try { deactivateAggressiveFallback(); } catch (e) { }
      }
    } catch (e) { console.error('[adblock] post-init check failed', e && e.stack ? e.stack : e); }

    try {
      const usesCosmetic = (adMode === 'cosmetic' || adMode === 'standard' || adMode === 'full' || adMode === 'aggressive');
      if (usesCosmetic) {
        try { contentBlockingRuntime = new ContentBlockingRuntime(adblockerService); } catch (e) { contentBlockingRuntime = null; }
      }

      // Handle aggressive fallback blocking: 
      // Only activate fallback if native network blocking is NOT working
      if (adMode === 'aggressive') {
        if (adblockerService && adblockerService.networkAttached) {
          console.info('[adblock] native blocker is ACTIVE; disabling fallback');
          try { deactivateAggressiveFallback(); } catch (e) { }
        } else {
          console.warn('[adblock] native blocker INACTIVE; activating fallback blocker');
          try { attachAggressiveFallbackToSession(sess); } catch (e) { }
        }
      } else {
        try { deactivateAggressiveFallback(); } catch (e) { }
      }
    } catch (e) { contentBlockingRuntime = null; }

    // Apply any CSS immediately (best-effort)
    try {
      if (adblockerService && adblockerService.css) {
        if (contentBlockingRuntime) {
          try { await contentBlockingRuntime.applyToAll(); } catch (e) { }
        } else {
          for (const t of tabs.values()) {
            try { t.view.webContents.insertCSS(adblockerService.css).catch(() => { }); } catch (e) { }
          }
        }
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('adblock-css-updated', { css: adblockerService.css });
      }
    } catch (e) { }
  } catch (e) {
    logError('adblock-reconfig', e);
  } finally {
    _adblockReconfigLock = false;
  }
}

// Settings IPC is only reachable from trusted windows and from the internal
// settings page itself. Trust follows the currently loaded URL: if the page
// navigates away from the local settings.html file, event.sender.getURL() no
// longer matches and privileges are revoked immediately.
const _isSettingsTrusted = (event) => isTrustedIpcSender(event) || (isTabBrowserView(event) && isInternalSettingsPage(event)) || isInternalIncognitoPage(event);

// ── IPC ──
ipcMain.on('show-overlay-suggestions', (event, payload) => {
  if (!isTrustedIpcSender(event)) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  overlayClosePending = false;

  const { rect, items } = payload;
  let overlayPayload = payload;
  if (rect && items) {
    activeOverlaySuggestions = payload;
    // The overlay is hidden whenever its geometry changes and revealed only
    // after being positioned, so no stale frame can paint mid-resize.
    try { overlayWindow.hide(); } catch (e) { }
    overlayPayload = updateOverlaySuggestionBounds(payload) || payload;
    try { overlayWindow.show(); } catch (e) { }
    overlayWindow.setIgnoreMouseEvents(false);
  }

  overlayWindow.webContents.send('overlay-suggestions', overlayPayload);
});

ipcMain.on('hide-overlay-suggestions', (event) => {
  if (!isTrustedIpcSender(event)) return;
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  activeOverlaySuggestions = null;
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.webContents.send('overlay-hide');
  // Hide the window before restoring default bounds so the resize never paints
  // a stale suggestion frame at an intermediate (far-left) position.
  try { overlayWindow.hide(); } catch (e) { }
  // Invalidate both caches so the overlay is definitely resized back to full
  // window bounds (and next show re-applies the suggestion bounds).
  _lastOverlayBounds = null;
  _lastOverlaySuggestionBounds = null;
  updateOverlayBounds();
});

ipcMain.on('overlay-suggestion-hover', (event, index) => {
  if (!isTrustedIpcSender(event)) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('overlay-suggestion-hover', index);
  }
});

ipcMain.on('navigate-to-suggestion', (event, url) => {
  if (!isTrustedIpcSender(event)) return;
  const tab = getActiveTab();
  if (!tab) return;
  const target = normalizeNavigationTarget(url);
  if (!target) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('navigation-invalid', { input: typeof url === 'string' ? url : '' });
    }
    return;
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    activeOverlaySuggestions = null;
    overlayWindow.setIgnoreMouseEvents(true, { forward: true });
    overlayWindow.webContents.send('overlay-hide');
    try { overlayWindow.hide(); } catch (e) { }
    updateOverlayBounds();
  }
  navigateTabToTarget(tab, target);
});

ipcMain.on('navigate', (event, url) => {
  if (!isTrustedIpcSender(event)) return;
  const tab = getActiveTab();
  if (!tab) return;
  const target = normalizeNavigationTarget(url);
  if (!target) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('navigation-invalid', { input: typeof url === 'string' ? url : '' });
    }
    return;
  }
  if (isSiteBlocked(target)) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendAdblockEvent( {
          url: target,
          blocked: true,
          rule: 'site-blocker',
          resourceType: 'navigation',
          domain: (() => { try { return new URL(target).hostname; } catch { return null; } })(),
        });
      }
    } catch (e) { }
    return;
  }
  navigateTabToTarget(tab, target);
});

ipcMain.on('open-history-entry', (event, url) => {
  // The History and Bookmarks pages are loaded inside tab BrowserViews, so
  // accept both trusted renderers and our own tab views (same policy as the
  // history/bookmarks IPC). Opening a bookmark behaves exactly like navigating
  // to any other URL — it goes through createTab + switchToTab like history.
  if (!isTrustedIpcSender(event) && !(isTabBrowserView(event) && (isInternalHistoryPage(event) || isInternalBookmarksPage(event)))) return;
  if (typeof url !== 'string' || !url.trim()) return;

  const target = normalizeNavigationTarget(url);
  if (!target) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('navigation-invalid', { input: url });
    }
    return;
  }
  if (isSiteBlocked(target)) {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        sendAdblockEvent( {
          url: target,
          blocked: true,
          rule: 'site-blocker',
          resourceType: 'navigation',
          domain: (() => { try { return new URL(target).hostname; } catch { return null; } })(),
        });
      }
    } catch (e) { }
    return;
  }

  const newTabId = createTab(target);
  switchToTab(newTabId);
});

ipcMain.on('go-back', (event) => {
  if (!isTrustedIpcSender(event)) return;
  const tab = getActiveTab();
  if (!tab) return;
  if (tab.view.webContents.navigationHistory.canGoBack()) {
    tab.view.webContents.navigationHistory.goBack();
  }
});

ipcMain.on('go-forward', (event) => {
  if (!isTrustedIpcSender(event)) return;
  const tab = getActiveTab();
  if (!tab) return;
  if (tab.view.webContents.navigationHistory.canGoForward()) {
    tab.view.webContents.navigationHistory.goForward();
  }
});

ipcMain.on('reload', (event) => {
  if (!isTrustedIpcSender(event)) return;
  const tab = getActiveTab();
  if (!tab) return;
  tab.view.webContents.reload();
});

ipcMain.on('stop-loading', (event) => {
  if (!isTrustedIpcSender(event)) return;
  const tab = getActiveTab();
  if (!tab) return;
  try {
    tab.view.webContents.stop();
  } catch (e) { }
});

ipcMain.on('zoom-in', (event) => {
  if (!isTrustedIpcSender(event)) return;
  const tab = getActiveTab();
  if (tab) zoomInTab(tab);
});

ipcMain.on('zoom-out', (event) => {
  if (!isTrustedIpcSender(event)) return;
  const tab = getActiveTab();
  if (tab) zoomOutTab(tab);
});

ipcMain.on('zoom-reset', (event) => {
  if (!isTrustedIpcSender(event)) return;
  const tab = getActiveTab();
  if (tab) resetTabZoom(tab);
});

ipcMain.on('tab-create', (event, url) => {
  if (!isTrustedIpcSender(event)) return;
  if (typeof url !== 'undefined' && typeof url !== 'string') return;
  const newTabId = createTab(typeof url === 'string' ? url : HOME_PAGE_URL);
  switchToTab(newTabId);
});

ipcMain.on('tab-switch', (event, tabId) => {
  if (!isTrustedIpcSender(event)) return;
  if (!Number.isInteger(tabId)) return;
  switchToTab(tabId);
});

// Drag-and-drop reorder commit from the renderer. The main process is the
// single source of truth for tab order: the payload only carries the source
// tab id and the desired final index, both re-validated here (integer types,
// trusted sender, tab existence, section clamping inside reorderTab). No
// arbitrary tab manipulation is exposed — only a single move within the
// existing pinned/normal grouping rules.
ipcMain.on('tab-reorder', (event, payload) => {
  if (!isTrustedIpcSender(event)) return;
  if (!payload || typeof payload !== 'object') return;
  const { sourceId, targetIndex } = payload;
  if (!Number.isInteger(sourceId) || !Number.isInteger(targetIndex)) return;
  if (!tabs.has(sourceId)) return; // reject stale/destroyed tabs
  reorderTab(sourceId, targetIndex);
});

// Renderer reports whether browser chrome holds keyboard focus (address bar,
// AI input, buttons). Used by the window 'focus' handler so returning to the
// app never steals focus from chrome UI the user is actively using.
ipcMain.on('chrome-ui-focus', (event, focused) => {
  if (!isTrustedIpcSender(event)) return;
  chromeUiFocused = focused === true;
});

ipcMain.on('tab-context-menu', (event, tabId) => {
  if (!isTrustedIpcSender(event)) return;
  if (!Number.isInteger(tabId)) return;
  if (!tabs.has(tabId)) return;

  const clickedTab = tabs.get(tabId);
  const isPinned = !!(clickedTab && clickedTab.pinned);
  const isSleeping = !!(clickedTab && clickedTab.sleeping);
  const hasClosedTabs = recentlyClosedTabs.length > 0;

  if (DIAG) console.info('[tab-context-menu] showing menu for tab', tabId, '(pinned:', isPinned, ')');
  setupTabContextMenu(tabId, {
    onNewTab: () => {
      const newTabId = createTab(HOME_PAGE_URL);
      switchToTab(newTabId);
    },
    onReloadTab: (clickedTabId) => {
      const tab = tabs.get(clickedTabId);
      if (tab && tab.view && tab.view.webContents && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.reload();
      }
    },
    onDuplicateTab: (clickedTabId) => {
      duplicateTab(clickedTabId);
    },
    onWakeTab: (clickedTabId) => {
      // Wakes a sleeping tab in the background — focus is never changed.
      const tab = tabs.get(clickedTabId);
      if (tab) tabSleepManager.wakeTab(clickedTabId);
    },
    onCloseTab: (clickedTabId) => {
      closeTab(clickedTabId);
    },
    onTogglePin: (clickedTabId) => {
      togglePinned(clickedTabId);
    },
    onReopenTab: () => {
      restoreClosedTab();
    },
    hasClosedTabs,
    onCloseOtherTabs: (clickedTabId) => {
      const entries = Array.from(tabs.entries());
      for (const [id, tab] of entries) {
        if (id === clickedTabId) continue;
        // Pinned tabs must never be closed by bulk-close actions
        if (tab.pinned) continue;
        destroyTab(id);
      }

      // Ensure the clicked tab is still active
      if (!tabs.has(activeTabId)) {
        switchToTab(clickedTabId);
      } else {
        emitTabsState();
      }
    },
    onCloseTabsToTheRight: (clickedTabId) => {
      const entries = Array.from(tabs.entries());
      const sourceIndex = entries.findIndex(([id]) => id === clickedTabId);
      if (sourceIndex === -1) return;

      // Collect tabs to the right of the clicked tab (in visual tab order)
      const toClose = [];
      for (let i = sourceIndex + 1; i < entries.length; i++) {
        const [id, tab] = entries[i];
        // Pinned tabs must never be closed by bulk-close actions
        if (tab.pinned) continue;
        toClose.push(id);
      }

      for (const id of toClose) {
        destroyTab(id);
      }

      // Ensure the clicked tab is still active
      if (!tabs.has(activeTabId)) {
        switchToTab(clickedTabId);
      } else {
        emitTabsState();
      }
    },
  }, { isPinned, hasClosedTabs, isSleeping });
});

ipcMain.on('tab-close', (event, tabId) => {
  if (!isTrustedIpcSender(event)) return;
  closeTab(tabId);
});

ipcMain.on('toggle-sidebar', (event, open) => {
  if (!isTrustedIpcSender(event) || typeof open !== 'boolean') return;
  sidebarOpen = open;
  updateBounds();
});

ipcMain.handle('restart-app', (event) => {
  if (!_isSettingsTrusted(event)) throw new Error('Unauthorized IPC sender');
  // app.exit() does NOT emit before-quit, so flush the debounced session
  // snapshot and stop the sleeping-tabs sweep explicitly before restarting.
  try { flushSessionPersist(); } catch (e) { }
  try { tabSleepManager.stop(); } catch (e) { }
  app.relaunch();
  app.exit(0);
  return true;
});

ipcMain.on('layout-metrics', (event, metrics) => {
  if (!isTrustedIpcSender(event)) return;
  if (!metrics || typeof metrics !== 'object') return;
  const x = Math.round(metrics.x);
  const y = Math.round(metrics.y);
  const width = Math.round(metrics.width);
  const height = Math.round(metrics.height);
  if (DIAG) console.info('[BOUNDS-DIAG] IPC layout-metrics RECEIVED raw payload:', JSON.stringify(metrics), '| rounded:', { x, y, width, height });
  if (![x, y, width, height].every(Number.isFinite)) {
    if (DIAG) console.warn('[BOUNDS-DIAG] IPC layout-metrics INVALID payload (non-finite):', JSON.stringify(metrics));
    return;
  }

  // SANITY CLAMP: Guard against stale mid-resize measurements.
  // The renderer may have measured centerCol during a resize/maximize
  // transition when the window was larger, arriving after the window
  // has already settled to its final (smaller) size.
  const rawLayoutMetrics = {
    x: Math.max(0, x),
    y: Math.max(0, y),
    width: Math.max(1, width),
    height: Math.max(1, height),
  };

  if (mainWindow && !mainWindow.isDestroyed()) {
    const [currentW, currentH] = mainWindow.getContentSize();
    const clampedX = Math.min(rawLayoutMetrics.x, Math.max(0, currentW - 100));
    const clampedY = Math.min(rawLayoutMetrics.y, Math.max(0, currentH - 100));
    layoutMetrics = {
      x: clampedX,
      y: clampedY,
      // width must also be constrained by available space to the right of x
      width: Math.min(rawLayoutMetrics.width, currentW, Math.max(100, currentW - clampedX)),
      height: Math.min(rawLayoutMetrics.height, currentH, Math.max(100, currentH - clampedY)),
    };

    // Log if clamping occurred
    if (layoutMetrics.x !== rawLayoutMetrics.x || layoutMetrics.y !== rawLayoutMetrics.y ||
        layoutMetrics.width !== rawLayoutMetrics.width || layoutMetrics.height !== rawLayoutMetrics.height) {
      diagWarn('[BOUNDS-DIAG] *** STALE MEASUREMENT DETECTED: clamped layoutMetrics at storage:', {
        raw: rawLayoutMetrics,
        clamped: layoutMetrics,
        currentContentSize: { w: currentW, h: currentH }
      });
    }
  } else {
    layoutMetrics = rawLayoutMetrics;
  }

  diag('[BOUNDS-DIAG] IPC layout-metrics stored as:', JSON.stringify(layoutMetrics));
  updateBounds();
});

// Renderer sends its delayed getBoundingClientRect for cross-reference
ipcMain.on('layout-metrics-delayed', (event, metrics) => {
  if (!isTrustedIpcSender(event)) return;
  if (!metrics || typeof metrics !== 'object') return;
  const x = Math.round(metrics.x);
  const y = Math.round(metrics.y);
  const width = Math.round(metrics.width);
  const height = Math.round(metrics.height);
  if (DIAG) console.info('[BOUNDS-DIAG] IPC layout-metrics DELAYED (2s settle) received:', JSON.stringify(metrics), '| rounded:', { x, y, width, height });
  if (layoutMetrics) {
    const dx = Math.abs(layoutMetrics.x - x);
    const dy = Math.abs(layoutMetrics.y - y);
    const dw = Math.abs(layoutMetrics.width - width);
    const dh = Math.abs(layoutMetrics.height - height);
    if (dx > 1 || dy > 1 || dw > 1 || dh > 1) {
      diagWarn('[BOUNDS-DIAG] *** LAYOUT SHIFT: initial vs delayed metrics differ!', {
        initial: JSON.stringify(layoutMetrics),
        delayed: JSON.stringify({ x, y, width, height }),
        delta: { dx, dy, dw, dh }
      });
    } else {
      diag('[BOUNDS-DIAG] initial vs delayed metrics MATCH (stable layout)');
    }
  }
});

// DPI / display info from renderer
ipcMain.on('display-info', (event, info) => {
  if (!isTrustedIpcSender(event)) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const diagWidth = mainWindow.getSize();
  const diagContent = mainWindow.getContentSize();
  const diagBounds = mainWindow.getBounds();
  const diagContentBounds = mainWindow.getContentBounds();
  if (DIAG) {
    console.info('[SIZING-DIAG] ═══════ STARTUP SIZING CROSS-REFERENCE ═══════');
    console.info('[SIZING-DIAG] Renderer:', JSON.stringify(info));
    console.info('[SIZING-DIAG] mainWindow.getSize():', diagWidth);
    console.info('[SIZING-DIAG] mainWindow.getContentSize():', diagContent);
    console.info('[SIZING-DIAG] mainWindow.getBounds():', JSON.stringify(diagBounds));
    console.info('[SIZING-DIAG] mainWindow.getContentBounds():', JSON.stringify(diagContentBounds));
    try {
      const primaryDisplay = screen.getPrimaryDisplay();
      console.info('[SIZING-DIAG] primary display:', {
        size: primaryDisplay.size,
        workArea: primaryDisplay.workArea,
        scaleFactor: primaryDisplay.scaleFactor,
      });
    } catch (e) {}
  }
  if (info && info.innerWidth && diagContent[0] !== info.innerWidth) {
    console.warn('[SIZING-DIAG] *** CRITICAL: getContentSize() width', diagContent[0],
      '!= renderer innerWidth', info.innerWidth,
      '— diff:', info.innerWidth - diagContent[0]);
  }
  console.info('[SIZING-DIAG] ═══════ END STARTUP SIZING ═══════');
});

ipcMain.on('window-minimize', (event) => {
  if (!isTrustedIpcSender(event)) return;
  mainWindow.minimize();
});
ipcMain.on('window-maximize', (event) => {
  if (!isTrustedIpcSender(event)) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', (event) => {
  if (!isTrustedIpcSender(event)) return;
  mainWindow.close();
});

// ── SENSITIVE STORE KEYS ──────────────────────────────────────
// Keys that must NOT be accessible through the generic store-get / store-set
// IPC channels. These contain secrets or privileged configuration that a
// compromised renderer must not be able to exfiltrate or overwrite.
// Purpose-specific IPC handlers exist for legitimately needed values.
const SENSITIVE_STORE_KEYS = new Set([
  'groqApiKey',
]);

ipcMain.handle('store-get', (event, key) => {
  if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
  if (typeof key !== 'string' || !key || key.length > MAX_STORE_KEY_LENGTH) {
    throw new Error('Invalid store key');
  }
  if (SENSITIVE_STORE_KEYS.has(key)) {
    throw new Error('Access denied: sensitive store key');
  }
  return store.get(key);
});
ipcMain.handle('store-set', (event, key, value) => {
  if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
  if (typeof key !== 'string' || !key || key.length > MAX_STORE_KEY_LENGTH) {
    throw new Error('Invalid store key');
  }
  if (SENSITIVE_STORE_KEYS.has(key)) {
    throw new Error('Access denied: sensitive store key');
  }
  store.set(key, value);
  return true;
});

// ── PURPOSE-SPECIFIC: Groq API Key ────────────────────────────
// The AI panel needs to read the Groq API key. Instead of exposing it
// through generic store access, a narrow IPC handler provides read/write
// only to trusted browser chrome. The key is never exposed to untrusted
// webpage tabs.
ipcMain.handle('get-groq-api-key', (event) => {
  if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
  try {
    return store.get('groqApiKey') || '';
  } catch (e) {
    return '';
  }
});
ipcMain.handle('set-groq-api-key', (event, apiKey) => {
  if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
  if (typeof apiKey !== 'string') throw new Error('Invalid API key');
  store.set('groqApiKey', apiKey);
  return true;
});
ipcMain.handle('log-error', (event, payload) => {
  if (!_isSettingsTrusted(event)) throw new Error('Unauthorized IPC sender');
  if (!payload || typeof payload.source !== 'string' || typeof payload.message !== 'string') {
    throw new Error('Invalid error payload');
  }
  logError(`renderer-${payload.source}`, payload.message);
  return true;
});

ipcMain.handle('settings-get-state', (event) => {
  if (!_isSettingsTrusted(event)) throw new Error('Unauthorized IPC sender');
  return featureStore.getPublicSnapshot();
});

// Expose a small, safe IPC to let preload determine adblock mode without exposing full settings.
// Restricted to trusted browser chrome and tab BrowserViews — untrusted webpages
// cannot invoke this channel.
ipcMain.handle('get-adblock-mode', (event) => {
  if (!isTrustedIpcSender(event) && !isTabBrowserView(event)) {
    throw new Error('Unauthorized IPC sender');
  }
  try {
    const enabled = !!featureStore.isEnabled('adBlocker');
    const settings = featureStore.getFeatureSettings('adBlocker') || {};
    const mode = (settings && typeof settings.mode === 'string') ? String(settings.mode).toLowerCase() : 'off';
    return { enabled, mode };
  } catch (e) {
    return { enabled: false, mode: 'off' };
  }
});

ipcMain.handle('settings-set-feature-enabled', (event, featureId, enabled) => {
  if (!_isSettingsTrusted(event)) throw new Error('Unauthorized IPC sender');
  if (typeof featureId !== 'string' || featureId.length > 128 || typeof enabled !== 'boolean') {
    throw new Error('Invalid settings payload');
  }
  const ok = featureStore.setFeatureEnabled(featureId, enabled);
  if (!ok) throw new Error('Unknown feature');
  if (featureId === 'webRtcProtection') applyWebRtcProtectionToTabs();
  emitSettingsState(event.sender.id);

  // Optional smoke test runner: set KAIRON_RUN_ADBLOCK_SMOKE=1 to auto-open test pages
  try {
    if (process.env.KAIRON_RUN_ADBLOCK_SMOKE === '1') {
      (async () => {
        try {
          await new Promise((r) => setTimeout(r, 3000));
          const testUrls = [
            'https://adblock.turtlecute.org/',
            'https://www.youtube.com/',
            'https://www.yahoo.com/',
          ];
          for (const u of testUrls) {
            try {
              const id = createTab(u);
              const tab = tabs.get(id);
              if (tab && tab.view && tab.view.webContents) {
                await new Promise((res) => {
                  const onFinish = () => { try { tab.view.webContents.removeListener('did-finish-load', onFinish); } catch (e) { }; setTimeout(res, 4000); };
                  tab.view.webContents.once('did-finish-load', onFinish);
                });
              } else {
                await new Promise((r) => setTimeout(r, 4000));
              }
              // Report progress after each test URL
              try {
                console.info('[adblock][smoke-progress]', 'url=', u, 'totalRequests=', _networkRequestCount, 'nativeBlocked=', _nativeBlockedCount, 'aggressiveBlocked=', _aggressiveBlockedCount);
              } catch (e) { }
            } catch (e) { }
          }
          // Wait for diagnostics interval to run and capture data
          await new Promise((r) => setTimeout(r, 8000));
          const nativeBlocked = _nativeBlockedCount || 0;
          const aggressiveBlocked = _aggressiveBlockedCount || 0;
          const totalBlocked = nativeBlocked + aggressiveBlocked;
          const totalReq = _networkRequestCount || 0;
          const coverage = totalReq > 0 ? ((totalBlocked / totalReq) * 100) : 0;
          console.info('[adblock][smoke-result]', 'totalRequests=', totalReq, 'nativeBlocked=', nativeBlocked, 'aggressiveBlocked=', aggressiveBlocked, 'totalBlocked=', totalBlocked, 'coverage=', coverage);
          // Exit after reporting
          try { app.exit(0); } catch (e) { process.exit(0); }
        } catch (e) { console.error('[adblock][smoke-runner] error', e && e.stack ? e.stack : e); }
      })();
    }
  } catch (e) { }
  // Reconfigure adblocker asynchronously when settings change
  setImmediate(() => reconfigureAdblocker().catch((err) => logError('adblock-reconfig', err)));
  return true;
});

ipcMain.handle('settings-update-feature-config', (event, featureId, patch) => {
  if (!_isSettingsTrusted(event)) throw new Error('Unauthorized IPC sender');
  if (typeof featureId !== 'string' || featureId.length > 128 || !patch || typeof patch !== 'object') {
    throw new Error('Invalid settings payload');
  }
  const ok = featureStore.updateFeatureConfig(featureId, patch);
  if (!ok) throw new Error('Unknown feature');
  emitSettingsState(event.sender.id);
  // Reconfigure adblocker if mode or settings changed
  setImmediate(() => reconfigureAdblocker().catch((err) => logError('adblock-reconfig', err)));
  return true;
});

ipcMain.handle('settings-reset-feature', (event, featureId) => {
  if (!_isSettingsTrusted(event)) throw new Error('Unauthorized IPC sender');
  if (typeof featureId !== 'string' || featureId.length > 128) throw new Error('Invalid feature id');
  const ok = featureStore.resetFeature(featureId);
  if (!ok) throw new Error('Unknown feature');
  if (featureId === 'webRtcProtection') applyWebRtcProtectionToTabs();
  emitSettingsState(event.sender.id);
  setImmediate(() => reconfigureAdblocker().catch((err) => logError('adblock-reconfig', err)));
  return true;
});

ipcMain.handle('settings-reset-all', (event) => {
  if (!_isSettingsTrusted(event)) throw new Error('Unauthorized IPC sender');
  featureStore.resetAll();
  applyWebRtcProtectionToTabs();
  emitSettingsState(event.sender.id);
  setImmediate(() => reconfigureAdblocker().catch((err) => logError('adblock-reconfig', err)));
  return true;
});

ipcMain.handle('settings-export', (event) => {
  if (!_isSettingsTrusted(event)) throw new Error('Unauthorized IPC sender');
  return featureStore.exportJson();
});

ipcMain.handle('settings-import', (event, jsonText) => {
  if (!_isSettingsTrusted(event)) throw new Error('Unauthorized IPC sender');
  if (typeof jsonText !== 'string' || jsonText.length > MAX_SETTINGS_PAYLOAD_LENGTH) {
    throw new Error('Invalid settings import payload');
  }
  const ok = featureStore.importJson(jsonText);
  if (!ok) throw new Error('Invalid settings JSON');
  applyWebRtcProtectionToTabs();
  emitSettingsState(event.sender.id);
  setImmediate(() => reconfigureAdblocker().catch((err) => logError('adblock-reconfig', err)));
  return true;
});

// ── BRAVE SUGGEST HELPER ──────────────────────────────────────
// Fetches search suggestions from Brave's public suggest endpoint.
// Returns an array of suggestion strings. Only the query is sent;
// no user data, history, cookies, or page content is included.
const _BRAVE_SUGGEST_URL = 'https://search.brave.com/api/suggest';
const _BRAVE_SUGGEST_TIMEOUT_MS = 4000;

function _fetchBraveSuggestions(query) {
  return new Promise((resolve, reject) => {
    try {
      const https = require('https');
      const url = new URL(_BRAVE_SUGGEST_URL);
      url.searchParams.set('q', query);
      const req = https.get(url.href, {
        timeout: _BRAVE_SUGGEST_TIMEOUT_MS,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`Brave suggest HTTP ${res.statusCode}`));
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // Response format: ["query", ["suggestion1", "suggestion2", ...]]
            if (Array.isArray(parsed) && Array.isArray(parsed[1])) {
              resolve(parsed[1]);
            } else {
              resolve([]);
            }
          } catch (e) {
            resolve([]);
          }
        });
        res.on('error', () => resolve([]));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Brave suggest timeout')); });
      req.on('error', () => resolve([]));
    } catch (e) {
      resolve([]);
    }
  });
}

// Network diagnostics (trusted renderer only)
ipcMain.handle('run-network-diagnostics', async (event) => {
  if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
  const urls = ['https://fonts.googleapis.com', 'https://www.youtube.com', 'https://example.com'];
  const https = require('https');
  function checkUrl(u) {
    return new Promise((resolve) => {
      try {
        const req = https.request(u, { method: 'HEAD', timeout: 5000 }, (res) => {
          resolve({ url: u, ok: res.statusCode >= 200 && res.statusCode < 400, statusCode: res.statusCode });
        });
        req.on('error', (err) => resolve({ url: u, ok: false, error: String(err) }));
        req.on('timeout', () => { req.destroy(); resolve({ url: u, ok: false, error: 'timeout' }); });
        req.end();
      } catch (e) {
        resolve({ url: u, ok: false, error: String(e) });
      }
    });
  }
  const results = await Promise.all(urls.map(checkUrl));
  return { results };
});

app.whenReady().then(async () => {
  // Restore the persisted Theme Mode into Chromium's prefers-color-scheme
  // before any window loads, so first paint and every subsequent website
  // already observe Kairon's selected color scheme.
  syncNativeColorScheme();

  initializeLogging();

  // Initialize history service
  try {
    historyService = new HistoryService(app.getPath('userData'));
  } catch (e) {
    console.error('[history] failed to initialize history service:', e);
  }

  // Initialize the bookmark service (electron-store backed, shared with the
  // FeatureStore — the same persistent storage layer the rest of the app uses).
  try {
    bookmarkService = new BookmarkService(store);
  } catch (e) {
    console.error('[bookmarks] failed to initialize bookmark service:', e);
  }

  // Initialize the Quick Access service — same electron-store layer, same
  // shape as BookmarkService. Feeds the home/new-tab page's Quick Access
  // section (seeded with the historical default dials on first run).
  try {
    quickAccessService = new QuickAccessService(store);
  } catch (e) {
    console.error('[quick-access] failed to initialize quick access service:', e);
  }

  installTelemetryRequestBlocker(session.defaultSession);
  
  // Set app icon explicitly
  try {
    if (process.platform === 'darwin') {
      app.dock.setIcon(getAppIconPath('.icns'));
    } else if (process.platform === 'win32') {
      app.setAppUserModelId(APP_USER_MODEL_ID);
    }
  } catch (e) {
    console.warn('[main] Could not set app icon:', e);
  }
  
  process.on('uncaughtException', (err) => logError('main-uncaughtException', err));
  process.on('unhandledRejection', (reason) => logError('main-unhandledRejection', reason));


  const sess = session.fromPartition('persist:browser');
  installTelemetryRequestBlocker(sess);

  // Install deny-by-default permission handlers on the main browsing session.
  // Must run before any windows are created so every tab inherits the policy.
  // Replaces the blanket grant that tab-sleep previously installed.
  setupSessionPermissionHandlers(sess);

  // Initialize the download manager — it routes every download to the
  // configured directory (system Downloads by default, or the user's chosen
  // folder persisted in the settings FeatureStore) and never shows a Save As
  // dialog for normal downloads.
  try {
    downloadManager = new DownloadManager({ store, featureStore, onStateChange: broadcastDownloadsState });
    downloadManager.attach(sess);
  } catch (e) {
    logError('downloads-init-failed', e);
  }
  // Initialize adblocker service only when the feature is enabled and mode is not 'off'.
  try {
    const adSettings = featureStore.getFeatureSettings('adBlocker') || {};
    const adMode = (adSettings && typeof adSettings.mode === 'string') ? String(adSettings.mode).toLowerCase() : 'off';
    const shouldInitAdblock = featureStore.isEnabled('adBlocker') && adMode !== 'off';
    if (shouldInitAdblock) {
      adblockerService = new AdblockerService({
        lists: null,
        updateIntervalMs: 24 * 60 * 60 * 1000,
        mode: adMode,
        onCss: (css) => {
          try {
            if (contentBlockingRuntime) {
              try { contentBlockingRuntime.applyToAll(); } catch (e) { }
            } else {
              for (const t of tabs.values()) {
                try { t.view.webContents.insertCSS(css).catch(() => { }); } catch (e) { }
              }
            }
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('adblock-css-updated', { css });
            }
          } catch (e) { }
        },
        onBlocked: (payload) => {
          try {
            sendAdblockEvent( payload);
            if (DIAG) console.info('[adblock] blocked', payload && payload.url, 'rule=', payload && payload.rule);
          } catch (e) { }
        }
      });

      // Defer adblocker initialization to after the window is shown so the
      // UI appears immediately while filter lists download in the background.
      // Tabs created before init completes won't have adblocking — that's
      // acceptable for the first ~1-2s of startup.
      (async () => {
        try {
          await adblockerService.init(sess);
        } catch (err) {
          logError('adblock-init-failed', err);
        }

        // Only create the runtime when cosmetic filters are in use (cosmetic or full)
        try {
          const usesCosmetic = (adMode === 'cosmetic' || adMode === 'standard' || adMode === 'full' || adMode === 'aggressive');
          if (usesCosmetic) {
            try { contentBlockingRuntime = new ContentBlockingRuntime(adblockerService); } catch (e) { contentBlockingRuntime = null; }
          }
          if (adMode === 'aggressive') {
            try {
              if (adblockerService && adblockerService.networkAttached) {
                console.info('[adblock] STARTUP: native blocker ACTIVE for aggressive mode');
              } else {
                console.warn('[adblock] STARTUP: native blocker INACTIVE - enabling fallback blocker');
                attachAggressiveFallbackToSession(sess);
              }
            } catch (e) { console.error('[adblock] aggressive initialization failed', e && e.stack ? e.stack : e); }
          }
        } catch (e) { contentBlockingRuntime = null; }
      })();
    }
  } catch (e) {
    logError('adblock-init-check', e);
  }
  ipcMain.on('kairon-dom-changed', (event) => {
    try {
      if (contentBlockingRuntime) contentBlockingRuntime.handleDomChanged(event.sender.id);
    } catch (e) { }
  });

  // Renderer can request the latest cosmetic CSS (preload uses this)
  // Restricted to trusted browser chrome and tab BrowserViews — untrusted
  // webpages must not be able to probe cosmetic filter rules.
  ipcMain.handle('get-cosmetic-css', (event) => {
    if (!isTrustedIpcSender(event) && !isTabBrowserView(event)) {
      throw new Error('Unauthorized IPC sender');
    }
    try {
      return (adblockerService && adblockerService.css) || '';
    } catch (e) { return ''; }
  });

  // ── HISTORY IPC (accept from trusted windows AND the internal history page) ──

  // History IPC is only reachable from trusted windows and from the internal
  // history page itself (its webContents URL must still be history.html).
  const _isHistoryTrusted = (event) => isTrustedIpcSender(event) || (isTabBrowserView(event) && isInternalHistoryPage(event));

  ipcMain.handle('history-get', (event, limit, offset) => {
    if (!_isHistoryTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!historyService) return [];
    return historyService.getHistory(limit || 50, offset || 0);
  });

  ipcMain.handle('history-search', (event, query, limit, offset) => {
    if (!_isHistoryTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!historyService) return [];
    if (typeof query !== 'string') return [];
    return historyService.searchHistory(query, limit || 50, offset || 0);
  });

  ipcMain.handle('history-autocomplete', (event, query, limit) => {
    if (!isTrustedIpcSender(event)) return [];
    if (!historyService) return [];
    if (typeof query !== 'string') return [];
    return historyService.getAutocompleteSuggestions(query, limit || 8);
  });

  // ── BRAVE SEARCH SUGGESTIONS (network, main process only) ─────
  // Fetches real-time search suggestions from Brave's public suggest endpoint.
  // The request stays in the main process — no network APIs are exposed to
  // webpage BrowserViews. Only the raw query string is sent; no history,
  // cookies, or page content is included.
  ipcMain.handle('brave-suggestions', async (event, query) => {
    if (!isTrustedIpcSender(event)) return [];
    if (typeof query !== 'string' || !query.trim()) return [];
    const trimmed = query.trim().slice(0, 200); // cap query length
    try {
      const suggestions = await _fetchBraveSuggestions(trimmed);
      return suggestions;
    } catch (err) {
      return []; // graceful failure — caller falls back to local history
    }
  });

  ipcMain.handle('history-delete-entry', (event, id) => {
    if (!_isHistoryTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!historyService) return false;
    if (!Number.isInteger(id)) throw new Error('Invalid history entry id');
    return historyService.deleteHistoryEntry(id);
  });

  ipcMain.handle('history-clear', (event) => {
    if (!_isHistoryTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!historyService) return;
    historyService.clearHistory();
  });

  ipcMain.handle('history-get-count', (event) => {
    if (!_isHistoryTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!historyService) return 0;
    return historyService.getEntryCount();
  });

  // ── BOOKMARKS IPC (accept from trusted windows AND the internal bookmarks page) ──

  // Bookmarks IPC is only reachable from trusted windows and from the internal
  // bookmarks page itself (its webContents URL must still be bookmarks.html).
  // All data is validated in the main process — renderer input can never write
  // directly into persistent storage.
  const _isBookmarksTrusted = (event) => isTrustedIpcSender(event) || (isTabBrowserView(event) && isInternalBookmarksPage(event));

  ipcMain.handle('bookmarks-get', (event) => {
    if (!_isBookmarksTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!bookmarkService) return [];
    return bookmarkService.getBookmarks();
  });

  ipcMain.handle('bookmarks-search', (event, query) => {
    if (!_isBookmarksTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!bookmarkService) return [];
    if (typeof query !== 'string') return [];
    return bookmarkService.searchBookmarks(query);
  });

  ipcMain.handle('bookmarks-delete', (event, id) => {
    if (!_isBookmarksTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!bookmarkService || !Number.isInteger(id)) return false;
    const removed = bookmarkService.deleteBookmark(id);
    if (removed) broadcastBookmarksState();
    return removed;
  });

  // ── BOOKMARK STAR IPC (browser chrome only) ──────────────────
  // The chrome star pulls the active tab's state to render itself and calls
  // the toggle action on click. Both go through the exact same
  // main-process BookmarkService and toggle path as Ctrl+D, so the star and
  // Ctrl+D share one source of truth (and the same toast feedback).

  ipcMain.handle('bookmarks-active-state', (event) => {
    if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
    return getActiveBookmarkState();
  });

  ipcMain.handle('bookmarks-toggle-active', (event) => {
    if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
    toggleBookmarkForTab(getActiveTab());
    return getActiveBookmarkState();
  });

  // Right-click menu for the bookmarks bar — a native Electron Menu (the same
  // pattern as the page context menu in context-menu.js). The bookmark is
  // re-validated here by id/URL before anything is shown or acted on.
  ipcMain.on('bookmarks-context-menu', (event, payload) => {
    if (!isTrustedIpcSender(event)) return;
    if (!bookmarkService || !payload || typeof payload !== 'object') return;
    const url = typeof payload.url === 'string' ? payload.url : '';
    const id = payload.id;
    if (!isAllowedHttpUrl(url) || !Number.isInteger(id)) return;
    const bookmark = bookmarkService.getBookmarkById(id);
    if (!bookmark || bookmark.url !== url) return;

    const openInActiveTab = () => {
      // Same validation path as the navigate/open-history-entry handlers.
      const target = normalizeNavigationTarget(url);
      if (!target) return;
      if (isSiteBlocked(target)) {
        try {
          if (mainWindow && !mainWindow.isDestroyed()) {
            sendAdblockEvent( {
              url: target,
              blocked: true,
              rule: 'site-blocker',
              resourceType: 'navigation',
              domain: (() => { try { return new URL(target).hostname; } catch { return null; } })(),
            });
          }
        } catch (e) { }
        return;
      }
      const tab = getActiveTab();
      if (tab) navigateTabToTarget(tab, target);
    };

    const menu = Menu.buildFromTemplate([
      { label: 'Open', click: openInActiveTab },
      { label: 'Open in New Tab', click: () => { const newTabId = createTab(url); switchToTab(newTabId); } },
      { label: 'Open in New Window', click: () => openLinkInNewWindow(url) },
      { type: 'separator' },
      {
        label: 'Delete Bookmark',
        click: () => {
          bookmarkService.deleteBookmark(id);
          broadcastBookmarksState();
        },
      },
    ]);
    try {
      menu.popup({ window: mainWindow });
    } catch (e) { }
  });

  // ── QUICK ACCESS IPC (accept from trusted windows AND the internal home page) ──

  // Quick Access IPC is only reachable from trusted windows and from the
  // internal home page itself (its webContents URL must still be home.html).
  // All data is validated in the main process — renderer input can never
  // write directly into persistent storage. Incognito tabs never load
  // home.html, so the Incognito window can never reach this store.
  const _isQuickAccessTrusted = (event) => isTrustedIpcSender(event) || (isTabBrowserView(event) && isInternalHomePage(event));

  ipcMain.handle('quick-access-get', (event) => {
    if (!_isQuickAccessTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!quickAccessService) return [];
    return quickAccessService.getEntries();
  });

  ipcMain.handle('quick-access-delete', (event, id) => {
    if (!_isQuickAccessTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!quickAccessService || !Number.isInteger(id)) return false;
    const removed = quickAccessService.deleteEntry(id);
    if (removed) broadcastQuickAccessState();
    return removed;
  });

  // Toggle the active page's Quick Access entry (star popup action). Same
  // main-process QuickAccessService and toggle path as the star popup's
  // "Add/Remove from Quick Access" row.
  ipcMain.handle('quick-access-toggle-active', (event) => {
    if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
    toggleQuickAccessForTab(getActiveTab());
    return getActiveBookmarkState();
  });

  // ── DOWNLOADS IPC (accept from trusted windows AND the internal downloads page) ──

  // Downloads IPC is only reachable from trusted windows and from the internal
  // downloads page itself (its webContents URL must still be downloads.html).
  const _isDownloadsTrusted = (event) => isTrustedIpcSender(event) || (isTabBrowserView(event) && isInternalDownloadsPage(event));

  ipcMain.handle('downloads-get', (event) => {
    if (!_isDownloadsTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager) return [];
    return downloadManager.getDownloads();
  });

  ipcMain.handle('downloads-clear', (event) => {
    if (!_isDownloadsTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager) return false;
    return downloadManager.clearCompleted();
  });

  ipcMain.handle('downloads-pause', (event, id) => {
    if (!_isDownloadsTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager || !Number.isInteger(id)) return false;
    return downloadManager.pause(id);
  });

  ipcMain.handle('downloads-resume', (event, id) => {
    if (!_isDownloadsTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager || !Number.isInteger(id)) return false;
    return downloadManager.resume(id);
  });

  ipcMain.handle('downloads-cancel', (event, id) => {
    if (!_isDownloadsTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager || !Number.isInteger(id)) return false;
    return downloadManager.cancel(id);
  });

  ipcMain.handle('downloads-open', async (event, id) => {
    if (!_isDownloadsTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager || !Number.isInteger(id)) return false;
    return downloadManager.openFile(id);
  });

  ipcMain.handle('downloads-show-in-folder', (event, id) => {
    if (!_isDownloadsTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager || !Number.isInteger(id)) return false;
    return downloadManager.showInFolder(id);
  });

  ipcMain.handle('downloads-open-folder', async (event) => {
    if (!_isDownloadsTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager) return false;
    return downloadManager.openDownloadsFolder();
  });

  ipcMain.handle('downloads-retry', (event, id) => {
    if (!_isDownloadsTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager || !Number.isInteger(id)) return false;
    return downloadManager.retry(id);
  });

  ipcMain.handle('downloads-remove', (event, id) => {
    if (!_isDownloadsTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager || !Number.isInteger(id)) return false;
    return downloadManager.removeDownload(id);
  });

  // ── DOWNLOAD LOCATION IPC (trusted windows + internal settings/downloads pages) ──

  // The download directory preference lives in the settings FeatureStore, so
  // both the internal settings page (where it is managed) and trusted windows
  // may read it. Changing it only affects future downloads.
  const _isDownloadLocationTrusted = (event) =>
    isTrustedIpcSender(event) ||
    (isTabBrowserView(event) && (isInternalSettingsPage(event) || isInternalDownloadsPage(event)));

  ipcMain.handle('downloads-get-location', (event) => {
    if (!_isDownloadLocationTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager) return { path: '', isDefault: true };
    return downloadManager.getDownloadLocationInfo();
  });

  // Opens the native folder picker — only ever on explicit user action from
  // Settings ("Change"), never during normal downloads. Selecting a folder
  // persists it and returns the new location; cancelling returns null.
  ipcMain.handle('downloads-set-location', async (event) => {
    if (!_isDownloadLocationTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager) return null;
    const current = downloadManager.getDownloadDirectory();
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose downloads folder',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths || !result.filePaths.length) return null;
    const info = downloadManager.setDownloadDirectory(result.filePaths[0]);
    if (info) emitSettingsState(event.sender.id);
    return info;
  });

  ipcMain.handle('downloads-reset-location', (event) => {
    if (!_isDownloadLocationTrusted(event)) throw new Error('Unauthorized IPC sender');
    if (!downloadManager) return { path: '', isDefault: true };
    const info = downloadManager.resetDownloadDirectory();
    emitSettingsState(event.sender.id);
    return info;
  });

  // ── DOWNLOADS PANEL IPC ───────────────────────────────────
  // The main renderer anchors the panel by sending the Downloads button's
  // rect; main sizes the overlay to the panel and tells it to render.
  ipcMain.on('show-downloads-panel', (event, payload) => {
    if (!isTrustedIpcSender(event)) return;
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const rect = payload && payload.rect && typeof payload.rect === 'object' ? payload.rect : null;
    if (!rect || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) return;

    // The panel, the omnibox suggestions, the app menu, and the star popup
    // share the overlay — never more than one at a time. An explicit show
    // always repositions the overlay, so any pending close freeze ends.
    overlayClosePending = false;
    activeOverlaySuggestions = null;
    _lastOverlaySuggestionBounds = null;
    activeAppMenu = null;
    _lastAppMenuBounds = null;
    activeStarPopup = null;
    _lastStarPopupBounds = null;
    try { overlayWindow.webContents.send('overlay-hide'); } catch (e) { }
    try { overlayWindow.webContents.send('app-menu-hide'); } catch (e) { }
    try { overlayWindow.webContents.send('star-popup-hide'); } catch (e) { }
    try { mainWindow.webContents.send('app-menu-hide'); } catch (e) { }
    try { mainWindow.webContents.send('star-popup-hide'); } catch (e) { }

    activeDownloadsPanel = { rect, at: Date.now() };
    // Hide → position → reveal (same rule as the app menu).
    try { overlayWindow.hide(); } catch (e) { }
    updateDownloadsPanelBounds();
    try { overlayWindow.show(); } catch (e) { }
    try { overlayWindow.setIgnoreMouseEvents(false); } catch (e) { }
    try { if (overlayWindow.setFocusable) overlayWindow.setFocusable(true); } catch (e) { }
    try { overlayWindow.webContents.send('downloads-panel-show', { rect }); } catch (e) { }
    // Echo to the main renderer so the toolbar button's open state stays in sync.
    try { mainWindow.webContents.send('downloads-panel-show', { rect }); } catch (e) { }
    try { overlayWindow.focus(); } catch (e) { }
  });

  ipcMain.on('hide-downloads-panel', (event) => {
    if (!isTrustedIpcSender(event)) return;
    hideDownloadsPanel();
  });

  // ── STAR POPUP IPC (browser chrome only) ──────────────────
  // The main renderer anchors the popup by sending the star button's rect;
  // main sizes the overlay to the popup and forwards the live page state
  // (bookmarked / inQuickAccess) so the two rows read the current state.
  ipcMain.on('show-star-popup', (event, payload) => {
    if (!isTrustedIpcSender(event)) return;
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const rect = payload && payload.rect && typeof payload.rect === 'object' ? payload.rect : null;
    if (!rect || !Number.isFinite(rect.right) || !Number.isFinite(rect.bottom)) return;

    // Only bookmarkable pages can open the popup (the star is disabled
    // everywhere else); re-validate here so a stale renderer can't bypass it.
    const state = getActiveBookmarkState();
    if (!state.bookmarkable) return;

    // The popup, the omnibox suggestions, the app menu, the downloads panel,
    // and the About dialog share the overlay — never more than one at a time.
    overlayClosePending = false;
    activeOverlaySuggestions = null;
    _lastOverlaySuggestionBounds = null;
    activeAppMenu = null;
    _lastAppMenuBounds = null;
    activeDownloadsPanel = null;
    activeAboutDialog = false;
    try { overlayWindow.webContents.send('overlay-hide'); } catch (e) { }
    try { overlayWindow.webContents.send('app-menu-hide'); } catch (e) { }
    try { overlayWindow.webContents.send('downloads-panel-hide'); } catch (e) { }
    try { overlayWindow.webContents.send('about-hide'); } catch (e) { }
    try { mainWindow.webContents.send('app-menu-hide'); } catch (e) { }
    try { mainWindow.webContents.send('downloads-panel-hide'); } catch (e) { }

    activeStarPopup = { rect, at: Date.now() };
    // Hide → position → reveal (same rule as every popup).
    try { overlayWindow.hide(); } catch (e) { }
    updateStarPopupBounds();
    try { overlayWindow.show(); } catch (e) { }
    try { overlayWindow.setIgnoreMouseEvents(false); } catch (e) { }
    try { if (overlayWindow.setFocusable) overlayWindow.setFocusable(true); } catch (e) { }
    // Include custom site state in the popup payload so overlay can render
    // the label synchronously (avoids async IPC check on popup open).
    (async () => {
      let isCs = false;
      try {
        const csJson = await mainWindow.webContents.executeJavaScript(
          'localStorage.getItem("kairon:custom-sites") || "[]"'
        );
        const csData = JSON.parse(csJson || '[]');
        isCs = Array.isArray(csData) && csData.some((s) => s.url === state.url);
      } catch (e) { /* localStorage read failed */ }
      try { overlayWindow.webContents.send('star-popup-show', { rect, state: { ...state, isCustomSite: isCs } }); } catch (e) { }
    })();
    // Echo to the main renderer so the star button's open state stays in sync.
    try { mainWindow.webContents.send('star-popup-show', { rect }); } catch (e) { }
    try { overlayWindow.focus(); } catch (e) { }
  });

  ipcMain.on('hide-star-popup', (event) => {
    if (!isTrustedIpcSender(event)) return;
    hideStarPopup();
  });

  // The overlay measures the popup's exact natural height after render and
  // reports it so the overlay is sized to fit (same pattern as the app menu).
  ipcMain.on('star-popup-measure', (event, payload) => {
    if (!isTrustedIpcSender(event)) return;
    if (!activeStarPopup) return;
    const height = payload && Number.isFinite(payload.height) ? Math.round(payload.height) : 0;
    if (height > 0 && height !== activeStarPopup.measuredHeight) {
      activeStarPopup.measuredHeight = height;
      updateStarPopupBounds();
    }
  });

  // ── CUSTOM SITES IPC ─────────────────────────────────────
  // The overlay star popup toggles pages in/out of Custom Sites. The main
  // renderer owns the data (localStorage-backed); this handler forwards the
  // request via webContents.send to the main renderer, which performs the
  // toggle and broadcasts the update back.
  ipcMain.handle('custom-sites-toggle', (event, url, name, favicon) => {
    if (!isTrustedIpcSender(event)) return false;
    // Forward to the main renderer which owns the custom-sites module
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('custom-sites-toggle-request', { url, name, favicon });
    }
    return true;
  });

  ipcMain.on('custom-sites-updated', (event) => {
    if (!isTrustedIpcSender(event)) return;
    // Broadcast to all windows (overlay needs the update for star popup state)
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('custom-sites-updated');
    }
  });

  // ── APP MENU IPC ─────────────────────────────────────────
  // The main renderer anchors the menu by sending the menu button's rect; main
  // sizes the overlay to the menu, computes the current browser state, and
  // tells the overlay to render it.
  ipcMain.on('show-app-menu', (event, payload) => {
    if (!isTrustedIpcSender(event)) return;
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    const rect = payload && payload.rect && typeof payload.rect === 'object' ? payload.rect : null;
    if (!rect || !Number.isFinite(rect.left) || !Number.isFinite(rect.bottom)) return;

    // The menu, the omnibox suggestions, the downloads panel, the star popup,
    // and the About dialog share the overlay — never more than one at a time.
    // An explicit show always repositions the overlay, so any pending close
    // freeze ends.
    overlayClosePending = false;
    activeOverlaySuggestions = null;
    _lastOverlaySuggestionBounds = null;
    activeAboutDialog = false;
    activeStarPopup = null;
    _lastStarPopupBounds = null;
    try { overlayWindow.webContents.send('overlay-hide'); } catch (e) { }
    try { overlayWindow.webContents.send('about-hide'); } catch (e) { }
    try { overlayWindow.webContents.send('star-popup-hide'); } catch (e) { }
    try { mainWindow.webContents.send('star-popup-hide'); } catch (e) { }

    activeAppMenu = { rect, at: Date.now() };
    // Hide → position → reveal: the overlay's geometry only ever changes while
    // the window is hidden, so a resize can never flash stale content at an
    // intermediate position.
    try { overlayWindow.hide(); } catch (e) { }
    updateAppMenuBounds();
    try { overlayWindow.show(); } catch (e) { }
    try { overlayWindow.setIgnoreMouseEvents(false); } catch (e) { }
    try { if (overlayWindow.setFocusable) overlayWindow.setFocusable(true); } catch (e) { }
    try { overlayWindow.webContents.send('app-menu-show', { rect, state: getAppMenuState() }); } catch (e) { }
    // Echo to the main renderer so the menu button's open state stays in sync.
    try { mainWindow.webContents.send('app-menu-show', { rect }); } catch (e) { }
    try { overlayWindow.focus(); } catch (e) { }
  });

  ipcMain.on('hide-app-menu', (event) => {
    if (!isTrustedIpcSender(event)) return;
    hideAppMenu();
  });

  // The overlay renderer reports that the toast finished its display cycle
  // (its fade-out completed), so main can reclaim the overlay bounds. The
  // main-side auto-hide timer is a safety net for the same transition.
  ipcMain.on('toast-hide', (event) => {
    if (!isTrustedIpcSender(event)) return;
    hideOverlayToast();
  });

  // The overlay renderer reports that a popup's close animation finished (or
  // the popup was hidden instantly). Only now is it safe to restore the
  // overlay's default full-window bounds — resizing earlier would have
  // teleported the still-visible popup. Skipped entirely when a new popup is
  // already showing (its own bounds win).
  ipcMain.on('popup-close-finished', (event) => {
    if (!isTrustedIpcSender(event)) return;
    overlayClosePending = false;
    // The toast owns the overlay while it is up (its close of other popups can
    // race the toast's own positioning), so a late popup-close notification
    // must never reclaim the overlay's bounds.
    if (activeAppMenu || activeDownloadsPanel || activeStarPopup || activeAboutDialog || activeOverlaySuggestions || activeToast) return;
    // The popup is fully hidden. Hide the overlay window itself before
    // restoring its default bounds, so the resize can never paint a stale
    // popup frame at an intermediate (far-left) position. The next popup
    // open repositions and reveals the window.
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      try { overlayWindow.hide(); } catch (e) { }
    }
    _lastOverlayBounds = null;
    updateOverlayBounds();
  });

  // The overlay measures the menu's exact natural height after render and
  // reports it so the overlay is sized to fit — never clips, never pads.
  ipcMain.on('app-menu-measure', (event, payload) => {
    if (!isTrustedIpcSender(event)) return;
    if (!activeAppMenu) return;
    const height = payload && Number.isFinite(payload.height) ? Math.round(payload.height) : 0;
    if (height > 0 && height !== activeAppMenu.measuredHeight) {
      activeAppMenu.measuredHeight = height;
      updateAppMenuBounds();
    }
  });

  // ── ABOUT DIALOG IPC ──────────────────────────────────────
  ipcMain.on('show-about', (event) => {
    if (!isTrustedIpcSender(event)) return;
    if (!overlayWindow || overlayWindow.isDestroyed()) return;
    overlayClosePending = false; // the About modal is full-window; free the freeze
    activeAppMenu = null;
    _lastAppMenuBounds = null;
    activeOverlaySuggestions = null;
    _lastOverlaySuggestionBounds = null;
    activeStarPopup = null;
    _lastStarPopupBounds = null;
    try { overlayWindow.webContents.send('overlay-hide'); } catch (e) { }
    try { overlayWindow.webContents.send('app-menu-hide'); } catch (e) { }
    try { overlayWindow.webContents.send('star-popup-hide'); } catch (e) { }
    try { mainWindow.webContents.send('app-menu-hide'); } catch (e) { }
    try { mainWindow.webContents.send('star-popup-hide'); } catch (e) { }

    activeAboutDialog = true;
    // Hide → position (full window) → reveal: same rule as every popup.
    try { overlayWindow.hide(); } catch (e) { }
    _lastOverlayBounds = null;
    updateOverlayBounds(); // full-window overlay for the centered modal
    try { overlayWindow.show(); } catch (e) { }
    try { overlayWindow.setIgnoreMouseEvents(false); } catch (e) { }
    try { if (overlayWindow.setFocusable) overlayWindow.setFocusable(true); } catch (e) { }
    let version = '1.0.0';
    try { version = app.getVersion(); } catch (e) { }
    try { overlayWindow.webContents.send('about-show', { version }); } catch (e) { }
    try { overlayWindow.focus(); } catch (e) { }
  });

  ipcMain.on('hide-about', (event) => {
    if (!isTrustedIpcSender(event)) return;
    hideAboutDialog();
  });

  // ── MENU ACTIONS ──────────────────────────────────────────
  // New Incognito Window — reuses the existing Incognito browser.
  ipcMain.on('open-incognito-window', (event) => {
    if (!isTrustedIpcSender(event)) return;
    openIncognitoWindow();
  });

  // New Window — opens an additional normal browser window.
  ipcMain.on('open-new-window', (event) => {
    if (!isTrustedIpcSender(event)) return;
    openNewWindow();
  });

  // Fullscreen — reuses the existing F11 toggle (also exits content fullscreen).
  ipcMain.on('toggle-fullscreen', (event) => {
    if (!isTrustedIpcSender(event)) return;
    toggleBrowserFullscreen();
  });

  // Exit — flush session state and quit, mirroring the restart path.
  ipcMain.on('app-exit', (event) => {
    if (!isTrustedIpcSender(event)) return;
    hideAppMenu();
    hideAboutDialog();
    setTimeout(() => {
      try { flushSessionPersist(); } catch (e) { }
      try { tabSleepManager.stop(); } catch (e) { }
      app.quit();
    }, 120);
  });

  // Authoritative current zoom factor so the menu's zoom display stays exact.
  ipcMain.handle('zoom-get', (event) => {
    if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
    const tab = getActiveTab();
    return { zoomFactor: tab && typeof tab.zoomFactor === 'number' ? tab.zoomFactor : 1.0 };
  });

  // ── FIND BAR IPC ──────────────────────────────────────────
  // The find bar lives in the main renderer (browser chrome). The app menu
  // (overlay renderer) and Ctrl+F request it through main, which forwards to
  // the chrome; find results flow back the same way.
  ipcMain.on('show-find-bar', (event) => {
    if (!isTrustedIpcSender(event)) return;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('find-bar-show');
    }
  });

  ipcMain.on('find-next', (event, text) => {
    if (!isTrustedIpcSender(event)) return;
    const tab = getActiveTab();
    if (!tab || typeof text !== 'string' || !text) return;
    try { tab.view.webContents.findInPage(text, { forward: true, findNext: true }); } catch (e) { }
  });

  ipcMain.on('find-prev', (event, text) => {
    if (!isTrustedIpcSender(event)) return;
    const tab = getActiveTab();
    if (!tab || typeof text !== 'string' || !text) return;
    try { tab.view.webContents.findInPage(text, { forward: false, findNext: true }); } catch (e) { }
  });

  ipcMain.on('find-close', (event) => {
    if (!isTrustedIpcSender(event)) return;
    const tab = getActiveTab();
    if (!tab) return;
    try { tab.view.webContents.stopFindInPage('clearSelection'); } catch (e) { }
  });

  // Hand keyboard focus back to the active page (find bar close, etc.).
  ipcMain.on('focus-page', (event) => {
    if (!isTrustedIpcSender(event)) return;
    focusActiveTabWebContents();
  });

  // Expose a diagnostic endpoint for adblock state (trusted renderer only)
  ipcMain.handle('get-adblock-status', (event) => {
    if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
    try {
      const adSettings = featureStore.getFeatureSettings('adBlocker') || {};
      const mode = (adSettings && typeof adSettings.mode === 'string') ? String(adSettings.mode).toLowerCase() : 'off';
      return {
        enabled: featureStore.isEnabled('adBlocker'),
        mode,
        nativeAttached: !!(adblockerService && adblockerService.networkAttached),
        enableError: (adblockerService && adblockerService._enableBlockingError) || null,
        aggressiveActive: !!_aggressiveActive,
        aggressiveBlockedCount: _aggressiveBlockedCount || 0,
        engineConfig: (adblockerService && adblockerService._engineConfig) || null,
      };
    } catch (e) {
      return {
        enabled: false,
        mode: 'off',
        nativeAttached: false,
        enableError: null,
        aggressiveActive: !!_aggressiveActive,
        aggressiveBlockedCount: _aggressiveBlockedCount || 0,
      };
    }
  });

  // ── AUTO UPDATER IPC ──────────────────────────────────────
  ipcMain.handle('updater-get-state', (event) => {
    if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
    return getUpdaterState();
  });

  ipcMain.handle('updater-check', async (event) => {
    if (!isTrustedIpcSender(event)) throw new Error('Unauthorized IPC sender');
    return await checkForUpdates();
  });

  ipcMain.on('updater-install', (event) => {
    if (!isTrustedIpcSender(event)) return;
    installUpdate();
  });

  createWindow();
  tabSleepManager.start();

  // Register the Incognito browser with the shared services it needs (theme,
  // settings, error logging, icon). It keeps its own window/tabs/session and
  // never touches normal browsing state. Ctrl+Shift+N opens it via
  // openIncognitoWindow() above.
  try {
    registerIncognitoBrowser({
      getCurrentThemeMode,
      getThemeQuery,
      featureStore,
      store,
      emitSettingsState,
      reconfigureAdblocker,
      logError,
      getAppIcon,
      sensitiveStoreKeys: SENSITIVE_STORE_KEYS,
      isSiteBlocked,
    });
  } catch (e) {
    logError('incognito-register-failed', e);
  }

  // Register the New Window module with shared services. Each additional
  // window created via Ctrl+N gets its own tabs, overlay, and layout,
  // sharing the same session and services as the main window.
  try {
    registerNewWindow({
      getCurrentThemeMode,
      getThemeQuery,
      featureStore,
      store,
      emitSettingsState,
      reconfigureAdblocker,
      logError,
      getAppIcon,
      getHistoryService: () => historyService,
      getBookmarkService: () => bookmarkService,
      getQuickAccessService: () => quickAccessService,
      getDownloadManager: () => downloadManager,
      getUpdaterState,
      sensitiveStoreKeys: SENSITIVE_STORE_KEYS,
      isSiteBlocked,
    });
    registerNewWindowIpc();
  } catch (e) {
    logError('new-window-register-failed', e);
  }

  // If adblock CSS is already available, inject into any created tabs and notify renderer.
  try {
    if (adblockerService && adblockerService.css) {
      if (contentBlockingRuntime) {
        try { await contentBlockingRuntime.applyToAll(); } catch (e) { }
      } else {
        for (const t of tabs.values()) {
          try { t.view.webContents.insertCSS(adblockerService.css).catch(() => { }); } catch (e) { }
        }
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('adblock-css-updated', { css: adblockerService.css });
    }
  } catch (e) { }

  // Initialize automatic updates (delayed check runs inside updater.js).
  try {
    initUpdater({
      onStateChange: (state) => {
        broadcastUpdaterState(state);
      },
    });
  } catch (e) {
    logError('updater-init-failed', e);
  }

  emitSettingsState();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  try {
    tabSleepManager.stop();
  } catch (e) { }
  try {
    flushSessionPersist();
  } catch (e) { }
  try {
    if (contentBlockingRuntime) {
      try { contentBlockingRuntime.destroy(); } catch (e) { }
      contentBlockingRuntime = null;
    }
  } catch (e) { }
  try {
    if (historyService) {
      try { historyService.flushNow(); } catch (e) { }
      historyService = null;
    }
  } catch (e) { }
  try {
    if (adblockerService) {
      try { adblockerService.destroy(); } catch (e) { }
      adblockerService = null;
    }
  } catch (e) { }
});
