/**
 * context-menu.js — Native Electron context menu infrastructure
 *
 * Architecture:
 *   detectContext(params)  – Analyze webContents context-menu params to determine context type
 *   buildMenu(context)     – Create an Electron Menu instance dynamically from context
 *   showMenu(menu, tab)    – Display the Menu at the cursor position for a tab's BrowserView
 *   setupContextMenu(tab)  – Attach the context-menu listener to a tab's webContents
 *
 * Future menu items should be added to buildMenu() without restructuring any other function.
 * The context object passed to buildMenu() contains all information needed to decide which
 * items to show (page, link, image, editable, selection, etc.).
 */

const { app, Menu, MenuItem, clipboard } = require('electron');

/**
 * Detect the context type from the params object emitted by webContents
 * 'context-menu' event. Returns a plain object describing the context.
 *
 * Supported future contexts (all flags are false by default until items are added):
 *   isPage       – right-click on general page area
 *   isLink       – right-click on a hyperlink
 *   isImage      – right-click on an image
 *   isEditable   – right-click on an editable field (input, textarea, contenteditable)
 *   hasSelection – right-click on selected text
 *
 * @param {Electron.ContextMenuParams} params
 * @returns {{ isPage: boolean, isLink: boolean, isImage: boolean, isEditable: boolean, hasSelection: boolean, linkURL: string, srcURL: string, selectionText: string, x: number, y: number }}
 */
function detectContext(params) {
  const isLink = !!(params.linkURL && params.linkURL.length > 0);
  const isImage = !!(params.mediaType === 'image' || params.srcURL);
  const isEditable = params.isEditable === true;
  const hasSelection = !!(params.selectionText && params.selectionText.trim().length > 0);
  const isPage = !isLink && !isImage && !isEditable && !hasSelection;

  return {
    isPage,
    isLink,
    isImage,
    isEditable,
    hasSelection,
    linkURL: params.linkURL || '',
    srcURL: params.srcURL || '',
    selectionText: params.selectionText || '',
    x: params.x,
    y: params.y,
  };
}

/**
 * Build the menu items for the editable field context.
 *
 * Returns Undo, Redo, separator, Cut, Copy, Paste, Delete, separator,
 * and Select All. Uses Electron's built-in role system so enabled/disabled
 * states are managed automatically based on the webContents state.
 *
 * @param {ReturnType<typeof detectContext>} context
 * @param {object} tab – The active tab containing `view` (BrowserView)
 * @returns {MenuItem[]}
 */
function editableMenu(context, tab) {
  if (!context.isEditable) {
    return [];
  }

  return [
    new MenuItem({ role: 'undo' }),
    new MenuItem({ role: 'redo' }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({ role: 'cut' }),
    new MenuItem({ role: 'copy' }),
    new MenuItem({ role: 'paste' }),
    new MenuItem({ role: 'delete' }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({ role: 'selectAll' }),
  ];
}

/**
 * Build the menu items for the page context.
 *
 * Returns Back, Forward, and Reload items.
 * Back/Forward are disabled when there is no navigation history in that direction.
 * All actions operate on the currently active tab via the tab's webContents.
 *
 * @param {ReturnType<typeof detectContext>} context
 * @param {object} tab – The active tab containing `view` (BrowserView)
 * @returns {MenuItem[]}
 */
function pageMenu(context, tab) {
  if (!context.isPage) {
    return [];
  }

  const webContents = tab.view.webContents;
  const canGoBack = webContents.navigationHistory.canGoBack();
  const canGoForward = webContents.navigationHistory.canGoForward();

  const backItem = new MenuItem({
    label: 'Back',
    enabled: canGoBack,
    click: () => {
      try {
        if (webContents.navigationHistory.canGoBack()) {
          webContents.navigationHistory.goBack();
        }
      } catch (err) {
        console.error('[context-menu] back failed:', err);
      }
    },
  });

  const forwardItem = new MenuItem({
    label: 'Forward',
    enabled: canGoForward,
    click: () => {
      try {
        if (webContents.navigationHistory.canGoForward()) {
          webContents.navigationHistory.goForward();
        }
      } catch (err) {
        console.error('[context-menu] forward failed:', err);
      }
    },
  });

  const reloadItem = new MenuItem({
    label: 'Reload',
    enabled: true,
    click: () => {
      try {
        webContents.reload();
      } catch (err) {
        console.error('[context-menu] reload failed:', err);
      }
    },
  });

  return [backItem, forwardItem, reloadItem];
}

/**
 * Build the menu items for the selected text context.
 *
 * Returns Copy (using Electron's built-in role) and a Search action.
 * The displayed search label truncates long selections to ~40 characters.
 *
 * @param {ReturnType<typeof detectContext>} context
 * @param {object} tab – The active tab
 * @param {{ onSearch: (query: string) => void }} actions – Callbacks for actions
 * @returns {MenuItem[]}
 */
function selectedTextMenu(context, tab, actions) {
  if (!context.hasSelection) {
    return [];
  }

  const fullText = context.selectionText;
  const truncated =
    fullText.length > 42
      ? fullText.slice(0, 39) + '...'
      : fullText;

  return [
    new MenuItem({ role: 'copy' }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: `Search "${truncated}"`,
      click: () => {
        try {
          if (actions && typeof actions.onSearch === 'function') {
            actions.onSearch(fullText);
          }
        } catch (err) {
          console.error('[context-menu] search failed:', err);
        }
      },
    }),
  ];
}

/**
 * Build the menu items for the link context.
 *
 * Returns Open Link, Open Link in New Tab, Open Link in New Window,
 * separator, and Copy Link Address.
 *
 * @param {ReturnType<typeof detectContext>} context
 * @param {object} tab – The active tab
 * @param {{ onOpenInCurrentTab?: (url: string) => void, onOpenInNewTab?: (url: string) => void, onOpenInNewWindow?: (url: string) => void }} actions
 * @returns {MenuItem[]}
 */
function linkMenu(context, tab, actions) {
  if (!context.isLink) {
    return [];
  }

  const url = context.linkURL;

  return [
    new MenuItem({
      label: 'Open Link',
      click: () => {
        try {
          if (actions && typeof actions.onOpenInCurrentTab === 'function') {
            actions.onOpenInCurrentTab(url);
          }
        } catch (err) {
          console.error('[context-menu] open link failed:', err);
        }
      },
    }),
    new MenuItem({
      label: 'Open Link in New Tab',
      click: () => {
        try {
          if (actions && typeof actions.onOpenInNewTab === 'function') {
            actions.onOpenInNewTab(url);
          }
        } catch (err) {
          console.error('[context-menu] open link in new tab failed:', err);
        }
      },
    }),
    new MenuItem({
      label: 'Open Link in New Window',
      click: () => {
        try {
          if (actions && typeof actions.onOpenInNewWindow === 'function') {
            actions.onOpenInNewWindow(url);
          }
        } catch (err) {
          console.error('[context-menu] open link in new window failed:', err);
        }
      },
    }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'Copy Link Address',
      click: () => {
        try {
          clipboard.writeText(url);
        } catch (err) {
          console.error('[context-menu] copy link failed:', err);
        }
      },
    }),
  ];
}

/**
 * Build the menu items for the image context.
 *
 * Returns Open Image in New Tab, Save Image As..., Copy Image Address.
 *
 * @param {ReturnType<typeof detectContext>} context
 * @param {object} tab – The active tab
 * @param {{ onOpenInNewTab?: (url: string) => void, onSaveImageAs?: (url: string) => void }} actions
 * @returns {MenuItem[]}
 */
function imageMenu(context, tab, actions) {
  if (!context.isImage) {
    return [];
  }

  const url = context.srcURL;

  return [
    new MenuItem({
      label: 'Open Image in New Tab',
      click: () => {
        try {
          if (actions && typeof actions.onOpenInNewTab === 'function') {
            actions.onOpenInNewTab(url);
          }
        } catch (err) {
          console.error('[context-menu] open image in new tab failed:', err);
        }
      },
    }),
    new MenuItem({
      label: 'Save Image As...',
      click: () => {
        try {
          if (actions && typeof actions.onSaveImageAs === 'function') {
            actions.onSaveImageAs(url);
          }
        } catch (err) {
          console.error('[context-menu] save image failed:', err);
        }
      },
    }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'Copy Image Address',
      click: () => {
        try {
          clipboard.writeText(url);
        } catch (err) {
          console.error('[context-menu] copy image address failed:', err);
        }
      },
    }),
  ];
}

/**
 * Build a native Electron Menu instance from the given context object,
 * the active tab, and action callbacks.
 *
 * Priority: editable → image → link → selected text → page
 *
 * Dispatches to context-specific builder functions (e.g. pageMenu).
 * Future contexts should add their own builder functions and insert
 * them at the correct priority in this function.
 *
 * @param {ReturnType<typeof detectContext>} context
 * @param {object} tab – The active tab containing `view` (BrowserView)
 * @param {{ onSearch?: (query: string) => void, onOpenInCurrentTab?: (url: string) => void, onOpenInNewTab?: (url: string) => void, onOpenInNewWindow?: (url: string) => void, onSaveImageAs?: (url: string) => void }} [actions] – Optional callbacks
 * @returns {Menu}
 */
function buildMenu(context, tab, actions) {
  const menu = new Menu();

  // Editable context: Undo, Redo, Cut, Copy, Paste, Delete, Select All
  if (context.isEditable) {
    const editableItems = editableMenu(context, tab);
    for (const item of editableItems) {
      menu.append(item);
    }
    return menu;
  }

  // Image context: Open Image in New Tab, Save Image As, Copy Address
  if (context.isImage) {
    const imageItems = imageMenu(context, tab, actions);
    for (const item of imageItems) {
      menu.append(item);
    }
    return menu;
  }

  // Link context: Open Link, Open in New Tab/Window, Copy Link
  if (context.isLink) {
    const linkItems = linkMenu(context, tab, actions);
    for (const item of linkItems) {
      menu.append(item);
    }
    return menu;
  }

  // Selected text context (on normal pages): Copy, Search
  if (context.hasSelection) {
    const textItems = selectedTextMenu(context, tab, actions);
    for (const item of textItems) {
      menu.append(item);
    }
    return menu;
  }

  // Page context: Back, Forward, Reload
  if (context.isPage) {
    const pageItems = pageMenu(context, tab);
    for (const item of pageItems) {
      menu.append(item);
    }
  }

  // Dev-only: Inspect Element appended to every menu after context items
  appendDeveloperItems(menu, context, tab);

  return menu;
}

/**
 * Append developer-only items to the menu (currently Inspect Element).
 *
 * Only active in development builds (!app.isPackaged).
 * Uses the right-click coordinates from the context to inspect the
 * exact element that was clicked.
 *
 * @param {Menu} menu – The menu to append to
 * @param {ReturnType<typeof detectContext>} context
 * @param {object} tab – The active tab
 */
function appendDeveloperItems(menu, context, tab) {
  // Production builds: never show developer items
  if (app.isPackaged) {
    return;
  }

  const webContents = tab.view && tab.view.webContents;
  if (!webContents) {
    return;
  }

  menu.append(new MenuItem({ type: 'separator' }));
  menu.append(
    new MenuItem({
      label: 'Inspect Element',
      accelerator: 'CmdOrCtrl+Shift+C',
      click: () => {
        try {
          webContents.inspectElement(context.x, context.y);
          if (webContents.isDevToolsOpened()) {
            webContents.devToolsWebContents && webContents.devToolsWebContents.focus();
          }
        } catch (err) {
          console.error('[context-menu] inspect element failed:', err);
        }
      },
    })
  );
}

/**
 * Display the given Menu at the cursor position.
 *
 * We call menu.popup() without explicit x/y coordinates because Electron
 * defaults to the current mouse cursor screen position — which is exactly
 * where the user right-clicked. This avoids the complexity of transforming
 * BrowserView-relative coordinates to screen coordinates.
 *
 * @param {Menu} menu  – The fully built Electron Menu
 */
function showMenu(menu) {
  if (!menu) {
    return;
  }

  try {
    menu.popup();
  } catch (err) {
    console.error('[context-menu] failed to show menu:', err);
  }
}

/**
 * Attach the native context-menu listener to the given tab's webContents.
 *
 * This is the single entry point called from main.js when a tab is created.
 * When the user right-clicks inside the webpage, this handler:
 *   1. Detects the context (page, link, image, editable, selection, etc.)
 *   2. Builds a Menu dynamically from that context
 *   3. Displays the Menu at the cursor position
 *
 * The optional `actions` parameter provides callbacks for actions that require
 * main process integration (e.g. `onSearch` to open a search tab).
 *
 * @param {object} tab – The tab object created by createTab()
 * @param {{ onSearch?: (query: string) => void, onOpenInCurrentTab?: (url: string) => void, onOpenInNewTab?: (url: string) => void, onOpenInNewWindow?: (url: string) => void, onSaveImageAs?: (url: string) => void }} [actions] – Optional callbacks
 */
function setupContextMenu(tab, actions) {
  if (!tab || !tab.view || !tab.view.webContents) {
    console.warn('[context-menu] cannot attach: invalid tab');
    return;
  }

  const webContents = tab.view.webContents;

  const onContextMenu = (_event, params) => {
    try {
      const context = detectContext(params);
      const menu = buildMenu(context, tab, actions);
      showMenu(menu);
    } catch (err) {
      console.error('[context-menu] handler error:', err);
    }
  };

  webContents.on('context-menu', onContextMenu);

  // Store the listener so it can be removed cleanly when the tab is destroyed
  // (main.js already removes all listeners from tab.listeners during destroyTab).
  tab.listeners.push(['context-menu', onContextMenu]);
}

module.exports = { setupContextMenu, detectContext, buildMenu, showMenu };
