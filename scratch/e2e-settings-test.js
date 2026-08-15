// End-to-end test against the REAL Kairon app via CDP:
//  1. launch the app with --remote-debugging-port
//  2. navigate the active tab to kairon://settings from the main window
//  3. verify the settings page renders and its settings IPC is trusted
//  4. navigate the settings tab to an external site and verify settings IPC
//     is revoked immediately (and unusable from remote pages)
const { spawn } = require('child_process');
const http = require('http');

const PORT = 9333;
const CDP = 'http://127.0.0.1:' + PORT;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail !== undefined ? ' | ' + detail : ''));
  if (!ok) failures++;
}

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get(CDP + path, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class CDPClient {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const client = new CDPClient(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && client.pending.has(msg.id)) {
        const { resolve, reject } = client.pending.get(msg.id);
        client.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    return client;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (res.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description));
    return res.result && res.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitForTarget(urlPart, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await getJson('/json/list').catch(() => []);
    const t = targets.find((x) => x.url && x.url.includes(urlPart) && x.type === 'page');
    if (t) return t;
    await sleep(400);
  }
  return null;
}

(async () => {
  const child = spawn('npx', ['electron', '.', '--remote-debugging-port=' + PORT], {
    cwd: process.cwd(),
    env: { ...process.env, KAIRON_DIAG: '0' },
    stdio: 'ignore',
    shell: true,
    windowsHide: true,
  });

  try {
    // wait for CDP to come up
    let targets = null;
    for (let i = 0; i < 40; i++) {
      targets = await getJson('/json/list').catch(() => null);
      if (targets && targets.length) break;
      await sleep(500);
    }
    if (!targets) throw new Error('CDP never came up');

    const mainTarget = targets.find((t) => t.url && t.url.includes('/renderer/index.html'));
    if (!mainTarget) throw new Error('main window target not found: ' + JSON.stringify(targets.map((t) => t.url)));
    const main = await CDPClient.connect(mainTarget.webSocketDebuggerUrl);

    // 1. Navigate the active tab to kairon://settings
    await main.evaluate(`window.kairon.navigate('kairon://settings')`);
    const settingsTarget = await waitForTarget('/settings.html');
    check('E2E: kairon://settings opens in a tab', !!settingsTarget,
      settingsTarget ? settingsTarget.url : 'no target');

    const st = await CDPClient.connect(settingsTarget.webSocketDebuggerUrl);
    // Poll until the page actually renders — on a cold app start the first
    // load can take longer than a fixed sleep.
    let navCount = 0;
    for (let i = 0; i < 30 && navCount === 0; i++) {
      navCount = await st.evaluate(`document.querySelectorAll('.nav-item').length`).catch(() => 0);
      if (navCount === 0) await sleep(300);
    }
    check('E2E: settings page renders 4 nav items', navCount === 4, 'got ' + navCount);

    const title = await st.evaluate(`document.getElementById('page-title').textContent`);
    check('E2E: default category renders', title === 'Appearance', title);

    // 2. Settings IPC from the internal page must be TRUSTED (real sender validation)
    let stateKeys = null;
    try {
      stateKeys = await st.evaluate(`window.kairon.getSettingsState().then(s => Object.keys(s.state).length)`);
    } catch (e) {
      stateKeys = 'ERR: ' + e.message;
    }
    // Real registry has 11 features (6 wired + 5 inert-but-registered); the
    // snapshot must flow through from the FeatureStore.
    check('E2E: settings IPC trusted from the internal page', stateKeys >= 6, String(stateKeys));

    // 3. Navigate the settings tab to an external site → privileges must be revoked
    await main.evaluate(`window.kairon.navigate('https://example.com')`);
    await sleep(2500);
    const externalTarget = await waitForTarget('example.com', 10000);
    check('E2E: settings tab navigated to external site', !!externalTarget,
      externalTarget ? externalTarget.url : 'no example.com target (may be offline error page)');

    // whichever page is now in that tab, settings IPC must be rejected
    const nowTarget = externalTarget || (await waitForTarget('/settings.html', 2000));
    const probeTarget = nowTarget || settingsTarget;
    const ext = await CDPClient.connect(probeTarget.webSocketDebuggerUrl);
    let revokeResult = null;
    try {
      revokeResult = await ext.evaluate(`window.kairon.getSettingsState().then(() => 'ALLOWED').catch(e => 'REJECTED: ' + e.message)`);
    } catch (e) {
      revokeResult = 'ERR: ' + e.message;
    }
    const revoked = typeof revokeResult === 'string' && revokeResult.startsWith('REJECTED');
    check('E2E: navigating away revokes settings IPC', revoked, String(revokeResult));

    // 4. Deep link from the address bar: kairon://settings/security
    await main.evaluate(`window.kairon.navigate('kairon://settings/security')`);
    await sleep(1200);
    const secTitle = await st.evaluate(`document.getElementById('page-title').textContent`).catch(() => '(page gone)');
    check('E2E: deep link kairon://settings/security opens Security', secTitle === 'Security', String(secTitle));

    // 5. Persistence: change a setting via the UI → underlying store + survives reload
    const orig = await st.evaluate(`window.kairon.getSettingsState().then(s => s.state.themeSystem.settings.tabPosition)`);
    const flipped = orig === 'top' ? 'sidebar' : 'top';
    await main.evaluate(`window.kairon.navigate('kairon://settings/appearance')`);
    await sleep(900);
    await st.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="tabPosition"][data-value="${flipped}"]').click()`);
    await sleep(500);
    const stored = await st.evaluate(`window.kairon.getSettingsState().then(s => s.state.themeSystem.settings.tabPosition)`);
    check('E2E: UI change lands in the underlying store', stored === flipped, String(stored));
    await st.evaluate(`location.reload()`);
    await sleep(1400);
    const afterReload = await st.evaluate(`window.kairon.getSettingsState().then(s => s.state.themeSystem.settings.tabPosition)`);
    check('E2E: reloading the page preserves the value', afterReload === flipped, String(afterReload));
    // restore the original value
    await main.evaluate(`window.kairon.navigate('kairon://settings/appearance')`);
    await sleep(900);
    await st.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="tabPosition"][data-value="${orig}"]').click()`);
    await sleep(400);

    // 6. Theme mode: switching Dark ↔ Light lands in the real store, re-skins
    //    the page instantly, and persists across a reload.
    await main.evaluate(`window.kairon.navigate('kairon://settings/appearance')`);
    await sleep(900);
    const origTheme = await st.evaluate(`window.kairon.getSettingsState().then(s => s.state.themeSystem.settings.mode)`);
    const flippedTheme = origTheme === 'light' ? 'dark' : 'light';
    await st.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="${flippedTheme}"]').click()`);
    await sleep(500);
    const storedTheme = await st.evaluate(`window.kairon.getSettingsState().then(s => s.state.themeSystem.settings.mode)`);
    check('E2E: theme switch lands in the real FeatureStore', storedTheme === flippedTheme, String(storedTheme));
    const appliedTheme = await st.evaluate(`document.body.dataset.theme`);
    check('E2E: theme switch re-skins the page instantly', appliedTheme === flippedTheme, String(appliedTheme));
    await st.evaluate(`location.reload()`);
    await sleep(1400);
    const themeAfterReload = await st.evaluate(`document.body.dataset.theme`);
    const themeSegSelected = await st.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="${flippedTheme}"]').classList.contains('selected')`);
    check('E2E: theme persists after reload (data-theme + segment)', themeAfterReload === flippedTheme && themeSegSelected === true, themeAfterReload + '/' + themeSegSelected);
    // restore the original theme
    await main.evaluate(`window.kairon.navigate('kairon://settings/appearance')`);
    await sleep(900);
    await st.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="${origTheme}"]').click()`);
    await sleep(400);

    main.close(); st.close();
    if (ext !== st) ext.close();
  } catch (err) {
    console.error('E2E ERROR', err && err.stack ? err.stack : err);
    failures++;
  } finally {
    child.kill('SIGKILL');
    await sleep(500);
    console.log('---');
    console.log(failures === 0 ? 'ALL E2E CHECKS PASSED' : failures + ' E2E CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
  }
})();
