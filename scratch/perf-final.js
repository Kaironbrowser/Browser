// Final performance measurement with warm caches
const http = require('http');
const { spawn } = require('child_process');

let msgId = 0;
function evalCDP(ws, expression, awaitPromise = false) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const handler = (rawData) => {
      const msg = JSON.parse(rawData.toString());
      if (msg.id === id) {
        ws.removeListener('message', handler);
        resolve(msg.result?.result?.value);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise }
    }));
  });
}

async function measureBatch(ws, label, expression, iterations = 10) {
  const latencies = [];
  for (let i = 0; i < iterations; i++) {
    const lat = await evalCDP(ws, `
      (async function() {
        const start = performance.now();
        ${expression}
        return performance.now() - start;
      })()
    `, true);
    latencies.push(Math.round(lat));
  }
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  console.log(`  ${label}: avg=${avg}ms min=${min}ms max=${max}ms`);
  return { avg, min, max };
}

async function main() {
  const PORT = 9227;
  const WebSocket = require('ws');
  console.log('=== KAIRON PERFORMANCE FINAL MEASUREMENT ===\n');

  const electron = spawn('npx', ['electron', '.', `--remote-debugging-port=${PORT}`], {
    cwd: __dirname + '/..',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: true
  });
  electron.stderr.on('data', () => {});

  await new Promise(r => setTimeout(r, 8000));

  try {
    const targets = await new Promise((resolve, reject) => {
      http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });

    const mainPage = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
    if (!mainPage) throw new Error('Main page not found');

    const ws = new WebSocket(mainPage.webSocketDebuggerUrl);
    await new Promise(r => ws.on('open', r));
    ws.send(JSON.stringify({ id: 0, method: 'Runtime.enable' }));
    await new Promise(r => setTimeout(r, 500));

    // Warm up - run a few queries first
    console.log('--- Warm-up ---');
    await evalCDP(ws, `
      (async function() {
        for (let i = 0; i < 5; i++) {
          await window.kairon.getAutocompleteSuggestions('test', 8);
          await window.kairon.getSettingsState();
          await window.kairon.getBookmarks();
        }
      })()
    `, true);
    await new Promise(r => setTimeout(r, 500));

    // Memory
    console.log('\n--- Memory ---');
    const mem = await evalCDP(ws, `JSON.stringify({ used: performance.memory?.usedJSHeapSize || 0 })`);
    console.log(`  JS Heap: ${(JSON.parse(mem).used / 1024 / 1024).toFixed(1)} MB`);

    // Database
    console.log('\n--- Database ---');
    const histCount = await evalCDP(ws, `window.kairon.getHistoryCount ? window.kairon.getHistoryCount() : -1`, true);
    console.log(`  History entries: ${histCount}`);
    await measureBatch(ws, 'getHistory(50)', `await window.kairon.getHistory(50, 0);`);

    // Autocomplete (10 iterations each)
    console.log('\n--- Omnibox Autocomplete (10 iterations) ---');
    await measureBatch(ws, '"goo"', `await window.kairon.getAutocompleteSuggestions('goo', 8);`);
    await measureBatch(ws, '"you"', `await window.kairon.getAutocompleteSuggestions('you', 8);`);
    await measureBatch(ws, '"git"', `await window.kairon.getAutocompleteSuggestions('git', 8);`);
    await measureBatch(ws, '"wiki"', `await window.kairon.getAutocompleteSuggestions('wiki', 8);`);
    await measureBatch(ws, '"test"', `await window.kairon.getAutocompleteSuggestions('test', 8);`);
    await measureBatch(ws, '"electron"', `await window.kairon.getAutocompleteSuggestions('electron', 8);`);

    // Bookmarks
    console.log('\n--- Bookmarks ---');
    await measureBatch(ws, 'getBookmarks()', `await window.kairon.getBookmarks();`);

    // Settings (FeatureStore)
    console.log('\n--- Settings ---');
    await measureBatch(ws, 'getSettingsState()', `await window.kairon.getSettingsState();`);

    // Tab creation
    console.log('\n--- Tab Creation ---');
    await measureBatch(ws, 'createTab', `
      window.kairon.createTab('about:blank');
      await new Promise(r => setTimeout(r, 500));
    `, 3);

    // Quick Access
    console.log('\n--- Quick Access ---');
    await measureBatch(ws, 'getQuickAccess()', `await window.kairon.getQuickAccess();`);

    // Batched repeated queries
    console.log('\n--- Repeated Queries (IPC overhead) ---');
    await measureBatch(ws, '10x getSettingsState', `
      for (let i = 0; i < 10; i++) await window.kairon.getSettingsState();
    `, 3);
    await measureBatch(ws, '10x autocomplete', `
      for (let i = 0; i < 10; i++) await window.kairon.getAutocompleteSuggestions('test', 8);
    `, 3);

    console.log('\n=== MEASUREMENT COMPLETE ===');
    ws.close();
  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    electron.kill();
    process.exit(0);
  }
}

setTimeout(() => process.exit(1), 90000);
main();
