// Debug 2: why is the settings tab's rAF/timers frozen? Compare visibilityState
// and rAF behavior: (a) fresh tab direct to settings (no transition), (b) home
// tab, (c) transitioned load.
const { spawn } = require('child_process');
const http = require('http');
const PORT = 9356;
const CDP = 'http://127.0.0.1:' + PORT;

function getJson(p) { return new Promise((resolve, reject) => { http.get(CDP + p, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject); }); }
class CDPClient {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const client = new CDPClient(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && client.pending.has(msg.id)) { const { resolve, reject } = client.pending.get(msg.id); client.pending.delete(msg.id); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); }
    };
    return client;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (res.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description));
    return res.result && res.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitForTarget(urlPart, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await getJson('/json/list').catch(() => []);
    const t = targets.find((x) => x.url && x.url.includes(urlPart) && x.type === 'page');
    if (t) return t;
    await sleep(300);
  }
  return null;
}
async function connectPage(target) {
  const c = await CDPClient.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable').catch(() => {});
  await c.send('Page.enable').catch(() => {});
  return c;
}

// Install a probe that reports whether rAF and setTimeout actually fire.
const PROBE = `(function(){
  var out = { vis: document.visibilityState, hidden: document.hidden, rafs: 0, timeouts: 0 };
  try { requestAnimationFrame(function tick(){ out.rafs++; requestAnimationFrame(tick); }); } catch(e){ out.err1 = String(e); }
  try { setTimeout(function(){ out.timeouts++; }, 20); } catch(e){ out.err2 = String(e); }
  window.__probe = out;
})();`;

async function readProbe(client, label) {
  await sleep(400);
  const r = await client.evaluate(`window.__probe || null`);
  console.log(label, JSON.stringify(r));
}

(async () => {
  const child = spawn('npx', ['electron', '.', '--remote-debugging-port=' + PORT], { cwd: process.cwd(), env: { ...process.env, KAIRON_DIAG: '0' }, stdio: 'ignore', shell: true, windowsHide: true });
  try {
    let targets = null;
    for (let i = 0; i < 40; i++) { targets = await getJson('/json/list').catch(() => null); if (targets && targets.length) break; await sleep(500); }
    const mainTarget = targets.find((t) => t.url && t.url.includes('/renderer/index.html'));
    const main = await connectPage(mainTarget);

    // (a) Fresh tab DIRECT to settings (no transition) — install probe, read.
    await main.evaluate(`window.kairon.createTab('kairon://settings')`);
    const s1 = await waitForTarget('/settings.html');
    const t1 = await connectPage(s1);
    await t1.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    // the probe above only affects FUTURE docs; inject into the current doc too:
    await t1.evaluate(PROBE.replace('(function(){', '(function(){').replace(/window\.__probe = out;/, 'window.__probe = out;'));
    await readProbe(t1, 'A: fresh tab direct settings (no transition):');

    // (b) home tab, current doc probe
    await main.evaluate(`window.kairon.createTab('kairon://home')`);
    const h = await waitForTarget('/home.html');
    const t2 = await connectPage(h);
    await t2.evaluate(PROBE.replace(/window\.__probe = out;/, 'window.__probe = out;'));
    await readProbe(t2, 'B: fresh home tab:');

    // (c) navigate the home tab → settings (WITH transition) and probe the new doc
    await t2.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
    await main.evaluate(`window.kairon.navigate('kairon://settings')`);
    await sleep(900);
    const r = await t2.evaluate(`(function(){
      return {
        path: location.pathname,
        cls: document.documentElement.className,
        op: getComputedStyle(document.documentElement).opacity,
        probe: window.__probe || null,
        vis: document.visibilityState,
        hidden: document.hidden,
        focus: document.hasFocus()
      };
    })()`);
    console.log('C: transitioned settings doc:', JSON.stringify(r));

    main.close(); t1.close(); t2.close();
  } catch (e) {
    console.error('ERR', e);
  } finally {
    child.kill();
  }
  process.exit(0);
})();
