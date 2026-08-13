export function createTabStateStore() {
  let tabs = [];
  let activeTabId = null;

  function getActiveTab() {
    return tabs.find((tab) => tab.id === activeTabId) || null;
  }

  function getTabs() {
    return tabs;
  }

  function applyTabsState(payload) {
    if (!payload || !Array.isArray(payload.tabs)) return;
    tabs = payload.tabs.map((tab) => ({
      id: tab.id,
      title: typeof tab.title === 'string' ? tab.title : 'New Tab',
      url: typeof tab.url === 'string' ? tab.url : 'about:blank',
      loading: !!tab.loading,
      sleeping: !!tab.sleeping,
      pinned: !!tab.pinned,
      canGoBack: !!tab.canGoBack,
      canGoForward: !!tab.canGoForward,
      zoomFactor: typeof tab.zoomFactor === 'number' ? tab.zoomFactor : 1.0,
      favicon: null,
    }));
    activeTabId = Number.isInteger(payload.activeTabId) ? payload.activeTabId : null;
    if (!tabs.some((tab) => tab.id === activeTabId) && tabs.length > 0) activeTabId = tabs[0].id;
  }

  function updateActiveTabPatch(patch) {
    const active = getActiveTab();
    if (!active || !patch || typeof patch !== 'object') return;
    Object.assign(active, patch);
  }

  return {
    getTabs,
    getActiveTab,
    applyTabsState,
    updateActiveTabPatch,
  };
}
