// ============================================================
//  KAIRON SETTINGS WINDOW — entry point
// ============================================================

import { initSettingsPanel } from './settings.js';

const { kairon } = window;

const settings = initSettingsPanel(kairon);

window.addEventListener('error', (event) => {
  const msg = event.error?.stack || event.message || 'Unknown settings renderer error';
  kairon.logError('settings-window-error', msg).catch(() => {});
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason?.stack || event.reason?.message || String(event.reason ?? 'Unhandled rejection');
  kairon.logError('settings-window-rejection', reason).catch(() => {});
});

kairon.onSettingsUpdated((snapshot) => {
  settings.applySettings(snapshot);
});

settings.bindEvents();
settings.bootstrapState().catch((err) => {
  kairon.logError('settings-bootstrap', err?.stack || err?.message || String(err)).catch(() => {});
});
