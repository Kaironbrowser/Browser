const http = require('http');
const { spawn } = require('child_process');

const electron = spawn('npx', ['electron', '.', '--remote-debugging-port=9224'], {
  cwd: __dirname + '/..',
  stdio: ['pipe', 'pipe', 'pipe'],
  shell: true
});

let stderrOutput = '';
electron.stderr.on('data', d => { stderrOutput += d.toString(); });

setTimeout(() => {
  http.get('http://127.0.0.1:9224/json', (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const targets = JSON.parse(data);
        const mainPage = targets.find(t => t.type === 'page' && t.url.includes('index.html'));
        console.log('=== CDP Targets ===');
        console.log('Main page:', mainPage ? mainPage.url : 'NOT FOUND');
        console.log('Total targets:', targets.length);

        if (mainPage) {
          const WebSocket = require('ws');
          const ws = new WebSocket(mainPage.webSocketDebuggerUrl);
          let msgId = 0;
          const errors = [];

          ws.on('open', () => {
            ws.send(JSON.stringify({ id: ++msgId, method: 'Runtime.enable' }));
            setTimeout(() => {
              ws.send(JSON.stringify({
                id: ++msgId,
                method: 'Runtime.evaluate',
                params: {
                  expression: `JSON.stringify({
                    kaironDefined: typeof window.kairon !== 'undefined',
                    navigate: typeof window.kairon?.navigate === 'function',
                    onUrlChanged: typeof window.kairon?.onUrlChanged === 'function',
                    getSettingsState: typeof window.kairon?.getSettingsState === 'function',
                    createTab: typeof window.kairon?.createTab === 'function',
                    closeTab: typeof window.kairon?.closeTab === 'function',
                    getDownloads: typeof window.kairon?.getDownloads === 'function',
                    getBookmarks: typeof window.kairon?.getBookmarks === 'function',
                    getHistory: typeof window.kairon?.getHistory === 'function',
                    getGroqApiKey: typeof window.kairon?.getGroqApiKey === 'function',
                    toggleSidebar: typeof window.kairon?.toggleSidebar === 'function',
                    windowMinimize: typeof window.kairon?.windowMinimize === 'function',
                    toggleCustomSite: typeof window.kairon?.toggleCustomSite === 'function',
                    onAdblockEvent: typeof window.kairon?.onAdblockEvent === 'function',
                    showOverlaySuggestions: typeof window.kairon?.showOverlaySuggestions === 'function',
                    toggleActiveBookmark: typeof window.kairon?.toggleActiveBookmark === 'function',
                    openIncognitoWindow: typeof window.kairon?.openIncognitoWindow === 'function',
                  })`
                }
              }));
            }, 2000);
          });

          ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            if (msg.id === 2 && msg.result?.result?.value) {
              console.log('\n=== window.kairon API Check ===');
              const api = JSON.parse(msg.result.result.value);
              for (const [key, val] of Object.entries(api)) {
                console.log(`  ${key}: ${val ? '✅' : '❌'}`);
              }
              const allOk = Object.values(api).every(v => v);
              console.log(`\nAll APIs functional: ${allOk ? '✅ YES' : '❌ NO'}`);

              ws.send(JSON.stringify({
                id: ++msgId,
                method: 'Runtime.evaluate',
                params: {
                  expression: `JSON.stringify({
                    tabListItems: document.querySelectorAll('#tab-list .tab').length,
                    addressBarExists: !!document.getElementById('address-bar'),
                    downloadBtnExists: !!document.getElementById('btn-downloads'),
                    bookmarkBtnExists: !!document.getElementById('btn-bookmark'),
                    settingsBtnExists: !!document.getElementById('btn-open-settings'),
                    historyBtnExists: !!document.getElementById('btn-open-history'),
                    navBackExists: !!document.getElementById('btn-back'),
                    navForwardExists: !!document.getElementById('btn-forward'),
                    reloadExists: !!document.getElementById('btn-reload'),
                    customSitesGrid: !!document.getElementById('custom-sites-grid'),
                    aiPanel: !!document.getElementById('ai-panel'),
                  })`
                }
              }));
            }
            if (msg.id === 3 && msg.result?.result?.value) {
              console.log('\n=== DOM Elements Check ===');
              const dom = JSON.parse(msg.result.result.value);
              for (const [key, val] of Object.entries(dom)) {
                console.log(`  ${key}: ${val ? '✅' : '❌'}`);
              }
              console.log('\n=== JS Errors (excl. GPU/cache) ===');
              const realErrors = errors.filter(e => 
                !e.includes('gpu') && !e.includes('cache') && !e.includes('disk_cache')
              );
              console.log(realErrors.length ? realErrors.join('\n') : '  No renderer JS errors ✅');
              ws.close();
              process.exit(0);
            }
            if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
              const text = (msg.params.args || []).map(a => a.value || a.description || '').join(' ');
              if (text && !text.includes('favicon.ico') && !text.includes('net::ERR') && !text.includes('gpu') && !text.includes('cache') && !text.includes('disk_cache')) {
                errors.push(`  [ERROR] ${text}`);
              }
            }
            if (msg.method === 'Runtime.exceptionThrown') {
              const d = msg.params?.exceptionDetails;
              errors.push(`  [EXCEPTION] ${d?.text || d?.exception?.description || JSON.stringify(d)}`);
            }
          });
        }
      } catch (e) {
        console.log('Error:', e.message);
      }
    });
  }).on('error', (e) => {
    console.log('CDP connection failed:', e.message);
    process.exit(1);
  });
}, 6000);

setTimeout(() => {
  electron.kill();
  process.exit(1);
}, 20000);
