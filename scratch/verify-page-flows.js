// One-off verification: Secure DNS restart-modal flow, Export/Import/Reset-all
// flows, using the REAL settings.html + REAL preload with stub IPC handlers.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.on('window-all-closed', () => {});

const PRELOAD = path.join(__dirname, '..', 'src', 'main', 'preload.js');
const SETTINGS_HTML = path.join(__dirname, '..', 'src', 'renderer', 'settings.html');

const watchdog = setTimeout(() => { console.log('FAIL | watchdog'); app.exit(3); }, 40000);
watchdog.unref();

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail !== undefined ? ' | ' + detail : ''));
  if (!ok) failures++;
}

function makeSnapshot() {
  const state = {};
  const set = (id, enabled, settings) => { state[id] = { enabled, settings }; };
  set('themeSystem', true, { mode: 'dark', tabPosition: 'sidebar' });
  set('adBlocker', true, { mode: 'standard' });
  set('httpsOnlyMode', true, {});
  set('webRtcProtection', true, {});
  set('dnsOverHttps', true, { provider: 'custom', customUrl: 'https://dns.nextdns.io/abc' });
  set('siteBlocker', false, { blockedSites: [] });
  return { registry: [], state };
}

const calls = [];
function record(channel) {
  return (...args) => { calls.push([channel, args]); return true; };
}

// Mirror the REAL FeatureStore + emitSettingsState: update-feature-config
// mutates the live snapshot and pushes settings-updated back to the page.
// Without the push-back the page's cancel-revert would re-sync from a stale
// local snapshot, which does not happen in the real app.
let liveSnapshot = null;
let pageWin = null;
function freshSnapshot() {
  liveSnapshot = makeSnapshot();
  return liveSnapshot;
}
function pushLive() {
  if (pageWin && !pageWin.isDestroyed() && liveSnapshot) {
    try { pageWin.webContents.send('settings-updated', liveSnapshot); } catch (e) { }
  }
}

app.whenReady().then(async () => {
  ipcMain.handle('get-adblock-mode', () => ({ enabled: false, mode: 'off' }));
  ipcMain.handle('get-cosmetic-css', () => '');
  ipcMain.handle('log-error', record('log-error'));
  ipcMain.handle('settings-get-state', freshSnapshot);
  ipcMain.handle('settings-set-feature-enabled', (e, featureId, enabled) => {
    calls.push(['settings-set-feature-enabled', [e, featureId, enabled]]);
    if (liveSnapshot && liveSnapshot.state[featureId]) liveSnapshot.state[featureId].enabled = enabled;
    pushLive();
    return true;
  });
  ipcMain.handle('settings-update-feature-config', (e, featureId, patch) => {
    calls.push(['settings-update-feature-config', [e, featureId, patch]]);
    if (liveSnapshot && liveSnapshot.state[featureId]) {
      Object.assign(liveSnapshot.state[featureId].settings, patch);
    }
    pushLive();
    return true;
  });
  ipcMain.handle('settings-reset-all', record('settings-reset-all'));
  ipcMain.handle('settings-import', record('settings-import'));
  ipcMain.handle('settings-export', () => JSON.stringify({ version: 1, state: { adBlocker: { enabled: true, settings: { mode: 'standard' } } } }));
  ipcMain.handle('restart-app', record('restart-app'));

  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  pageWin = win;
  await win.loadFile(SETTINGS_HTML);
  await new Promise((r) => setTimeout(r, 600));

  const run = (js) => win.webContents.executeJavaScript(js, true);

  await run('document.querySelector(".nav-item[data-cat=\\"privacy\\"]").click()');
  await new Promise((r) => setTimeout(r, 150));

  // ── DNS: custom URL row (fixture provider=custom) change → modal → confirm ──
  const rowVisible = await run('!document.querySelector("[data-dns-row=\\"customUrl\\"]").hidden');
  check('DNS: customUrl row visible when provider=custom', rowVisible === true);
  await run('(function(){ const i = document.querySelector("input[data-feature=\\"dnsOverHttps\\"][data-setting=\\"customUrl\\"]"); i.focus(); i.value = "https://dns.nextdns.io/xyz"; i.dispatchEvent(new Event("change")); })()');
  await new Promise((r) => setTimeout(r, 150));
  const modalOpen0 = await run('document.getElementById("modal-overlay").classList.contains("open")');
  check('DNS: customUrl change opens restart modal', modalOpen0 === true);
  await run('document.getElementById("modal-confirm").click()');
  await new Promise((r) => setTimeout(r, 200));
  const urlUpd = calls.filter((c) => c[0] === 'settings-update-feature-config' && c[1][1] === 'dnsOverHttps' && c[1][2] && c[1][2].customUrl === 'https://dns.nextdns.io/xyz');
  check('DNS: customUrl change issues update-feature-config + restart', urlUpd.length === 1 && calls.filter((c) => c[0] === 'restart-app').length === 1, 'match=' + urlUpd.length);

  // ── DNS: provider change opens the restart modal; confirm applies + restarts ──
  await run('(function(){ const s = document.querySelector("select[data-feature=\\"dnsOverHttps\\"][data-setting=\\"provider\\"]"); s.value = "quad9"; s.dispatchEvent(new Event("change")); })()');
  await new Promise((r) => setTimeout(r, 150));
  const modalOpen1 = await run('document.getElementById("modal-overlay").classList.contains("open")');
  const modalTitle = await run('document.getElementById("modal-title").textContent');
  check('DNS: provider change opens restart modal', modalOpen1 === true, modalTitle);
  check('DNS: modal title mentions restart', /Restart Kairon/.test(modalTitle), modalTitle);
  await run('document.getElementById("modal-confirm").click()');
  await new Promise((r) => setTimeout(r, 200));
  const dnsUpd = calls.filter((c) => c[0] === 'settings-update-feature-config' && c[1][1] === 'dnsOverHttps' && c[1][2] && c[1][2].provider === 'quad9');
  const dnsRestart = calls.filter((c) => c[0] === 'restart-app');
  check('DNS: confirm issues update-feature-config(provider=quad9)', dnsUpd.length === 1, 'match=' + dnsUpd.length);
  check('DNS: confirm requests app restart', dnsRestart.length === 2, 'match=' + dnsRestart.length);
  const modalClosed1 = await run('!document.getElementById("modal-overlay").classList.contains("open")');
  check('DNS: modal closes after confirm', modalClosed1 === true);

  // ── DNS: cancel reverts the select (live snapshot now says quad9) ──
  await run('(function(){ const s = document.querySelector("select[data-feature=\\"dnsOverHttps\\"][data-setting=\\"provider\\"]"); s.dispatchEvent(new Event("focus")); s.value = "cloudflare"; s.dispatchEvent(new Event("change")); })()');
  await new Promise((r) => setTimeout(r, 150));
  await run('document.getElementById("modal-cancel").click()');
  await new Promise((r) => setTimeout(r, 150));
  const reverted = await run('document.querySelector("select[data-feature=\\"dnsOverHttps\\"][data-setting=\\"provider\\"]").value');
  check('DNS: cancel reverts the select to prior value', reverted === 'quad9', String(reverted));

  // ── Advanced: Export ──
  await run('document.querySelector(".nav-item[data-cat=\\"advanced\\"]").click()');
  await new Promise((r) => setTimeout(r, 150));
  await run('document.querySelector(".action[data-action=\\"export\\"]").click()');
  await new Promise((r) => setTimeout(r, 250));
  const exportShown = await run('!document.getElementById("modal-textarea").hidden && document.getElementById("modal-textarea").value.length > 0');
  const exportParses = await run('(function(){ try { JSON.parse(document.getElementById("modal-textarea").value); return true; } catch (e) { return false; } })()');
  check('Export: modal shows parseable settings JSON', exportShown === true && exportParses === true);

  // ── Advanced: Import valid ──
  await run('document.getElementById("modal-cancel").click()');
  await new Promise((r) => setTimeout(r, 120));
  await run('document.querySelector(".action[data-action=\\"import\\"]").click()');
  await new Promise((r) => setTimeout(r, 150));
  await run('(function(){ const t = document.getElementById("modal-textarea"); t.value = JSON.stringify({ version: 1, state: {} }); })()');
  await run('document.getElementById("modal-confirm").click()');
  await new Promise((r) => setTimeout(r, 200));
  const impValid = calls.filter((c) => c[0] === 'settings-import');
  check('Import: valid JSON issues settings-import', impValid.length === 1, 'match=' + impValid.length);

  // ── Advanced: Import invalid stays open, no IPC ──
  const importCallsBefore = calls.filter((c) => c[0] === 'settings-import').length;
  await run('document.querySelector(".action[data-action=\\"import\\"]").click()');
  await new Promise((r) => setTimeout(r, 150));
  await run('(function(){ const t = document.getElementById("modal-textarea"); t.value = "{not json"; })()');
  await run('document.getElementById("modal-confirm").click()');
  await new Promise((r) => setTimeout(r, 200));
  const importCallsAfter = calls.filter((c) => c[0] === 'settings-import').length;
  const stillOpen = await run('document.getElementById("modal-overlay").classList.contains("open")');
  check('Import: invalid JSON issues no IPC and keeps modal open', importCallsAfter === importCallsBefore && stillOpen === true,
    'before=' + importCallsBefore + ' after=' + importCallsAfter + ' open=' + stillOpen);

  // ── Advanced: Reset all ──
  await run('document.getElementById("modal-cancel").click()');
  await new Promise((r) => setTimeout(r, 120));
  await run('document.querySelector(".action[data-action=\\"reset\\"]").click()');
  await new Promise((r) => setTimeout(r, 150));
  const resetDanger = await run('document.getElementById("modal-confirm").classList.contains("btn-danger")');
  await run('document.getElementById("modal-confirm").click()');
  await new Promise((r) => setTimeout(r, 200));
  const resetCalls = calls.filter((c) => c[0] === 'settings-reset-all');
  check('Reset-all: modal is danger-styled and confirm issues settings-reset-all', resetDanger === true && resetCalls.length === 1,
    'danger=' + resetDanger + ' match=' + resetCalls.length);

  clearTimeout(watchdog);
  console.log('---');
  console.log(failures === 0 ? 'ALL FLOW CHECKS PASSED' : failures + ' FLOW CHECK(S) FAILED');
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('HARNESS ERROR', err && err.stack ? err.stack : err);
  app.exit(2);
});
