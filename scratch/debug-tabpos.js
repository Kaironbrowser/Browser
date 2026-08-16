// Debug: why is #top-tab-bar opacity 0 / transform -6 / pointer-events none in top mode?
const { spawn } = require('child_process');
const http = require('http');
const PORT = 9362;
const CDP = 'http://127.0.0.1:' + PORT;
function getJson(p) { return new Promise((resolve, reject) => { http.get(CDP + p, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }).on('error', reject); }); }
class C {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    const c = new C(ws);
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && c.p.has(m.id)) { const { r, j } = c.p.get(m.id); c.p.delete(m.id); m.error ? j(new Error(m.error.message)) : r(m.result); } };
    return c;
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((r, j) => { this.p.set(id, { r, j }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async ev(expression, awaitPromise = true) { const res = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }); if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails)); return res.result && res.result.value; }
  close() { try { this.ws.close(); } catch (e) {} }
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const child = spawn('npx', ['electron', '.', '--remote-debugging-port=' + PORT], { cwd: process.cwd(), env: { ...process.env, KAIRON_DIAG: '0' }, stdio: 'ignore', shell: true, windowsHide: true });
  let main = null, ctl = null;
  try {
    let targets = null;
    let mainT = null, overlayT = null;
    for (let i = 0; i < 40; i++) {
      targets = await getJson('/json/list').catch(() => []);
      mainT = targets.find((t) => t.url && t.url.includes('/index.html'));
      overlayT = targets.find((t) => t.url && t.url.includes('/overlay.html'));
      if (mainT && overlayT) break;
      await sleep(500);
    }
    if (!mainT || !overlayT) throw new Error('targets not found: ' + JSON.stringify(targets));
    main = await C.connect(mainT.webSocketDebuggerUrl);
    await main.send('Runtime.enable');
    ctl = await C.connect(overlayT.webSocketDebuggerUrl);
    await ctl.send('Runtime.enable');
    await sleep(1200);

    const pos0 = await main.ev(`document.body.dataset.tabPosition`);
    console.log('boot pos:', pos0);

    // Always end in TOP mode via an actual switch (exercises the morph path).
    if (pos0 !== 'top') {
      await ctl.ev(`window.kairon.updateFeatureConfig('themeSystem', { tabPosition: 'top' })`);
    } else {
      // Flip away first, then back, to exercise the switch into top mode.
      await ctl.ev(`window.kairon.updateFeatureConfig('themeSystem', { tabPosition: 'sidebar' })`);
      await sleep(900);
      await ctl.ev(`window.kairon.updateFeatureConfig('themeSystem', { tabPosition: 'top' })`);
    }
    await sleep(900);

    const info = await main.ev(`(function(){
      const el = document.getElementById('top-tab-bar');
      const cs = getComputedStyle(el);
      return {
        pos: document.body.dataset.tabPosition,
        topbarInScope: !!document.getElementById('top-tab-bar'),
        opacity: cs.opacity,
        transform: cs.transform,
        pointer: cs.pointerEvents,
        height: cs.height,
        display: cs.display,
        transition: cs.transitionProperty,
        matchedSelectors: (function(){
          const out = [];
          for (const sheet of document.styleSheets) {
            try {
              const rules = sheet.cssRules || [];
              for (const rule of rules) {
                if (rule.selectorText && rule.selectorText.indexOf('top-tab-bar') !== -1 && el.matches(rule.selectorText)) {
                  out.push({ sel: rule.selectorText, opacity: rule.style.opacity, transform: rule.style.transform, pointer: rule.style.pointerEvents, height: rule.style.height });
                }
              }
            } catch (e) {}
          }
          return out;
        })()
      };
    })()`);
    console.log('INFO:', JSON.stringify(info, null, 2));
    main.close(); ctl.close();
  } catch (e) { console.error('ERR', e); }
  finally { child.kill(); }
  process.exit(0);
})();
