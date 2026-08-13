/**
 * tab-context-menu.js — Native Electron tab context menu
 *
 * Completely separate from the webpage context menu (context-menu.js).
 *
 * Architecture:
 *   coreTabActions(tabId, actions)            – New Tab, Reload Tab, Duplicate Tab
 *   wakeTabAction(tabId, actions)             – Wake Tab (only when the tab is sleeping)
 *   pinAction(tabId, actions, isPinned)       – Pin Tab / Unpin Tab (toggle)
 *   tabManagementActions(tabId, actions)      – Close Tab, Close Other Tabs, Close Tabs to the Right
 *   reopenAction(actions)                     – Reopen Closed Tab (disabled when empty)
 *   buildTabMenu(tabId, actions, isPinned, isSleeping) – Create a native Menu instance from all action groups
 *   showTabMenu(menu)                         – Display the Menu at the cursor position
 *   setupTabContextMenu(tabId, actions, options) – Orchestrate build + show given a tab ID
 *
 * The tab context menu receives the clicked tab ID via IPC from the renderer
 * (ui.js detects right-click on tab elements and sends the tab ID to main).
 *
 * All tab actions go through the `actions` callbacks provided by main.js.
 * The module does not access the tabs Map directly — this keeps it decoupled.
 */

const { Menu, MenuItem } = require('electron');

/**
 * Build the core tab action menu items: New Tab, Reload Tab, Duplicate Tab.
 *
 * These are the first items in the tab context menu.
 *
 * @param {number} tabId – The ID of the clicked tab
 * @param {{ onNewTab?: () => void, onReloadTab?: (tabId: number) => void, onDuplicateTab?: (tabId: number) => void }} actions – Callbacks
 * @returns {MenuItem[]}
 */
function coreTabActions(tabId, actions) {
  const items = [];

  // ── New Tab ──────────────────────────────────────────────
  items.push(
    new MenuItem({
      label: 'New Tab',
      accelerator: 'CmdOrCtrl+T',
      click: () => {
        try {
          if (actions && typeof actions.onNewTab === 'function') {
            actions.onNewTab();
          }
        } catch (err) {
          console.error('[tab-context-menu] new tab failed:', err);
        }
      },
    })
  );

  items.push(new MenuItem({ type: 'separator' }));

  // ── Reload Tab ───────────────────────────────────────────
  items.push(
    new MenuItem({
      label: 'Reload Tab',
      accelerator: 'CmdOrCtrl+R',
      click: () => {
        try {
          if (actions && typeof actions.onReloadTab === 'function') {
            actions.onReloadTab(tabId);
          }
        } catch (err) {
          console.error('[tab-context-menu] reload tab failed:', err);
        }
      },
    })
  );

  // ── Duplicate Tab ────────────────────────────────────────
  items.push(
    new MenuItem({
      label: 'Duplicate Tab',
      click: () => {
        try {
          if (actions && typeof actions.onDuplicateTab === 'function') {
            actions.onDuplicateTab(tabId);
          }
        } catch (err) {
          console.error('[tab-context-menu] duplicate tab failed:', err);
        }
      },
    })
  );

  return items;
}

/**
 * Build the Wake Tab menu item for a sleeping tab.
 *
 * Only added when the clicked tab is sleeping (isSleeping === true).
 * Waking keeps the tab in the background — it never changes focus.
 *
 * @param {number} tabId – The ID of the clicked tab
 * @param {{ onWakeTab?: (tabId: number) => void }} actions – Callbacks
 * @returns {MenuItem[]}
 */
function wakeTabAction(tabId, actions) {
  const items = [];

  items.push(new MenuItem({ type: 'separator' }));

  items.push(
    new MenuItem({
      label: 'Wake Tab',
      click: () => {
        try {
          if (actions && typeof actions.onWakeTab === 'function') {
            actions.onWakeTab(tabId);
          }
        } catch (err) {
          console.error('[tab-context-menu] wake tab failed:', err);
        }
      },
    })
  );

  return items;
}

/**
 * Build the pin/unpin menu item.
 *
 * Label automatically changes based on the current pinned state:
 *   "Pin Tab" for unpinned tabs
 *   "Unpin Tab" for pinned tabs
 *
 * @param {number} tabId – The ID of the clicked tab
 * @param {{ onTogglePin?: (tabId: number) => void }} actions – Callbacks
 * @param {boolean} isPinned – Whether the clicked tab is currently pinned
 * @returns {MenuItem[]}
 */
function pinAction(tabId, actions, isPinned) {
  const items = [];

  // No leading separator — Pin Tab follows immediately after Duplicate Tab
  // (the separator in coreTabActions already separates New Tab from the rest).
  // The separator in tabManagementActions will separate Pin from Close actions.
  items.push(
    new MenuItem({
      label: isPinned ? 'Unpin Tab' : 'Pin Tab',
      click: () => {
        try {
          if (actions && typeof actions.onTogglePin === 'function') {
            actions.onTogglePin(tabId);
          }
        } catch (err) {
          console.error('[tab-context-menu] pin toggle failed:', err);
        }
      },
    })
  );

  return items;
}

/**
 * Build the tab management menu items: Close Tab, Close Other Tabs,
 * Close Tabs to the Right.
 *
 * These follow the pin action, separated by a divider.
 *
 * @param {number} tabId – The ID of the clicked tab
 * @param {{ onCloseTab?: (tabId: number) => void, onCloseOtherTabs?: (tabId: number) => void, onCloseTabsToTheRight?: (tabId: number) => void }} actions – Callbacks
 * @returns {MenuItem[]}
 */
function tabManagementActions(tabId, actions) {
  const items = [];

  items.push(new MenuItem({ type: 'separator' }));

  // ── Close Tab ────────────────────────────────────────────
  items.push(
    new MenuItem({
      label: 'Close Tab',
      accelerator: 'CmdOrCtrl+W',
      click: () => {
        try {
          if (actions && typeof actions.onCloseTab === 'function') {
            actions.onCloseTab(tabId);
          }
        } catch (err) {
          console.error('[tab-context-menu] close tab failed:', err);
        }
      },
    })
  );

  // ── Close Other Tabs ─────────────────────────────────────
  items.push(
    new MenuItem({
      label: 'Close Other Tabs',
      click: () => {
        try {
          if (actions && typeof actions.onCloseOtherTabs === 'function') {
            actions.onCloseOtherTabs(tabId);
          }
        } catch (err) {
          console.error('[tab-context-menu] close other tabs failed:', err);
        }
      },
    })
  );

  // ── Close Tabs to the Right ──────────────────────────────
  items.push(
    new MenuItem({
      label: 'Close Tabs to the Right',
      click: () => {
        try {
          if (actions && typeof actions.onCloseTabsToTheRight === 'function') {
            actions.onCloseTabsToTheRight(tabId);
          }
        } catch (err) {
          console.error('[tab-context-menu] close tabs to the right failed:', err);
        }
      },
    })
  );

  return items;
}

/**
 * Build the Reopen Closed Tab menu item.
 *
 * Disabled when there are no recently closed tabs.
 * Enabled when at least one tab has been closed during this session.
 *
 * @param {{ onReopenTab?: () => void, hasClosedTabs?: boolean }} actions
 * @returns {MenuItem[]}
 */
function reopenAction(actions) {
  const items = [];

  items.push(new MenuItem({ type: 'separator' }));

  items.push(
    new MenuItem({
      label: 'Reopen Closed Tab',
      accelerator: 'CmdOrCtrl+Shift+T',
      enabled: !!(actions && actions.hasClosedTabs),
      click: () => {
        try {
          if (actions && typeof actions.onReopenTab === 'function') {
            actions.onReopenTab();
          }
        } catch (err) {
          console.error('[tab-context-menu] reopen tab failed:', err);
        }
      },
    })
  );

  return items;
}

/**
 * Build a native Electron Menu instance for tab context.
 *
 * Full menu layout:
 *   New Tab
 *   ────────
 *   Reload Tab
 *   Duplicate Tab
 *   ────────
 *   Wake Tab            (only when the tab is sleeping)
 *   ────────
 *   Pin Tab (or Unpin Tab)
 *   ────────
 *   Close Tab
 *   Close Other Tabs
 *   Close Tabs to the Right
 *   ────────
 *   Reopen Closed Tab
 *
 * @param {number} tabId – The ID of the clicked tab
 * @param {object} actions – Callbacks object
 * @param {boolean} [isPinned=false] – Whether the clicked tab is pinned
 * @param {boolean} [isSleeping=false] – Whether the clicked tab is sleeping
 * @returns {Menu}
 */
function buildTabMenu(tabId, actions, isPinned, isSleeping) {
  const menu = new Menu();

  // Group 1: Core tab actions — New Tab, Reload Tab, Duplicate Tab
  const coreItems = coreTabActions(tabId, actions);
  for (const item of coreItems) {
    menu.append(item);
  }

  // Group 1.5: Wake Tab — only for sleeping tabs, wakes without switching focus
  if (isSleeping) {
    const wakeItems = wakeTabAction(tabId, actions);
    for (const item of wakeItems) {
      menu.append(item);
    }
  }

  // Group 2: Pin / Unpin Tab
  const pinItems = pinAction(tabId, actions, !!isPinned);
  for (const item of pinItems) {
    menu.append(item);
  }

  // Group 3: Tab management — Close Tab, Close Other Tabs, Close Tabs to the Right
  const mgmtItems = tabManagementActions(tabId, actions);
  for (const item of mgmtItems) {
    menu.append(item);
  }

  // Group 4: Reopen Closed Tab
  const reopenItems = reopenAction(actions);
  for (const item of reopenItems) {
    menu.append(item);
  }

  return menu;
}

/**
 * Display the given Menu at the cursor position.
 *
 * Calls menu.popup() without explicit coordinates because Electron
 * defaults to the current mouse cursor screen position — which is
 * exactly where the user right-clicked.
 *
 * @param {Menu} menu – The fully built Electron Menu
 */
function showTabMenu(menu) {
  if (!menu) {
    return;
  }

  try {
    menu.popup();
  } catch (err) {
    console.error('[tab-context-menu] failed to show menu:', err);
  }
}

/**
 * Build and display a native Electron context menu for the given tab.
 *
 * This is the single entry point called from main.js when a tab
 * right-click IPC message is received.
 *
 * @param {number} tabId – The ID of the clicked tab
 * @param {object} [actions] – Callbacks (may also contain meta hasClosedTabs)
 * @param {{ isPinned?: boolean, hasClosedTabs?: boolean }} [options={}] – Tab state options
 */
function setupTabContextMenu(tabId, actions, options = {}) {
  try {
    const isPinned = !!options.isPinned;
    const isSleeping = !!options.isSleeping;
    // Inject hasClosedTabs into actions so reopenAction can read it
    if (actions && typeof options.hasClosedTabs === 'boolean') {
      actions.hasClosedTabs = options.hasClosedTabs;
    }
    const menu = buildTabMenu(tabId, actions, isPinned, isSleeping);
    showTabMenu(menu);
  } catch (err) {
    console.error('[tab-context-menu] setup failed:', err);
  }
}

module.exports = { setupTabContextMenu, buildTabMenu, showTabMenu, coreTabActions, wakeTabAction, pinAction, tabManagementActions, reopenAction };
