// Diagnostic logging is gated so the overlay performs no unnecessary console
// output (or forced-layout measurement) in production.
const OVERLAY_DIAG = false;

const suggestions = document.getElementById('address-suggestions');

function renderSuggestions({ items, rect, selectedIndex = -1 }) {
  if (!suggestions) return;

  suggestions.innerHTML = '';
  const top = Math.round(rect.bottom);
  const left = Math.round(rect.left);
  const width = Math.round(rect.width);

  if (OVERLAY_DIAG) {
    console.info('[OVERLAY-DIAG] renderSuggestions rect from payload:', JSON.stringify(rect));
    console.info('[OVERLAY-DIAG] applying suggestions style:', { top, left, width });
  }

  suggestions.style.top = `${top}px`;
  suggestions.style.left = `${left}px`;
  suggestions.style.width = `${width}px`;
  suggestions.style.maxWidth = `${width}px`;
  suggestions.style.right = 'auto';
  suggestions.style.boxSizing = 'border-box';

  // After render, measure actual position (diagnostic only — avoids a forced
  // layout read in production)
  if (OVERLAY_DIAG) {
    requestAnimationFrame(() => {
      const actualRect = suggestions.getBoundingClientRect();
      console.info('[OVERLAY-DIAG] suggestions actual getBoundingClientRect after render:', JSON.stringify({
        left: Math.round(actualRect.left),
        right: Math.round(actualRect.right),
        top: Math.round(actualRect.top),
        bottom: Math.round(actualRect.bottom),
        width: Math.round(actualRect.width),
      }));
      console.info('[OVERLAY-DIAG] overlay window info:', {
        devicePixelRatio: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      });
    });
  }

  items.forEach((value, index) => {
    const btn = document.createElement('button');
    btn.className = 'address-suggestion-item';
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    if (index === selectedIndex) btn.setAttribute('aria-selected', 'true');

    const isSearch = index === items.length - 1 && value.includes('search.brave.com');
    let displayText = value;
    let iconElement;

    if (isSearch) {
      try {
        const url = new URL(value);
        const query = url.searchParams.get('q');
        if (query) {
          displayText = decodeURIComponent(query);
        }
      } catch {}
      // Search rows carry a secondary text color that follows the global theme.
      btn.classList.add('address-suggestion-search');
      iconElement = `<img src="https://brave.com/favicon.ico" width="16" height="16" style="flex-shrink:0">`;
    } else {
      // The globe icon uses currentColor (theme text) with a theme-driven opacity.
      iconElement = `<svg width="11" height="11" viewBox="0 0 12 12" fill="none" style="flex-shrink:0;opacity:var(--sugg-icon-opacity)">
          <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/>
          <path d="M1 6h10M6 1C4.5 3 4.5 9 6 11M6 1c1.5 2 1.5 8 0 10" stroke="currentColor" stroke-width="1.2"/>
         </svg>`;
    }

    btn.innerHTML = `
      <span>
        ${iconElement}
        <span style="text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${sanitizeText(displayText)}</span>
      </span>`;

    btn.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      window.kairon.navigateToSuggestion(value);
    });

    suggestions.appendChild(btn);
  });

  if (items.length) suggestions.style.display = 'block';
  else suggestions.style.display = 'none';
}

function sanitizeText(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

window.kairon.on('overlay-suggestions', (payload) => {
  if (!payload || !payload.items) return;
  renderSuggestions(payload);
});

window.kairon.on('overlay-hide', () => {
  suggestions.innerHTML = '';
  suggestions.style.display = 'none';
  suggestions.style.right = '';
  suggestions.style.maxWidth = '';
  suggestions.style.boxSizing = '';
});

// ══════════════════════════════════════════════════════════════
//  DOWNLOADS PANEL — rendered by the overlay window so it always
//  paints above BrowserView content. Anchored by the main renderer.
// ══════════════════════════════════════════════════════════════

const downloadsPanel    = document.getElementById('downloads-panel');
const downloadsList     = document.getElementById('downloads-panel-list');
const downloadsMenuBtn  = document.getElementById('downloads-menu-btn');
const downloadsMenu     = document.getElementById('downloads-menu');
const downloadsMenuWrap = document.getElementById('downloads-menu-wrap');
const downloadsClearBtn = document.getElementById('downloads-clear-btn');
const downloadsShowMore = document.getElementById('downloads-show-more-btn');

let downloadsCache = [];
let downloadsPanelVisible = false;

// ── ICONS / FORMATTING ──────────────────────────────────────

const DL_ICONS = {
  document: `<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M3.5 1.5h5.2L12 4.8v8.7H3.5z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M8.5 1.8v3.2h3.2M5.5 8h4M5.5 10.2h4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`,
  archive: `<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><rect x="2.5" y="5" width="10" height="8" rx="1.2" stroke="currentColor" stroke-width="1.1"/><path d="M4.5 5V3.5h6V5M5 3.5l1.2 2.2M7.5 3.5l1.2 2.2M10 3.5l1.2 2.2" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/></svg>`,
  image: `<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><rect x="2.5" y="2.5" width="10" height="10" rx="1.5" stroke="currentColor" stroke-width="1.1"/><circle cx="5.6" cy="5.6" r="1" stroke="currentColor" stroke-width="1.1"/><path d="M4 10.5l2.6-2.6 2 2 2.4-2.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  video: `<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><rect x="2.5" y="3" width="10" height="9" rx="1.5" stroke="currentColor" stroke-width="1.1"/><path d="M6.2 5.7l2.9 1.8-2.9 1.8z" fill="currentColor"/></svg>`,
  audio: `<svg width="15" height="15" viewBox="0 0 15 15" fill="none"><path d="M4.5 10.5V4.2L10.5 2.8v6.4" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/><circle cx="3.5" cy="10.5" r="1.4" stroke="currentColor" stroke-width="1.1"/><circle cx="9.5" cy="9.2" r="1.4" stroke="currentColor" stroke-width="1.1"/></svg>`,
};

const ICON_PAUSE = `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M3.2 1.8v7.4M7.8 1.8v7.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`;
const ICON_RESUME = `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M3 1.8l6 3.7-6 3.7z" fill="currentColor"/></svg>`;
const ICON_CANCEL = `<svg width="11" height="11" viewBox="0 0 11 11" fill="none"><path d="M2 2l7 7M9 2L2 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`;
const ICON_FOLDER = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M1.5 2.5h3l1 1.2h5v5.8h-9z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/></svg>`;

function dlFileKind(d) {
  const filename = d.filename || '';
  const ext = filename.includes('.') ? filename.split('.').pop().toLowerCase() : '';
  const mime = (d.mimeType || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'tgz', 'iso'].includes(ext)) return 'archive';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'mpg', 'mpeg'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'opus'].includes(ext)) return 'audio';
  return 'document';
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function formatEta(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s left`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}m ${s}s left`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m left`;
}

function dlStatusText(d) {
  switch (d.state) {
    case 'downloading': {
      const total = d.totalBytes > 0 ? formatBytes(d.totalBytes) : 'unknown size';
      let s = `${formatBytes(d.receivedBytes || 0)} of ${total}`;
      if (d.speed > 0) s += ` · ${formatBytes(d.speed)}/s`;
      if (Number.isFinite(d.etaSeconds) && d.etaSeconds != null && d.totalBytes > 0) s += ` · ${formatEta(d.etaSeconds)}`;
      return s;
    }
    case 'paused':      return 'Paused';
    case 'completed':   return 'Download complete';
    case 'interrupted': return 'Interrupted — click to resume';
    case 'failed':      return 'Failed';
    case 'cancelled':   return 'Cancelled';
    default:            return '';
  }
}

function dlProgressPercent(d) {
  if (d.totalBytes > 0 && Number.isFinite(d.receivedBytes)) {
    return Math.min(100, Math.max(0, Math.round((d.receivedBytes / d.totalBytes) * 100)));
  }
  return 0;
}

function dlIsOpenable(d) {
  return !!(d.savePath && (d.state === 'completed' || d.state === 'interrupted' || d.state === 'failed' || d.state === 'cancelled'));
}

function dlIsActive(d) {
  return d.state === 'downloading' || d.state === 'paused' || d.state === 'interrupted';
}

// ── RENDERING ───────────────────────────────────────────────

function makeIconBtn(inner, label, action) {
  const btn = document.createElement('button');
  btn.className = 'dl-icon-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.innerHTML = inner;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    action();
  });
  return btn;
}

function buildDownloadRow(d) {
  const row = document.createElement('div');
  row.className = 'dl-row' + (dlIsOpenable(d) ? ' openable' : '');
  row.dataset.id = String(d.id);
  row.setAttribute('role', 'button');
  row.setAttribute('aria-label', d.filename || 'Download');
  row.tabIndex = -1;

  const icon = document.createElement('div');
  icon.className = 'dl-icon';
  icon.innerHTML = DL_ICONS[dlFileKind(d)] || DL_ICONS.document;

  const body = document.createElement('div');
  body.className = 'dl-body';

  const filename = document.createElement('div');
  filename.className = 'dl-filename';
  filename.textContent = d.filename || 'Unknown file';
  filename.title = d.filename || '';
  body.appendChild(filename);

  if (dlIsActive(d)) {
    const status = document.createElement('div');
    status.className = 'dl-status';
    status.textContent = dlStatusText(d);
    body.appendChild(status);
    if (d.state === 'downloading' || d.state === 'paused') {
      const bar = document.createElement('div');
      bar.className = 'dl-progress';
      const fill = document.createElement('div');
      fill.className = 'dl-progress-fill';
      fill.style.width = `${dlProgressPercent(d)}%`;
      bar.appendChild(fill);
      body.appendChild(bar);
    }
  } else {
    const status = document.createElement('div');
    status.className = 'dl-status' + (d.state === 'failed' ? ' failed' : '');
    status.textContent = dlStatusText(d);
    body.appendChild(status);
  }

  const actions = document.createElement('div');
  actions.className = 'dl-actions';
  if (d.state === 'downloading') {
    actions.appendChild(makeIconBtn(ICON_PAUSE, 'Pause download', () => window.kairon.pauseDownload(d.id)));
    actions.appendChild(makeIconBtn(ICON_CANCEL, 'Cancel download', () => window.kairon.cancelDownload(d.id)));
  } else if (d.state === 'paused' || d.state === 'interrupted') {
    actions.appendChild(makeIconBtn(ICON_RESUME, 'Resume download', () => window.kairon.resumeDownload(d.id)));
    actions.appendChild(makeIconBtn(ICON_CANCEL, 'Cancel download', () => window.kairon.cancelDownload(d.id)));
  } else if (d.savePath) {
    actions.appendChild(makeIconBtn(ICON_FOLDER, 'Show in folder', () => window.kairon.showDownloadInFolder(d.id)));
  }

  row.appendChild(icon);
  row.appendChild(body);
  row.appendChild(actions);

  row.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('.dl-actions')) return;
    if (dlIsOpenable(d)) window.kairon.openDownload(d.id);
  });

  return row;
}

function renderDownloadsPanel() {
  downloadsList.innerHTML = '';
  if (!downloadsCache.length) {
    const empty = document.createElement('div');
    empty.id = 'downloads-empty';
    empty.textContent = 'No downloads yet';
    downloadsList.appendChild(empty);
    return;
  }
  for (const d of downloadsCache) downloadsList.appendChild(buildDownloadRow(d));
}

function focusFirstDownloadRow() {
  const rows = downloadsList.querySelectorAll('.dl-row');
  if (rows.length) {
    rows[0].focus();
    return;
  }
  downloadsMenuBtn.focus();
}

function closeDownloadsMenu() {
  downloadsMenu.hidden = true;
  downloadsMenuBtn.setAttribute('aria-expanded', 'false');
}

function toggleDownloadsMenu() {
  const willOpen = downloadsMenu.hidden;
  downloadsMenu.hidden = !willOpen;
  downloadsMenuBtn.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) downloadsMenu.querySelector('button')?.focus();
}

// ── PANEL SHOW / HIDE ───────────────────────────────────────

function showDownloadsPanel() {
  downloadsPanelVisible = true;
  closeDownloadsMenu();
  downloadsPanel.hidden = false;
  renderDownloadsPanel();
  focusFirstDownloadRow();
  // Refresh from the authoritative store; live updates arrive via pushes.
  window.kairon.getDownloads().then((list) => {
    downloadsCache = Array.isArray(list) ? list : [];
    renderDownloadsPanel();
    // The initial render's focus target was just replaced — restore focus if
    // it was lost (and the user hasn't already moved somewhere in the panel).
    const active = document.activeElement;
    if (!active || active === document.body || !downloadsPanel.contains(active)) {
      focusFirstDownloadRow();
    }
  }).catch(() => {});
}

function hideDownloadsPanel() {
  const wasVisible = downloadsPanelVisible;
  downloadsPanelVisible = false;
  closeDownloadsMenu();
  downloadsPanel.hidden = true;
  // Tell main the popup is fully hidden so it can restore the overlay's
  // default bounds (never while the panel is still on screen).
  if (wasVisible) window.kairon.notifyPopupClosed();
}

window.kairon.on('downloads-panel-show', () => showDownloadsPanel());
window.kairon.on('downloads-panel-hide', () => hideDownloadsPanel());

window.kairon.onDownloadsUpdated((list) => {
  downloadsCache = Array.isArray(list) ? list : [];
  if (downloadsPanelVisible) renderDownloadsPanel();
});

// ── EVENTS ──────────────────────────────────────────────────

downloadsMenuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleDownloadsMenu();
});

downloadsMenu.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  closeDownloadsMenu();
  if (action === 'open-folder') window.kairon.openDownloadsFolder();
  else if (action === 'clear-completed') window.kairon.clearDownloads();
});

// A click anywhere else in the overlay closes the menu (the panel itself
// stays open — it fills the whole overlay window).
document.addEventListener('click', (e) => {
  if (downloadsMenu.hidden) return;
  if (downloadsMenuWrap.contains(e.target)) return;
  closeDownloadsMenu();
});

downloadsClearBtn.addEventListener('click', () => {
  window.kairon.clearDownloads();
});

downloadsShowMore.addEventListener('click', () => {
  // Open the full downloads page in the active tab (existing navigation).
  window.kairon.navigate('kairon://downloads');
  window.kairon.hideDownloadsPanel();
});

// Keyboard navigation: arrows move between rows, Enter/Space opens an
// openable row, Escape closes the menu first, then the panel.
downloadsList.addEventListener('keydown', (e) => {
  const rows = Array.from(downloadsList.querySelectorAll('.dl-row'));
  if (!rows.length) return;
  const idx = rows.indexOf(document.activeElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = idx + 1;
  else if (e.key === 'ArrowUp') next = idx - 1;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = rows.length - 1;
  else if (e.key === 'Enter' || e.key === ' ') {
    const el = document.activeElement;
    if (el && el.classList && el.classList.contains('dl-row') && el.classList.contains('openable')) {
      e.preventDefault();
      const id = Number(el.dataset.id);
      const record = downloadsCache.find((d) => d.id === id);
      if (record && dlIsOpenable(record)) window.kairon.openDownload(id);
    }
    return;
  }
  if (next >= 0 && next < rows.length) {
    e.preventDefault();
    rows[next].focus();
  }
});

// Escape closes whatever is open: the About dialog, then the app menu, then
// the downloads panel (its nested menu first, then the panel itself).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (aboutVisible) { window.kairon.hideAbout(); return; }
  if (appMenuVisible) { window.kairon.hideAppMenu(); return; }
  if (!downloadsPanelVisible) return;
  if (!downloadsMenu.hidden) {
    closeDownloadsMenu();
    downloadsMenuBtn.focus();
    return;
  }
  window.kairon.hideDownloadsPanel();
});

// ══════════════════════════════════════════════════════════════
//  APPLICATION MENU — rendered by the overlay window so it always
//  paints above BrowserView content. Anchored by the main renderer.
// ══════════════════════════════════════════════════════════════

const appMenu = document.getElementById('app-menu');
const amZoomValue = document.getElementById('am-zoom-value');
const amFullscreenLabel = document.getElementById('am-fullscreen-label');

const REDUCED_MOTION = typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let appMenuVisible = false;
let _appMenuHideTimer = null;

function showAppMenu(payload) {
  if (!appMenu) return;
  const state = (payload && payload.state) || {};

  // Adapt available actions to the live browser state.
  const backItem = appMenu.querySelector('[data-action="back"]');
  const fwdItem = appMenu.querySelector('[data-action="forward"]');
  if (backItem) backItem.disabled = !state.canGoBack;
  if (fwdItem) fwdItem.disabled = !state.canGoForward;
  if (amZoomValue) {
    const factor = typeof state.zoomFactor === 'number' ? state.zoomFactor : 1;
    amZoomValue.textContent = `${Math.round(factor * 100)}%`;
  }
  if (amFullscreenLabel) {
    amFullscreenLabel.textContent = state.isFullscreen ? 'Exit Fullscreen' : 'Enter Fullscreen';
  }

  clearTimeout(_appMenuHideTimer);
  appMenu.classList.remove('am-closing');
  appMenu.hidden = false;
  void appMenu.offsetHeight; // restart the enter animation on every open
  appMenuVisible = true;

  // Report the exact natural height so main can size the overlay to fit the
  // menu precisely (initial estimate may differ by a few px from font metrics).
  requestAnimationFrame(() => {
    if (!appMenuVisible) return;
    const prevHeight = appMenu.style.height;
    appMenu.style.height = 'auto';
    const h = appMenu.offsetHeight;
    appMenu.style.height = prevHeight || '';
    if (h > 0) window.kairon.sendAppMenuMeasure({ height: h });
  });

  const first = appMenu.querySelector('.am-item:not([disabled])');
  if (first) first.focus();
}

function hideAppMenu() {
  if (!appMenuVisible) return;
  appMenuVisible = false;
  clearTimeout(_appMenuHideTimer);
  const finishClose = () => {
    appMenu.hidden = true;
    // Tell main the popup is fully hidden (animation finished) so it can
    // restore the overlay's default bounds without a visible teleport.
    window.kairon.notifyPopupClosed();
  };
  if (REDUCED_MOTION) { finishClose(); return; }
  appMenu.classList.add('am-closing');
  _appMenuHideTimer = setTimeout(finishClose, 130);
}

window.kairon.onAppMenuShow((payload) => showAppMenu(payload));
window.kairon.onAppMenuHide(() => hideAppMenu());

// ── ITEM ACTIONS ────────────────────────────────────────────

function runAppMenuCommand(action) {
  switch (action) {
    case 'new-tab':       window.kairon.createTab('kairon://home'); break;
    case 'new-incognito': window.kairon.openIncognitoWindow(); break;
    case 'back':          window.kairon.goBack(); break;
    case 'forward':       window.kairon.goForward(); break;
    case 'reload':        window.kairon.reload(); break;
    case 'find':          window.kairon.showFindBar(); break;
    case 'history':       window.kairon.navigate('kairon://history'); break;
    case 'downloads':     window.kairon.navigate('kairon://downloads'); break;
    case 'settings':      window.kairon.navigate('kairon://settings'); break;
    case 'exit':          window.kairon.exitApp(); break;
    default: break;
  }
}

function refreshMenuZoom() {
  window.kairon.getZoom().then((res) => {
    if (amZoomValue && res && typeof res.zoomFactor === 'number') {
      amZoomValue.textContent = `${Math.round(res.zoomFactor * 100)}%`;
    }
  }).catch(() => {});
}

function handleAppMenuAction(action) {
  switch (action) {
    case 'zoom-in':
      window.kairon.zoomIn();
      refreshMenuZoom();
      break; // the menu stays open while zooming
    case 'zoom-out':
      window.kairon.zoomOut();
      refreshMenuZoom();
      break;
    case 'zoom-reset':
      window.kairon.resetZoom();
      refreshMenuZoom();
      break;
    case 'fullscreen':
      hideAppMenu();
      window.kairon.toggleFullscreen();
      break;
    case 'about':
      hideAppMenu();
      window.kairon.showAbout();
      break;
    default:
      hideAppMenu();
      runAppMenuCommand(action);
  }
}

appMenu.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('button[data-action]');
  if (!btn || btn.disabled) return;
  const action = btn.dataset.action;
  if (!action) return;
  e.stopPropagation();
  handleAppMenuAction(action);
});

// Arrow / Home / End navigation between enabled items; Escape closes.
appMenu.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    window.kairon.hideAppMenu();
    return;
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const items = Array.from(appMenu.querySelectorAll('.am-item:not([disabled])'));
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  let next = -1;
  if (e.key === 'ArrowDown') next = idx + 1;
  else if (e.key === 'ArrowUp') next = idx - 1;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  if (next < 0) next = items.length - 1;
  if (next >= items.length) next = 0;
  e.preventDefault();
  items[next].focus();
});

// ══════════════════════════════════════════════════════════════
//  ABOUT DIALOG — centered modal at full-window overlay size.
// ══════════════════════════════════════════════════════════════

const aboutDialog = document.getElementById('about-dialog');
const aboutBackdrop = document.getElementById('about-backdrop');
const aboutCloseBtn = document.getElementById('about-close');
const aboutVersion = document.getElementById('about-version');
let aboutVisible = false;

function showAboutDialog(payload) {
  if (!aboutDialog) return;
  if (payload && payload.version && aboutVersion) {
    aboutVersion.textContent = `Version ${payload.version}`;
  }
  // The menu may still be mid-close-animation; force it out of the way.
  clearTimeout(_appMenuHideTimer);
  appMenu.hidden = true;
  appMenuVisible = false;
  aboutVisible = true;
  aboutDialog.hidden = false;
  void aboutDialog.offsetHeight; // restart the enter animation
  if (aboutCloseBtn) aboutCloseBtn.focus();
}

function hideAboutDialog() {
  if (!aboutVisible) return;
  aboutVisible = false;
  aboutDialog.hidden = true;
}

window.kairon.on('about-show', (payload) => showAboutDialog(payload));
window.kairon.on('about-hide', () => hideAboutDialog());

if (aboutBackdrop) aboutBackdrop.addEventListener('click', () => window.kairon.hideAbout());
if (aboutCloseBtn) aboutCloseBtn.addEventListener('click', () => window.kairon.hideAbout());
