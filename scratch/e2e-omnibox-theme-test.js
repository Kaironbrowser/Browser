// OMNIBOX THEME + prefers-color-scheme — E2E against the REAL Kairon app via CDP.
// Acceptance criteria:
//   1. Omnibox suggestions dropdown is DARK in Dark Mode (unchanged).
//   2. Omnibox suggestions dropdown is LIGHT in Light Mode (surface, text,
//      search row, icons all resolve the light palette).
//   3. The dropdown flips LIVE when Theme Mode changes in settings.
//   4. Websites that support prefers-color-scheme observe Kairon's theme:
//      light → prefers-color-scheme: light, dark → prefers-color-scheme: dark,
//      live-switched without reload, inherited by new tabs, retained across
//      navigation and reload.
//   5. Websites without color-scheme support are NOT forcibly modified.
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const PORT = 9345;
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

// Sample the compositor-rendered pixel of a probe whose background resolves a
// CSS variable — ground truth that the variable resolves AND is painted.
async function probePixel(client, varName, shotFile) {
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
  const file = shotFile || path.join(__dirname, 'omnibox-theme-shot.png');
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  const img = sharp(file);
  const meta = await img.metadata();
  const left = Math.min(34, meta.width - 1);
  const top = Math.min(34, meta.height - 1);
  const buf = await img.extract({ left, top, width: 1, height: 1 }).raw().toBuffer();
  await client.evaluate(`document.getElementById(${JSON.stringify(probeId)}) && document.getElementById(${JSON.stringify(probeId)}).remove()`);
  return { rgb: [buf[0], buf[1], buf[2]], varName };
}

const isLight = (p) => p && p.rgb && p.rgb[0] > 200 && p.rgb[1] > 200 && p.rgb[2] > 200;
const isDark = (p) => p && p.rgb && p.rgb[0] < 60 && p.rgb[1] < 60 && p.rgb[2] < 60;

// Local server with two pages:
//   /       → supports prefers-color-scheme (light bg in light scheme, dark bg in
//             dark scheme) and exposes live matchMedia state on window.__cs.
//   /plain  → no color-scheme support at all (fixed background) — must be untouched.
const EXT_PORT = 9346;
let extServer = null;
function startExternalSite() {
  return new Promise((resolve) => {
    extServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (req.url.startsWith('/plain')) {
        res.end('<!doctype html><html><head><style>body{background:#123456;color:#fff;font-family:sans-serif}</style></head><body><h1>plain site</h1></body></html>');
        return;
      }
      res.end(`<!doctype html><html><head><style>
        body{background:#0d1b2a;color:#e0e0e0;font-family:sans-serif}
        @media (prefers-color-scheme: light){ body{background:#fff8e7;color:#111} }
      </style></head><body><h1>scheme-aware site</h1>
      <script>
        window.__cs = {
          dark: matchMedia('(prefers-color-scheme: dark)').matches,
          light: matchMedia('(prefers-color-scheme: light)').matches,
          mql: matchMedia('(prefers-color-scheme: dark)').matches
        };
        matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function(e){
          window.__cs.dark = e.matches;
          window.__cs.light = matchMedia('(prefers-color-scheme: light)').matches;
        });
      </script></body></html>`);
    });
    extServer.listen(EXT_PORT, '127.0.0.1', () => resolve());
  });
}

// Spawn the LOCAL electron binary directly (no npx indirection) so the child
// IS the app process and can be killed as a tree on Windows.
const ELECTRON_BIN = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
function spawnApp() {
  return spawn(ELECTRON_BIN, ['.', '--remote-debugging-port=' + PORT], {
    cwd: process.cwd(),
    env: { ...process.env, KAIRON_DIAG: '0' },
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
  });
}

function killAppTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGKILL');
    }
  } catch (e) {}
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

async function getOverlay() {
  const target = await waitForTarget('/overlay.html');
  if (!target) throw new Error('overlay window target not found');
  return connectPage(target);
}

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

// Focus the address bar, type a query, and wait for the overlay dropdown.
async function triggerOmnibox(main, query) {
  await main.evaluate(`(function(){
    const bar = document.getElementById('address-bar');
    bar.focus();
    bar.value = ${JSON.stringify(query)};
    bar.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(500);
}

// Inspect the rendered dropdown: root theme, computed colors of the surface,
// a URL row, the search row, and the icon opacity used by the globe SVG.
async function inspectDropdown(overlay) {
  return overlay.evaluate(`(function(){
    const root = document.getElementById('address-suggestions');
    if (!root) return { missing: true };
    const items = Array.from(root.querySelectorAll('.address-suggestion-item'));
    const first = items[0];
    const searchRow = items[items.length - 1];
    return {
      rootTheme: document.documentElement.dataset.theme,
      display: getComputedStyle(root).display,
      bg: getComputedStyle(root).backgroundColor,
      // border-top is none (merges with the omnibox), so its computed color
      // is currentColor — read the bottom border, which carries the real style.
      border: getComputedStyle(root).borderBottomColor,
      itemCount: items.length,
      firstColor: first ? getComputedStyle(first).color : null,
      searchColor: searchRow ? getComputedStyle(searchRow).color : null,
      searchClass: searchRow ? searchRow.className : null,
      iconOpacity: first ? (first.querySelector('svg') ? getComputedStyle(first.querySelector('svg')).opacity : null) : null,
      suggestVar: getComputedStyle(root).backgroundColor,
    };
  })()`);
}

(async () => {
  let child = null;
  try {
    await startExternalSite();

    // ── FIRST LAUNCH (persisted state may be dark from prior tests; force) ──
    child = spawnApp();
    let main = await getMainWindow();
    let overlay = await getOverlay();
    let st = await openSettings(main);
    await sleep(600);
    await setTheme(st, 'dark');
    await sleep(500);

    // ── 1. DARK MODE: dropdown stays exactly dark ────────────
    await triggerOmnibox(main, 'youtube.com');
    let dd = await inspectDropdown(overlay);
    check('1: overlay root data-theme is dark', dd.rootTheme === 'dark', String(dd.rootTheme));
    check('1: dropdown visible', dd.display === 'block' && dd.itemCount > 0, JSON.stringify({ display: dd.display, count: dd.itemCount }));
    check('1: dropdown surface is dark', dd.bg === 'rgb(26, 26, 26)', String(dd.bg));
    check('1: dropdown border is dark', dd.border === 'rgb(51, 51, 51)', String(dd.border));
    check('1: URL row text is light-on-dark', dd.firstColor === 'rgb(237, 237, 237)', String(dd.firstColor));
    check('1: search row is dimmed', dd.searchClass && dd.searchClass.includes('address-suggestion-search') && dd.searchColor === 'rgba(255, 255, 255, 0.6)', JSON.stringify({ cls: dd.searchClass, color: dd.searchColor }));
    const darkProbe = await probePixel(overlay, '--sugg-bg');
    check('1: dropdown compositor paints dark surface', isDark(darkProbe), JSON.stringify(darkProbe));

    // ── 2+3. LIGHT MODE: dropdown flips light, LIVE ──────────
    await setTheme(st, 'light');
    dd = await inspectDropdown(overlay);
    check('2: overlay root data-theme flips to light live', dd.rootTheme === 'light', String(dd.rootTheme));
    check('2: dropdown surface is off-white', dd.bg === 'rgb(251, 251, 251)', String(dd.bg));
    check('2: dropdown border is subtle gray', dd.border === 'rgb(224, 224, 224)', String(dd.border));
    check('2: URL row text is dark ink', dd.firstColor === 'rgb(26, 26, 26)', String(dd.firstColor));
    check('2: search row uses light secondary text', dd.searchClass && dd.searchClass.includes('address-suggestion-search') && dd.searchColor === 'rgb(95, 95, 95)', JSON.stringify({ cls: dd.searchClass, color: dd.searchColor }));
    const lightProbe = await probePixel(overlay, '--sugg-bg');
    check('2: dropdown compositor paints light surface', isLight(lightProbe), JSON.stringify(lightProbe));

    // ── 4. Website observes prefers-color-scheme: light ──────
    await st.evaluate(`window.kairon.disableFeature('httpsOnlyMode')`);
    await sleep(400);
    await main.evaluate(`window.kairon.createTab('http://127.0.0.1:${EXT_PORT}/')`);
    const siteTarget = await waitForTarget('127.0.0.1:' + EXT_PORT, 10000);
    check('4: scheme-aware site loads in a tab', !!siteTarget, siteTarget && siteTarget.url);
    const site = await connectPage(siteTarget);
    await sleep(1200);
    let cs = await site.evaluate(`window.__cs`);
    check('4: site receives prefers-color-scheme light', cs && cs.light === true && cs.dark === false, JSON.stringify(cs));
    const siteBgLight = await site.evaluate(`getComputedStyle(document.body).backgroundColor`);
    check('4: site applies its own light-scheme CSS', siteBgLight === 'rgb(255, 248, 231)', String(siteBgLight));
    const siteInjected = await site.evaluate(`(function(){
      return {
        htmlTheme: document.documentElement.getAttribute('data-theme'),
        bodyTheme: document.body.getAttribute('data-theme'),
        kaironStyles: Array.from(document.querySelectorAll('style')).filter(s => /kairon/i.test(s.id || '') || (s.getAttribute && s.getAttribute('data-kairon'))).length,
      };
    })()`);
    check('4: no data-theme / theme stylesheet injected into the website', siteInjected.htmlTheme === null && siteInjected.bodyTheme === null && siteInjected.kaironStyles === 0, JSON.stringify(siteInjected));

    // ── 5. Switch to Dark live → same site observes dark ─────
    await setTheme(st, 'dark');
    cs = await site.evaluate(`window.__cs`);
    check('5: same site now receives prefers-color-scheme dark (live)', cs && cs.dark === true && cs.light === false, JSON.stringify(cs));
    const siteBgDark = await site.evaluate(`getComputedStyle(document.body).backgroundColor`);
    check('5: site flips to its own dark-scheme CSS without reload', siteBgDark === 'rgb(13, 27, 42)', String(siteBgDark));
    dd = await inspectDropdown(overlay);
    check('5: dropdown flips back to dark live', dd.rootTheme === 'dark' && dd.bg === 'rgb(26, 26, 26)', JSON.stringify({ theme: dd.rootTheme, bg: dd.bg }));

    // ── 6. New tab inherits the current preference ───────────
    await main.evaluate(`window.kairon.createTab('http://127.0.0.1:${EXT_PORT}/?t=2')`);
    const site2Target = await waitForTarget('127.0.0.1:' + EXT_PORT, 10000);
    const site2 = await connectPage(site2Target);
    await sleep(1200);
    const cs2 = await site2.evaluate(`window.__cs`);
    check('6: newly created tab inherits dark preference', cs2 && cs2.dark === true && cs2.light === false, JSON.stringify(cs2));

    // ── 7. Navigating an existing tab retains the preference ─
    await site2.evaluate(`window.location.href = 'http://127.0.0.1:${EXT_PORT}/?t=3'`);
    await sleep(1500);
    const cs3 = await site2.evaluate(`window.__cs`);
    check('7: navigation to another page retains dark preference', cs3 && cs3.dark === true && cs3.light === false, JSON.stringify(cs3));

    // ── 8. Reload retains the preference ─────────────────────
    await site2.send('Page.reload', { ignoreCache: true });
    await sleep(1500);
    const cs4 = await site2.evaluate(`window.__cs`);
    check('8: reload retains dark preference', cs4 && cs4.dark === true && cs4.light === false, JSON.stringify(cs4));

    // ── 9. Websites without color-scheme support untouched ───
    await main.evaluate(`window.kairon.createTab('http://127.0.0.1:${EXT_PORT}/plain')`);
    const plainTarget = await waitForTarget('/plain', 10000);
    const plain = await connectPage(plainTarget);
    await sleep(1200);
    const plainInfo = await plain.evaluate(`(function(){
      return {
        htmlTheme: document.documentElement.getAttribute('data-theme'),
        bg: getComputedStyle(document.body).backgroundColor,
        h1: document.querySelector('h1') && document.querySelector('h1').textContent,
      };
    })()`);
    check('9: plain site keeps its own background (#123456)', plainInfo.bg === 'rgb(18, 52, 86)', String(plainInfo.bg));
    check('9: no data-theme injected into plain site', plainInfo.htmlTheme === null, String(plainInfo.htmlTheme));

    // ── 10. Restart → persisted preference restored for sites & dropdown ──
    await setTheme(st, 'light');
    main.close(); overlay.close(); st.close(); site.close(); site2.close(); plain.close();
    killAppTree(child);
    child = null;
    await sleep(700);

    child = spawnApp();
    main = await getMainWindow();
    overlay = await getOverlay();
    await sleep(1500);
    const bootOverlayTheme = await overlay.evaluate(`document.documentElement.dataset.theme`);
    check('10: overlay boots light after restart (persisted)', bootOverlayTheme === 'light', String(bootOverlayTheme));
    await main.evaluate(`window.kairon.createTab('http://127.0.0.1:${EXT_PORT}/?boot=1')`);
    const bootSiteTarget = await waitForTarget('127.0.0.1:' + EXT_PORT, 10000);
    const bootSite = await connectPage(bootSiteTarget);
    await sleep(1200);
    const bootCs = await bootSite.evaluate(`window.__cs`);
    check('10: new tab after restart observes persisted light preference', bootCs && bootCs.light === true && bootCs.dark === false, JSON.stringify(bootCs));

    // restore dark so the app state is back to default
    st = await openSettings(main);
    await sleep(400);
    await setTheme(st, 'dark');
    main.close(); overlay.close(); st.close(); bootSite.close();
  } catch (err) {
    console.error('OMNIBOX-THEME ERROR', err && err.stack ? err.stack : err);
    failures++;
  } finally {
    if (child) killAppTree(child);
    if (extServer) extServer.close();
    await sleep(500);
    console.log('---');
    console.log(failures === 0 ? 'ALL OMNIBOX-THEME CHECKS PASSED' : failures + ' OMNIBOX-THEME CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
  }
})();
