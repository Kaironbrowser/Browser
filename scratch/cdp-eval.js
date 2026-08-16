// Temporary debug helper: evaluate JS in a CDP target by URL substring.
// Usage: node scratch/cdp-eval.js <urlSubstring> <expression>
const [,, sub, expr] = process.argv;
if (!sub || !expr) { console.error('usage: node scratch/cdp-eval.js <urlSubstring> <expression>'); process.exit(1); }

const wsUrl = await getWsUrl(sub);
if (!wsUrl) { console.error('NO TARGET for', sub); process.exit(1); }

const ws = new WebSocket(wsUrl);
const result = await new Promise((resolve, reject) => {
  ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id === 1) resolve(msg);
  };
  ws.onerror = (e) => reject(e);
});
console.log(JSON.stringify(result.result?.result?.value ?? result.result, null, 2));
ws.close();
process.exit(0);

async function getWsUrl(sub) {
  const res = await fetch('http://127.0.0.1:9222/json');
  const targets = await res.json();
  const t = targets.find((x) => x.url && x.url.includes(sub));
  return t ? t.webSocketDebuggerUrl : null;
}
