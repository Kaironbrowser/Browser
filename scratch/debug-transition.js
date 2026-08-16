// Debug: why is page-enter stuck and the recorder empty in the new document?
const { spawn } = require('child_process');
const http = require('http');
const PORT = 9355;
const CDP = 'http://127.0.0.1:' + PORT;

function getJson(p) { return new Promise((resolve, reject) => { http.get(CDP + p, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject); }); }
class CDPClient {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []; }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const client = new CDPClient(ws);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && client.pending.has(msg.id)) { const { resolve, reject } = client.pending.get(msg.id); client.pending.delete(msg.id); if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result); }
      else if (msg.method) client.events.push(msg);
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
async function waitForTarget(urlPart, timeoutMs = 15000) {
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
    // Create a FRESH home tab (fresh webContents → no restore, no transition).
    await main.evaluate(`window.kairon.createTab('kairon://home')`);
    const homeTarget = await waitForTarget('/home.html', 20000);
    if (!homeTarget) {
      console.log('TARGETS:', JSON.stringify(await getJson('/json/list').catch(() => []), null, 1));
      throw new Error('home target not found');
    }
    console.log('HOME TARGET:', homeTarget.url);
    const tab = await connectPage(homeTarget);
    await sleep(400);

    // Install recorder + also log rAF firing
    await tab.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `(function(){
        try {
          window.__dbg = { started: true, rafs: 0, clsHistory: [] };
          var root = document.documentElement;
          function tick(){ window.__dbg.rafs++; requestAnimationFrame(tick); }
          requestAnimationFrame(tick);
          var obs = new MutationObserver(function(){ try { window.__dbg.clsHistory.push({ t: Date.now(), cls: root.className, op: getComputedStyle(root).opacity }); } catch(e){} });
          obs.observe(root, { attributes: true, attributeFilter: ['class','style'] });
          window.__dbg.obsInstalled = true;
        } catch (e) { window.__dbgErr = String(e); }
      })();`
    });

    await main.evaluate(`window.kairon.navigate('kairon://settings')`);

    for (const wait of [300, 400, 800]) {
      await sleep(wait);
      const info = await tab.evaluate(`(function(){
        return {
          t: Date.now(),
          path: location.pathname,
          search: location.search,
          cls: document.documentElement.className,
          op: getComputedStyle(document.documentElement).opacity,
          dbg: window.__dbg || null,
          dbgErr: window.__dbgErr || null
        };
      })()`);
      console.log('SETTINGS DOC INFO @+' + wait + 'ms:', JSON.stringify(info));
    }
    main.close(); tab.close();
  } catch (e) {
    console.error('ERR', e);
  } finally {
    child.kill();
  }
  process.exit(0);
})();
