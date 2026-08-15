// One-off verification of Light Mode in the REAL app via CDP:
//  - kairon://settings renders the stored theme immediately
//  - clicking the Light segment flips data-theme instantly and lands in the
//    real FeatureStore
//  - every surface (sidebar, cards, inputs, switches, segments, nav, modals,
//    toasts) resolves to the light palette
//  - subtle grid is still present in light mode
//  - the COMPOSITOR paints the transitioning elements (segment / nav) light —
//    sampled from a real screenshot, because in occluded windows Chromium
//    defers style commits and getComputedStyle can return stale used values
//  - no console errors and no horizontal overflow in light mode
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PORT = 9336;
const CDP = 'http://127.0.0.1:' + PORT;

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail !== undefined ? ' | ' + detail : ''));
  if (!ok) failures++;
}

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get(CDP + p, (res) => {
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

async function connectSettings(target) {
  const c = await CDPClient.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable').catch(() => {});
  return c;
}

// Sample the rendered pixel at an element's background area from a real
// screenshot. The viewport is pinned to 1400x900 at dpr 1 first so the
// coordinates are deterministic regardless of the window's OS-level size.
async function samplePixel(st, selector, xFrac) {
  await st.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  const box = await st.evaluate(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // Sample just inside the left padding (clear of icon/text glyphs)
    const x = r.left + 8;
    const y = r.top + Math.round(r.height / 2);
    return { x: Math.round(x), y: Math.round(y), w: r.width, h: r.height };
  })()`);
  if (!box) return null;
  const shot = await st.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(__dirname, 'light-theme-shot.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const img = sharp(file);
  const meta = await img.metadata();
  const left = Math.max(0, Math.min(box.x, meta.width - 1));
  const top = Math.max(0, Math.min(box.y, meta.height - 1));
  const buf = await img.extract({ left, top, width: 1, height: 1 }).raw().toBuffer();
  return { rgb: [buf[0], buf[1], buf[2]], x: left, y: top, size: [meta.width, meta.height] };
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
    await sleep(2000);

    await main.evaluate(`window.kairon.navigate('kairon://settings')`);
    let settingsTarget = await waitForTarget('/settings.html');
    check('LT: kairon://settings opens', !!settingsTarget, settingsTarget && settingsTarget.url);
    if (!settingsTarget) throw new Error('settings page never opened');

    let st = await connectSettings(settingsTarget);
    await sleep(900);

    // Deterministic start: force the store to dark, then re-navigate so the
    // page first-paints dark (query + snapshot agree, no flip on load).
    const storedMode = await st.evaluate(`window.kairon.getSettingsState().then(s => s.state.themeSystem.settings.mode)`);
    if (storedMode !== 'dark') {
      await st.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="dark"]').click()`);
      await sleep(500);
      await main.evaluate(`window.kairon.navigate('kairon://settings')`);
      settingsTarget = await waitForTarget('/settings.html');
      st.close();
      st = await connectSettings(settingsTarget);
      await sleep(900);
    }

    const startsDark = await st.evaluate(`document.body.dataset.theme`);
    const darkBg = await st.evaluate(`getComputedStyle(document.body).backgroundColor`);
    check('LT: page renders the stored theme immediately (dark)', startsDark === 'dark' && darkBg === 'rgb(5, 5, 5)', startsDark + '/' + darkBg);

    // Switch to Light through the real control
    await st.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="light"]').click()`);
    await sleep(600);
    const themeNow = await st.evaluate(`document.body.dataset.theme`);
    check('LT: clicking Light switches data-theme instantly', themeNow === 'light', themeNow);
    const storeNow = await st.evaluate(`window.kairon.getSettingsState().then(s => s.state.themeSystem.settings.mode)`);
    check('LT: switch lands in the real FeatureStore', storeNow === 'light', storeNow);

    // Custom properties (reliable even when occluded — they passed consistently)
    const vars = await st.evaluate(`(function(){
      const cs = getComputedStyle(document.body);
      const v = (n) => cs.getPropertyValue(n).trim();
      return {
        bg: v('--bg'), panel: v('--panel'), cardBg: v('--card-bg'), cardBorder: v('--card-border'),
        text: v('--text'), muted: v('--muted'), grid: v('--grid-line'),
        sidebarBorder: v('--sidebar-border'), navActiveBg: v('--nav-active-bg'),
        segmentBg: v('--segment-bg'), segmentText: v('--segment-text'), segmentSelBorder: v('--segment-selected-border'),
        switchTrack: v('--switch-track'), switchOffTrack: v('--switch-off-track'),
        inputBg: v('--input-bg'), inputBorder: v('--input-border'), selectText: v('--select-text'),
        textInputText: v('--text-input-text'), searchBg: v('--search-bg'),
        modalBg: v('--modal-bg'), modalBorder: v('--modal-border'), btnBg: v('--btn-bg'),
        btnSolidBg: v('--btn-solid-bg'), toastBg: v('--toast-bg'), dangerText: v('--danger-text'),
      };
    })()`);
    // Custom properties serialize as authored (e.g. `#ddd` stays `#ddd`).
    const expected = {
      bg: '#f0f0f0', panel: '#f5f5f5', cardBg: '#f7f7f7', cardBorder: '#e0e0e0',
      text: '#1a1a1a', muted: '#5f5f5f', grid: 'rgba(0,0,0,.045)',
      sidebarBorder: '#ddd', navActiveBg: '#fcfcfc',
      segmentBg: '#f7f7f7', segmentText: '#666', segmentSelBorder: '#9a9a9a',
      switchTrack: '#f1f1f1', switchOffTrack: '#d9d9d9',
      inputBg: '#fafafa', inputBorder: '#d4d4d4', selectText: '#2a2a2a',
      textInputText: '#4a4a4a', searchBg: '#fafafa',
      modalBg: '#fbfbfb', modalBorder: '#d8d8d8', btnBg: '#f7f7f7',
      btnSolidBg: '#2a2a2a', toastBg: '#2a2a2a', dangerText: '#a05050',
    };
    let varOk = true;
    const diffs = [];
    for (const key of Object.keys(expected)) {
      if (vars[key] !== expected[key]) { varOk = false; diffs.push(key + '=' + vars[key] + ' (want ' + expected[key] + ')'); }
    }
    check('LT: light palette variables applied', varOk, diffs.join(' ;; '));

    // getComputedStyle on elements WITHOUT background transitions (reliable)
    const el = await st.evaluate(`(function(){
      const cs = (sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e) : null; };
      const body = cs('body');
      const card = cs('.card');
      const sw = cs('.switch[data-feature="httpsOnlyMode"]');
      const sel = cs('select[data-feature="adBlocker"][data-setting="mode"]');
      return {
        bodyBg: body && body.backgroundColor, bodyGrid: body && body.backgroundImage,
        cardBg: card && card.backgroundColor, cardBorder: card && card.borderColor,
        switchBg: sw && sw.backgroundColor,
        selectBg: sel && sel.backgroundColor, selectColor: sel && sel.color,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    check('LT: body background is off-white (#f0f0f0)', el.bodyBg === 'rgb(240, 240, 240)', el.bodyBg);
    check('LT: subtle grid still present', /linear-gradient/.test(el.bodyGrid || ''), el.bodyGrid && el.bodyGrid.slice(0, 60));
    check('LT: card surface is light gray (#f7f7f7)', el.cardBg === 'rgb(247, 247, 247)', el.cardBg);
    check('LT: card border adapts', el.cardBorder === 'rgb(224, 224, 224)', el.cardBorder);
    check('LT: switch track renders in light', el.switchBg === 'rgb(241, 241, 241)', el.switchBg);
    check('LT: select control re-skins', el.selectBg === 'rgb(250, 250, 250)' && el.selectColor === 'rgb(42, 42, 42)', el.selectBg + '/' + el.selectColor);
    check('LT: no horizontal overflow in light mode', el.overflowX <= 1, String(el.overflowX));

    // Ground truth: the compositor must paint the transitioning elements light.
    // In occluded windows getComputedStyle can lag behind, so sample the actual
    // rendered pixels from a screenshot.
    const segPixel = await samplePixel(st, '.segment[data-feature="themeSystem"][data-setting="mode"][data-value="light"]');
    const navPixel = await samplePixel(st, '.nav-item.active');
    const isLight = (p) => p && p.rgb && p.rgb[0] > 200 && p.rgb[1] > 200 && p.rgb[2] > 200;
    check('LT: compositor paints the selected segment light', isLight(segPixel), JSON.stringify(segPixel));
    check('LT: compositor paints the active nav item light', isLight(navPixel), JSON.stringify(navPixel));

    // No console errors while switching and interacting in light mode
    const errors = st.events.filter((m) =>
      (m.method === 'Runtime.exceptionThrown') ||
      (m.method === 'Log.entryAdded' && m.params && m.params.entry && m.params.entry.level === 'error') ||
      (m.method === 'Runtime.consoleAPICalled' && m.params && m.params.type === 'error')
    );
    check('LT: no console errors in light mode', errors.length === 0, errors.length ? JSON.stringify(errors[0]) : 'clean');

    // Live sync: toggle another feature while light, page must stay light
    await st.evaluate(`document.querySelector('.nav-item[data-cat="privacy"]').click()`);
    await sleep(300);
    await st.evaluate(`document.querySelector('.switch[data-feature="webRtcProtection"]').click()`);
    await sleep(400);
    await st.evaluate(`document.querySelector('.switch[data-feature="webRtcProtection"]').click()`);
    await sleep(400);
    const stillLight = await st.evaluate(`document.body.dataset.theme`);
    check('LT: theme stays light across navigation + live-sync renders', stillLight === 'light', stillLight);

    // restore dark
    await st.evaluate(`document.querySelector('.nav-item[data-cat="appearance"]').click()`);
    await sleep(200);
    await st.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="dark"]').click()`);
    await sleep(400);

    main.close(); st.close();
  } catch (err) {
    console.error('VERIFY ERROR', err && err.stack ? err.stack : err);
    failures++;
  } finally {
    child.kill('SIGKILL');
    await sleep(500);
    console.log('---');
    console.log(failures === 0 ? 'ALL LIGHT-THEME CHECKS PASSED' : failures + ' LIGHT-THEME CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
  }
})();
