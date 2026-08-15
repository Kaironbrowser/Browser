// One-off verification of the real settings page in the REAL app via CDP:
//  - kairon://settings opens with no console errors
//  - no horizontal overflow at desktop width and at a narrow viewport
//  - responsive layout stacks the sidebar at narrow widths
//  - Ctrl+, opens settings from the main window
//  - master toggle reflects real store state (no fake "On" state)
const { spawn } = require('child_process');
const http = require('http');

const PORT = 9335;
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
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
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
      } else if (msg.method) {
        client.events.push(msg);
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
    let targets = null;
    for (let i = 0; i < 40; i++) {
      targets = await getJson('/json/list').catch(() => null);
      if (targets && targets.length) break;
      await sleep(500);
    }
    if (!targets) throw new Error('CDP never came up');

    const mainTarget = targets.find((t) => t.url && t.url.includes('/renderer/index.html'));
    if (!mainTarget) throw new Error('main window target not found');
    const main = await CDPClient.connect(mainTarget.webSocketDebuggerUrl);
    await main.send('Runtime.enable');
    // Let the main window renderer finish booting before dispatching keys
    await sleep(2000);

    // 1. Ctrl+, from the main window must open settings in the active tab
    await main.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true }))`);
    let settingsTarget = await waitForTarget('/settings.html');
    check('UI: Ctrl+, opens settings', !!settingsTarget, settingsTarget && settingsTarget.url);

    if (!settingsTarget) throw new Error('settings page never opened');
    const st = await CDPClient.connect(settingsTarget.webSocketDebuggerUrl);
    await st.send('Runtime.enable');
    await st.send('Log.enable');
    await sleep(700);

    // Reload to capture init-time console output
    await st.send('Page.enable').catch(() => {});
    await st.evaluate(`location.reload()`);
    await sleep(1600);

    const errors = st.events.filter((m) =>
      (m.method === 'Runtime.exceptionThrown') ||
      (m.method === 'Log.entryAdded' && m.params && m.params.entry && m.params.entry.level === 'error') ||
      (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error')
    ).map((m) => {
      if (m.method === 'Runtime.exceptionThrown') return 'exception: ' + JSON.stringify(m.params.exceptionDetails && m.params.exceptionDetails.text);
      if (m.method === 'Log.entryAdded') return 'log: ' + JSON.stringify(m.params.entry.text);
      return 'console: ' + JSON.stringify((m.params.args || []).map((a) => a.value || a.description).join(' '));
    });
    check('UI: no console errors on settings page', errors.length === 0, errors.length ? errors.join(' ;; ') : 'clean');

    // Show Privacy so the httpsOnlyMode toggle is in the DOM
    await st.evaluate(`document.querySelector('.nav-item[data-cat="privacy"]').click()`);
    await sleep(300);
    const desktop = await st.evaluate(`(function(){
      const de = document.documentElement;
      const overflowX = de.scrollWidth - de.clientWidth;
      const appDisplay = getComputedStyle(document.querySelector('.app')).display;
      const sidebarFirst = document.querySelector('.sidebar').getBoundingClientRect().left <= document.querySelector('.main').getBoundingClientRect().left;
      const hasToggle = !!document.querySelector('.switch[data-feature="httpsOnlyMode"]');
      const themeVal = document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"].selected').dataset.value;
      const toggleState = document.querySelector('.switch[data-feature="httpsOnlyMode"]').getAttribute('aria-checked');
      return { overflowX, appDisplay, sidebarFirst, hasToggle, themeVal, toggleState, width: window.innerWidth };
    })()`);
    check('UI: no horizontal overflow at desktop width', desktop.overflowX <= 1, JSON.stringify(desktop));
    check('UI: desktop layout is flex row (sidebar left)', desktop.appDisplay === 'flex' && desktop.sidebarFirst === true, JSON.stringify({ appDisplay: desktop.appDisplay, sidebarFirst: desktop.sidebarFirst }));
    check('UI: httpsOnlyMode toggle reflects REAL state (aria-checked present)', desktop.toggleState === 'true' || desktop.toggleState === 'false', desktop.toggleState);

    // 2. Narrow viewport: no overflow, sidebar stacks above content
    await st.send('Emulation.setDeviceMetricsOverride', { width: 560, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    const narrow = await st.evaluate(`(function(){
      const de = document.documentElement;
      const overflowX = de.scrollWidth - de.clientWidth;
      const appDisplay = getComputedStyle(document.querySelector('.app')).display;
      const sidebarW = document.querySelector('.sidebar').getBoundingClientRect().width;
      const sidebarTop = document.querySelector('.sidebar').getBoundingClientRect().top <= document.querySelector('.main').getBoundingClientRect().top;
      return { overflowX, appDisplay, sidebarW, sidebarTop, clientW: de.clientWidth };
    })()`);
    check('UI: no horizontal overflow at 560px width', narrow.overflowX <= 1, JSON.stringify(narrow));
    check('UI: responsive layout stacks sidebar on top', narrow.appDisplay === 'block' && narrow.sidebarTop === true, JSON.stringify({ appDisplay: narrow.appDisplay, sidebarTop: narrow.sidebarTop }));
    await st.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
    await sleep(200);

    // 3. Real state flows through: toggle httpsOnlyMode off via UI → aria-checked flips + store follows
    const before = await st.evaluate(`window.kairon.getSettingsState().then(s => s.state.httpsOnlyMode.enabled)`);
    await st.evaluate(`document.querySelector('.switch[data-feature="httpsOnlyMode"]').click()`);
    await sleep(500);
    const after = await st.evaluate(`window.kairon.getSettingsState().then(s => s.state.httpsOnlyMode.enabled)`);
    const aria = await st.evaluate(`document.querySelector('.switch[data-feature="httpsOnlyMode"]').getAttribute('aria-checked')`);
    check('UI: toggle click flips real store + aria-checked', after === !before && String(after) === aria, 'before=' + before + ' after=' + after + ' aria=' + aria);
    // restore
    await st.evaluate(`document.querySelector('.switch[data-feature="httpsOnlyMode"]').click()`);
    await sleep(400);

    main.close(); st.close();
  } catch (err) {
    console.error('VERIFY ERROR', err && err.stack ? err.stack : err);
    failures++;
  } finally {
    child.kill('SIGKILL');
    await sleep(500);
    console.log('---');
    console.log(failures === 0 ? 'ALL UI CHECKS PASSED' : failures + ' UI CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
  }
})();
