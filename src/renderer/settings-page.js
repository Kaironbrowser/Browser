// ============================================================
//  KAIRON SETTINGS PAGE — kairon://settings
//  Drives the static design DOM in settings.html using the real
//  feature registry over the narrow preload API. No new settings
//  database, no fake toggles — every control reads/writes the
//  actual FeatureStore through kairon.* IPC.
// ============================================================

(function () {
  'use strict';

  const { kairon } = window;

  // ── CATEGORIES ─────────────────────────────────────────────
  // The four sidebar categories. Only categories backed by genuinely
  // wired settings exist; the page never invents settings to fill a
  // category. Titles/subtitles match the supplied design.
	  const CATEGORIES = [
	    { id: 'appearance', label: 'Appearance', description: 'Customize how Kairon looks and how tabs are arranged.' },
	    { id: 'side-rail', label: 'Side Rail', description: 'Configure the built-in browser Side Rail.' },
    { id: 'privacy',    label: 'Privacy',    description: 'Protections that limit tracking and data exposure.' },
    { id: 'security',   label: 'Security',   description: 'Controls that keep unsafe sites and content away.' },
    { id: 'downloads',  label: 'Downloads',  description: 'Choose where downloaded files are saved.' },
    { id: 'advanced',   label: 'Advanced',   description: 'Data utilities and power-user actions.' },
  ];

  // ── FEATURE DEFINITIONS ────────────────────────────────────
  // Data layer only: searchable labels/keywords for each wired feature.
  // Registered-but-inert features are intentionally absent — no fake toggles.
  const FEATURES = {
	    themeSystem: {
      id: 'themeSystem',
      name: 'Theme',
      category: 'appearance',
      rows: [
        { key: 'mode', label: 'Theme mode', description: 'Dark or light color scheme for Kairon\u2019s interface and for websites that support it.' },
        { key: 'tabPosition', label: 'Tab position', description: 'Where the tab strip sits in the browser window.' },
      ],
	      keywords: ['theme', 'dark', 'light', 'dark mode', 'light mode', 'appearance', 'tab position', 'sidebar', 'top bar', 'tabs', 'layout'],
	    },
	    sideRail: {
	      id: 'sideRail', name: 'Side Rail', category: 'side-rail',
	      rows: [
	        { key: 'position', label: 'Position', description: 'Place the Side Rail on the left or right edge.' },
	        { key: 'width', label: 'Width', description: 'Choose compact or normal width.' },
	        { key: 'showCustomSites', label: 'Pinned sites', description: 'Show pinned websites in the Side Rail.' },
	      ],
	      keywords: ['side rail', 'rail', 'browser frame', 'position', 'width', 'pinned sites', 'navigation buttons'],
	    },
    adBlocker: {
      id: 'adBlocker',
      name: 'Ad Blocker',
      category: 'privacy',
      mainToggle: true,
      rows: [
        { key: 'mode', label: 'Blocking level', description: 'Standard blocks ads and trackers. Aggressive adds a stricter host-pattern fallback.' },
      ],
      keywords: ['adblock', 'ads', 'blocker', 'shields', 'tracker', 'tracking', 'easyprivacy', 'easylist', 'blocking level'],
    },
    httpsOnlyMode: {
      id: 'httpsOnlyMode',
      name: 'HTTPS-Only Mode',
      category: 'privacy',
      mainToggle: true,
      rows: [],
      keywords: ['https', 'http', 'secure', 'upgrade', 'insecure', 'encryption', 'ssl'],
    },
    webRtcProtection: {
      id: 'webRtcProtection',
      name: 'WebRTC Protection',
      category: 'privacy',
      mainToggle: true,
      rows: [],
      keywords: ['webrtc', 'web rtc', 'ip address', 'ip leak', 'udp'],
    },
    dnsOverHttps: {
      id: 'dnsOverHttps',
      name: 'Secure DNS',
      category: 'privacy',
      mainToggle: true,
      rows: [
        { key: 'provider', label: 'DNS provider', description: 'Which encrypted DNS resolver to use. Falls back to system DNS automatically.' },
        { key: 'customUrl', label: 'Custom DNS URL', description: 'Only used when Provider is set to a custom URL.' },
      ],
      keywords: ['doh', 'dns', 'secure dns', 'dns over https', 'cloudflare', 'quad9', 'nextdns', 'encrypted dns', 'resolver'],
    },
    siteBlocker: {
      id: 'siteBlocker',
      name: 'Site Blocker',
      category: 'security',
      rows: [],
      keywords: ['block', 'sites', 'blocked sites', 'blocklist', 'website', 'blocked', 'pattern'],
    },
    downloadLocation: {
      id: 'downloadLocation',
      name: 'Downloads',
      category: 'downloads',
      rows: [],
      keywords: ['download', 'downloads', 'download location', 'downloads folder', 'save to', 'directory', 'save path', 'default downloads folder', 'reset to default', 'open download folder'],
    },
  };

  // ── DOM REFS ───────────────────────────────────────────────
  const els = {
    search: document.getElementById('settings-search'),
    nav: document.getElementById('nav'),
    main: document.querySelector('.main'),
    pageTitle: document.getElementById('page-title'),
    pageSubtitle: document.getElementById('page-subtitle'),
    modalOverlay: document.getElementById('modal-overlay'),
    modalTitle: document.getElementById('modal-title'),
    modalText: document.getElementById('modal-text'),
    modalTextareaLabel: document.getElementById('modal-textarea-label'),
    modalTextarea: document.getElementById('modal-textarea'),
    modalCancel: document.getElementById('modal-cancel'),
    modalConfirm: document.getElementById('modal-confirm'),
    toast: document.getElementById('toast'),
  };

  // ── STATE ──────────────────────────────────────────────────
  let snapshot = { registry: [], state: {} };
  let activeCategory = 'appearance';
  let searchQuery = '';
  let searchIndex = null;
  let lastMatches = [];
  let modal = null;
  let toastTimer = null;
  let downloadLocation = { path: '', isDefault: true };

  // ── HELPERS ─────────────────────────────────────────────────
  function runtime(featureId) {
    return (snapshot.state && snapshot.state[featureId]) || { enabled: false, settings: {} };
  }

  function sanitize(str) {
    const d = document.createElement('div');
    d.textContent = str == null ? '' : String(str);
    return d.innerHTML;
  }

  function applyTheme() {
    const mode = runtime('themeSystem').settings.mode;
    const theme = mode === 'light' ? 'light' : 'dark';
    if (document.body.dataset.theme === theme) return;
    // Animate the flip: while the theme-switching class is present every
    // element transitions its theme-dependent properties (220ms, see
    // settings.html). The class is dropped after ~300ms, which also snaps any
    // transition Chromium froze in a hidden/occluded window to the new theme
    // values, so stale colors are impossible.
    document.body.classList.add('theme-switching');
    void document.body.offsetHeight; // recalc so the transition rule is active before values change
    document.body.dataset.theme = theme;
    setTimeout(() => document.body.classList.remove('theme-switching'), 300);
  }

  // ── CATEGORY VIEW ───────────────────────────────────────────
  function setCategory(catId) {
    if (!CATEGORIES.some((c) => c.id === catId)) catId = CATEGORIES[0].id;
    activeCategory = catId;
    if (searchQuery) {
      searchQuery = '';
      els.search.value = '';
    }
    renderCategory();
  }

  function renderCategory() {
    const cat = CATEGORIES.find((c) => c.id === activeCategory) || CATEGORIES[0];
    activeCategory = cat.id;
    els.pageTitle.textContent = cat.label;
    els.pageSubtitle.textContent = cat.description;

    // Sidebar active state
    for (const item of els.nav.querySelectorAll('.nav-item')) {
      const active = item.dataset.cat === activeCategory;
      item.classList.toggle('active', active);
      if (active) item.setAttribute('aria-current', 'page');
      else item.removeAttribute('aria-current');
    }

    // Show only this category's sections (all design markup stays in the DOM)
    for (const section of document.querySelectorAll('.main > .section')) {
      section.hidden = section.dataset.cat !== activeCategory;
      // clear any leftover search-state on rows
      for (const row of section.querySelectorAll(':scope > .card > .row, :scope > .card > .nested > .row, :scope > .card.advanced-card > .action')) {
        row.hidden = false;
        row.classList.remove('is-match', 'flash');
      }
    }

    els.main.scrollTop = 0;
    applyControls();
  }

  // ── CONTROLS: reflect snapshot into the static DOM ──────────
  function applyControls() {
    // Segmented controls
	    for (const seg of document.querySelectorAll('.segment[data-setting]')) {
      const def = runtime(seg.dataset.feature);
      seg.classList.toggle('selected', String(seg.dataset.value) === String(def.settings[seg.dataset.setting]));
    }
    // Switches
    for (const sw of document.querySelectorAll('.switch[data-feature]')) {
      const on = !!runtime(sw.dataset.feature).enabled;
      sw.setAttribute('aria-checked', String(on));
      sw.classList.toggle('is-off', !on);
      sw.setAttribute('aria-label', on ? 'On' : 'Off');
    }
    // Selects
    for (const sel of document.querySelectorAll('select[data-setting]')) {
      const def = runtime(sel.dataset.feature);
      const str = String(def.settings[sel.dataset.setting] == null ? '' : def.settings[sel.dataset.setting]);
      if (sel.value !== str) sel.value = str;
    }
    // Custom DNS URL input
    const urlInput = document.querySelector('input[data-setting="customUrl"]');
    if (urlInput) {
      const v = runtime('dnsOverHttps').settings.customUrl;
      const str = String(v == null ? '' : v);
      if (urlInput.value !== str) urlInput.value = str;
    }
    // DNS nested rows: custom URL row only when provider === 'custom'
    const dnsProvider = String(runtime('dnsOverHttps').settings.provider);
    for (const row of document.querySelectorAll('[data-dns-row]')) {
      row.hidden = row.dataset.dnsRow === 'customUrl' ? dnsProvider !== 'custom' : false;
    }
    // Dependent rows dim when their feature master is off
    const adOn = !!runtime('adBlocker').enabled;
    const modeRow = document.querySelector('select[data-setting="mode"]');
    if (modeRow && modeRow.closest('.row')) modeRow.closest('.row').classList.toggle('is-dimmed', !adOn);
    const dnsOn = !!runtime('dnsOverHttps').enabled;
	    for (const row of document.querySelectorAll('[data-dns-row]')) {
	      row.classList.toggle('is-dimmed', !dnsOn);
	    }
	    applySideRailControls();
	    applyDownloadLocation();
    applyTheme();
	  }

	  function applySideRailControls() {
	    const state = runtime('sideRail');
	    const settings = state.settings || {};
	    const customSites = document.querySelector('input[data-feature="sideRail"][data-setting="showCustomSites"]');
	    if (customSites) customSites.checked = settings.showCustomSites !== false;
	    const list = document.getElementById('side-rail-button-list');
	    if (!list) return;
	    const labels = { home: 'Home', bookmarks: 'Bookmarks', history: 'History', downloads: 'Downloads', settings: 'Settings' };
	    const fallback = ['home', 'bookmarks', 'history', 'downloads', 'settings'];
	    const order = [...(Array.isArray(settings.order) ? settings.order : fallback), ...fallback].filter((id, i, ids) => labels[id] && ids.indexOf(id) === i);
	    const visible = new Set(Array.isArray(settings.visibleItems) ? settings.visibleItems : fallback);
	    list.innerHTML = order.map((id, index) => `<div class="side-rail-order-row"><label><input type="checkbox" data-side-rail-item="${id}" ${visible.has(id) ? 'checked' : ''}> <span>${labels[id]}</span></label><span class="side-rail-order-actions"><button type="button" data-side-rail-move="up" data-side-rail-item="${id}" aria-label="Move ${labels[id]} up" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-side-rail-move="down" data-side-rail-item="${id}" aria-label="Move ${labels[id]} down" ${index === order.length - 1 ? 'disabled' : ''}>↓</button></span></div>`).join('');
	  }

  // Downloads location row: path + Default/Custom indicator.
  function applyDownloadLocation() {
    const pathInput = document.getElementById('downloads-location-path');
    const note = document.getElementById('downloads-location-note');
    const badge = document.getElementById('downloads-location-badge');
    if (pathInput) {
      pathInput.value = downloadLocation.path || '';
      pathInput.title = downloadLocation.path || '';
    }
    if (badge) {
      badge.textContent = downloadLocation.isDefault ? 'Default' : 'Custom';
      badge.classList.toggle('is-custom', !downloadLocation.isDefault);
    }
    if (note) {
      note.textContent = downloadLocation.isDefault
        ? 'Default location \u2014 your system Downloads folder.'
        : 'Custom location \u2014 downloads save here automatically.';
    }
  }

  function refreshDownloadLocation() {
    kairon.getDownloadsLocation()
      .then((loc) => {
        if (loc && typeof loc.path === 'string') {
          downloadLocation = loc;
          applyDownloadLocation();
        }
      })
      .catch(() => {});
  }

  // ── SEARCH ──────────────────────────────────────────────────
  function buildSearchIndex() {
    const entries = [];
    for (const def of Object.values(FEATURES)) {
      const base = [def.id, def.name, def.description || ''].concat(def.keywords || []).join(' ').toLowerCase();
      entries.push({
        featureId: def.id,
        rowKey: null,
        category: def.category,
        featureName: def.name,
        rowLabel: def.name,
        text: base,
      });
      for (const row of def.rows || []) {
        entries.push({
          featureId: def.id,
          rowKey: row.key,
          category: def.category,
          featureName: def.name,
          rowLabel: row.label,
          text: (base + ' ' + row.label + ' ' + row.description).toLowerCase(),
        });
      }
    }
    // Downloads actions
    entries.push({ featureId: 'downloadLocation', rowKey: 'openFolder', category: 'downloads', featureName: 'Downloads', rowLabel: 'Open download folder', text: 'open download folder show in explorer find saved files'.toLowerCase() });
    entries.push({ featureId: 'downloadLocation', rowKey: 'resetLocation', category: 'downloads', featureName: 'Downloads', rowLabel: 'Reset to default', text: 'reset download location default system downloads folder'.toLowerCase() });

    // Advanced utilities
    entries.push({ featureId: '__advanced', rowKey: 'export', category: 'advanced', featureName: 'Advanced', rowLabel: 'Export settings', text: 'export settings save json backup file'.toLowerCase() });
    entries.push({ featureId: '__advanced', rowKey: 'import', category: 'advanced', featureName: 'Advanced', rowLabel: 'Import settings', text: 'import settings load json restore file'.toLowerCase() });
    entries.push({ featureId: '__advanced', rowKey: 'reset', category: 'advanced', featureName: 'Advanced', rowLabel: 'Reset all settings', text: 'reset all settings restore defaults factory'.toLowerCase() });
    return entries;
  }

  // Map a (featureId, rowKey) search hit to its DOM row.
  function rowElFor(featureId, rowKey) {
    const by = (sel) => { const el = document.querySelector(sel); return el ? (el.closest('.row') || el) : null; };
	    if (featureId === 'themeSystem') return by('.segment[data-feature="themeSystem"][data-setting="' + rowKey + '"]');
	    if (featureId === 'sideRail') {
	      if (rowKey === null) return by('.switch[data-feature="sideRail"]');
	      return by('[data-feature="sideRail"][data-setting="' + rowKey + '"]');
	    }
    if (featureId === 'adBlocker') {
      if (rowKey === null) return by('.switch[data-feature="adBlocker"]');
      return by('select[data-feature="adBlocker"][data-setting="' + rowKey + '"]');
    }
    if (featureId === 'httpsOnlyMode') return by('.switch[data-feature="httpsOnlyMode"]');
    if (featureId === 'webRtcProtection') return by('.switch[data-feature="webRtcProtection"]');
    if (featureId === 'dnsOverHttps') {
      if (rowKey === null) return by('.switch[data-feature="dnsOverHttps"]');
      return by('[data-feature="dnsOverHttps"][data-setting="' + rowKey + '"]');
    }
    if (featureId === 'siteBlocker') return by('[data-action="site-blocker"]');
    if (featureId === 'downloadLocation') {
      if (rowKey === 'openFolder') {
        const btn = document.getElementById('downloads-open-folder');
        return btn ? btn.closest('.row') : null;
      }
      if (rowKey === 'resetLocation') {
        const btn = document.getElementById('downloads-reset');
        return btn ? btn.closest('.row') : null;
      }
      const el = document.getElementById('downloads-location-path');
      return el ? el.closest('.row') : null;
    }
    if (featureId === '__advanced') return document.querySelector('.action[data-action="' + rowKey + '"]');
    return null;
  }

  function renderSearch() {
    const q = searchQuery.trim().toLowerCase();
    if (!q) { renderCategory(); return; }
    if (!searchIndex) searchIndex = buildSearchIndex();
    const matches = searchIndex.filter((e) => e.text.includes(q));
    lastMatches = matches;

    els.pageTitle.textContent = 'Search';
    els.pageSubtitle.textContent = matches.length + ' result' + (matches.length === 1 ? '' : 's') + ' for \u201c' + sanitize(searchQuery.trim()) + '\u201d';

    const matchedEls = new Set();
    for (const m of matches) {
      const el = rowElFor(m.featureId, m.rowKey);
      if (el) matchedEls.add(el);
    }

    // Show every section that has a match; hide non-matching rows inside it.
    for (const section of document.querySelectorAll('.main > .section')) {
      let any = false;
      const rows = section.querySelectorAll(':scope > .card > .row, :scope > .card > .nested > .row, :scope > .card.advanced-card > .action');
      for (const row of rows) {
        const hit = matchedEls.has(row);
        row.hidden = !hit;
        row.classList.toggle('is-match', hit);
        if (hit) any = true;
      }
      section.hidden = !any;
    }
    els.main.scrollTop = 0;
  }

  function clearSearch() {
    searchQuery = '';
    els.search.value = '';
    renderCategory();
  }

  function navigateToMatch(m) {
    searchQuery = '';
    els.search.value = '';
    setCategory(m.category);
    const el = rowElFor(m.featureId, m.rowKey);
    if (el) {
      setTimeout(() => {
        const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        el.scrollIntoView({ block: 'center', behavior: reduceMotion ? 'auto' : 'smooth' });
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      }, 40);
    }
  }

  // ── MODAL ───────────────────────────────────────────────────
  function openModal(opts) {
    modal = opts || {};
    els.modalTitle.textContent = modal.title || '';
    els.modalText.hidden = !modal.text;
    els.modalText.textContent = modal.text || '';
    els.modalTextareaLabel.hidden = !modal.textareaLabel;
    els.modalTextareaLabel.textContent = modal.textareaLabel || '';
    els.modalTextarea.hidden = !modal.textareaLabel;
    els.modalTextarea.value = modal.textareaValue || '';
    els.modalConfirm.textContent = modal.confirmLabel || 'Confirm';
    els.modalConfirm.className = 'modal-btn modal-btn-solid' + (modal.danger ? ' btn-danger' : '');
    els.modalOverlay.hidden = false;
    // Synchronous reflow so the fade-in starts from the base state even in
    // hidden/backgrounded tabs (rAF is unreliable there).
    void els.modalOverlay.offsetHeight;
    els.modalOverlay.classList.add('open');
    if (modal.textareaLabel) els.modalTextarea.focus();
    else els.modalCancel.focus();
  }

  function closeModal() {
    els.modalOverlay.classList.remove('open');
    els.modalOverlay.hidden = true;
    modal = null;
  }

  function cancelModal() {
    if (modal && modal.onCancel) modal.onCancel();
    closeModal();
  }

  async function confirmModal() {
    if (!modal) { closeModal(); return; }
    let keepOpen = false;
    try {
      const result = modal.onConfirm ? await modal.onConfirm() : false;
      keepOpen = result === true;
    } catch (err) {
      showToast('Something went wrong');
    }
    if (!keepOpen) closeModal();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Copied to clipboard');
    } catch (err) {
      try {
        els.modalTextarea.select();
        document.execCommand('copy');
        showToast('Copied to clipboard');
      } catch (err2) {
        showToast('Select the text and copy manually');
      }
    }
    return false;
  }

  // ── TOAST ───────────────────────────────────────────────────
  function showToast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    void els.toast.offsetHeight;
    els.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove('show');
      els.toast.hidden = true;
    }, 2200);
  }

  // ── ACTION HANDLERS ─────────────────────────────────────────
  function openSiteBlocker() {
    const rt = runtime('siteBlocker');
    const items = Array.isArray(rt.settings.blockedSites) ? rt.settings.blockedSites : [];
    openModal({
      title: 'Blocked sites',
      text: 'One site or pattern per line. Patterns like *.example.com are supported.',
      textareaLabel: 'Blocked sites',
      textareaValue: items.join('\n'),
      confirmLabel: 'Save',
      onConfirm: () => {
        const list = els.modalTextarea.value.split('\n').map((s) => s.trim()).filter(Boolean);
        kairon.updateFeatureConfig('siteBlocker', { blockedSites: list })
          .then(() => showToast('Blocked sites saved'))
          .catch(() => showToast('Save failed'));
        return false;
      },
    });
  }

  function openExport() {
    kairon.exportSettings()
      .then((json) => {
        openModal({
          title: 'Export settings',
          textareaLabel: 'Settings JSON',
          textareaValue: json,
          confirmLabel: 'Copy to clipboard',
          onConfirm: () => copyText(els.modalTextarea.value),
        });
      })
      .catch(() => showToast('Export failed'));
  }

  function openImport() {
    openModal({
      title: 'Import settings',
      textareaLabel: 'Paste settings JSON',
      textareaValue: '',
      confirmLabel: 'Import',
      onConfirm: () => {
        const raw = els.modalTextarea.value.trim();
        if (!raw) { showToast('Paste settings JSON first'); return true; }
        try { JSON.parse(raw); } catch (err) { showToast('Invalid JSON \u2014 check your input'); return true; }
        kairon.importSettings(raw)
          .then(() => { showToast('Settings imported'); refreshDownloadLocation(); })
          .catch(() => showToast('Import failed'));
        return false;
      },
    });
  }

  function openReset() {
    openModal({
      title: 'Reset all settings?',
      text: 'Every setting will be restored to its default value. This cannot be undone.',
      confirmLabel: 'Reset all',
      danger: true,
      onConfirm: () => {
        kairon.resetAllSettings()
          .then(() => { showToast('All settings reset'); refreshDownloadLocation(); })
          .catch(() => showToast('Reset failed'));
        return false;
      },
    });
  }

  function openDnsRestartModal(apply) {
    openModal({
      title: 'Restart Kairon to apply your DNS setting?',
      text: 'Secure DNS is configured at startup through Chromium. Your choice takes effect after Kairon restarts.',
      confirmLabel: 'Restart now',
      onConfirm: () => {
        apply()
          .then(() => kairon.restartApp())
          .catch((err) => { kairon.logError('dns-restart', String(err && (err.stack || err.message) || err)).catch(() => {}); });
        return false;
      },
      onCancel: null, // revert handled by caller via els passed below
    });
  }

  // ── EVENT BINDING ───────────────────────────────────────────
  function bindEvents() {
    const activate = (el) => el.dispatchEvent(new Event('click', { bubbles: true }));

    // Sidebar navigation
    for (const item of els.nav.querySelectorAll('.nav-item')) {
      item.addEventListener('click', () => setCategory(item.dataset.cat));
      item.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCategory(item.dataset.cat); } });
    }

    // Segmented controls (theme mode / tab position)
    for (const seg of document.querySelectorAll('.segment[data-setting]')) {
      const onClick = () => {
        seg.parentElement.querySelectorAll('.segment').forEach((s) => s.classList.remove('selected'));
        seg.classList.add('selected');
        const patch = {};
        patch[seg.dataset.setting] = seg.dataset.value;
        // Optimistically flip the local snapshot so applyControls() (called on
        // category switches / search / live-sync renders) keeps reflecting the
        // new value instead of reverting. The main process excludes the sender
        // from settings-updated push-back, so without this the UI would snap
        // back to the old state even though the store changed.
        const featureId = seg.dataset.feature;
        if (snapshot.state && snapshot.state[featureId] && snapshot.state[featureId].settings) {
          snapshot.state[featureId].settings[seg.dataset.setting] = seg.dataset.value;
        }
        kairon.updateFeatureConfig(featureId, patch)
          .catch((err) => kairon.logError('settings-page-segment', String(err && (err.message || err) || err)).catch(() => {}));
        if (featureId === 'themeSystem' && seg.dataset.setting === 'mode') {
          applyTheme();
        }
      };
      seg.addEventListener('click', onClick);
      seg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
	    }

	    const sideRailSites = document.querySelector('input[data-feature="sideRail"][data-setting="showCustomSites"]');
	    sideRailSites?.addEventListener('change', () => {
	      const value = sideRailSites.checked;
	      if (snapshot.state?.sideRail?.settings) snapshot.state.sideRail.settings.showCustomSites = value;
	      kairon.updateFeatureConfig('sideRail', { showCustomSites: value }).catch((err) => kairon.logError('settings-page-side-rail-sites', String(err && (err.message || err) || err)).catch(() => {}));
	    });

	    const sideRailList = document.getElementById('side-rail-button-list');
	    sideRailList?.addEventListener('change', (event) => {
	      const input = event.target.closest('[data-side-rail-item]');
	      if (!input) return;
	      const current = Array.isArray(snapshot.state?.sideRail?.settings?.visibleItems) ? snapshot.state.sideRail.settings.visibleItems : ['home', 'bookmarks', 'history', 'downloads', 'settings'];
	      const visibleItems = input.checked ? [...new Set([...current, input.dataset.sideRailItem])] : current.filter((id) => id !== input.dataset.sideRailItem);
	      if (snapshot.state?.sideRail?.settings) snapshot.state.sideRail.settings.visibleItems = visibleItems;
	      kairon.updateFeatureConfig('sideRail', { visibleItems }).catch((err) => kairon.logError('settings-page-side-rail-visibility', String(err && (err.message || err) || err)).catch(() => {}));
	    });
    sideRailList?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-side-rail-move]');
      if (!button) return;
      const fallback = ['home', 'bookmarks', 'history', 'downloads', 'settings'];
      const order = [...(snapshot.state?.sideRail?.settings?.order || fallback)];
      const index = order.indexOf(button.dataset.sideRailItem);
      const next = index + (button.dataset.sideRailMove === 'up' ? -1 : 1);
      if (index < 0 || next < 0 || next >= order.length) return;
      [order[index], order[next]] = [order[next], order[index]];
      if (snapshot.state?.sideRail?.settings) snapshot.state.sideRail.settings.order = order;
      kairon.updateFeatureConfig('sideRail', { order }).catch((err) => kairon.logError('settings-page-side-rail-order', String(err && (err.message || err) || err)).catch(() => {}));
      applySideRailControls();
    });

	    // Master switches
    for (const sw of document.querySelectorAll('.switch[data-feature]')) {
      const onClick = () => {
        const on = sw.getAttribute('aria-checked') !== 'true';
        sw.setAttribute('aria-checked', String(on));
        sw.classList.toggle('is-off', !on);
        sw.setAttribute('aria-label', on ? 'On' : 'Off');
        const featureId = sw.dataset.feature;
        // Optimistically flip the local snapshot so applyControls() (called
        // below and by any pending render) reflects the new state instead of
        // re-rendering the stale value. The main process excludes the sender
        // from settings-updated push-back, so without this the UI would snap
        // back to the old state even though the store changed.
        if (snapshot.state && snapshot.state[featureId]) {
          snapshot.state[featureId].enabled = on;
        }
        if (on) kairon.enableFeature(featureId);
        else kairon.disableFeature(featureId);
        // Keep dependent rows consistent (dimmed) until the live snapshot lands.
        applyControls();
      };
      sw.addEventListener('click', onClick);
      sw.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } });
    }

    // Blocking level (adBlocker.mode) — applied immediately, no restart
    const modeSelect = document.querySelector('select[data-setting="mode"]');
    if (modeSelect) {
      modeSelect.addEventListener('change', () => {
        kairon.updateFeatureConfig('adBlocker', { mode: modeSelect.value })
          .catch((err) => kairon.logError('settings-page-mode', String(err && (err.message || err) || err)).catch(() => {}));
      });
    }

    // DNS provider — restart flow
    const dnsSelect = document.querySelector('select[data-setting="provider"]');
    if (dnsSelect) {
      dnsSelect.addEventListener('focus', () => { dnsSelect.dataset.prev = dnsSelect.value; });
      dnsSelect.addEventListener('change', () => {
        const value = dnsSelect.value;
        const prev = dnsSelect.dataset.prev != null ? dnsSelect.dataset.prev : '';
        if (value === prev) return;
        openModal({
          title: 'Restart Kairon to apply your DNS setting?',
          text: 'Secure DNS is configured at startup through Chromium. Your choice takes effect after Kairon restarts.',
          confirmLabel: 'Restart now',
          onConfirm: () => {
            kairon.updateFeatureConfig('dnsOverHttps', { provider: value })
              .then(() => kairon.restartApp())
              .catch((err) => { kairon.logError('dns-restart', String(err && (err.stack || err.message) || err)).catch(() => {}); });
            return false;
          },
          onCancel: () => {
            dnsSelect.value = prev;
            applyControls();
          },
        });
      });
    }

    // Custom DNS URL — restart flow
    const dnsUrl = document.querySelector('input[data-setting="customUrl"]');
    if (dnsUrl) {
      dnsUrl.addEventListener('focus', () => { dnsUrl.dataset.prev = dnsUrl.value; });
      dnsUrl.addEventListener('change', () => {
        const value = dnsUrl.value;
        const prev = dnsUrl.dataset.prev != null ? dnsUrl.dataset.prev : '';
        if (value === prev) return;
        openModal({
          title: 'Restart Kairon to apply your DNS setting?',
          text: 'Secure DNS is configured at startup through Chromium. Your choice takes effect after Kairon restarts.',
          confirmLabel: 'Restart now',
          onConfirm: () => {
            kairon.updateFeatureConfig('dnsOverHttps', { customUrl: value })
              .then(() => kairon.restartApp())
              .catch((err) => { kairon.logError('dns-restart', String(err && (err.stack || err.message) || err)).catch(() => {}); });
            return false;
          },
          onCancel: () => {
            dnsUrl.value = prev;
          },
        });
      });
    }

    // Site Blocker editor
    const sbRow = document.querySelector('[data-action="site-blocker"]');
    if (sbRow) {
      sbRow.addEventListener('click', openSiteBlocker);
      sbRow.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSiteBlocker(); } });
    }

    // Downloads location — Change opens the native folder picker (only on
    // explicit user action); Open folder / Reset affect the stored location.
    const changeBtn = document.getElementById('downloads-change');
    if (changeBtn) {
      const onChange = async () => {
        try {
          const info = await kairon.chooseDownloadsLocation();
          if (info && typeof info.path === 'string') {
            downloadLocation = info;
            applyDownloadLocation();
            showToast('Future downloads will be saved to the new folder');
          }
        } catch (err) {
          kairon.logError('settings-page-downloads-change', String(err && (err.stack || err.message) || err)).catch(() => {});
        }
      };
      changeBtn.addEventListener('click', onChange);
      changeBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(); } });
    }

    const openFolderBtn = document.getElementById('downloads-open-folder');
    if (openFolderBtn) {
      const onOpen = () => {
        kairon.openDownloadsFolder().catch((err) =>
          kairon.logError('settings-page-downloads-open', String(err && (err.stack || err.message) || err)).catch(() => {}));
      };
      openFolderBtn.addEventListener('click', onOpen);
      openFolderBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } });
    }

    const resetBtn = document.getElementById('downloads-reset');
    if (resetBtn) {
      const onReset = async () => {
        try {
          const info = await kairon.resetDownloadsLocation();
          if (info && typeof info.path === 'string') {
            downloadLocation = info;
            applyDownloadLocation();
            showToast('Downloads will be saved to your default folder');
          }
        } catch (err) {
          kairon.logError('settings-page-downloads-reset', String(err && (err.stack || err.message) || err)).catch(() => {});
        }
      };
      resetBtn.addEventListener('click', onReset);
      resetBtn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onReset(); } });
    }

    // Advanced actions
    const actionHandlers = { export: openExport, import: openImport, reset: openReset };
    for (const action of document.querySelectorAll('.action[data-action]')) {
      const handler = actionHandlers[action.dataset.action];
      if (!handler) continue;
      action.addEventListener('click', handler);
      action.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
    }

    // Search
    let searchTimer = null;
    els.search.addEventListener('input', () => {
      searchQuery = els.search.value;
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(renderSearch, 90);
    });
    els.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (lastMatches.length) navigateToMatch(lastMatches[0]);
      }
    });

    // Modal
    els.modalCancel.addEventListener('click', cancelModal);
    els.modalConfirm.addEventListener('click', confirmModal);
    els.modalOverlay.addEventListener('click', (e) => { if (e.target === els.modalOverlay) cancelModal(); });

    // Global keys: Ctrl/Cmd+F focuses search; Escape closes modal / clears search
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        els.search.focus();
        els.search.select();
        return;
      }
      if (e.key === 'Escape') {
        if (modal) { cancelModal(); return; }
        if (searchQuery) { clearSearch(); els.search.focus(); }
      }
    });
  }

  // ── ERROR CAPTURE ───────────────────────────────────────────
  window.addEventListener('error', (event) => {
    const msg = (event.error && (event.error.stack || event.error.message)) || event.message || 'Unknown settings page error';
    kairon.logError('settings-page-error', String(msg)).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = (event.reason && (event.reason.stack || event.reason.message)) || String(event.reason || 'Unhandled rejection');
    kairon.logError('settings-page-rejection', String(reason)).catch(() => {});
  });

  // ── INIT ────────────────────────────────────────────────────
  async function init() {
    try {
      snapshot = await kairon.getSettingsState();
    } catch (err) {
      kairon.logError('settings-page-bootstrap', String(err && (err.stack || err.message) || err)).catch(() => {});
      snapshot = { registry: [], state: {} };
    }

    // Current downloads location (path + whether it is the system default).
    try {
      const loc = await kairon.getDownloadsLocation();
      if (loc && typeof loc.path === 'string') downloadLocation = loc;
    } catch (err) { /* non-fatal; keep defaults */ }

    // Deep link: kairon://settings/<section> arrives as a query param set by
    // the main process via loadFile. Unknown sections fall back to the first
    // category — never a crash.
    const section = (new URLSearchParams(location.search).get('section') || '').toLowerCase();
    activeCategory = CATEGORIES.some((c) => c.id === section) ? section : CATEGORIES[0].id;

    bindEvents();
    renderCategory();

    // Live sync from the main process (trust follows the loaded URL).
    kairon.onSettingsUpdated((incoming) => {
      snapshot = incoming || snapshot;
      searchIndex = null;
      // The download location can change through other surfaces (e.g. Reset
      // all settings), so re-read it alongside the settings snapshot.
      refreshDownloadLocation();
      if (searchQuery.trim()) renderSearch();
      else renderCategory();
    });
  }

  init();
})();
