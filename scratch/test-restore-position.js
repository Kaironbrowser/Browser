// Scratch verification for the Ctrl+Shift+T position-restoration logic.
// Extracts insertTabAtRecordedPosition() from src/main/main.js and exercises it
// against the spec scenarios (single restore, LIFO, pinned grouping, clamping).

const fs = require('fs');
const src = fs.readFileSync('src/main/main.js', 'utf8');

// Extract the function source (brace-balanced).
const marker = 'function insertTabAtRecordedPosition(tabId, entry) {';
const start = src.indexOf(marker);
if (start === -1) throw new Error('function not found');
let depth = 0;
let end = start;
for (let i = start; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSource = src.slice(start, end);
// Rename the free `tabs` reference to a parameter so the harness can pass the
// current Map per call (mirrors main.js's module-level `tabs`).
const transformed = fnSource
  .replace('function insertTabAtRecordedPosition(tabId, entry) {', 'function insertTabAtRecordedPosition(tabsMap, tabId, entry) {')
  .replace(/\btabs\b/g, 'tabsMap');
// eslint-disable-next-line no-new-func
const insertTabAtRecordedPosition = new Function(`${transformed}\nreturn insertTabAtRecordedPosition;`)();

function makeTabs(spec) {
  // spec: array of [id, pinned]
  const m = new Map();
  for (const [id, pinned] of spec) m.set(id, { id, pinned: !!pinned });
  return m;
}
const order = (tabs) => Array.from(tabs.keys()).map(String);

let nextId = 1000;
function closeTab(tabs, id, out) {
  const idx = Array.from(tabs.keys()).indexOf(id);
  let pinnedCount = 0;
  for (const [, t] of tabs) if (t.pinned) pinnedCount++;
  out.unshift({
    id,
    pinned: tabs.get(id).pinned,
    originalIndex: Math.max(0, idx),
    pinnedCountAtClose: pinnedCount,
  });
  tabs.delete(id);
}
function restoreTab(tabs, entry) {
  const id = nextId++;
  tabs.set(id, { id, pinned: !!entry.pinned });
  insertTabAtRecordedPosition(tabs, id, entry);
  return id;
}

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

// ── 1. Spec example: close Tab 3 of [1..5], Ctrl+Shift+T → back to slot 2 ──
{
  const tabs = makeTabs([[1, false], [2, false], [3, false], [4, false], [5, false]]);
  const closed = [];
  closeTab(tabs, 3, closed);
  check('after closing tab 3', order(tabs), ['1', '2', '4', '5']);
  const id = restoreTab(tabs, closed[0]);
  check('single restore back to original slot', order(tabs), ['1', '2', String(id), '4', '5']);
}

// ── 2. LIFO: close C, D, E → restore E, D, C each to its own old slot ──
{
  const tabs = makeTabs([['A', false], ['B', false], ['C', false], ['D', false], ['E', false]]);
  const closed = [];
  closeTab(tabs, 'C', closed); // idx 2
  closeTab(tabs, 'D', closed); // now idx 2
  closeTab(tabs, 'E', closed); // now idx 2
  check('remaining after closing C,D,E', order(tabs), ['A', 'B']);

  const idE = restoreTab(tabs, closed[0]); // E
  check('restore E to its old slot', order(tabs), ['A', 'B', String(idE)]);
  const idD = restoreTab(tabs, closed[1]); // D
  check('restore D to its old slot', order(tabs), ['A', 'B', String(idD), String(idE)]);
  const idC = restoreTab(tabs, closed[2]); // C
  check('restore C to its old slot', order(tabs), ['A', 'B', String(idC), String(idD), String(idE)]);
}

// ── 3. Pinned tab restores among pinned tabs ──
{
  const tabs = makeTabs([['P1', true], ['P2', true], ['A', false]]);
  const closed = [];
  closeTab(tabs, 'P2', closed); // pinned, idx 1
  check('after closing pinned P2', order(tabs), ['P1', 'A']);
  const id = restoreTab(tabs, closed[0]);
  check('pinned tab restores into pinned block', order(tabs), ['P1', String(id), 'A']);
}

// ── 4. Normal tab among pinned tabs restores after the pinned block ──
{
  const tabs = makeTabs([['P1', true], ['P2', true], ['A', false], ['B', false]]);
  const closed = [];
  closeTab(tabs, 'A', closed); // unpinned, idx 2, pinnedCountAtClose 2
  check('after closing A', order(tabs), ['P1', 'P2', 'B']);
  const id = restoreTab(tabs, closed[0]);
  check('normal tab restores after pinned block', order(tabs), ['P1', 'P2', String(id), 'B']);
}

// ── 5. Clamping: surrounding tabs closed → closest valid slot, never throws ──
{
  const tabs = makeTabs([['T1', false], ['T2', false], ['T3', false], ['T4', false], ['T5', false]]);
  const closed = [];
  closeTab(tabs, 'T3', closed); // idx 2
  closeTab(tabs, 'T1', closed);
  closeTab(tabs, 'T2', closed);
  check('after closing T3,T1,T2', order(tabs), ['T4', 'T5']);
  const id = restoreTab(tabs, closed[2]); // T3 (closed first): clamp 2 → end
  check('clamped restore never throws / lands at end', order(tabs), ['T4', 'T5', String(id)]);
}

// ── 6. Absurd originalIndex clamps safely ──
{
  const tabs = makeTabs([['X', false], ['Y', false]]);
  const id = restoreTab(tabs, { pinned: false, originalIndex: 99999, pinnedCountAtClose: 0 });
  check('huge index clamps to end', order(tabs), ['X', 'Y', String(id)]);
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
