// Debug 3: main window visibility + can Page.setWebLifecycleState('active') un-freeze a tab?
const { spawn } = require('child_process');
const http = require('http');
const PORT = 9357;
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

(async () => {
  const child = spawn('npx', ['electron', '.', '--remote-debugging-port=' + PORT], { cwd: process.cwd(), env: { ...process.env, KAIRON_DIAG: '0' }, stdio: 'ignore', shell: true, windowsHide: true });
  try {
    let targets = null;
    for (let i = 0; i < 40; i++) { targets = await getJson('/json/list').catch(() => null); if (targets && targets.length) break; await sleep(500); }
    const mainTarget = targets.find((t) => t.url && t.url.includes('/renderer/index.html'));
    const main = await connectPage(mainTarget);
    const mainInfo = await main.evaluate(`(function(){
      var out = { vis: document.visibilityState, hidden: document.hidden, rafs: 0 };
      try { requestAnimationFrame(function tick(){ out.rafs++; requestAnimationFrame(tick); }); } catch(e){}
      return out;
    })()`);
    await sleep(400);
    const mainInfo2 = await main.evaluate(`(function(){
      var el = document.createElement('div');
      return { vis: document.visibilityState, hidden: document.hidden };
    })()`);
    console.log('MAIN vis:', JSON.stringify(mainInfo), JSON.stringify(mainInfo2));

    await main.evaluate(`window.kairon.createTab('kairon://home')`);
    const h = await waitForTarget('/home.html');
    const t2 = await connectPage(h);
    // Force lifecycle active and check rAF.
    await t2.send('Page.setWebLifecycleState', { state: 'active' }).catch((e) => console.log('setWebLifecycleState failed:', e.message));
    await t2.evaluate(`(function(){ window.__probe = { vis: document.visibilityState, rafs: 0 }; try { requestAnimationFrame(function tick(){ window.__probe.rafs++; requestAnimationFrame(tick); }); } catch(e){} })()`);
    await sleep(400);
    const p = await t2.evaluate(`window.__probe`);
    console.log('TAB after lifecycle active:', JSON.stringify(p));

    main.close(); t2.close();
  } catch (e) {
    console.error('ERR', e);
  } finally {
    child.kill();
  }
  process.exit(0);
})();
