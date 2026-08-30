// ============================================================
// PERFORMANCE MEASUREMENT FRAMEWORK v2
// Fixed async evaluation using awaitPromise
// ============================================================

const http = require('http');
const { spawn } = require('child_process');

function getTargets(port) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

let msgId = 0;
function evalCDP(ws, expression, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const handler = (rawData) => {
      const msg = JSON.parse(rawData.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        if (msg.result?.result?.value !== undefined) {
          resolve(msg.result.result.value);
        } else if (msg.result?.result?.description) {
          resolve(msg.result.result.description);
        } else {
          resolve(null);
        }
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: {
        expression,
        returnByValue: true,
        awaitPromise
      }
    }));
  });
}

async function main() {
  const PORT = 9226;
  const WebSocket = require('ws');
  console.log('=== KAIRON PERFORMANCE BASELINE v2 ===\n');

  const electron = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    cwd: __dirname + '/..',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  });
  electron.stderr.on('data', () => {});

  await new Promise(r => setTimeout(r, 8000));

  try {
    const targets = await getTargets(PORT);
    const mainPage = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
    if (!mainPage) throw new Error('Main page not found');
    console.log(`Main page found, targets: ${targets.length}\n`);

    const ws = new WebSocket(mainPage.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }));
    await new Promise(r => setTimeout(r, 500));

    // 1. Startup
    console.log('--- Startup ---');
    const kaironOk = await evalCDP(ws, `typeof window.kairon !== 'undefined'`);
    console.log(`  window.kairon: ${kaironOk ? '✅' : '❌'}`);

    // 2. Memory
    console.log('\n--- Memory ---');
    const mem = await evalCDP(ws, `
      (function() {
        const m = performance.memory || {};
        return JSON.stringify({
          used: m.usedJSHeapSize || 0,
          total: m.totalJSHeapSize || 0,
        });
      })()
    `);
    const memObj = JSON.parse(mem);
    console.log(`  JS Heap: ${(memObj.used / 1024 / 1024).toFixed(1)} MB`);

    // 3. DOM
    console.log('\n--- DOM ---');
    const domCount = await evalCDP(ws, `document.querySelectorAll('*').length`);
    console.log(`  DOM nodes: ${domCount}`);

    // 4. History count
    console.log('\n--- Database ---');
    const histCount = await evalCDP(ws, `window.kairon.getHistoryCount ? window.kairon.getHistoryCount() : -1`, true);
    console.log(`  History entries: ${histCount}`);

    // 5. getHistory latency
    const histLatency = await evalCDP(ws, `
      (async function() {
        const start = performance.now();
        await window.kairon.getHistory(50, 0);
        return performance.now() - start;
      })()
    `, true);
    console.log(`  getHistory(50): ${Math.round(histLatency)} ms`);

    // 6. Autocomplete latency
    console.log('\n--- Omnibox Autocomplete ---');
    for (const q of ['goo', 'you', 'git', 'wiki', 'test', 'electron']) {
      const lat = await evalCDP(ws, `
        (async function() {
          const start = performance.now();
          const r = await window.kairon.getAutocompleteSuggestions('${q}', 8);
          return performance.now() - start;
        })()
      `, true);
      console.log(`  "${q}" → ${Math.round(lat)} ms`);
    }

    // 7. Bookmarks
    console.log('\n--- Bookmarks ---');
    const bmLat = await evalCDP(ws, `
      (async function() {
        const start = performance.now();
        await window.kairon.getBookmarks();
        return performance.now() - start;
      })()
    `, true);
    console.log(`  getBookmarks(): ${Math.round(bmLat)} ms`);

    // 8. Settings
    console.log('\n--- Settings ---');
    const settLat = await evalCDP(ws, `
      (async function() {
        const start = performance.now();
        await window.kairon.getSettingsState();
        return performance.now() - start;
      })()
    `, true);
    console.log(`  getSettingsState(): ${Math.round(settLat)} ms`);

    // 9. Tab creation
    console.log('\n--- Tab Creation ---');
    const tabLat = await evalCDP(ws, `
      (async function() {
        const start = performance.now();
        window.kairon.createTab('about:blank');
        await new Promise(r => setTimeout(r, 1000));
        return performance.now() - start;
      })()
    `, true);
    console.log(`  createTab: ${Math.round(tabLat)} ms`);

    // 10. Quick Access
    console.log('\n--- Quick Access ---');
    const qaLat = await evalCDP(ws, `
      (async function() {
        const start = performance.now();
        await window.kairon.getQuickAccess();
        return performance.now() - start;
      })()
    `, true);
    console.log(`  getQuickAccess(): ${Math.round(qaLat)} ms`);

    // 11. Repeated Settings query (FeatureStore deep clone cost)
    console.log('\n--- FeatureStore Repeated Query (deep clone cost) ---');
    const repeatedLat = await evalCDP(ws, `
      (async function() {
        const start = performance.now();
        for (let i = 0; i < 10; i++) {
          await window.kairon.getSettingsState();
        }
        return performance.now() - start;
      })()
    `, true);
    console.log(`  10x getSettingsState(): ${Math.round(repeatedLat)} ms (${Math.round(repeatedLat/10)} ms avg)`);

    // 12. Repeated autocomplete (IPC overhead)
    console.log('\n--- Repeated Autocomplete (IPC overhead) ---');
    const repeatedAcLat = await evalCDP(ws, `
      (async function() {
        const start = performance.now();
        for (let i = 0; i < 10; i++) {
          await window.kairon.getAutocompleteSuggestions('test', 8);
        }
        return performance.now() - start;
      })()
    `, true);
    console.log(`  10x getAutocompleteSuggestions(): ${Math.round(repeatedAcLat)} ms (${Math.round(repeatedAcLat/10)} ms avg)`);

    console.log('\n=== BASELINE COMPLETE ===');
    ws.close();
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    electron.kill();
    process.exit(0);
  }
}

setTimeout(() => process.exit(1), 60000);
main();
