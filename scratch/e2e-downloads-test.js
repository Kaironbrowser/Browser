// DOWNLOADS PANEL + DOWNLOADS PAGE — E2E against the REAL Kairon app via CDP.
// Acceptance checks:
//   A. Toolbar has a Downloads button
//   B. A real download completes and is recorded (state, filename, savePath)
//   C. The toolbar badge reflects the active download count
//   D. Clicking the button opens the floating panel (overlay window renders it)
//   E. The panel lists the completed download with status + folder action
//   F. Escape closes the panel; reopening works
//   G. "Show more" opens kairon://downloads in a tab and it lists the download
//   H. Live theme switch re-skins the overlay panel and the downloads page
//   I. Restart restores the persisted download history
//   J. Clear removes entries from the UI (files stay on disk)
//   K. No console errors in the main renderer or overlay
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 9351;
const FILE_PORT = 9352;
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

async function pageErrors(client) {
  const logs = client.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
  const logs2 = client.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry && e.params.entry.level === 'error');
  const msgs = [];
  for (const l of logs) {
    const a = l.params.args || [];
    msgs.push(a.map((x) => (x.value !== undefined ? String(x.value) : x.description || '')).join(' '));
  }
  for (const l of logs2) msgs.push(l.params.entry.text);
  // "Failed to load resource" entries are Chromium's network-level notices for
  // missing resources (e.g. the pre-existing empty-domain tab-favicon request
  // to google's favicon service) — not JS errors from the downloads feature.
  return msgs.filter((m) => !/Failed to load resource/.test(m));
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

async function getOverlay() {
  const t = await waitForTarget('/overlay.html');
  if (!t) throw new Error('overlay target not found');
  return connectPage(t);
}

// Poll the downloads snapshot from the main renderer until a condition holds.
async function waitDownloads(main, predicate, timeoutMs = 30000, label = '') {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const list = await main.evaluate(`window.kairon.getDownloads()`).catch((e) => 'ERR:' + e.message);
    if (Array.isArray(list)) {
      last = list;
      if (predicate(list)) return list;
    }
    await sleep(500);
  }
  console.log('[waitDownloads:' + label + '] last poll:', JSON.stringify(Array.isArray(last) ? last.map((d) => ({ filename: d.filename, state: d.state })) : last));
  return null;
}

// Local server: a tiny instant file and a slow 3 MB stream so active-download
// states (progress / pause / resume / cancel) can be exercised.
let fileServer = null;
function startFileServer() {
  return new Promise((resolve) => {
    fileServer = http.createServer((req, res) => {
      if (req.url.startsWith('/slow.bin')) {
        const total = 3 * 1024 * 1024;
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="kairon-e2e-slow.bin"',
          'Content-Length': total,
        });
        let sent = 0;
        const chunk = Buffer.alloc(64 * 1024, 7);
        const timer = setInterval(() => {
          if (sent >= total || res.destroyed) { clearInterval(timer); res.end(); return; }
          sent += chunk.length;
          res.write(chunk);
        }, 50);
        req.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="kairon-e2e-download-test.txt"',
        'Content-Length': 5,
      });
      res.end('hello');
    });
    fileServer.listen(FILE_PORT, '127.0.0.1', () => resolve());
  });
}

(async () => {
  let child = null;
  try {
    await startFileServer();

    // ── LAUNCH ──────────────────────────────────────────────
    child = spawnApp();
    const main = await getMainWindow();
    await sleep(1200);

    // ── A. Toolbar Downloads button ─────────────────────────
    const btnExists = await main.evaluate(`!!document.getElementById('btn-downloads')`);
    check('A: Downloads button exists in toolbar', btnExists === true);
    const badgeHidden = await main.evaluate(`document.getElementById('downloads-badge').classList.contains('hidden')`);
    check('A: Downloads badge starts hidden (0 active)', badgeHidden === true);

    // Clean up leftovers from previous runs: a restored http download tab may
    // re-download at boot (httpsOnlyMode was disabled by a prior test run).
    // Cancel any in-flight downloads and clear the list so the run is
    // deterministic, then wait for quiescence.
    await main.evaluate(`(async () => {
      try {
        const list = await window.kairon.getDownloads();
        for (const d of list) {
          if (d.state === 'downloading' || d.state === 'paused') {
            try { await window.kairon.cancelDownload(d.id); } catch (e) {}
          }
        }
        await window.kairon.clearDownloads();
      } catch (e) {}
      return true;
    })()`);
    await sleep(800);

    // HTTPS-Only mode would upgrade the plain-HTTP download URL — disable it
    // for the duration of the test (same approach as the theme E2E).
    await main.evaluate(`window.kairon.disableFeature('httpsOnlyMode')`);
    await sleep(400);

    // ── A2. ACTIVE download: progress, pause, resume, cancel ─
    const overlay = await getOverlay();
    console.log('[e2e-downloads] starting slow download…');
    await main.evaluate(`window.kairon.createTab('http://127.0.0.1:${FILE_PORT}/slow.bin')`);
    const slowList = await waitDownloads(main, (l) => l.some((d) => d.state === 'downloading' && d.receivedBytes > 0 && d.totalBytes > 0), 15000, 'slow');
    const slow = slowList && slowList.find((d) => d.filename === 'kairon-e2e-slow.bin' && d.state === 'downloading');
    check('A2: slow download is in-flight with progress', !!slow && slow.receivedBytes > 0 && slow.totalBytes === 3 * 1024 * 1024, JSON.stringify(slow && { received: slow.receivedBytes, total: slow.totalBytes }));
    if (slow) {
      const badgeActive = await main.evaluate(`(() => { const b = document.getElementById('downloads-badge'); return { text: b.textContent, hidden: b.classList.contains('hidden') }; })()`);
      check('A2: badge shows 1 while downloading', badgeActive.text === '1' && badgeActive.hidden === false, JSON.stringify(badgeActive));
      await main.evaluate(`document.getElementById('btn-downloads').click()`);
      await sleep(500);
      const activeRow = await overlay.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('.dl-row')).find((r) => ((r.querySelector('.dl-filename') || {}).textContent || '').includes('slow.bin'));
        if (!row) return null;
        return {
          hasProgress: !!row.querySelector('.dl-progress-fill'),
          hasPause: !!row.querySelector('[aria-label="Pause download"]'),
          hasCancel: !!row.querySelector('[aria-label="Cancel download"]'),
        };
      })()`);
      check('A2: panel row shows progress + pause + cancel', !!(activeRow && activeRow.hasProgress && activeRow.hasPause && activeRow.hasCancel), JSON.stringify(activeRow));

      // Pause via the real UI button
      await overlay.evaluate(`document.querySelector('[aria-label="Pause download"]').click()`);
      const paused = await waitDownloads(main, (l) => l.some((d) => d.id === slow.id && d.state === 'paused'), 10000, 'paused');
      check('A2: pause button pauses the download', !!paused, JSON.stringify(paused && paused.find((d) => d.id === slow.id)));

      // The overlay re-renders on the state push — wait for the resume button.
      for (let i = 0; i < 20; i++) {
        if (await overlay.evaluate(`!!document.querySelector('[aria-label="Resume download"]')`)) break;
        await sleep(250);
      }
      // Resume via the real UI button
      await overlay.evaluate(`document.querySelector('[aria-label="Resume download"]').click()`);
      const resumed = await waitDownloads(main, (l) => l.some((d) => d.id === slow.id && d.state === 'downloading'), 10000, 'resumed');
      check('A2: resume button resumes the download', !!resumed);

      // Cancel via the real UI button, then wait for the entry to leave the list
      await overlay.evaluate(`document.querySelector('[aria-label="Cancel download"]').click()`);
      const gone = await waitDownloads(main, (l) => !l.some((d) => d.id === slow.id), 10000, 'cancelled');
      check('A2: cancel button removes the download', !!gone, JSON.stringify(gone));
      await main.evaluate(`document.getElementById('btn-downloads').click()`);
      await sleep(300);
    } else {
      check('A2: skip (slow download never started)', false);
    }

    // ── B. Real download completes ──────────────────────────
    console.log('[e2e-downloads] starting quick download…');
    await main.evaluate(`window.kairon.createTab('http://127.0.0.1:${FILE_PORT}/file.txt')`);
    await sleep(500);
    const list = await waitDownloads(main, (l) => Array.isArray(l) && l.some((d) => d.state === 'completed'), 30000, 'download');
    console.log('[e2e-downloads] download wait finished:', JSON.stringify(list && list.map((d) => ({ filename: d.filename, state: d.state }))));
    const completed = list && list.find((d) => d.state === 'completed');
    check('B: download completed and recorded', !!completed, JSON.stringify(completed || null));
    check('B: filename recorded', !!(completed && completed.filename === 'kairon-e2e-download-test.txt'), completed && completed.filename);
    check('B: savePath recorded', !!(completed && completed.savePath && completed.savePath.length > 0), completed && completed.savePath);
    if (!completed) throw new Error('download never completed — cannot continue');

    // ── C. Badge reflects active count (0 after completion) ─
    const badgeAfter = await main.evaluate(`(() => { const b = document.getElementById('downloads-badge'); return { text: b.textContent, hidden: b.classList.contains('hidden') }; })()`);
    check('C: badge hidden after completion (0 active)', badgeAfter.hidden === true, JSON.stringify(badgeAfter));

    // ── D. Panel opens on button click ──────────────────────
    console.log('[e2e-downloads] opening panel…');
    await main.evaluate(`document.getElementById('btn-downloads').click()`);
    let panelVisible = false;
    for (let i = 0; i < 16; i++) {
      panelVisible = await overlay.evaluate(`(() => { const p = document.getElementById('downloads-panel'); return !p.hidden && getComputedStyle(p).display !== 'none'; })()`);
      if (panelVisible) break;
      await sleep(250);
    }
    const btnState = await main.evaluate(`(() => { const b = document.getElementById('btn-downloads'); return { expanded: b.getAttribute('aria-expanded'), active: b.classList.contains('active') }; })()`);
    check('D: downloads panel visible in overlay', panelVisible === true, 'btnState=' + JSON.stringify(btnState));

    // ── E. Panel lists the completed download ───────────────
    const rowInfo = await overlay.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.dl-row'));
      if (!rows.length) return null;
      const completed = rows.find((r) => (r.querySelector('.dl-status') || {}).textContent === 'Download complete') || rows[0];
      return {
        count: rows.length,
        filename: (completed.querySelector('.dl-filename') || {}).textContent,
        status: (completed.querySelector('.dl-status') || {}).textContent,
        hasFolder: !!completed.querySelector('.dl-actions [aria-label="Show in folder"]'),
      };
    })()`);
    check('E: panel renders the completed row', !!rowInfo && rowInfo.count >= 1, JSON.stringify(rowInfo));
    check('E: row shows "Download complete"', !!(rowInfo && rowInfo.status === 'Download complete'), rowInfo && rowInfo.status);
    check('E: row has folder action', !!(rowInfo && rowInfo.hasFolder));

    // Open/folder actions resolve without error (tolerate OS-level failure)
    const openResult = await main.evaluate(`window.kairon.openDownload(${completed.id})`).catch((e) => 'ERR:' + e.message);
    const folderResult = await main.evaluate(`window.kairon.showDownloadInFolder(${completed.id})`).catch((e) => 'ERR:' + e.message);
    check('K-actions: openDownload resolves', typeof openResult === 'boolean', String(openResult));
    check('K-actions: showDownloadInFolder resolves', typeof folderResult === 'boolean', String(folderResult));

    // ── F. Escape closes the panel ──────────────────────────
    await overlay.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    // Wait for the main renderer to receive the hide echo and sync its state.
    for (let i = 0; i < 20 && (await main.evaluate(`document.getElementById('btn-downloads').getAttribute('aria-expanded') === 'true'`)); i++) await sleep(200);
    await sleep(300);
    const panelClosed = await overlay.evaluate(`document.getElementById('downloads-panel').hidden`);
    check('F: Escape closes the panel', panelClosed === true);

    // Reopen + outside click (main renderer click) closes it
    await main.evaluate(`document.getElementById('btn-downloads').click()`);
    let reopened = false;
    for (let i = 0; i < 20; i++) {
      reopened = await overlay.evaluate(`!document.getElementById('downloads-panel').hidden`);
      if (reopened) break;
      await sleep(250);
    }
    check('F: panel reopens', reopened === true);
    await main.evaluate(`document.getElementById('address-bar').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(400);
    const closedOutside = await overlay.evaluate(`document.getElementById('downloads-panel').hidden`);
    check('F: outside click closes the panel', closedOutside === true);

    // ── G. Show more → kairon://downloads ───────────────────
    console.log('[e2e-downloads] show more…');
    await main.evaluate(`document.getElementById('btn-downloads').click()`);
    await sleep(500);
    await overlay.evaluate(`document.getElementById('downloads-show-more-btn').click()`);
    await sleep(600);
    const dlTarget = await waitForTarget('/downloads.html');
    check('G: Show more opens kairon://downloads page', !!dlTarget, dlTarget && dlTarget.url);
    const dlPage = dlTarget ? await connectPage(dlTarget) : null;
    if (dlPage) {
      await sleep(900);
      const pageCount = await dlPage.evaluate(`document.getElementById('entry-count').textContent`);
      const pageRows = await dlPage.evaluate(`document.querySelectorAll('.download-item').length`);
      check('G: downloads page lists the download', pageRows >= 1 && /1 item/.test(pageCount), JSON.stringify({ pageCount, pageRows }));
    }

    // ── H. Live theme switch re-skins overlay + page ────────
    await main.evaluate(`window.kairon.updateFeatureConfig('themeSystem', { mode: 'light' })`);
    await sleep(700);
    const overlayTheme = await overlay.evaluate(`document.documentElement.dataset.theme`);
    const overlayBg = await overlay.evaluate(`getComputedStyle(document.getElementById('downloads-panel')).backgroundColor`);
    check('H: overlay panel flips to light theme', overlayTheme === 'light', String(overlayTheme));
    check('H: overlay panel background is a light surface', /rgb\(2(4[0-9]|5[0-9])|rgb\(2[0-4][0-9]/.test(overlayBg) || overlayBg === 'rgb(251, 251, 251)', String(overlayBg));
    if (dlPage) {
      const dlTheme = await dlPage.evaluate(`document.documentElement.dataset.theme`);
      check('H: downloads page flips to light theme', dlTheme === 'light', String(dlTheme));
    }
    await main.evaluate(`window.kairon.updateFeatureConfig('themeSystem', { mode: 'dark' })`);
    await sleep(500);

    // ── I. Restart restores persisted history ───────────────
    console.log('[e2e-downloads] restarting app…');
    try { child.kill('SIGKILL'); } catch (e) {}
    await sleep(2000);
    child = spawnApp();
    const main2 = await getMainWindow();
    await sleep(1500);
    const restored = await waitDownloads(main2, (l) => Array.isArray(l) && l.some((d) => d.state === 'completed' && d.filename === 'kairon-e2e-download-test.txt'), 15000, 'restore');
    check('I: download history restored after restart', !!restored && restored.some((d) => d.filename === 'kairon-e2e-download-test.txt'),
      restored && restored.map((d) => d.filename).join(','));

    // ── J. Clear removes entries (files stay) ───────────────
    const idBeforeClear = restored && restored.find((d) => d.filename === 'kairon-e2e-download-test.txt');
    const clearOk = await main2.evaluate(`window.kairon.clearDownloads()`);
    check('J: clearDownloads resolves', clearOk === true);
    await sleep(500);
    const afterClear = await main2.evaluate(`window.kairon.getDownloads()`);
    const stillThere = Array.isArray(afterClear) && afterClear.some((d) => d.id === (idBeforeClear && idBeforeClear.id));
    check('J: entry removed from downloads list', stillThere === false, JSON.stringify(afterClear));
    if (idBeforeClear && idBeforeClear.savePath) {
      const fileStillOnDisk = fs.existsSync(idBeforeClear.savePath);
      check('J: file NOT deleted from disk', fileStillOnDisk === true, idBeforeClear.savePath);
    }

    // ── K. No console errors in main renderer / overlay ─────
    const mainErrs = await pageErrors(main2);
    const overlayErrs = await pageErrors(overlay);
    check('K: no console errors in main renderer', mainErrs.length === 0, mainErrs.join(' | ').slice(0, 300));
    check('K: no console errors in overlay', overlayErrs.length === 0, overlayErrs.join(' | ').slice(0, 300));
    if (dlPage) {
      const dlErrs = await pageErrors(dlPage);
      check('K: no console errors on downloads page', dlErrs.length === 0, dlErrs.join(' | ').slice(0, 300));
    }

    console.log('\nRESULT: ' + (failures === 0 ? 'ALL PASSED' : failures + ' FAILED'));
    process.exitCode = failures === 0 ? 0 : 1;
  } catch (err) {
    console.error('E2E crashed:', err);
    console.log('\nRESULT: CRASHED');
    process.exitCode = 1;
  } finally {
    // Restore the default HTTPS-Only setting so future runs boot cleanly.
    try {
      if (main2) await main2.evaluate(`window.kairon.enableFeature('httpsOnlyMode')`).catch(() => {});
      else if (main) await main.evaluate(`window.kairon.enableFeature('httpsOnlyMode')`).catch(() => {});
    } catch (e) {}
    if (child && child.exitCode === null) { try { child.kill(); } catch (e) {} }
    if (fileServer) { try { fileServer.close(); } catch (e) {} }
  }
})();
