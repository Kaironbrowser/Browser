// REPRO: star button broken after cold start + home-page search navigation.
// Focused scenario: the session restores with a WEBSITE tab active and a
// home tab in the background; the user switches to the home tab and searches.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const electronPath = require('electron');

const PORT = 9360;
const CDP = 'http://127.0.0.1:' + PORT;
const SITE_PORT = 9355;
const SITE_URL = 'http://127.0.0.1:' + SITE_PORT + '/';

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
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(url, timeoutMs = 10000) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('ws connect timeout: ' + url)), timeoutMs);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error('ws connect error: ' + url)); };
    });
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

async function launchApp() {
  console.log('[repro] launching electron…');
  const child = spawn(electronPath, ['.', '--remote-debugging-port=' + PORT], {
    cwd: process.cwd(),
    env: { ...process.env, KAIRON_DIAG: '0' },
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    targets = await getJson('/json/list').catch(() => null);
    if (targets && targets.length) break;
    await sleep(500);
  }
  if (!targets) throw new Error('CDP never came up');
  console.log('[repro] app up');
  return child;
}

async function quitApp(main) {
  try { await main.evaluate(`window.kairon.exitApp()`); } catch (e) {}
  await sleep(2000);
}

// The electron-store JSON (userData/config.json) holds the persisted session
// under 'session.tabs.v1'. Clear it before phase 1 so the repro starts from a
// known, clean session instead of accumulating junk from earlier runs.
function clearSessionStore() {
  const dir = process.env.APPDATA || '';
  const file = path.join(dir, 'Kairon Browser', 'config.json');
  try {
    if (!fs.existsSync(file)) { console.log('[repro] no config.json to clean'); return; }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      // electron-store dot-paths nest it as session.tabs.v1; delete the whole
      // session subtree (flat key or nested object).
      const hadFlat = 'session.tabs.v1' in raw;
      const nested = raw.session && typeof raw.session === 'object' && raw.session.tabs && typeof raw.session.tabs === 'object';
      if (hadFlat || nested) {
        delete raw['session.tabs.v1'];
        if (nested) delete raw.session;
        fs.writeFileSync(file, JSON.stringify(raw, null, 2));
        console.log('[repro] cleared session from', file);
      } else {
        console.log('[repro] no session key present');
      }
    }
  } catch (e) {
    console.log('[repro] could not clear session store:', e.message);
  }
}

function startSiteServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><html><head><title>Star Repro Site</title></head><body><h1>Repro site</h1></body></html>');
  });
  return new Promise((resolve) => server.listen(SITE_PORT, '127.0.0.1', () => resolve(server)));
}

async function getChrome() {
  const targets = await getJson('/json/list');
  const mainTarget = targets.find((t) => t.url && t.url.includes('/renderer/index.html'));
  if (!mainTarget) throw new Error('main window target not found');
  return CDPClient.connect(mainTarget.webSocketDebuggerUrl);
}

async function tabTitles(main) {
  return main.evaluate(`Array.from(document.querySelectorAll('.tab-item[data-id]')).map(el => ({
    id: Number(el.dataset.id),
    title: (el.querySelector('.tab-title') || {}).textContent || '',
    active: el.classList.contains('active'),
  }))`);
}

async function switchToTabById(main, id) {
  await main.evaluate(`window.kairon.switchTab(${id})`);
  await sleep(800);
}

async function searchFromHome(homeTab, query) {
  await homeTab.evaluate(`(() => {
    const input = document.getElementById('search-input');
    input.value = ${JSON.stringify(query)};
    document.getElementById('search-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return true;
  })()`);
}

async function waitSearchInput(homeTab) {
  for (let i = 0; i < 40; i++) {
    const ready = await homeTab.evaluate(`!!document.getElementById('search-input')`).catch(() => false);
    if (ready) return;
    await sleep(300);
  }
}

async function cleanSiteState(main) {
  await main.evaluate(`(async () => {
    const bms = await window.kairon.getBookmarks();
    for (const b of bms) if (b.url && b.url.includes('127.0.0.1')) await window.kairon.deleteBookmark(b.id);
    const qa = await window.kairon.getQuickAccess();
    for (const e of qa) if (e.url && e.url.includes('127.0.0.1')) await window.kairon.deleteQuickAccessEntry(e.id);
    return true;
  })()`);
}

(async () => {
  const watchdog = setTimeout(() => { console.error('WATCHDOG: repro timed out'); process.exit(3); }, 360000);
  let child = null;
  let siteServer = null;
  try {
    siteServer = await startSiteServer();
    clearSessionStore();

    // ── PHASE 1: persist a session = [site tab (active), home tab (background)] ──
    child = await launchApp();
    let main = await getChrome();
    await main.evaluate(`window.kairon.disableFeature('httpsOnlyMode')`);
    await cleanSiteState(main);
    await main.evaluate(`window.kairon.createTab('kairon://home')`);
    await waitForTarget('home.html', 15000);
    await sleep(800);
    // Navigate the active (home) tab to the site, then open a NEW home tab.
    await main.evaluate(`window.kairon.navigate('${SITE_URL}')`);
    await waitForTarget('127.0.0.1:' + SITE_PORT, 15000);
    await sleep(1000);
    await main.evaluate(`window.kairon.createTab('kairon://home')`);
    await sleep(1200);
    // Now switch BACK to the site tab so it is the restored ACTIVE tab.
    const t1 = await tabTitles(main);
    const siteTab = t1.find((t) => t.title.includes('Star Repro Site')) || t1.find((t) => !/home/i.test(t.title));
    if (siteTab) await switchToTabById(main, siteTab.id);
    await sleep(500);
    check('P1: session = site active + home background', true, JSON.stringify(await tabTitles(main)));
    await quitApp(main);
    main.close();
    child.kill();
    child = null;
    await sleep(1500);
    console.log('[repro] phase 1 done');

    // ── PHASE 2: relaunch → switch to restored home tab → search → navigate → star ──
    child = await launchApp();
    main = await getChrome();
    const home2 = await waitForTarget('home.html', 15000);
    check('P2: home tab restored', !!home2, home2 && home2.url);
    // Wait for the tab strip to render (cold-start renderer timing).
    let restored = [];
    for (let i = 0; i < 30 && restored.length === 0; i++) {
      restored = await tabTitles(main);
      if (!restored.length) await sleep(400);
    }
    console.log('[repro] restored tabs:', JSON.stringify(restored));
    const restoredHome = restored.find((t) => /home/i.test(t.title));
    check('P2: restored home tab is in background (site active)', !!restoredHome && !restoredHome.active, JSON.stringify(restored));
    if (restoredHome) {
      // User clicks the restored home tab → becomes active → searches from it.
      await switchToTabById(main, restoredHome.id);
      const homeTab = await CDPClient.connect(home2.webSocketDebuggerUrl);
      await waitSearchInput(homeTab);
      console.log('[repro] searching from restored home tab (bare word)…');
      await searchFromHome(homeTab, 'kairon browser repro test');
      const braveTarget = await waitForTarget('search.brave.com', 20000);
      check('P2: navigated to search engine', !!braveTarget, braveTarget && braveTarget.url);
      await sleep(2500);
      const stateA = await main.evaluate(`window.kairon.getActiveBookmarkState()`);
      const starA = await main.evaluate(`(() => { const b = document.getElementById('btn-bookmark'); return { disabled: b.disabled, active: b.classList.contains('active') }; })()`);
      console.log('[repro] A state:', JSON.stringify(stateA), 'star:', JSON.stringify(starA));
      check('P2: bookmarkable = true (home search → engine)', !!(stateA && stateA.bookmarkable), JSON.stringify(stateA));
      check('P2: visible star enabled', !!(starA && starA.disabled === false), JSON.stringify(starA));

      // Navigate to the local site via the home tab (address bar navigate on the same tab).
      await main.evaluate(`window.kairon.navigate('${SITE_URL}')`);
      const site2 = await waitForTarget('127.0.0.1:' + SITE_PORT, 15000);
      check('P2: navigated to local site', !!site2, site2 && site2.url);
      await sleep(1500);
      const stateB = await main.evaluate(`window.kairon.getActiveBookmarkState()`);
      console.log('[repro] B state:', JSON.stringify(stateB));
      check('P2: bookmarkable = true on site', !!(stateB && stateB.bookmarkable), JSON.stringify(stateB));

      // Full popup flow: open star → Add to Bookmarks → reopen → Add to Quick Access.
      await main.evaluate(`document.getElementById('btn-bookmark').click()`);
      await sleep(700);
      const overlayTarget = (await getJson('/json/list')).find((t) => t.url && t.url.includes('overlay.html'));
      if (overlayTarget) {
        const overlay = await CDPClient.connect(overlayTarget.webSocketDebuggerUrl);
        const popup = await overlay.evaluate(`(() => {
          const p = document.getElementById('star-popup');
          return { visible: !!p && !p.hidden,
            qa: document.getElementById('sp-quick-access-label').textContent,
            bm: document.getElementById('sp-bookmark-label').textContent };
        })()`);
        console.log('[repro] popup:', JSON.stringify(popup));
        check('P2: star popup opened', !!(popup && popup.visible), JSON.stringify(popup));
        check('P2: popup shows Add to Bookmarks', popup && popup.bm === 'Add to Bookmarks', popup && popup.bm);
        check('P2: popup shows Add to Quick Access', popup && popup.qa === 'Add to Quick Access', popup && popup.qa);
        if (popup && popup.visible) {
          await overlay.evaluate(`document.getElementById('sp-bookmark-item').click()`);
          await sleep(900);
          const afterBm = await main.evaluate(`window.kairon.getActiveBookmarkState()`);
          check('P2: bookmarked = true after popup action', !!(afterBm && afterBm.bookmarked), JSON.stringify(afterBm));
          await main.evaluate(`document.getElementById('btn-bookmark').click()`);
          await sleep(700);
          const popup2 = await overlay.evaluate(`(() => ({
            visible: !!document.getElementById('star-popup') && !document.getElementById('star-popup').hidden,
            bm: document.getElementById('sp-bookmark-label').textContent,
            qa: document.getElementById('sp-quick-access-label').textContent,
          }))()`);
          check('P2: popup now shows Remove from Bookmarks', popup2 && popup2.bm === 'Remove from Bookmarks', JSON.stringify(popup2));
          if (popup2 && popup2.visible) {
            await overlay.evaluate(`document.getElementById('sp-quick-access-item').click()`);
            await sleep(900);
            const afterQa = await main.evaluate(`window.kairon.getActiveBookmarkState()`);
            check('P2: inQuickAccess = true after popup action', !!(afterQa && afterQa.inQuickAccess), JSON.stringify(afterQa));
            check('P2: still bookmarked after QA add', !!(afterQa && afterQa.bookmarked), JSON.stringify(afterQa));
          }
        }
        overlay.close();
      } else {
        check('P2: overlay target found', false, 'no overlay target');
      }
      homeTab.close();
    }
    await quitApp(main);
    main.close();
    child.kill();
    child = null;
    await sleep(1500);
    console.log('[repro] phase 2 done');

    // ── PHASE 3: relaunch → both states persist ──
    child = await launchApp();
    main = await getChrome();
    const site3 = await waitForTarget('127.0.0.1:' + SITE_PORT, 15000);
    check('P3: site tab restored', !!site3, site3 && site3.url);
    await sleep(1500);
    const finalState = await main.evaluate(`window.kairon.getActiveBookmarkState()`);
    console.log('[repro] final restored state:', JSON.stringify(finalState));
    check('P3: bookmark persisted across restart', !!(finalState && finalState.bookmarked), JSON.stringify(finalState));
    check('P3: Quick Access persisted across restart', !!(finalState && finalState.inQuickAccess), JSON.stringify(finalState));
    main.close();
    await quitApp(main);
    child.kill();
    child = null;
  } catch (err) {
    console.error('REPRO ERROR', err && err.stack ? err.stack : err);
    failures++;
  } finally {
    clearTimeout(watchdog);
    if (child) { child.kill(); }
    if (siteServer) siteServer.close();
    await sleep(300);
    console.log('---');
    console.log(failures === 0 ? 'ALL REPRO CHECKS PASSED' : failures + ' REPRO CHECK(S) FAILED');
    process.exit(failures === 0 ? 0 : 1);
  }
})();
