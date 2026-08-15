// GLOBAL THEME PROPAGATION — E2E against the REAL Kairon app via CDP.
// Acceptance criteria A–I:
//   A. Set Theme Mode → Light in kairon://settings
//   B. The ENTIRE Kairon UI immediately becomes light (chrome + data-theme)
//   C. Open History → it is light
//   D. Open a New Tab → it is light
//   E. Browser tabs + toolbar + address bar + controls are light
//   F. Navigate to a normal external website → the website remains untouched
//   G. Return to kairon://settings → still light
//   H. Switch back to Dark → the entire UI immediately returns to dark
//   I. Restart Kairon → the selected theme persists everywhere
//
// Compositor ground truth: a tiny probe element is injected into the chrome
// whose background resolves each chrome CSS variable (--bg-chrome, --tab-bg,
// --surface-1, --status-bg, --bg-base). Sampling its pixels from a real
// screenshot proves BOTH that the variable resolves to the light palette AND
// that the compositor actually paints it — no glyphs, no layout dependence.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PORT = 9341;
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

async function connectPage(target) {
  const c = await CDPClient.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Log.enable');
  await c.send('Page.enable').catch(() => {});
  return c;
}

// Sample the compositor-rendered pixel at the center of the theme probe. The
// probe's background resolves a chrome CSS variable, so the pixel is ground
// truth for that variable's painted value. Pin the viewport first so the
// coordinates are deterministic.
async function probePixel(client, varName) {
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(150);
  const probeId = '__kaironThemeProbe__';
  await client.evaluate(`(function(){
    let el = document.getElementById(${JSON.stringify(probeId)});
    if (!el) {
      el = document.createElement('div');
      el.id = ${JSON.stringify(probeId)};
      document.body.appendChild(el);
    }
    el.style.cssText = 'position:fixed;left:10px;top:10px;width:48px;height:48px;background:var(${varName});z-index:2147483647;border:0;margin:0;';
  })()`);
  await sleep(120);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(__dirname, 'global-theme-shot.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const img = sharp(file);
  const meta = await img.metadata();
  // Probe occupies 10,10 → 58,58 in CSS px (dpr 1). Sample its center.
  const left = Math.min(34, meta.width - 1);
  const top = Math.min(34, meta.height - 1);
  const buf = await img.extract({ left, top, width: 1, height: 1 }).raw().toBuffer();
  await client.evaluate(`document.getElementById(${JSON.stringify(probeId)}) && document.getElementById(${JSON.stringify(probeId)}).remove()`);
  return { rgb: [buf[0], buf[1], buf[2]], varName };
}

const isLight = (p) => p && p.rgb && p.rgb[0] > 200 && p.rgb[1] > 200 && p.rgb[2] > 200;
const isDark = (p) => p && p.rgb && p.rgb[0] < 60 && p.rgb[1] < 60 && p.rgb[2] < 60;

// Local plain-HTML server: proves external sites are NOT restyled (no theme
// injection, no data-theme attribute, page's own background preserved).
const EXT_PORT = 9342;
let extServer = null;
function startExternalSite() {
  return new Promise((resolve) => {
    extServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<!doctype html><html><head><style>body{background:#123456;color:#fff;font-family:sans-serif}</style></head><body><h1>external site</h1></body></html>');
    });
    extServer.listen(EXT_PORT, '127.0.0.1', () => resolve());
  });
}

function spawnApp() {
  return spawn('npx', ['electron', '.', '--remote-debugging-port=' + PORT], {
    cwd: process.cwd(),
    env: { ...process.env, KAIRON_DIAG: '0' },
    stdio: 'ignore',
    shell: true,
    windowsHide: true,
  });
}

async function getMainWindow() {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    targets = await getJson('/json/list').catch(() => null);
    if (targets && targets.length) break;
    await sleep(500);
  }
  if (!targets) throw new Error('CDP never came up');
  const t = targets.find((x) => x.url && x.url.includes('/renderer/index.html'));
  if (!t) throw new Error('main window target not found');
  return connectPage(t);
}

// Open kairon://settings in its OWN tab (so the settings page stays alive
// while other tabs navigate) and wait for it to render.
async function openSettings(main) {
  await main.evaluate(`window.kairon.createTab('kairon://settings')`);
  const target = await waitForTarget('/settings.html');
  if (!target) throw new Error('settings page never opened');
  const st = await connectPage(target);
  for (let i = 0; i < 30; i++) {
    const n = await st.evaluate(`document.querySelectorAll('.nav-item').length`).catch(() => 0);
    if (n === 4) break;
    await sleep(300);
  }
  return st;
}

async function setTheme(st, mode) {
  await st.evaluate(`document.querySelector('.nav-item[data-cat="appearance"]').click()`);
  await sleep(250);
  await st.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="${mode}"]').click()`);
  await sleep(600);
}

// Verify the whole chrome paints per-theme: data-theme attribute + compositor
// pixels for each major chrome surface variable.
async function verifyChromePainted(main, expectLight, label) {
  const theme = await main.evaluate(`document.body.dataset.theme`);
  check(label + ': chrome data-theme is ' + (expectLight ? 'light' : 'dark'), theme === (expectLight ? 'light' : 'dark'), String(theme));
  const vars = ['--bg-chrome', '--bg-base', '--surface-1', '--status-bg', '--tab-bg'];
  const results = {};
  for (const v of vars) {
    results[v] = await probePixel(main, v);
    const ok = expectLight ? isLight(results[v]) : isDark(results[v]);
    check(label + ': compositor paints ' + v + (expectLight ? ' light' : ' dark'), ok, JSON.stringify(results[v]));
  }
  return results;
}

(async () => {
  let child = null;
  try {
    await startExternalSite();

    // ── FIRST LAUNCH ─────────────────────────────────────────
    child = spawnApp();
    let main = await getMainWindow();
    let st = await openSettings(main);
    await sleep(600);

    // Deterministic start: force dark, then set Light via the real control.
    await setTheme(st, 'dark');
    await setTheme(st, 'light');

    // ── A. Theme Mode → Light ───────────────────────────────
    const stored = await st.evaluate(`window.kairon.getSettingsState().then(s => s.state.themeSystem.settings.mode)`);
    check('A: Light selected in settings lands in FeatureStore', stored === 'light', String(stored));

    // ── B + E. ENTIRE chrome becomes light (tabs, toolbar, address bar, controls) ──
    await verifyChromePainted(main, true, 'B/E');

    // ── C. History is light ─────────────────────────────────
    await main.evaluate(`window.kairon.createTab('kairon://history')`);
    const histTarget = await waitForTarget('/history.html');
    check('C: history page opens', !!histTarget, histTarget && histTarget.url);
    const hist = await connectPage(histTarget);
    await sleep(800);
    const histTheme = await hist.evaluate(`document.documentElement.dataset.theme`);
    const histBg = await hist.evaluate(`getComputedStyle(document.body).backgroundColor`);
    check('C: history data-theme is light', histTheme === 'light', String(histTheme));
    check('C: history background renders light', histBg === 'rgb(240, 240, 240)', String(histBg));

    // ── D. New Tab (home) is light ──────────────────────────
    await main.evaluate(`window.kairon.createTab('kairon://home')`);
    const homeTarget = await waitForTarget('/home.html');
    check('D: home page opens in new tab', !!homeTarget, homeTarget && homeTarget.url);
    const home = await connectPage(homeTarget);
    await sleep(800);
    const homeTheme = await home.evaluate(`document.documentElement.dataset.theme`);
    const homeBg = await home.evaluate(`getComputedStyle(document.body).backgroundColor`);
    check('D: home data-theme is light', homeTheme === 'light', String(homeTheme));
    check('D: home background renders light', homeBg === 'rgb(240, 240, 240)', String(homeBg));

    // ── F. External website remains untouched ───────────────
    // HTTPS-Only mode would upgrade the plain-HTTP test site; disable it from
    // the trusted settings page first, then re-enable after the check.
    await st.evaluate(`window.kairon.disableFeature('httpsOnlyMode')`);
    await sleep(400);
    await main.evaluate(`window.kairon.createTab('http://127.0.0.1:${EXT_PORT}/')`);
    const extTarget = await waitForTarget('127.0.0.1:' + EXT_PORT, 10000);
    check('F: external site loads in a tab', !!extTarget, extTarget && extTarget.url);
    const ext = await connectPage(extTarget);
    await sleep(1200);
    const extInfo = await ext.evaluate(`(function(){
      return {
        dataThemeHtml: document.documentElement.getAttribute('data-theme'),
        dataThemeBody: document.body.getAttribute('data-theme'),
        bg: getComputedStyle(document.body).backgroundColor,
        h1: document.querySelector('h1') && document.querySelector('h1').textContent,
      };
    })()`);
    check('F: no data-theme injected into the website', extInfo.dataThemeHtml === null && extInfo.dataThemeBody === null, JSON.stringify(extInfo));
    check('F: website keeps its own background (#123456)', extInfo.bg === 'rgb(18, 52, 86)', String(extInfo.bg));
    await st.evaluate(`window.kairon.enableFeature('httpsOnlyMode')`);
    await sleep(300);

    // ── G. Settings tab is still open → still light ─────────
    const backTheme = await st.evaluate(`document.body.dataset.theme`);
    check('G: settings stays light while other tabs navigate', backTheme === 'light', String(backTheme));

    // ── H. Switch back to Dark → entire UI dark immediately ─
    await setTheme(st, 'dark');
    await verifyChromePainted(main, false, 'H');
    const darkHist = await hist.evaluate(`document.documentElement.dataset.theme`);
    check('H: already-open history page flips to dark live', darkHist === 'dark', String(darkHist));
    const darkHome = await home.evaluate(`document.documentElement.dataset.theme`);
    check('H: already-open home page flips to dark live', darkHome === 'dark', String(darkHome));

    main.close(); st.close(); hist.close(); home.close(); ext.close();
    child.kill('SIGKILL');
    await sleep(700);

    // ── I. Restart → theme persists everywhere ──────────────
    // Theme is Dark now; restart and confirm chrome + settings + history boot
    // dark, then flip to Light, restart again, confirm everything boots light.
    child = spawnApp();
    main = await getMainWindow();
    await sleep(1500);
    const bootDark = await main.evaluate(`document.body.dataset.theme`);
    check('I: after restart the chrome boots the persisted theme (dark)', bootDark === 'dark', String(bootDark));

    st = await openSettings(main);
    await sleep(500);
    await setTheme(st, 'light');
    const chromeLight = await main.evaluate(`document.body.dataset.theme`);
    check('I: live flip to light before restart', chromeLight === 'light', String(chromeLight));
    main.close(); st.close();
    child.kill('SIGKILL');
    await sleep(700);

    child = spawnApp();
    main = await getMainWindow();
    await sleep(1500);
    const bootLight = await main.evaluate(`document.body.dataset.theme`);
    check('I: after second restart the chrome boots light', bootLight === 'light', String(bootLight));
    const bar2 = await probePixel(main, '--bg-chrome');
    check('I: chromebar paints light after restart (compositor)', isLight(bar2), JSON.stringify(bar2));

    st = await openSettings(main);
    await sleep(500);
    const settingsBoot = await st.evaluate(`document.body.dataset.theme`);
    check('I: settings boots light after restart', settingsBoot === 'light', String(settingsBoot));

    await main.evaluate(`window.kairon.createTab('kairon://history')`);
    const hist2Target = await waitForTarget('/history.html');
    const hist2 = await connectPage(hist2Target);
    await sleep(900);
    const hist2Theme = await hist2.evaluate(`document.documentElement.dataset.theme`);
    check('I: history boots light after restart', hist2Theme === 'light', String(hist2Theme));

    // restore dark so the app state is back to default
    await setTheme(st, 'dark');
    main.close(); st.close(); hist2.close();
  } catch (err) {
    console.error('GLOBAL-THEME ERROR', err && err.stack ? err.stack : err);
    failures++;
  } finally {
    if (child) { try { child.kill('SIGKILL'); } catch (e) {} }
    if (extServer) extServer.close();
    await sleep(500);
    console.log('---');
    console.log(failures === 0 ? 'ALL GLOBAL-THEME CHECKS PASSED' : failures + ' GLOBAL-THEME CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
  }
})();
