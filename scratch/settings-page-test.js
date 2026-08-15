// Runtime smoke test for the kairon://settings page.
// Loads the REAL settings.html with the REAL app preload inside a sandboxed
// BrowserWindow, registers the settings IPC handlers it depends on, and
// asserts the page renders, switches categories, searches, deep-links, and
// issues the correct IPC calls.
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

// Keep the app alive while test windows are destroyed mid-run (the real app
// always has the main window + overlay, so this only matters for the harness).
app.on('window-all-closed', () => {});

const PRELOAD = path.join(__dirname, '..', 'src', 'main', 'preload.js');
const SETTINGS_HTML = path.join(__dirname, '..', 'src', 'renderer', 'settings.html');

// Hard watchdog: never hang the CI run.
const watchdog = setTimeout(() => {
  console.error('WATCHDOG: harness timed out');
  console.log('FAIL | harness timed out');
  app.exit(3);
}, 45000);
watchdog.unref();

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION', reason && reason.stack ? reason.stack : reason);
});

function makeSnapshot() {
  const state = {};
  const set = (id, enabled, settings) => { state[id] = { enabled, settings }; };
  set('themeSystem', true, { mode: 'dark', tabPosition: 'sidebar' });
  set('adBlocker', true, { mode: 'standard', blockTrackers: true, blockAds: true });
  set('httpsOnlyMode', true, {});
  set('webRtcProtection', true, {});
  set('dnsOverHttps', true, { provider: 'cloudflare', customUrl: '' });
  set('siteBlocker', false, { blockedSites: ['example.com'], allowOverrides: true, schedules: [] });
  return { registry: [], state };
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail !== undefined ? ' | ' + detail : ''));
  if (!ok) failures++;
}

const calls = [];
function record(channel) {
  return (...args) => { calls.push([channel, args]); return true; };
}

app.whenReady().then(async () => { console.log("STEP: whenReady");
  ipcMain.handle('get-adblock-mode', () => ({ enabled: false, mode: 'off' }));
  ipcMain.handle('get-cosmetic-css', () => '');
  ipcMain.handle('log-error', record('log-error'));
  ipcMain.handle('settings-get-state', () => makeSnapshot());
  ipcMain.handle('settings-set-feature-enabled', record('settings-set-feature-enabled'));
  ipcMain.handle('settings-update-feature-config', record('settings-update-feature-config'));
  ipcMain.handle('settings-reset-feature', record('settings-reset-feature'));
  ipcMain.handle('settings-reset-all', record('settings-reset-all'));
  ipcMain.handle('settings-export', () => JSON.stringify(makeSnapshot()));
  ipcMain.handle('settings-import', record('settings-import'));
  ipcMain.handle('restart-app', record('restart-app'));

  function makeWin() {
    return new BrowserWindow({
      show: false,
      webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
  }

  async function settle(win) {
    // loadFile's promise resolves on did-finish-load, so a listener attached
    // here would race. Just wait out the page's async init + preload roundtrips.
    await new Promise((r) => setTimeout(r, 600));
  }

  async function run(win, js) {
    const out = await win.webContents.executeJavaScript(js, true);
    return out;
  }

  async function exerciseWin(win, label) {
    console.log("STEP: settle start for", label);
    await settle(win);
    console.log("STEP: settle done for", label);
    const runJs = (js) => run(win, js);

    const navCount = await runJs('document.querySelectorAll(".nav-item").length');
    check(label + ': 4 nav items rendered', navCount === 4, 'got ' + navCount);

    // Dark is the default theme and must keep its exact original colors
    const darkBodyBg = await runJs('getComputedStyle(document.body).backgroundColor');
    check(label + ': dark body keeps the original --bg (#050505)', darkBodyBg === 'rgb(5, 5, 5)', darkBodyBg);
    const darkCardBg = await runJs('getComputedStyle(document.querySelector(".card")).backgroundColor');
    check(label + ': dark card keeps the original --card-bg (#070707)', darkCardBg === 'rgb(7, 7, 7)', darkCardBg);

    const firstTitle = await runJs('document.getElementById("page-title").textContent');
    check(label + ': default category rendered (Appearance)', firstTitle === 'Appearance', firstTitle);

    await runJs('document.querySelector(".nav-item[data-cat=\\"privacy\\"]").click()');
    await new Promise((r) => setTimeout(r, 150));
    const privacyTitle = await runJs('document.getElementById("page-title").textContent');
    check(label + ': category switch to Privacy', privacyTitle === 'Privacy', privacyTitle);

    const privacySwitches = await runJs('document.querySelectorAll(".section[data-cat=\\"privacy\\"] .switch[data-feature]").length');
    check(label + ': Privacy shows 4 feature switches', privacySwitches === 4, 'got ' + privacySwitches);

    await runJs('document.querySelector(".switch[data-feature=\\"httpsOnlyMode\\"]").click()');
    await new Promise((r) => setTimeout(r, 150));
    const toggleCalls = calls.filter((c) => c[0] === 'settings-set-feature-enabled' && c[1][1] === 'httpsOnlyMode');
    check(label + ': master toggle issues settings-set-feature-enabled', toggleCalls.length === 1, 'match=' + toggleCalls.length);

    await runJs('(function(){ const s = document.querySelector("select[data-feature=\\"adBlocker\\"][data-setting=\\"mode\\"]"); s.value = "aggressive"; s.dispatchEvent(new Event("change")); })()');
    await new Promise((r) => setTimeout(r, 150));
    const selCalls = calls.filter((c) => c[0] === 'settings-update-feature-config' && c[1][1] === 'adBlocker' && c[1][2] && c[1][2].mode === 'aggressive');
    check(label + ': adBlocker mode select issues update-feature-config', selCalls.length === 1, 'match=' + selCalls.length);

    await runJs('(function(){ const i = document.getElementById("settings-search"); i.value = "dark mode"; i.dispatchEvent(new Event("input")); })()');
    await new Promise((r) => setTimeout(r, 300));
    const searchTitle = await runJs('document.getElementById("page-title").textContent');
    const searchMatches = await runJs('document.querySelectorAll(".is-match").length');
    check(label + ': search title shows Search', searchTitle === 'Search', searchTitle);
    check(label + ': "dark mode" yields >=1 match', searchMatches >= 1, 'got ' + searchMatches);

    await runJs('(function(){ const i = document.getElementById("settings-search"); i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()');
    await new Promise((r) => setTimeout(r, 250));
    const afterSearchTitle = await runJs('document.getElementById("page-title").textContent');
    const searchCleared = await runJs('document.getElementById("settings-search").value === ""');
    check(label + ': Enter navigates to matching category', afterSearchTitle === 'Appearance', afterSearchTitle);
    check(label + ': search cleared after navigation', searchCleared === true);

    await runJs('document.querySelector(".nav-item[data-cat=\\"security\\"]").click()');
    await new Promise((r) => setTimeout(r, 150));
    await runJs('document.querySelector("[data-action=\\"site-blocker\\"]").click()');
    await new Promise((r) => setTimeout(r, 150));
    await runJs('(function(){ const t = document.getElementById("modal-textarea"); t.value = "a.com\\nb.com"; })()');
    await runJs('document.getElementById("modal-confirm").click()');
    await new Promise((r) => setTimeout(r, 150));
    const listCalls = calls.filter((c) => c[0] === 'settings-update-feature-config' && c[1][1] === 'siteBlocker' && Array.isArray(c[1][2].blockedSites) && c[1][2].blockedSites.join() === 'a.com,b.com');
    check(label + ': blocked-sites list issues update-feature-config', listCalls.length === 1, 'match=' + listCalls.length);
  }

  // Window A: plain load (defaults to first category)
  console.log("STEP: before winA");
  const winA = makeWin(); console.log("STEP: winA created");
  await winA.loadFile(SETTINGS_HTML); console.log("STEP: winA loadFile done");
  console.log("STEP: before exerciseWin");
  await exerciseWin(winA, 'A(plain)');
  console.log("STEP: exerciseWin done");
  winA.destroy();

  // Window B: deep link kairon://settings/privacy → section=privacy
  const winB = makeWin();
  await winB.loadFile(SETTINGS_HTML, { query: { section: 'privacy' } });
  await settle(winB);
  const bTitle = await run(winB, 'document.getElementById("page-title").textContent');
  check('B(deep link ?section=privacy): opens Privacy', bTitle === 'Privacy', bTitle);
  winB.destroy();

  // Window C: invalid deep link → falls back to first category, no crash
  const winC = makeWin();
  await winC.loadFile(SETTINGS_HTML, { query: { section: 'not-a-real-section' } });
  await settle(winC);
  const cTitle = await run(winC, 'document.getElementById("page-title").textContent');
  check('C(invalid deep link): falls back to Appearance, no crash', cTitle === 'Appearance', cTitle);
  winC.destroy();

  // Window D: theme light → data-theme=light + Light segment selected
  const winD = makeWin();
  ipcMain.removeHandler('settings-get-state');
  ipcMain.handle('settings-get-state', () => {
    const snap = makeSnapshot();
    snap.state.themeSystem.settings.mode = 'light';
    return snap;
  });
  await winD.loadFile(SETTINGS_HTML);
  await settle(winD);
  const theme = await run(winD, 'document.body.dataset.theme');
  const lightSelected = await run(winD, 'document.querySelector(".segment[data-feature=\\"themeSystem\\"][data-setting=\\"mode\\"][data-value=\\"light\\"]").classList.contains("selected")');
  check('D(theme light): data-theme=light applied', theme === 'light', theme);
  check('D(theme light): Light segment reflects stored state', lightSelected === true);

  // Light mode must actually re-skin the page through the CSS variables
  const bodyBg = await run(winD, 'getComputedStyle(document.body).backgroundColor');
  check('D(theme light): body background is the light --bg', bodyBg === 'rgb(240, 240, 240)', bodyBg);
  const cardBg = await run(winD, 'getComputedStyle(document.querySelector(".card")).backgroundColor');
  check('D(theme light): card background adapts (--card-bg)', cardBg === 'rgb(247, 247, 247)', cardBg);

  // Switching Dark ↔ Light must update the UI instantly AND issue the store write
  await run(winD, 'document.querySelector(".segment[data-feature=\\"themeSystem\\"][data-setting=\\"mode\\"][data-value=\\"dark\\"]").click()');
  await new Promise((r) => setTimeout(r, 150));
  const themeAfterClick = await run(winD, 'document.body.dataset.theme');
  const darkSelected = await run(winD, 'document.querySelector(".segment[data-feature=\\"themeSystem\\"][data-setting=\\"mode\\"][data-value=\\"dark\\"]").classList.contains("selected")');
  const modeCalls = calls.filter((c) => c[0] === 'settings-update-feature-config' && c[1][1] === 'themeSystem' && c[1][2] && c[1][2].mode === 'dark');
  check('D(theme light): clicking Dark switches the page instantly', themeAfterClick === 'dark', themeAfterClick);
  check('D(theme light): Dark segment selected after click', darkSelected === true);
  check('D(theme light): theme switch issues settings-update-feature-config', modeCalls.length === 1, 'match=' + modeCalls.length);

  // The optimistic local snapshot must survive a re-render (category round-trip)
  await run(winD, 'document.querySelector(".nav-item[data-cat=\\"privacy\\"]").click()');
  await new Promise((r) => setTimeout(r, 150));
  await run(winD, 'document.querySelector(".nav-item[data-cat=\\"appearance\\"]").click()');
  await new Promise((r) => setTimeout(r, 150));
  const themeAfterNav = await run(winD, 'document.body.dataset.theme');
  const darkStillSelected = await run(winD, 'document.querySelector(".segment[data-feature=\\"themeSystem\\"][data-setting=\\"mode\\"][data-value=\\"dark\\"]").classList.contains("selected")');
  check('D(theme light): theme survives category navigation (no revert)', themeAfterNav === 'dark' && darkStillSelected === true, themeAfterNav + '/' + darkStillSelected);
  winD.destroy();

  clearTimeout(watchdog);
  console.log('---');
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  app.exit(failures === 0 ? 0 : 1);
}).catch((err) => {
  console.error('HARNESS ERROR', err && err.stack ? err.stack : err);
  console.log('FAIL | harness error');
  app.exit(2);
});
