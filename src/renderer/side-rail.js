// Compact browser-section shortcuts. Layout space is provided by the shell's
// flex layout and measured through renderer.js for BrowserView bounds.
const STORAGE_KEY = 'kairon:custom-sites';
const FEATURE_ID = 'sideRail';
const DEFAULT_SETTINGS = { position: 'left', width: 'compact', visibleItems: ['home', 'bookmarks', 'history', 'downloads', 'settings'], order: ['home', 'bookmarks', 'history', 'downloads', 'settings'], showCustomSites: true };
const ITEMS = [
  { id: 'home', label: 'Home', url: 'kairon://home', icon: '<path d="m3 8 5-4 5 4v5H9v-3H7v3H3z"/>' },
  { id: 'bookmarks', label: 'Bookmarks', url: 'kairon://bookmarks', icon: '<path d="M4 3.5A1.5 1.5 0 0 1 5.5 2h5A1.5 1.5 0 0 1 12 3.5V14l-4-2.5L4 14z"/>' },
  { id: 'history', label: 'History', url: 'kairon://history', icon: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.2M2.5 4.5V2.8M2.5 2.8H4"/>' },
  { id: 'downloads', label: 'Downloads', url: 'kairon://downloads', icon: '<path d="M8 2v7M5 7l3 3 3-3M3 13.5h10"/>' },
  { id: 'settings', label: 'Settings', url: 'kairon://settings', icon: '<circle cx="8" cy="8" r="2.2"/><path d="M8 2v1.2M8 12.8V14M2 8h1.2M12.8 8H14M3.8 3.8l.85.85M11.35 11.35l.85.85M3.8 12.2l.85-.85M11.35 4.65l.85-.85"/>' },
];

function readSites() { try { const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); return Array.isArray(value) ? value.filter((s) => s && typeof s.url === 'string') : []; } catch { return []; } }
function canonical(url) { try { const u = new URL(url); return `${u.protocol}//${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`; } catch { return String(url || ''); } }
function safeFavicon(url) { try { const u = new URL(url); return ['http:', 'https:', 'data:'].includes(u.protocol) && (u.protocol !== 'data:' || url.toLowerCase().startsWith('data:image/')) ? url : ''; } catch { return ''; } }
function escapeHtml(value) { const div = document.createElement('div'); div.textContent = String(value || ''); return div.innerHTML; }

export function initSideRail(kairon, tabStore, onLayoutChange) {
  const rail = document.getElementById('side-rail');
  const itemsEl = document.getElementById('side-rail-items');
  const sitesEl = document.getElementById('side-rail-sites');
  const pin = document.getElementById('side-rail-pin');
  const settingsButton = document.getElementById('side-rail-settings');
  const toggle = document.getElementById('btn-toggle-side-rail');
  if (!rail || !itemsEl || !sitesEl) return;
  let currentUrl = '';
  let settings = { ...DEFAULT_SETTINGS };
  const itemById = new Map(ITEMS.map((item) => [item.id, item]));
  const isInternal = (url) => typeof url === 'string' && url.toLowerCase().startsWith('kairon://');
  const isActive = (item) => currentUrl.toLowerCase() === item.url || (item.id === 'settings' && currentUrl.toLowerCase().startsWith('kairon://settings/'));
  const orderedItems = () => { const order = Array.isArray(settings.order) ? settings.order : DEFAULT_SETTINGS.order; const visible = new Set(Array.isArray(settings.visibleItems) ? settings.visibleItems : DEFAULT_SETTINGS.visibleItems); return [...order, ...ITEMS.map((item) => item.id)].filter((id, index, list) => list.indexOf(id) === index && visible.has(id) && itemById.has(id)).map((id) => itemById.get(id)); };

  function applySettings() {
    const enabled = settings.enabled !== false;
    rail.hidden = false;
    rail.dataset.sideRailState = enabled ? 'on' : 'off';
    document.body.dataset.sideRail = enabled ? 'on' : 'off';
    document.body.dataset.sideRailPosition = settings.position === 'right' ? 'right' : 'left';
    document.body.dataset.sideRailWidth = settings.width === 'normal' ? 'normal' : 'compact';
    toggle?.setAttribute('aria-pressed', String(enabled));
    if (onLayoutChange) requestAnimationFrame(onLayoutChange);
  }
  function updateSettings(patch) {
    settings = { ...settings, ...patch };
    const { enabled, ...configPatch } = patch;
    if (typeof enabled === 'boolean') kairon.setFeatureEnabled(FEATURE_ID, enabled).catch(() => {});
    if (Object.keys(configPatch).length) kairon.updateFeatureConfig(FEATURE_ID, configPatch).catch(() => {});
    applySettings(); render();
  }
  function navigate(url) { currentUrl = url || ''; render(); kairon.navigate(url); }
  function render() {
    itemsEl.innerHTML = orderedItems().map((item) => `<button class="side-rail-btn${isActive(item) ? ' active' : ''}" type="button" data-side-url="${item.url}" title="${item.label}" aria-label="${item.label}" aria-current="${isActive(item) ? 'page' : 'false'}"><svg viewBox="0 0 16 16" aria-hidden="true">${item.icon}</svg></button>`).join('');
    sitesEl.hidden = settings.showCustomSites === false;
    pin.hidden = settings.showCustomSites === false;
    sitesEl.innerHTML = readSites().map((site) => { const name = escapeHtml(site.name || site.url); const favicon = safeFavicon(site.favicon); return `<button class="side-rail-site${canonical(currentUrl) === canonical(site.url) ? ' active' : ''}" type="button" data-side-site="${encodeURIComponent(site.url)}" title="${name}\nRight-click to unpin" aria-label="${name}">${favicon ? `<img src="${favicon}" alt="" aria-hidden="true">` : '<span aria-hidden="true">•</span>'}</button>`; }).join('');
  }

  itemsEl.addEventListener('click', (e) => { const b = e.target.closest('[data-side-url]'); if (b) navigate(b.dataset.sideUrl); });
  sitesEl.addEventListener('click', (e) => { const b = e.target.closest('[data-side-site]'); if (b) navigate(decodeURIComponent(b.dataset.sideSite)); });
  sitesEl.addEventListener('contextmenu', (e) => { const b = e.target.closest('[data-side-site]'); if (!b) return; e.preventDefault(); kairon.toggleCustomSite(decodeURIComponent(b.dataset.sideSite)).catch(() => {}); });
  pin?.addEventListener('click', () => { const tab = tabStore.getActiveTab(); const url = tab?.url || currentUrl; if (!url || isInternal(url) || !/^https?:\/\//i.test(url)) return; kairon.toggleCustomSite(url, tab?.title || '', tab?.favicon || '').catch(() => {}); });
  settingsButton?.addEventListener('click', () => kairon.navigate('kairon://settings/side-rail'));
  toggle?.addEventListener('click', () => updateSettings({ enabled: settings.enabled === false }));
  kairon.onUrlChanged((url) => { currentUrl = url || ''; render(); });
  kairon.onTabsState(() => setTimeout(() => { currentUrl = tabStore.getActiveTab()?.url || currentUrl; render(); }, 0));
  window.addEventListener('kairon-custom-sites-updated', render);
  kairon.onSettingsUpdated((snapshot) => { const next = snapshot?.state?.[FEATURE_ID]; if (next) settings = { ...DEFAULT_SETTINGS, ...next.settings, enabled: next.enabled }; applySettings(); render(); });
  kairon.getSettingsState().then((snapshot) => { const state = snapshot?.state?.[FEATURE_ID]; if (state) settings = { ...DEFAULT_SETTINGS, ...state.settings, enabled: state.enabled }; applySettings(); render(); }).catch(() => { applySettings(); render(); });
  applySettings(); render();
}
