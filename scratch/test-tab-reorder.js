// Standalone logic test for the main-process tab reorder algorithm.
// Mirrors src/main/main.js `reorderTab()` exactly (minus emitTabsState, which
// is irrelevant to ordering math) so the insertion + pinned-clamping logic can
// be verified without launching the Electron GUI.
'use strict';

let _emitted = 0;
function emitTabsState() { _emitted++; }

function reorderTab(tabs, activeTabId, tabId, targetIndex) {
  const tab = tabs.get(tabId);
  if (!tab || !Number.isInteger(targetIndex)) return false;

  const entries = Array.from(tabs.entries());
  const sourceIndex = entries.findIndex(([id]) => id === tabId);
  if (sourceIndex === -1) return false;

  const n = entries.length;
  if (n < 2) return false;

  let pinnedCount = 0;
  for (const [, t] of entries) if (t.pinned) pinnedCount++;

  const minIndex = tab.pinned ? 0 : pinnedCount;
  const maxIndex = tab.pinned ? Math.max(0, pinnedCount - 1) : n - 1;
  const target = Math.max(minIndex, Math.min(maxIndex, targetIndex));

  if (target === sourceIndex) return false;

  const moved = entries.splice(sourceIndex, 1)[0];
  entries.splice(target, 0, moved);

  tabs.clear();
  for (const [id, t] of entries) tabs.set(id, t);

  emitTabsState();
  return true;
}

// ── helpers ──────────────────────────────────────────────────
function makeTabs(spec) {
  // spec: array of "id:p|n" tokens, e.g. ['A:p','B:p','C:n','D:n']
  const tabs = new Map();
  let id = 1;
  for (const token of spec) {
    const [name, kind] = token.split(':');
    tabs.set(id, { id, name, pinned: kind === 'p', view: {} });
    id++;
  }
  return tabs;
}

function orderOf(tabs) {
  return Array.from(tabs.values()).map((t) => t.name).join(',');
}

function nameToId(tabs, name) {
  for (const [id, t] of tabs) if (t.name === name) return id;
  throw new Error('missing ' + name);
}

let passed = 0;
let failed = 0;
function check(desc, actual, expected) {
  if (actual === expected) { passed++; console.log('  ok  ' + desc); }
  else { failed++; console.log('  FAIL ' + desc + '  → got "' + actual + '" expected "' + expected + '"'); }
}

// ── tests ────────────────────────────────────────────────────
console.log('== basic reordering (no pinned) ==');
{
  const tabs = makeTabs(['A:n','B:n','C:n']);
  // A. drag first → third (final index 2)
  reorderTab(tabs, null, nameToId(tabs, 'A'), 2);
  check('A→pos2', orderOf(tabs), 'B,C,A');
}
{
  const tabs = makeTabs(['A:n','B:n','C:n']);
  // B. drag third → first (final index 0)
  reorderTab(tabs, null, nameToId(tabs, 'C'), 0);
  check('C→pos0', orderOf(tabs), 'C,A,B');
}
{
  const tabs = makeTabs(['A:n','B:n','C:n','D:n']);
  reorderTab(tabs, null, nameToId(tabs, 'B'), 3);
  check('B→pos3 (middle→end)', orderOf(tabs), 'A,C,D,B');
}
{
  const tabs = makeTabs(['A:n','B:n','C:n','D:n']);
  reorderTab(tabs, null, nameToId(tabs, 'D'), 1);
  check('D→pos1 (end→middle)', orderOf(tabs), 'A,D,B,C');
}
{
  const tabs = makeTabs(['A:n','B:n','C:n']);
  const changed = reorderTab(tabs, null, nameToId(tabs, 'B'), 1);
  check('no-op drop at same index returns false', String(changed), 'false');
  check('no-op leaves order', orderOf(tabs), 'A,B,C');
}
{
  const tabs = makeTabs(['A:n']);
  const changed = reorderTab(tabs, null, nameToId(tabs, 'A'), 0);
  check('single tab is a no-op', String(changed), 'false');
}

console.log('== pinned section rules ==');
{
  const tabs = makeTabs(['A:p','B:p','C:n','D:n']);
  // F. drag pinned tab within pinned section
  reorderTab(tabs, null, nameToId(tabs, 'B'), 0);
  check('pinned B→pos0', orderOf(tabs), 'B,A,C,D');
}
{
  const tabs = makeTabs(['A:p','B:p','C:n','D:n']);
  // G. normal tab dragged toward pinned section clamps to boundary (pos2)
  reorderTab(tabs, null, nameToId(tabs, 'D'), 0);
  check('normal D→0 clamps to 2', orderOf(tabs), 'A,B,D,C');
}
{
  const tabs = makeTabs(['A:p','B:p','C:n','D:n']);
  // H. pinned tab dragged into normal section clamps to end of pinned block
  reorderTab(tabs, null, nameToId(tabs, 'A'), 3);
  check('pinned A→3 clamps to 1', orderOf(tabs), 'B,A,C,D');
}
{
  const tabs = makeTabs(['A:p','B:p','C:n','D:n']);
  // Pinned tab between pinned tabs
  reorderTab(tabs, null, nameToId(tabs, 'A'), 1);
  check('pinned A→1 (swap within pinned)', orderOf(tabs), 'B,A,C,D');
}
{
  const tabs = makeTabs(['A:p','C:n','D:n']);
  // Only pinned tab dragged anywhere stays at 0
  reorderTab(tabs, null, nameToId(tabs, 'A'), 5);
  check('lone pinned A→5 stays 0', orderOf(tabs), 'A,C,D');
}
{
  const tabs = makeTabs(['A:p','B:p','C:n','D:n','E:n']);
  // Normal tab dragged to the pinned/normal boundary lands at the first
  // normal slot (index 2) — clamped into its own section.
  reorderTab(tabs, null, nameToId(tabs, 'E'), 2);
  check('normal E→2 (boundary) lands at 2', orderOf(tabs), 'A,B,E,C,D');
  reorderTab(tabs, null, nameToId(tabs, 'E'), 3);
  check('normal E→3', orderOf(tabs), 'A,B,C,E,D');
}

console.log('== validation ==');
{
  const tabs = makeTabs(['A:n','B:n']);
  check('missing source rejected', String(reorderTab(tabs, null, 999, 0)), 'false');
  check('non-integer target rejected', String(reorderTab(tabs, null, nameToId(tabs, 'A'), 1.5)), 'false');
  check('non-integer source rejected', String(reorderTab(tabs, null, 'A', 0)), 'false');
  check('order unchanged after rejects', orderOf(tabs), 'A,B');
}

console.log('');
console.log(`PASS: ${passed}  FAIL: ${failed}`);
process.exit(failed ? 1 : 0);
