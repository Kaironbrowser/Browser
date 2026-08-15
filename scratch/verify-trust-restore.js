// One-off verification: settings IPC trust must follow the CURRENT URL —
// revoked on navigation away, restored when navigating back to kairon://settings.
const { spawn } = require('child_process');
const http = require('http');

const PORT = 9334;
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

    async function probeTrust(label) {
      const result = await main.evaluate(
        `(async () => {
          try { const s = await window.kairon.getSettingsState(); return 'TRUSTED:' + Object.keys(s.state).length; }
          catch (e) { return 'REVOKED:' + e.message; }
        })()`
      );
      return result;
    }

    // 1. Open settings → trusted
    await main.evaluate(`window.kairon.navigate('kairon://settings')`);
    const settingsTarget = await waitForTarget('/settings.html');
    check('TRUST: kairon://settings opens', !!settingsTarget, settingsTarget && settingsTarget.url);
    const st = await CDPClient.connect(settingsTarget.webSocketDebuggerUrl);
    await sleep(700);
    const trusted = await st.evaluate(`window.kairon.getSettingsState().then(() => 'TRUSTED').catch((e) => 'REVOKED')`);
    check('TRUST: settings page has IPC access', trusted === 'TRUSTED', String(trusted));

    // 2. Navigate away → revoked
    await main.evaluate(`window.kairon.navigate('https://example.com')`);
    await sleep(2500);
    const awayTarget = await waitForTarget('example.com', 10000);
    check('TRUST: navigated to remote site', !!awayTarget, awayTarget && awayTarget.url);
    const revoked = await st.evaluate(`window.kairon.getSettingsState().then(() => 'TRUSTED').catch((e) => 'REVOKED')`);
    check('TRUST: IPC revoked after navigating away', revoked === 'REVOKED', String(revoked));

    // 3. Navigate back to kairon://settings → trust restored (current URL is settings.html again)
    await main.evaluate(`window.kairon.navigate('kairon://settings')`);
    await sleep(1500);
    const restored = await st.evaluate(`window.kairon.getSettingsState().then(() => 'TRUSTED').catch((e) => 'REVOKED')`);
    check('TRUST: IPC restored after navigating back', restored === 'TRUSTED', String(restored));

    // 4. Arbitrary kairon:// scheme (e.g. kairon://home) must NOT grant settings IPC
    await main.evaluate(`window.kairon.navigate('kairon://home')`);
    await sleep(1500);
    const homeTarget = await waitForTarget('home.html', 8000);
    check('TRUST: navigated to kairon://home', !!homeTarget, homeTarget && homeTarget.url);
    const homeTrusted = await st.evaluate(`window.kairon.getSettingsState().then(() => 'TRUSTED').catch((e) => 'REVOKED')`);
    check('TRUST: kairon://home does NOT get settings IPC', homeTrusted === 'REVOKED', String(homeTrusted));

    main.close(); st.close();
  } catch (err) {
    console.error('E2E ERROR', err && err.stack ? err.stack : err);
    failures++;
  } finally {
    child.kill('SIGKILL');
    await sleep(500);
    console.log('---');
    console.log(failures === 0 ? 'ALL TRUST CHECKS PASSED' : failures + ' TRUST CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
  }
})();
