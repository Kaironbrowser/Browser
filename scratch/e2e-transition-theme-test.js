// POLISH E2E — internal-page transitions + smooth global theme switching.
// Verifies against the REAL Kairon app via CDP:
//  1. First load (fresh tab → home) renders instantly — no page-enter, no
//     leftover opacity, no ?transition= in the URL, persisted theme applied.
//  2. home → settings (internal→internal): the new document gets ?transition=1,
//     applies page-enter, releases it (double-rAF + safety net), never gets
//     stuck, and the 150ms fade/rise CSS is wired on <html>.
//  3. settings → history, history → downloads, downloads → home: same entrance.
//  4. Rapid navigation (home→settings→history): lands on the last page, still
//     animates, no errors.
//  5. Theme flip Dark→Light: data-theme flips everywhere; the chrome AND the
//     downloads overlay animate their backgrounds through intermediate colors
//     (CDP-polled), proving the 220ms transition runs — not a snap. The
//     settings tab flips through the animated path (theme-switching class
//     observed) with the transition CSS wired.
//  6. Light→Dark back again.
//  7. Theme flip while the downloads panel is open: panel stays open, keeps its
//     position/size, and re-skins smoothly.
//  8. External website: untouched — no data-theme / page-enter / transitions.
//  9. prefers-reduced-motion: emulated media zeroes the entrance transition.
// 10. No console exceptions on any connected target.
//
// NOTE on the environment: BrowserView tabs report visibilityState 'hidden'
// here (rAF and timers are throttled), so CSS transitions in tab content are
// frozen at their start values and cannot be frame-sampled. Tab checks verify
// the *mechanism* (URL param, class lifecycle, CSS wiring, final state), while
// the chrome and overlay windows DO render frames and are CDP-polled to prove
// the transitions actually animate.
const { spawn } = require('child_process');
const http = require('http');

const PORT = 9347;
const CDP = 'http://127.0.0.1:' + PORT;
const EXT_PORT = 9348;

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
    await sleep(300);
  }
  return null;
}

// Find a NEW target (id not in beforeIds) whose URL matches — avoids matching
// a tab restored from the previous session.
async function waitForNewTarget(urlPart, beforeIds, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targets = await getJson('/json/list').catch(() => []);
    const t = targets.find((x) => x.type === 'page' && x.url && x.url.includes(urlPart) && !beforeIds.has(x.id));
    if (t) return t;
    await sleep(250);
  }
  return null;
}

async function connectPage(target) {
  const c = await CDPClient.connect(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable').catch(() => {});
  await c.send('Log.enable').catch(() => {});
  await c.send('Page.enable').catch(() => {});
  return c;
}

// Recorder injected into every future document of the tab target. Pure
// MutationObserver (microtasks are not throttled like timers/rAF in hidden
// tabs): captures class/style/data-theme changes on documentElement and body
// plus computed opacity/transform at each mutation.
const RECORDER = `
  (function () {
    try {
      var log = [];
      window.__kaironNavLog = log;
      function snap(what) {
        try {
          var de = document.documentElement;
          log.push({
            what: what,
            cls: de ? de.className : null,
            op: de ? getComputedStyle(de).opacity : null,
            rootTheme: de ? (de.dataset.theme || null) : null,
            bodyCls: document.body ? document.body.className : null,
            bodyTheme: document.body ? (document.body.dataset.theme || null) : null
          });
        } catch (e) {}
      }
      snap('start');
      var obs = new MutationObserver(function () { snap('mut'); });
      try { obs.observe(document, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'data-theme'] }); } catch (e) {}
    } catch (e) {}
  })();
`;

// Wait for the tab document to match the expected page (DOM interactive is
// enough — the page is usable then; 'load' may wait on hung font requests).
async function waitForTabPage(pageClient, pageName, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const info = await pageClient.evaluate(`(function(){
        try {
          return { path: location.pathname, search: location.search, ready: document.readyState };
        } catch (e) { return null; }
      })()`);
      if (info && info.path && info.path.indexOf(pageName) !== -1 && (info.ready === 'interactive' || info.ready === 'complete')) return info;
    } catch (e) {}
    await sleep(150);
  }
  return null;
}

// Verify the internal→internal entrance for the given tab document.
async function expectInternalEntrance(pageClient, pageName, label) {
  const loaded = await waitForTabPage(pageClient, pageName, 10000);
  check(`${label}: page loaded`, !!loaded, loaded ? loaded.path + loaded.search : 'timeout');
  if (!loaded) return;

  check(`${label}: entrance armed (?transition=1)`, String(loaded.search).indexOf('transition=1') !== -1, loaded.search);

  // Allow the entrance to complete (double-rAF, or the throttled safety timer).
  await sleep(1700);

  const log = await pageClient.evaluate(`window.__kaironNavLog || []`);
  const sawEnter = Array.isArray(log) && log.some((s) => s.cls && String(s.cls).indexOf('page-enter') !== -1);
  const sawRelease = Array.isArray(log) && log.some((s) => s.what === 'mut' && s.cls && String(s.cls).indexOf('page-enter') === -1);
  check(`${label}: page-enter applied then released`, sawEnter && sawRelease, 'log=' + JSON.stringify((log || []).map((s) => s.what + ':' + s.cls)));

  // "No stuck state" is: the class is gone (the release mechanism ran). Computed
  // opacity can't be used here — transitions freeze at their start value in a
  // hidden/occluded tab, which is exactly the state the release prevents.
  const finalCls = await pageClient.evaluate(`document.documentElement.className`);
  check(`${label}: no stuck page-enter state`, String(finalCls).indexOf('page-enter') === -1, 'cls=' + finalCls);

  const wiring = await pageClient.evaluate(`(function(){
    var h = document.documentElement;
    return { prop: getComputedStyle(h).transitionProperty, dur: getComputedStyle(h).transitionDuration };
  })()`);
  const opWired = String(wiring.prop).indexOf('opacity') !== -1 && String(wiring.dur).indexOf('0.15s') !== -1;
  check(`${label}: 150ms fade/rise transition wired on html`, opWired, JSON.stringify(wiring));
}

// Poll a computed color from the test side (CDP evaluate is not throttled).
// Works for windows that render frames (chrome, overlay).
async function pollColors(client, selector, totalMs) {
  const colors = [];
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    try {
      const c = await client.evaluate(`getComputedStyle(${selector}).backgroundColor`);
      colors.push(c);
    } catch (e) {}
    await sleep(12);
  }
  return colors;
}

async function distinctCount(samples) {
  return Array.from(new Set(samples || [])).length;
}

// Verify the theme-transition mechanism on a tab (which cannot be
// frame-sampled here): the theme-switching class must have been observed on
// body during the flip, and the class must enable a 220ms background-color
// transition.
async function assertTabThemeWired(pageClient, expectedTheme, label) {
  const theme = await pageClient.evaluate(`document.body.dataset.theme`);
  check(`${label}: settings data-theme is ${expectedTheme}`, theme === expectedTheme, String(theme));

  const log = await pageClient.evaluate(`window.__kaironNavLog || []`);
  const flipSeen = Array.isArray(log) && log.some((s) => s.bodyCls && String(s.bodyCls).indexOf('theme-switching') !== -1 && s.bodyTheme === expectedTheme);
  check(`${label}: flip went through the animated path (theme-switching observed)`, flipSeen, 'log=' + JSON.stringify((log || []).map((s) => s.what + ':' + s.bodyCls + ':' + s.bodyTheme)));

  const wiring = await pageClient.evaluate(`(function(){
    var b = document.body;
    b.classList.add('theme-switching');
    var out = { prop: getComputedStyle(b).transitionProperty, dur: getComputedStyle(b).transitionDuration };
    b.classList.remove('theme-switching');
    return out;
  })()`);
  const wired = String(wiring.prop).indexOf('background-color') !== -1 && String(wiring.dur).indexOf('0.22s') !== -1;
  check(`${label}: 220ms theme transition wired on body`, wired, JSON.stringify(wiring));
}

function startExternalSite() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><style>body{background:#123456;color:#fff}</style></head><body><h1>ext-site</h1></body></html>');
  });
  return new Promise((resolve) => server.listen(EXT_PORT, '127.0.0.1', () => resolve(server)));
}

(async () => {
  let child = null;
  let extServer = null;
  let main = null, tab = null, overlay = null;
  try {
    extServer = await startExternalSite();

    child = spawn('npx', ['electron', '.', '--remote-debugging-port=' + PORT], {
      cwd: process.cwd(),
      env: { ...process.env, KAIRON_DIAG: '0' },
      stdio: 'ignore',
      shell: true,
      windowsHide: true,
    });

    let targets = null;
    for (let i = 0; i < 40; i++) {
      targets = await getJson('/json/list').catch(() => null);
      if (targets && targets.length) break;
      await sleep(500);
    }
    if (!targets) throw new Error('CDP never came up');

    const mainTarget = targets.find((t) => t.url && t.url.includes('/renderer/index.html'));
    if (!mainTarget) throw new Error('main window target not found');
    main = await connectPage(mainTarget);
    await sleep(1200); // let session restore settle

    // ── 1. FIRST LOAD: fresh tab → home renders instantly ──
    const beforeIds = new Set((await getJson('/json/list')).map((t) => t.id));
    await main.evaluate(`window.kairon.createTab('kairon://home')`);
    const homeTarget = await waitForNewTarget('/home.html', beforeIds);
    check('1: fresh home tab opens', !!homeTarget, homeTarget && homeTarget.url);
    tab = await connectPage(homeTarget);
    const homeReady = await waitForTabPage(tab, 'home.html', 10000);
    check('1: home finished loading (not an error page)', !!homeReady, homeReady ? homeReady.path : 'timeout/error page');
    await sleep(400);

    const homeState = await tab.evaluate(`(function(){
      return {
        cls: document.documentElement.className,
        op: getComputedStyle(document.documentElement).opacity,
        inlineOp: document.documentElement.style.opacity || null,
        search: location.search,
        dataTheme: document.documentElement.dataset.theme || null
      };
    })()`);
    check('1: no page-enter / theme-switching on first load', String(homeState.cls).indexOf('page-enter') === -1 && String(homeState.cls).indexOf('theme-switching') === -1, JSON.stringify(homeState));
    check('1: no inline fade opacity left behind', homeState.inlineOp === null && homeState.op === '1', JSON.stringify(homeState));
    check('1: no ?transition= on first load', String(homeState.search).indexOf('transition=') === -1, homeState.search);
    const chromeBootTheme = await main.evaluate(`document.body.dataset.theme`);
    check('1: home renders the persisted theme (matches chrome)', homeState.dataTheme === chromeBootTheme && (homeState.dataTheme === 'dark' || homeState.dataTheme === 'light'), homeState.dataTheme + '/' + chromeBootTheme);

    // Install the entrance recorder — it runs in every future document of this tab.
    await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: RECORDER });

    // ── 2. home → settings ──
    await main.evaluate(`window.kairon.navigate('kairon://settings')`);
    await expectInternalEntrance(tab, 'settings.html', '2: home→settings');

    // ── 3. settings → history ──
    await main.evaluate(`window.kairon.navigate('kairon://history')`);
    await expectInternalEntrance(tab, 'history.html', '3: settings→history');

    // ── 4. history → downloads ──
    await main.evaluate(`window.kairon.navigate('kairon://downloads')`);
    await expectInternalEntrance(tab, 'downloads.html', '4: history→downloads');

    // ── 5. downloads → home ──
    await main.evaluate(`window.kairon.navigate('kairon://home')`);
    await expectInternalEntrance(tab, 'home.html', '5: downloads→home');

    // ── 6. RAPID navigation: home→settings→history back-to-back ──
    await main.evaluate(`window.kairon.navigate('kairon://settings')`);
    await sleep(60);
    await main.evaluate(`window.kairon.navigate('kairon://history')`);
    await expectInternalEntrance(tab, 'history.html', '6: rapid nav lands on history');
    check('6: rapid nav final URL is history', (await tab.evaluate(`location.pathname`)).indexOf('history.html') !== -1, 'path=' + (await tab.evaluate(`location.pathname`)));

    // ── 7. THEME FLIP Dark→Light ──
    await main.evaluate(`window.kairon.navigate('kairon://settings')`);
    await waitForTabPage(tab, 'settings.html', 10000);
    await sleep(600);

    await tab.evaluate(`document.querySelector('.nav-item[data-cat="appearance"]').click()`);
    await sleep(250);

    // Force a known starting theme (the store may be light from previous runs).
    const startTheme = await tab.evaluate(`document.body.dataset.theme`);
    if (startTheme !== 'dark') {
      await tab.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="dark"]').click()`);
      await sleep(900);
    }
    const forcedDark = await tab.evaluate(`document.body.dataset.theme`);
    check('7: settings starts dark', forcedDark === 'dark', String(forcedDark));

    // Dark → Light: poll the chrome's body color while flipping from settings.
    const chromePoll1 = pollColors(main, 'document.body', 800);
    await tab.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="light"]').click()`);
    const chromeSamples1 = await chromePoll1;

    const chromeTheme = await main.evaluate(`document.body.dataset.theme`);
    check('7: chrome data-theme flips to light', chromeTheme === 'light', String(chromeTheme));
    const c1 = await distinctCount(chromeSamples1);
    check('7: chrome background animates (intermediate colors observed)', c1 >= 3, 'distinct=' + JSON.stringify(Array.from(new Set(chromeSamples1))));
    await assertTabThemeWired(tab, 'light', '7: settings tab');

    // ── 8. THEME FLIP Light→Dark ──
    const chromePoll2 = pollColors(main, 'document.body', 800);
    await tab.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="dark"]').click()`);
    const chromeSamples2 = await chromePoll2;

    const chromeDark = await main.evaluate(`document.body.dataset.theme`);
    check('8: chrome data-theme flips back to dark', chromeDark === 'dark', String(chromeDark));
    const c2 = await distinctCount(chromeSamples2);
    check('8: chrome background animates back to dark', c2 >= 3 && chromeSamples2[chromeSamples2.length - 1] === 'rgb(0, 0, 0)', 'distinct=' + JSON.stringify(Array.from(new Set(chromeSamples2))));
    await assertTabThemeWired(tab, 'dark', '8: settings tab');

    // ── 9. THEME FLIP while the downloads panel is open ──
    await main.evaluate(`document.getElementById('btn-downloads').click()`);
    await sleep(400);
    const overlayTarget = await waitForTarget('/overlay.html');
    check('9: downloads panel overlay opens', !!overlayTarget, overlayTarget && overlayTarget.url);
    overlay = await connectPage(overlayTarget);
    await sleep(300);
    const panelVisible = await overlay.evaluate(`(() => { const p = document.getElementById('downloads-panel'); return !p.hidden && getComputedStyle(p).display !== 'none'; })()`);
    check('9: downloads panel visible', panelVisible === true, String(panelVisible));
    const rectBefore = await overlay.evaluate(`(() => { const r = document.getElementById('downloads-panel').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);

    const overlayPoll = pollColors(overlay, `document.getElementById('downloads-panel')`, 800);
    await tab.evaluate(`document.querySelector('.segment[data-feature="themeSystem"][data-setting="mode"][data-value="light"]').click()`);
    const panelSamples = await overlayPoll;

    const overlayTheme = await overlay.evaluate(`document.documentElement.dataset.theme`);
    check('9: overlay data-theme flips to light', overlayTheme === 'light', String(overlayTheme));
    const pc = await distinctCount(panelSamples);
    check('9: downloads panel re-skins smoothly (intermediates observed)', pc >= 3, 'distinct=' + JSON.stringify(Array.from(new Set(panelSamples))));
    const stillVisible = await overlay.evaluate(`(() => { const p = document.getElementById('downloads-panel'); return !p.hidden && getComputedStyle(p).display !== 'none'; })()`);
    const rectAfter = await overlay.evaluate(`(() => { const r = document.getElementById('downloads-panel').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const sameRect = rectBefore && rectAfter && Math.abs(rectBefore.x - rectAfter.x) < 2 && Math.abs(rectBefore.y - rectAfter.y) < 2 && Math.abs(rectBefore.w - rectAfter.w) < 2 && Math.abs(rectBefore.h - rectAfter.h) < 2;
    check('9: panel stays open with unchanged position/size', stillVisible === true && sameRect === true, JSON.stringify({ before: rectBefore, after: rectAfter }));

    await main.evaluate(`document.getElementById('btn-downloads').click()`);
    await sleep(300);

    // ── 10. EXTERNAL WEBSITE untouched ──
    await tab.evaluate(`window.kairon.disableFeature('httpsOnlyMode')`);
    await sleep(400);
    await main.evaluate(`window.kairon.navigate('http://127.0.0.1:${EXT_PORT}/')`);
    const extTarget = await waitForTarget('127.0.0.1:' + EXT_PORT, 10000);
    check('10: external site loads', !!extTarget, extTarget && extTarget.url);
    const ext = await connectPage(extTarget);
    await sleep(800);
    const extInfo = await ext.evaluate(`(function(){
      return {
        dataThemeHtml: document.documentElement.getAttribute('data-theme'),
        dataThemeBody: document.body.getAttribute('data-theme'),
        cls: document.documentElement.className,
        bg: getComputedStyle(document.body).backgroundColor,
        h1: document.querySelector('h1') && document.querySelector('h1').textContent,
        htmlTransition: getComputedStyle(document.documentElement).transitionDuration
      };
    })()`);
    check('10: no data-theme / page-enter injected into website', extInfo.dataThemeHtml === null && extInfo.dataThemeBody === null && String(extInfo.cls).indexOf('page-enter') === -1, JSON.stringify(extInfo));
    check('10: website keeps its own background (#123456)', extInfo.bg === 'rgb(18, 52, 86)', String(extInfo.bg));
    check('10: no Kairon transition styles on website html', extInfo.htmlTransition === '0s', String(extInfo.htmlTransition));

    // Return to settings (trusted) before touching feature IPC again.
    await main.evaluate(`window.kairon.navigate('kairon://settings')`);
    await waitForTabPage(tab, 'settings.html', 10000);
    await sleep(300);
    await tab.evaluate(`window.kairon.enableFeature('httpsOnlyMode')`);
    await sleep(300);

    // ── 11. prefers-reduced-motion guard (CSS side) ──
    await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await sleep(200);
    const rm = await tab.evaluate(`(function(){
      return {
        matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
        dur: getComputedStyle(document.documentElement).transitionDuration,
        cls: document.documentElement.className
      };
    })()`);
    check('11: reduced-motion emulation active', rm.matches === true, JSON.stringify(rm));
    check('11: entrance transition disabled under reduced motion', rm.dur === '0s' || parseFloat(rm.dur) < 0.01, JSON.stringify(rm));
    await tab.send('Emulation.setEmulatedMedia', { features: [] });
    await sleep(200);
    const rmOff = await tab.evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`);
    check('11: emulation cleared', rmOff === false, String(rmOff));

    // ── 12. No console exceptions anywhere ──
    const counts = {
      main: main.events.filter((e) => e.method === 'Runtime.exceptionThrown').length,
      tab: tab.events.filter((e) => e.method === 'Runtime.exceptionThrown').length,
      overlay: overlay ? overlay.events.filter((e) => e.method === 'Runtime.exceptionThrown').length : 0,
    };
    check('12: no uncaught exceptions (main/tab/overlay)', counts.main === 0 && counts.tab === 0 && counts.overlay === 0, JSON.stringify(counts));

    // ── 13. Theme persists + chrome still interactive after all of the above ──
    const finalTheme = await tab.evaluate(`document.body.dataset.theme`);
    check('13: settings still light after navigation round-trip', finalTheme === 'light', String(finalTheme));
    const chromeAlive = await main.evaluate(`!!document.getElementById('btn-downloads')`);
    check('13: chrome still functional', chromeAlive === true, String(chromeAlive));
  } catch (err) {
    check('TEST HARNESS ERROR', false, (err && err.stack) || String(err));
  } finally {
    for (const c of [main, tab, overlay]) { if (c) c.close(); }
    if (extServer) extServer.close();
    if (child) child.kill();
  }
  console.log(failures === 0 ? '\nALL PASS' : '\n' + failures + ' FAILURE(S)');
  process.exit(failures === 0 ? 0 : 1);
})();
