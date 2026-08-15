// ============================================================
//  KAIRON RENDERER — v2.0
//  Entry point. Wires IPC, UI, AI, layout metrics.
// ============================================================

import { createTabStateStore } from './state.js';
import { createUiController }  from './ui.js';
import { initAiPanel }         from './ai.js';

const { kairon } = window;

// ── GLOBAL THEME ─────────────────────────────────────────────
// The persisted Theme Mode (FeatureStore) is the single source of truth for
// the whole browser. The main process passes it as ?theme= at load so the
// chrome renders the right theme before first paint; the authoritative value
// is re-applied from the settings snapshot on boot and on every live
// settings-updated push. Transitions are suspended for one frame while
// flipping so every chrome surface re-skins instantly (Chromium freezes
// transitions in hidden/occluded windows, which would leave stale colors).
function applyChromeTheme(mode) {
  const theme = mode === 'light' ? 'light' : 'dark';
  if (document.body.dataset.theme === theme) return;
  document.body.classList.add('theme-switching');
  document.body.dataset.theme = theme;
  setTimeout(() => document.body.classList.remove('theme-switching'), 60);
}

// Synchronous first-paint hint from the load query (rendered before paint).
try {
  applyChromeTheme(new URLSearchParams(location.search).get('theme'));
} catch (e) {}

// ── INIT ─────────────────────────────────────────────────────
console.info('[renderer] init');
const tabStore = createTabStateStore();
const ui       = createUiController(kairon, tabStore, publishLayoutMetricsNow);
const ai       = initAiPanel(kairon);

// Authoritative boot value from the real store (corrects any stale query).
kairon.getSettingsState().then((snapshot) => {
  applyChromeTheme(snapshot.state?.themeSystem?.settings?.mode);
}).catch(() => {});

// ── ERROR CAPTURE ─────────────────────────────────────────────
window.addEventListener('error', (event) => {
  const msg = event.error?.stack || event.message || 'Unknown renderer error';
  kairon.logError('window-error', msg).catch(() => {});
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason?.stack || event.reason?.message || String(event.reason ?? 'Unhandled rejection');
  kairon.logError('unhandled-rejection', reason).catch(() => {});
});

// ── IPC BINDINGS ──────────────────────────────────────────────
kairon.onTabsState((payload)  => ui.onTabsState(payload));
kairon.onUrlChanged((url)     => ui.onUrlChanged(url));
kairon.onTitleChanged((title) => ui.onTitleChanged(title));
kairon.onLoading((loading)    => ui.onLoading(loading));
kairon.onAdblockEvent((payload) => ui.onAdblockEvent(payload));
kairon.onNavigationInvalid(() => ui.onNavigationInvalid());
kairon.onSettingsUpdated((snapshot) => {
  const mode = snapshot.state?.themeSystem?.settings?.mode;
  if (mode) applyChromeTheme(mode);
  const tabPosition = snapshot.state?.themeSystem?.settings?.tabPosition;
  if (tabPosition && tabPosition !== ui.tabPosition) ui.setTabPosition(tabPosition, true);
});

// ── WINDOW CONTROLS ───────────────────────────────────────────
document.getElementById('btn-min')  .addEventListener('click', () => kairon.windowMinimize());
document.getElementById('btn-max')  .addEventListener('click', () => kairon.windowMaximize());
document.getElementById('btn-close').addEventListener('click', () => kairon.windowClose());

// ── SETTINGS ──────────────────────────────────────────────────
// Settings is a first-class internal page (kairon://settings) opened in the
// active tab — the same pattern as the history page.
const SETTINGS_PAGE_URL = 'kairon://settings';
document.getElementById('btn-open-settings')?.addEventListener('click', () => kairon.navigate(SETTINGS_PAGE_URL));
document.getElementById('btn-chrome-settings')?.addEventListener('click', () => kairon.navigate(SETTINGS_PAGE_URL));

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === ',') {
    e.preventDefault();
    kairon.navigate(SETTINGS_PAGE_URL);
  }
});

// ── AI PANEL TOGGLE ───────────────────────────────────────────
const btnToggleAi = document.getElementById('btn-toggle-ai');
const aiPanel     = document.getElementById('ai-panel');

btnToggleAi.addEventListener('click', () => {
  const hidden = aiPanel.classList.toggle('hidden');
  btnToggleAi.classList.toggle('active', !hidden);
  // Recompute layout so webview repositions
  setTimeout(publishLayoutMetricsNow, 320); // wait for CSS transition
});

const btnCloseAi = document.getElementById('btn-close-ai');
btnCloseAi.addEventListener('click', () => {
  aiPanel.classList.add('hidden');
  btnToggleAi.classList.remove('active');
  setTimeout(publishLayoutMetricsNow, 320);
});

// ── LAYOUT METRICS ────────────────────────────────────────────
const centerCol  = document.getElementById('center-col');
const statusStrip = document.getElementById('status-strip');

// Single measurement source shared by the debounced, immediate, and delayed
// publishes — avoids triplicating the geometry math.
function _measureLayout() {
  if (!centerCol || !statusStrip) return null;
  const centerRect = centerCol.getBoundingClientRect();
  const statusRect  = statusStrip.getBoundingClientRect();
  return {
    x:      Math.round(centerRect.left),
    y:      Math.round(statusRect.bottom),
    width:  Math.round(centerRect.width),
    height: Math.round(Math.max(1, window.innerHeight - Math.round(statusRect.bottom))),
  };
}

// Sends layout metrics on the given channel. The delayed variant is a
// diagnostic-only post-settle check that does NOT re-apply bounds — it only
// lets the main process compare settled vs initial measurements.
function _sendLayoutMetrics(metrics, delayed = false) {
  if (!metrics) return;
  if (delayed) kairon.sendLayoutMetricsDelayed(metrics);
  else kairon.updateLayoutMetrics(metrics);
}

// Debounce: during active resize/maximize, wait 150ms of quiescence
// before sending layout metrics. Prevents stale mid-resize measurements
// from being applied after the window has already settled to a
// different (usually smaller) size — the root cause of the off-center bug.
let _layoutMetricsTimer = null;
function publishLayoutMetrics() {
  if (_layoutMetricsTimer) clearTimeout(_layoutMetricsTimer);
  _layoutMetricsTimer = setTimeout(() => {
    _layoutMetricsTimer = null;
    _sendLayoutMetrics(_measureLayout());
  }, 150);
}

// Also keep an immediate (non-debounced) variant for initial publish
// and deliberate calls (like AI panel toggle).
function publishLayoutMetricsNow() {
  if (_layoutMetricsTimer) {
    clearTimeout(_layoutMetricsTimer);
    _layoutMetricsTimer = null;
  }
  _sendLayoutMetrics(_measureLayout());
}

window.addEventListener('resize', publishLayoutMetrics);
new ResizeObserver(publishLayoutMetrics).observe(centerCol);

// ── STARTUP ───────────────────────────────────────────────────
ui.bindEvents();
ai.bindEvents();

// Initial measurement — must be immediate, not debounced
publishLayoutMetricsNow();

// Send display info (DPI / devicePixelRatio) for cross-referencing
try {
  kairon.sendDisplayInfo({
    devicePixelRatio: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
  });
} catch (e) { console.error('[renderer] sendDisplayInfo failed', e); }

// Delayed layout metrics check (2s) to detect post-settle shifts
setTimeout(() => {
  _sendLayoutMetrics(_measureLayout(), true);
}, 2000);
