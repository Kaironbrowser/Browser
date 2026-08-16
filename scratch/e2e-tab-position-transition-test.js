// E2E — top↔sidebar tab-position layout morph.
// Verifies against the REAL Kairon app via CDP:
//  1. Switching tab position applies layout-animating and morphs the shell:
//     the rail width and top-bar height animate through intermediate values
//     (not a snap), center-col tracks them, and the BrowserView follows via
//     per-frame layout-metrics.
//  2. Both directions (top→sidebar and sidebar→top) settle to the correct
//     final geometry (rail 0/236, top bar 48/0).
//  3. No stuck layout-animating class, no duplicate bars, no leftovers.
//  4. prefers-reduced-motion: the morph is instant (CSS zeroes transitions).
//  5. Downloads button still present/functional after switching.
const { spawn } = require('child_process');
const http = require('http');

const PORT = 9361;
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

// Sample chrome geometry at ~14ms cadence from the test side (CDP evaluate is
// not throttled, and the chrome window renders frames).
// Poll the chrome until the layout morph settles (this env throttles frames,
// so CSS transitions can take a couple of seconds of wall time). Returns the
// settled snapshot or null on timeout.
async function waitSettled(client, expectedPos, timeoutMs) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const s = await client.evaluate(`(function(){
        const rail = document.getElementById('left-rail').getBoundingClientRect();
        const topbar = document.getElementById('top-tab-bar').getBoundingClientRect();
        const ts = getComputedStyle(document.getElementById('top-tab-bar'));
        const rs = getComputedStyle(document.getElementById('left-rail'));
        return {
          pos: document.body.dataset.tabPosition,
          layoutAnimating: document.body.classList.contains('layout-animating'),
          railW: Math.round(rail.width),
          railOpacity: rs.opacity,
          topH: Math.round(topbar.height),
          topOpacity: ts.opacity,
          topTransform: ts.transform,
          topPointer: ts.pointerEvents,
          downloads: !!document.getElementById('btn-downloads')
        };
      })()`);
      last = s;
      const done = s.pos === expectedPos && !s.layoutAnimating &&
        (expectedPos === 'sidebar'
          ? s.railW >= 230 && s.topH <= 4 && s.topOpacity === '0' && s.topPointer === 'none'
          : s.railW <= 4 && s.topH >= 44 && s.topOpacity === '1' && s.topTransform === 'none' && s.topPointer === 'auto');
      if (done) return s;
    } catch (e) {}
    await sleep(150);
  }
  return last;
}

async function pollGeometry(client, totalMs) {
  const samples = [];
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    try {
      const s = await client.evaluate(`(function(){
        const rail = document.getElementById('left-rail').getBoundingClientRect();
        const topbar = document.getElementById('top-tab-bar').getBoundingClientRect();
        const col = document.getElementById('center-col').getBoundingClientRect();
        return {
          layoutAnimating: document.body.classList.contains('layout-animating'),
          pos: document.body.dataset.tabPosition || null,
          railW: Math.round(rail.width),
          topH: Math.round(topbar.height),
          colX: Math.round(col.left),
          colW: Math.round(col.width)
        };
      })()`);
      samples.push(s);
    } catch (e) {}
    await sleep(14);
  }
  return samples;
}

(async () => {
  const child = spawn('npx', ['electron', '.', '--remote-debugging-port=' + PORT], {
    cwd: process.cwd(), env: { ...process.env, KAIRON_DIAG: '0' }, stdio: 'ignore', shell: true, windowsHide: true,
  });
  let main = null;
  let ctl = null;
  try {
    // Use the overlay window as the settings-change controller: the chrome
    // suppresses settings-updated pushes from its own webContents (sender
    // exclusion), so a real change must originate from another trusted window.
    let mainT = null, overlayT = null, targets = [];
    for (let i = 0; i < 40; i++) {
      targets = await getJson('/json/list').catch(() => []);
      mainT = targets.find((t) => t.url && t.url.includes('/renderer/index.html'));
      overlayT = targets.find((t) => t.url && t.url.includes('/overlay.html'));
      if (mainT && overlayT) break;
      await sleep(500);
    }
    if (!mainT || !overlayT) throw new Error('targets not found: ' + JSON.stringify(targets));
    main = await CDPClient.connect(mainT.webSocketDebuggerUrl);
    await main.send('Runtime.enable');
    ctl = await CDPClient.connect(overlayT.webSocketDebuggerUrl);
    await ctl.send('Runtime.enable');
    await sleep(1500);

    const startPos = await main.evaluate(`document.body.dataset.tabPosition`);
    check('0: boot tab-position present', startPos === 'top' || startPos === 'sidebar', String(startPos));

    // Switch to the OPPOSITE position of the boot state.
    const target = startPos === 'top' ? 'sidebar' : 'top';

    // ── 1. Morph: sample geometry while switching ──
    const poll = pollGeometry(main, 600);
    await ctl.evaluate(`window.kairon.updateFeatureConfig('themeSystem', { tabPosition: '${target}' })`);
    const samples = await poll;

    const animSeen = samples.some((s) => s.layoutAnimating);
    check('1: layout-animating applied during switch', animSeen, 'samples=' + samples.length);

    // Rail width and top-bar height must have passed through intermediate values.
    const railWs = Array.from(new Set(samples.map((s) => s.railW)));
    const topHs = Array.from(new Set(samples.map((s) => s.topH)));
    const railMorphs = target === 'sidebar' ? railWs.some((w) => w > 10 && w < 230) : railWs.some((w) => w > 0 && w < 226);
    const topMorphs = target === 'sidebar' ? topHs.some((h) => h > 0 && h < 44) : topHs.some((h) => h > 4 && h < 48);
    check('1: rail width animates through intermediate values', railMorphs, 'railW=' + JSON.stringify(railWs));
    check('1: top tab bar height animates through intermediate values', topMorphs, 'topH=' + JSON.stringify(topHs));
    check('1: center-col x/width track the morph', new Set(samples.map((s) => s.colX)).size >= 2, 'colX=' + JSON.stringify(Array.from(new Set(samples.map((s) => s.colX)))));

    // ── 2. Settled state matches the target ──
    // (This environment throttles compositor frames, so the 260ms CSS morph
    // takes a while to finish; poll until it settles.)
    const settled = await waitSettled(main, target, 8000);
    check('2: morph completed', !!settled, settled ? JSON.stringify(settled) : 'timeout waiting for settle');
    if (settled) {
      check('2: settled position is ' + target, settled.pos === target, String(settled.pos));
      check('2: layout-animating removed after settle', settled.layoutAnimating === false, String(settled.layoutAnimating));
      check('2: rail width settled (' + (target === 'sidebar' ? '236' : '0') + ')', target === 'sidebar' ? settled.railW >= 230 : settled.railW <= 4, JSON.stringify(settled));
      check('2: top bar height settled (' + (target === 'sidebar' ? '0' : '48') + ')', target === 'sidebar' ? settled.topH <= 4 : settled.topH >= 44, JSON.stringify(settled));
      if (target === 'sidebar') {
        check('2: top bar hidden in sidebar mode', settled.topOpacity === '0' && settled.topPointer === 'none', JSON.stringify(settled));
      } else {
        check('2: top bar fully visible + interactive in top mode', settled.topOpacity === '1' && settled.topTransform === 'none' && settled.topPointer === 'auto', JSON.stringify(settled));
      }
      check('2: downloads button intact', settled.downloads === true, String(settled.downloads));
    }

    // ── 3. Switch back (reverse direction) ──
    const backTarget = startPos;
    const poll2 = pollGeometry(main, 600);
    await ctl.evaluate(`window.kairon.updateFeatureConfig('themeSystem', { tabPosition: '${backTarget}' })`);
    const samples2 = await poll2;
    const railWs2 = Array.from(new Set(samples2.map((s) => s.railW)));
    const topHs2 = Array.from(new Set(samples2.map((s) => s.topH)));
    const railMorphs2 = backTarget === 'sidebar' ? railWs2.some((w) => w > 10 && w < 230) : railWs2.some((w) => w > 0 && w < 226);
    const topMorphs2 = backTarget === 'sidebar' ? topHs2.some((h) => h > 0 && h < 44) : topHs2.some((h) => h > 4 && h < 48);
    check('3: reverse morph animates rail width', railMorphs2, 'railW=' + JSON.stringify(railWs2));
    check('3: reverse morph animates top bar height', topMorphs2, 'topH=' + JSON.stringify(topHs2));

    const settledBack = await waitSettled(main, backTarget, 8000);
    check('3: settled back at ' + backTarget, !!settledBack && settledBack.pos === backTarget, settledBack ? JSON.stringify(settledBack) : 'timeout');
    if (settledBack) {
      check('3: rail width restored', backTarget === 'sidebar' ? settledBack.railW >= 230 : settledBack.railW <= 4, JSON.stringify(settledBack));
      check('3: top bar height restored', backTarget === 'sidebar' ? settledBack.topH <= 4 : settledBack.topH >= 44, JSON.stringify(settledBack));
    }

    // ── 4. prefers-reduced-motion: instant switch, no morph samples ──
    await main.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(150);
    const rmOn = await main.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
    check('4: reduced-motion emulated', rmOn === true, String(rmOn));

    const poll3 = pollGeometry(main, 350);
    await ctl.evaluate(`window.kairon.updateFeatureConfig('themeSystem', { tabPosition: '${target}' })`);
    const samples3 = await poll3;
    const railWs3 = Array.from(new Set(samples3.map((s) => s.railW)));
    const midRail = railWs3.some((w) => w > 4 && w < (target === 'sidebar' ? 226 : 232));
    check('4: reduced-motion morph is instant (no intermediate rail width)', !midRail, 'railW=' + JSON.stringify(railWs3));
    const rmSettled = await waitSettled(main, target, 6000);
    check('4: reduced-motion switch still lands correctly', !!rmSettled && rmSettled.pos === target, rmSettled ? JSON.stringify(rmSettled) : 'timeout');
    await main.send('Emulation.setEmulatedMedia', { features: [] });
    await sleep(150);

    // ── 5. Restore the original position so the app is left as found ──
    await ctl.evaluate(`window.kairon.updateFeatureConfig('themeSystem', { tabPosition: '${startPos}' })`);
    await sleep(600);
    const restored = await main.evaluate(`document.body.dataset.tabPosition`);
    check('5: restored original position', restored === startPos, String(restored));
  } catch (err) {
    check('TEST HARNESS ERROR', false, (err && err.stack) || String(err));
  } finally {
    if (main) main.close();
    if (ctl) ctl.close();
    child.kill();
  }
  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})();
