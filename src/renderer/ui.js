// ============================================================
//  KAIRON UI CONTROLLER — v2.1
//  Surface-based, keyboard-first, instant-feeling UX.
// ============================================================

const HOME_PAGE_URL = 'kairon://home';

// Debug-logging gate for the renderer UI. Production builds emit no console
// output from the app shell.
const UI_DIAG = false;

// How long the tab loading dot stays in its fade-out before being removed.
// Matches --dur-fast with a small buffer; a one-shot timer, never polled.
const DOT_LEAVE_MS = 160;

// Snapshot of the OS reduced-motion preference. When set, loading-state
// transitions are skipped entirely (dots removed immediately, no fade) and the
// CSS media query renders the indicator as a static dot instead of pulsing.
const _reducedMotion = typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── ICONS ───────────────────────────────────────────────────
const ICON_GLOBE = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none">
  <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/>
  <path d="M1 6h10M6 1C4.5 3 4.5 9 6 11M6 1c1.5 2 1.5 8 0 10" stroke="currentColor" stroke-width="1.2"/>
</svg>`;

const ICON_KAIRON = `<svg width="12" height="12" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="128" height="128" fill="#000000"/>
  <path d="M37.3333 20V108C37.3333 111.314 40.0196 114 43.3333 114C46.6471 114 49.3333 111.314 49.3333 108V71.2L90.1333 20C93.4667 14.4 101.467 15.2 104.133 18.8C106.8 22.4 106.267 28.4 102.4 32L60.9333 75.2L86.9333 108C90.1333 110.8 90.9333 116 88.8 119.6C86.6667 123.2 80.8 124 77.3333 121.6L37.3333 90.4V20Z" fill="white"/>
</svg>`;

const ICON_CLOSE = `<svg width="9" height="9" viewBox="0 0 9 9" fill="none">
  <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

// Monochrome crescent-moon mark for sleeping tabs. Muted gray, no fill, low
// visual weight so it reads as a native browser affordance rather than a badge.
const ICON_SLEEP = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
  <path d="M8.6 6.1A3.9 3.9 0 1 1 3.9 1.4a3.15 3.15 0 0 0 4.7 4.7z" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>
</svg>`;

// ── HELPERS ──────────────────────────────────────────────────
function debounce(fn, delay) {
  let timeoutId = null;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
}

function getFaviconUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'kairon:') return null;
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return null;
  }
}

function sanitizeText(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Build the hover tooltip for a tab. Sleeping tabs get a status tooltip so the
// user immediately understands why the tab is paused. Kept as a single helper so
// it can later append memory-saving statistics (e.g. "~150 MB saved") without
// touching call sites.
function _buildTabTooltip(tab) {
  if (tab && tab.sleeping) {
    // The newline renders as a line break in Chromium's native tooltip.
    return 'Sleeping Tab\nPaused after 7 minutes of inactivity';
  }
  return (tab && (tab.title || tab.url)) || 'New Tab';
}

// Add or remove the sleeping badge inside a title element, guarded so a badge is
// never duplicated and is always removed when the tab wakes.
function _setSleepBadge(titleEl, sleeping) {
  const existing = titleEl && titleEl.querySelector('.tab-sleep-badge');
  if (sleeping && !existing) {
    const badge = document.createElement('span');
    badge.className = 'tab-sleep-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = ICON_SLEEP;
    titleEl.appendChild(badge);
  } else if (!sleeping && existing) {
    existing.remove();
  }
}

function getAddressDisplayValue(url) {
  return url === HOME_PAGE_URL ? '' : (url || '');
}

export function createUiController(kairon, store, onLayoutChange) {
  // ── DOM refs ───────────────────────────────────────────────
  const leftRail        = document.getElementById('left-rail');
  const btnCollapseRail = document.getElementById('btn-collapse-rail');
  const tabList         = document.getElementById('tab-list');
  const topTabBar       = document.getElementById('top-tab-bar');
  const btnNewTabTop    = document.getElementById('btn-new-tab-top');
  const addressBar      = document.getElementById('address-bar');
  const omnibar         = document.getElementById('omnibar');
  const addressSuggestions = document.getElementById('address-suggestions');
  const spinner         = document.getElementById('spinner');
  const pageTitle       = document.getElementById('page-title');
  const blockedNum      = document.getElementById('blocked-count');
  const totalNum        = document.getElementById('total-count');
  const notBlockedNum   = document.getElementById('not-blocked-count');
  const btnBack         = document.getElementById('btn-back');
  const btnForward      = document.getElementById('btn-forward');
  const btnReload       = document.getElementById('btn-reload');
  const btnNewTab       = document.getElementById('btn-new-tab');
  const shieldEl        = document.getElementById('shield');
  const btnZoomOut      = document.getElementById('btn-zoom-out');
  const btnZoomIn       = document.getElementById('btn-zoom-in');
  const btnZoomReset    = document.getElementById('btn-zoom-reset');
  const zoomValue       = document.getElementById('zoom-value');

  // ── TAB POSITION SETUP ─────────────────────────────────────
  let tabPosition = localStorage.getItem('kairon:tab-position') || 'top';
  document.body.dataset.tabPosition = tabPosition;

  function setTabPosition(newPosition, fromIpc = false) {
    if (tabPosition === newPosition) return;
    tabPosition = newPosition;
    document.body.dataset.tabPosition = tabPosition;
    try { localStorage.setItem('kairon:tab-position', tabPosition); } catch {}
    
    if (!fromIpc) {
      kairon.updateFeatureConfig('themeSystem', { tabPosition: newPosition });
    }
    
    _renderTabs();
    // Fire layout changes multiple times to catch CSS transitions
    if (onLayoutChange) {
      onLayoutChange();
      setTimeout(onLayoutChange, 50);
      setTimeout(onLayoutChange, 350);
    }
  }

  // ── STATE ──────────────────────────────────────────────────
  let blockedCount     = 0;
  let totalCount       = 0;
  let statusResetTimer = null;
  let _lastReloadIcon  = null;
  let _lastReloadLoading = null;
  let addressHistory   = _loadHistory();
  let suggVisible      = false;
  let selectedSuggIdx  = -1;
  let suggestionItems  = [];

  const savedCollapsed = localStorage.getItem('kairon:rail-collapsed') === 'true';
  _setRailCollapsed(savedCollapsed);

  // ── HISTORY PERSISTENCE ────────────────────────────────────
  function _loadHistory() {
    try {
      return JSON.parse(localStorage.getItem('kairon:address-history') || '[]');
    } catch {
      return [];
    }
  }

  function _saveHistory() {
    try {
      localStorage.setItem('kairon:address-history', JSON.stringify(addressHistory.slice(0, 100)));
    } catch {}
  }

  function _pushHistory(url) {
    if (typeof url !== 'string' || !url.trim()) return;
    addressHistory = [url, ...addressHistory.filter(u => u !== url)].slice(0, 100);
    _saveHistory();
  }

  // ── RAIL ───────────────────────────────────────────────────
  function _setRailCollapsed(collapsed) {
    leftRail.dataset.collapsed = collapsed ? 'true' : 'false';
    try { localStorage.setItem('kairon:rail-collapsed', String(collapsed)); } catch {}
  }

  // ── STATUS BAR ─────────────────────────────────────────────
  function _setStatus(text, durationMs = 2400) {
    pageTitle.textContent = text;
    clearTimeout(statusResetTimer);
    statusResetTimer = setTimeout(() => {
      const tab = store.getActiveTab();
      pageTitle.textContent = tab ? (tab.title || '') : '';
    }, durationMs);
  }

  // ── NAV STATE ──────────────────────────────────────────────
  function _renderNavigationState() {
    const tab = store.getActiveTab();
    if (!tab) return;

    if (document.activeElement !== addressBar) {
      addressBar.value = getAddressDisplayValue(tab.url);
    }

    pageTitle.textContent = tab.title || '';
    spinner.classList.toggle('hidden', !tab.loading);
    btnBack.disabled    = !tab.canGoBack;
    btnForward.disabled = !tab.canGoForward;

    if (zoomValue) {
      const zoomFactor = typeof tab.zoomFactor === 'number' ? tab.zoomFactor : 1.0;
      zoomValue.textContent = `${Math.round(zoomFactor * 100)}%`;
    }

    // Rebuild the reload SVG only when the loading state actually flips — avoids
    // allocating both template strings on every navigation-state render.
    if (_lastReloadLoading !== !!tab.loading) {
      _lastReloadLoading = !!tab.loading;
      const reloadIcon = tab.loading
        ? `<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M1 1l11 11M12 1L1 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>`
        : `<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M10.8 6.5a4.3 4.3 0 1 1-1.06-2.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
            <path d="M9.74 2l.5 2.2-2.2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linecap="round"/>
          </svg>`;
      _lastReloadIcon = reloadIcon;
      btnReload.innerHTML = reloadIcon;
    }
  }

  // ── TAB RENDERING ──────────────────────────────────────────
  // Live element references per tab id, so title/loading/favicon/active changes
  // can be patched in place instead of rebuilding the entire tab strip.
  let _tabEls = new Map();
  let _tabElsTabPosition = null;
  // Tabs whose close collapse animation is still playing. Entries hold the live
  // DOM nodes ({ sidebar, top, nextId, timer }). These elements are intentionally
  // kept OUT of _tabEls: the main-process tabs-state is the source of truth and
  // the animation is purely visual, so a closing tab can never be patched back
  // into existence or leave an orphaned element behind.
  let _closingTabs = new Map();
  // Set once the tab strip has rendered at least once. The very first render
  // (fresh start / session restore) renders statically — only genuinely NEW tabs
  // fade in afterwards.
  let _hasRendered = false;

  function _computeFaviconDesc(url) {
    if (url === HOME_PAGE_URL) return { kind: 'svg', svg: ICON_KAIRON, src: '' };
    const faviconUrl = getFaviconUrl(url);
    if (faviconUrl) return { kind: 'img', svg: '', src: faviconUrl };
    return { kind: 'svg', svg: ICON_GLOBE, src: '' };
  }

  function _applyFavicon(el, desc) {
    if (desc.kind === 'img') {
      const img = document.createElement('img');
      img.src = desc.src;
      img.width = 14;
      img.height = 14;
      img.loading = 'lazy';
      img.onerror = () => { el.innerHTML = ICON_GLOBE; };
      el.innerHTML = '';
      el.appendChild(img);
    } else {
      el.innerHTML = desc.svg;
    }
  }

  function _sameTabIds(tabsArr) {
    if (_tabEls.size !== tabsArr.length) return false;
    let i = 0;
    for (const id of _tabEls.keys()) {
      if (id !== tabsArr[i].id) return false;
      i++;
    }
    return true;
  }

  // Patch existing tab DOM in place — only touches what actually changed.
  function _patchTabs(tabsArr, active) {
    for (const tab of tabsArr) {
      const entry = _tabEls.get(tab.id);
      if (!entry) continue;
      const isActive = active && tab.id === active.id;

      // Active state
      if (entry.isActive !== isActive) {
        entry.isActive = isActive;
        entry.sidebar.classList.toggle('active', isActive);
        entry.top.classList.toggle('active', isActive);
        entry.sidebar.setAttribute('aria-selected', String(isActive));
        entry.top.setAttribute('aria-selected', String(isActive));
      }

      // Tooltip — sleeping tabs show a status tooltip (extensible for stats).
      const tooltip = _buildTabTooltip(tab);
      if (entry.sidebar.title !== tooltip) {
        entry.sidebar.title = tooltip;
        entry.top.title = tooltip;
      }

      // Sleeping state — toggle the muted class and badge in place. No strip
      // rebuild: only the affected elements are touched.
      const isSleeping = !!tab.sleeping;
      if (entry._sleeping !== isSleeping) {
        entry._sleeping = isSleeping;
        entry.sidebar.classList.toggle('sleeping', isSleeping);
        entry.top.classList.toggle('sleeping', isSleeping);
        _setSleepBadge(entry.title1, isSleeping);
        _setSleepBadge(entry.title2, isSleeping);
      }

      // Title + loading dot — sync atomically so a title change can never wipe
      // the loading dot while the tab is still loading.
      const title = tab.title || (tab.url || 'New Tab');
      const hasDot = !!tab.loading;
      const titleChanged = entry._lastTitle !== title;
      const dotChanged = !!entry._hasDot !== hasDot;
      if (titleChanged || dotChanged) {
        entry._lastTitle = title;
        entry._hasDot = hasDot;

        // Wipe the title text only when it actually changed — leaving the
        // loading dots connected otherwise so a completed load can fade them
        // out with a real CSS transition (a detached/re-attached span cannot).
        if (titleChanged) {
          entry.title1.textContent = title;
          entry.title2.textContent = title;
        }

        if (hasDot) {
          // Loading (re)started: cancel any pending fade-out (rapid reload),
          // drop stale dots, and drop in a fresh live dot. Only this tab's DOM
          // is touched; the CSS appearance threshold hides it for ~150ms so a
          // very fast load never flashes a dot.
          if (entry._dotLeaveTimer) { clearTimeout(entry._dotLeaveTimer); entry._dotLeaveTimer = null; }
          if (entry._dotEls) {
            for (const dot of entry._dotEls) dot.remove();
            entry._dotEls = null;
          }
          const dot1 = document.createElement('span');
          dot1.className = 'tab-loading-dot';
          dot1.setAttribute('aria-hidden', 'true');
          dot1.textContent = '●';
          entry.title1.appendChild(dot1);
          const dot2 = document.createElement('span');
          dot2.className = 'tab-loading-dot';
          dot2.setAttribute('aria-hidden', 'true');
          dot2.textContent = '●';
          entry.title2.appendChild(dot2);
          entry._dotEls = [dot1, dot2];
        } else if (entry._dotEls && entry._dotEls.length) {
          // Loading finished: fade the dot out cleanly, then remove it. If the
          // title changed at the same moment its text wipe already removed the
          // dots — nothing left to fade, so just drop the refs. Otherwise the
          // dots are still connected and the `.leaving` transition plays.
          // One-shot timer; under reduced motion removal is immediate.
          const dots = entry._dotEls; // kept tracked until removed so a rapid reload can clean them up
          if (_reducedMotion || titleChanged) {
            entry._dotEls = null;
            for (const dot of dots) dot.remove();
          } else {
            for (const dot of dots) dot.classList.add('leaving');
            if (entry._dotLeaveTimer) clearTimeout(entry._dotLeaveTimer);
            entry._dotLeaveTimer = setTimeout(() => {
              entry._dotLeaveTimer = null;
              if (entry._dotEls === dots) entry._dotEls = null;
              for (const dot of dots) dot.remove();
            }, DOT_LEAVE_MS);
          }
        }

        // textContent wiped child elements; re-apply the sleeping badge if the
        // tab is still sleeping so it can never be lost during a title update.
        _setSleepBadge(entry.title1, !!tab.sleeping);
        _setSleepBadge(entry.title2, !!tab.sleeping);
      }

      // Favicon — recompute the description only when the URL actually changed,
      // so unchanged tabs skip the URL parse + string allocation on every patch.
      if (entry._favUrl !== tab.url) {
        entry._favUrl = tab.url;
        entry._favDesc = _computeFaviconDesc(tab.url);
      }
      const favDesc = entry._favDesc;
      if (entry.faviconKind1 !== favDesc.kind || entry.faviconSrc1 !== favDesc.src) {
        entry.faviconKind1 = favDesc.kind;
        entry.faviconSrc1 = favDesc.src;
        _applyFavicon(entry.favicon1, favDesc);
      }
      if (entry.faviconKind2 !== favDesc.kind || entry.faviconSrc2 !== favDesc.src) {
        entry.faviconKind2 = favDesc.kind;
        entry.faviconSrc2 = favDesc.src;
        _applyFavicon(entry.favicon2, favDesc);
      }
    }
  }

  // Play the close collapse animation for a tab that has disappeared from the
  // authoritative tabs-state payload. The element stays in the DOM (collapsing in
  // place while neighbors reflow smoothly) until the animation ends, then is
  // removed. Cheap: no timers are required beyond the animation itself, and only
  // one small size read seeds the CSS variable the keyframe animates from.
  function _animateTabClose(tabId, entry) {
    _tabEls.delete(tabId);

    // Remember which tab followed it so the collapsing element can be re-inserted
    // in place if a full strip rebuild happens while it is still animating.
    const nextEl = entry.sidebar.nextElementSibling;
    const nextId = nextEl && nextEl.dataset ? nextEl.dataset.id : null;

    const record = { sidebar: entry.sidebar, top: entry.top, nextId, timer: null };
    _closingTabs.set(tabId, record);

    // Seed the collapse size so the keyframe starts from the tab's current size.
    // These are custom-property writes (no layout), plus one size read per strip.
    entry.sidebar.style.setProperty('--close-h', (entry.sidebar.offsetHeight || 32) + 'px');
    entry.top.style.setProperty('--close-w', (entry.top.offsetWidth || 240) + 'px');
    entry.sidebar.classList.add('closing');
    entry.top.classList.add('closing');

    let removed = false;
    const finish = () => {
      if (removed) return;
      removed = true;
      clearTimeout(record.timer);
      _closingTabs.delete(tabId);
      record.sidebar.remove();
      record.top.remove();
    };
    // Safety net in case the animation is interrupted (rebuild/rebind races).
    record.timer = setTimeout(finish, 260);
    entry.sidebar.addEventListener('animationend', finish, { once: true });
    entry.top.addEventListener('animationend', finish, { once: true });
  }

  // ── TAB DRAG & REORDER ────────────────────────────────────
  // Drag-and-drop tab reordering. The renderer only choreographs the visuals
  // (lifted tab, insertion caret, local DOM movement) and, on drop, reports
  // the desired FINAL index over the 'tab-reorder' IPC channel. The main
  // process re-validates and reorders its `tabs` Map, then broadcasts the new
  // order back through the existing tabs-state flow — the renderer's store is
  // never mutated locally, so the main process stays the single source of
  // truth. During the gesture nothing is committed: no tabs-state IPC, no
  // BrowserView work, no reloads.
  const DRAG_THRESHOLD_PX = 6;
  const DRAG_SCROLL_MARGIN = 36;
  const DRAG_SCROLL_STEP = 14;

  let _drag = null;          // active or potential drag state
  let _dragIndicator = null; // insertion caret element
  let _swallowNextClick = false; // suppress the click that trails a real drag
  let _swallowClickHandler = null;

  function _dragStrip(d) {
    return d.axis === 'y' ? tabList : topTabBar;
  }

  function _dragElFor(d, id) {
    const entry = _tabEls.get(id);
    if (!entry) return null;
    return d.axis === 'y' ? entry.sidebar : entry.top;
  }

  function _teardownDragListeners() {
    document.removeEventListener('pointermove', _onDragMove);
    document.removeEventListener('pointerup', _onDragUp);
    document.removeEventListener('mouseleave', _onDragMouseLeave);
    window.removeEventListener('blur', _onDragBlur);
    document.removeEventListener('keydown', _onDragKeydown);
  }

  // Capture-phase click guard: swallows the click the browser dispatches right
  // after a real drag (mousedown + mouseup), so dropping a tab can never be
  // mistaken for a click and switch tabs. Removes itself on first use.
  function _installClickSwallow() {
    if (_swallowClickHandler) return;
    const handler = (e) => {
      _swallowClickHandler = null;
      document.removeEventListener('click', handler, true);
      if (!_swallowNextClick) return;
      _swallowNextClick = false;
      e.stopPropagation();
      e.preventDefault();
    };
    _swallowClickHandler = handler;
    document.addEventListener('click', handler, true);
  }

  function _clearDragVisuals() {
    if (_drag) {
      const el = _dragElFor(_drag, _drag.sourceId);
      if (el) {
        el.classList.remove('dragging');
        // Release every temporary drag override so the tab returns to normal
        // (flex) flow at its DOM position with no leftover inline styles.
        el.style.transform = '';
        el.style.position = '';
        el.style.boxSizing = '';
        el.style.left = '';
        el.style.top = '';
        el.style.width = '';
        el.style.height = '';
      }
      if (_drag._placeholder && _drag._placeholder.parentNode) {
        _drag._placeholder.parentNode.removeChild(_drag._placeholder);
      }
    }
    if (_dragIndicator) {
      _dragIndicator.remove();
      _dragIndicator = null;
    }
    document.body.classList.remove('tab-dragging');
  }

  // Put the strip DOM back into the store's authoritative order. Used only on
  // cancel, where no authoritative tabs-state follows the drag.
  function _restoreDragDomOrder(d) {
    const ids = store.getTabs().map((t) => t.id);
    const strip = _dragStrip(d);
    if (d.axis === 'y') {
      for (const id of ids) {
        const el = _dragElFor(d, id);
        if (el) strip.appendChild(el);
      }
    } else {
      const newTabBtn = topTabBar.querySelector('.btn-new-tab-top');
      for (const id of ids) {
        const el = _dragElFor(d, id);
        if (el) topTabBar.insertBefore(el, newTabBtn);
      }
    }
  }

  // Shared teardown for every drag end path. `commit` keeps the (already
  // reordered) DOM in place awaiting the authoritative tabs-state; cancel
  // restores the DOM to the store order. `suppressClick` decides whether the
  // gesture's trailing click must be swallowed.
  function _endDrag({ commit, suppressClick }) {
    const d = _drag;
    if (!d) return;
    _teardownDragListeners();
    if (d.active) {
      if (commit) {
        // Keep the DOM in the dropped order while awaiting the authoritative
        // tabs-state: park the (still lifted) tab at its target slot. It is
        // still anchored out of flow here, so this causes no visual jump;
        // _clearDragVisuals then drops the placeholder and releases the
        // anchor, letting the tab settle into its slot in normal flow.
        const strip = _dragStrip(d);
        const sourceEl = _dragElFor(d, d.sourceId);
        if (sourceEl) {
          const refEl = _refElForTarget(d, d.targetIndex);
          strip.insertBefore(sourceEl, refEl);
        }
      } else {
        _restoreDragDomOrder(d);
      }
      _clearDragVisuals();
      if (suppressClick) _swallowNextClick = true;
    }
    _drag = null;
  }

  // A full strip rebuild (tab added/removed, tab-position switch) invalidates
  // the drag visuals — the DOM is about to be replaced, so no restore is
  // needed, but the release of a half-finished drag must never act as a click.
  function _cancelDragForRebuild() {
    if (!_drag) return;
    const wasActive = _drag.active;
    _teardownDragListeners();
    _clearDragVisuals();
    if (wasActive) _swallowNextClick = true;
    _drag = null;
  }

  // The dragged tab vanished (closed mid-drag): its element is now owned by
  // the close-collapse animation, so only strip the drag state.
  function _cancelDragSourceGone() {
    if (!_drag) return;
    const wasActive = _drag.active;
    _teardownDragListeners();
    _clearDragVisuals();
    if (wasActive) _swallowNextClick = true;
    _drag = null;
  }

  function _startPotentialDrag(tabId, e, axis) {
    // A single mouse only allows one active gesture, so any pre-existing drag
    // state here is stale (e.g. a pointer released outside the window without
    // a pointerup ever reaching us). Clear it before starting fresh rather
    // than silently blocking reordering forever.
    if (_drag) {
      _teardownDragListeners();
      _clearDragVisuals();
      _drag = null;
    }
    _swallowNextClick = false;
    const allTabs = store.getTabs();
    const source = allTabs.find((t) => t.id === tabId);
    if (!source) return;
    _drag = {
      sourceId: tabId,
      axis,
      startX: e.clientX,
      startY: e.clientY,
      curX: e.clientX,
      curY: e.clientY,
      active: false,
      sourceStartIndex: allTabs.findIndex((t) => t.id === tabId),
      order: allTabs.map((t) => t.id),
      pinnedCount: allTabs.filter((t) => t.pinned).length,
      sourcePinned: !!source.pinned,
      targetIndex: null,
      lastTargetIndex: null,
      scrollStart: 0,
    };
    document.addEventListener('pointermove', _onDragMove);
    document.addEventListener('pointerup', _onDragUp);
    document.addEventListener('mouseleave', _onDragMouseLeave);
    window.addEventListener('blur', _onDragBlur);
    document.addEventListener('keydown', _onDragKeydown);
  }

  function _onDragMove(e) {
    const d = _drag;
    if (!d) return;
    d.curX = e.clientX;
    d.curY = e.clientY;
    if (!_tabEls.has(d.sourceId)) { _cancelDragSourceGone(); return; }
    if (!d.active) {
      // Ignore jitter below the threshold so a plain click is never a drag.
      if (Math.hypot(d.curX - d.startX, d.curY - d.startY) < DRAG_THRESHOLD_PX) return;
      _activateDrag(d);
    }
    e.preventDefault(); // stop text selection / native image drag while reordering
    _updateDrag(d);
  }

  function _activateDrag(d) {
    d.active = true;
    const strip = _dragStrip(d);
    const el = _dragElFor(d, d.sourceId);
    if (el) el.classList.add('dragging');
    document.body.classList.add('tab-dragging');

    // Lift the tab out of the flex flow and pin it to the spot it occupied
    // when the drag began, in the strip's content space (padding-box origin;
    // these coordinates scroll with the strip). The anchor never changes for
    // the rest of the gesture, so DOM reordering underneath it (the drop-slot
    // updates in _updateDrag) can no longer move it — the tab only follows
    // the pointer via the transform in _updateDrag, staying glued to the
    // cursor (pointerX - grabOffsetX) the whole time.
    if (el) {
      const stripRect = strip.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();

      // Invisible same-size stand-in that keeps the remaining tabs laid out
      // exactly as they were while the real tab is out of flow. It preserves
      // the drop-slot math and the neighbors' reflow around the slot, and is
      // removed together with the rest of the drag visuals.
      const ph = document.createElement('div');
      ph.className = 'tab-drag-placeholder';
      ph.style.width = `${elRect.width}px`;
      ph.style.height = `${elRect.height}px`;
      strip.insertBefore(ph, el);
      d._placeholder = ph;

      el.style.position = 'absolute';
      el.style.boxSizing = 'border-box';
      el.style.left = `${elRect.left - stripRect.left + strip.scrollLeft}px`;
      el.style.top = `${elRect.top - stripRect.top + strip.scrollTop}px`;
      el.style.width = `${elRect.width}px`;
      el.style.height = `${elRect.height}px`;
      d.scrollStart = d.axis === 'x' ? strip.scrollLeft : strip.scrollTop;
    }

    const ind = document.createElement('div');
    ind.className = 'tab-drop-indicator';
    ind.setAttribute('aria-hidden', 'true');
    _dragIndicator = ind;
    strip.appendChild(ind);
    _installClickSwallow();
  }

  // The element that occupies a given slot in the drag's captured order — the
  // tab (or New Tab button) the dragged tab / its placeholder inserts before.
  function _refElForTarget(d, targetIndex) {
    const others = d.order.filter((id) => id !== d.sourceId);
    const refId = others[targetIndex];
    if (refId !== undefined) return _dragElFor(d, refId);
    if (d.axis === 'x') {
      // End of the top strip still means before the New Tab button.
      return topTabBar.querySelector('.btn-new-tab-top');
    }
    return null; // end of the sidebar list → append
  }

  function _updateDrag(d) {
    // Desired final index = how many OTHER tabs (in authoritative order) sit
    // before the pointer. The order is captured at drag start and never
    // changes during the gesture, so this matches the main process exactly.
    let idx = 0;
    for (const id of d.order) {
      if (id === d.sourceId) continue;
      const el = _dragElFor(d, id);
      if (!el) continue; // removed mid-drag; main clamps defensively
      const rect = el.getBoundingClientRect();
      const center = d.axis === 'y' ? rect.top + rect.height / 2 : rect.left + rect.width / 2;
      const pointer = d.axis === 'y' ? d.curY : d.curX;
      if (pointer > center) idx++;
      else break;
    }

    // Clamp into the dragged tab's own pinned/normal section so dragging
    // across the boundary can never pin or unpin a tab.
    let target;
    if (d.sourcePinned) target = Math.max(0, Math.min(d.pinnedCount - 1, idx));
    else target = Math.max(d.pinnedCount, Math.min(d.order.length - 1, idx));
    d.targetIndex = target;

    if (target !== d.lastTargetIndex) {
      d.lastTargetIndex = target;
      const strip = _dragStrip(d);
      // Move the placeholder (which holds the dragged tab's slot in the flex
      // layout) to the drop slot, with the caret marking it. The dragged tab
      // itself is anchored out of flow, so it never jumps when its slot
      // changes — only the placeholder and neighbors reflow.
      const ph = d._placeholder;
      if (ph) {
        const refEl = _refElForTarget(d, target);
        strip.insertBefore(ph, refEl); // insertBefore(el, null) appends
        if (_dragIndicator) strip.insertBefore(_dragIndicator, ph);
      }
    }

    // The lifted tab follows the pointer along the strip's reorder axis only.
    // Its anchor (left/top) is fixed in the strip's content space for the
    // whole gesture, so the transform is just the pointer delta plus any
    // strip scroll that happened since the drag began — the tab stays under
    // the cursor (visual left = pointerX - grabOffsetX) no matter how often
    // its DOM slot changes. The cross axis stays 0: in top mode the tab never
    // floats up/down with the cursor, in sidebar mode it never floats
    // sideways. The .dragging class adds the lift.
    const sourceEl = _dragElFor(d, d.sourceId);
    if (sourceEl) {
      const strip = _dragStrip(d);
      const delta = d.axis === 'x'
        ? d.curX - d.startX + (strip.scrollLeft - d.scrollStart)
        : d.curY - d.startY + (strip.scrollTop - d.scrollStart);
      const tx = d.axis === 'x' ? delta : 0;
      const ty = d.axis === 'x' ? 0 : delta;
      sourceEl.style.transform = `translate(${tx}px, ${ty}px) scale(1.03)`;
    }

    _autoScrollDrag(d);
  }

  // Gentle scroll while the pointer hugs a strip edge (long tab lists). Runs
  // only inside pointermove during an active drag — never polled.
  function _autoScrollDrag(d) {
    const strip = _dragStrip(d);
    const rect = strip.getBoundingClientRect();
    const pointer = d.axis === 'y' ? d.curY : d.curX;
    if (d.axis === 'y') {
      if (pointer < rect.top + DRAG_SCROLL_MARGIN) strip.scrollTop -= DRAG_SCROLL_STEP;
      else if (pointer > rect.bottom - DRAG_SCROLL_MARGIN) strip.scrollTop += DRAG_SCROLL_STEP;
    } else {
      if (pointer < rect.left + DRAG_SCROLL_MARGIN) strip.scrollLeft -= DRAG_SCROLL_STEP;
      else if (pointer > rect.right - DRAG_SCROLL_MARGIN) strip.scrollLeft += DRAG_SCROLL_STEP;
    }
  }

  function _onDragUp() {
    const d = _drag;
    if (!d) return;
    if (!d.active) {
      // Below threshold — a plain click; leave the normal click flow intact.
      _teardownDragListeners();
      _drag = null;
      return;
    }
    const targetIndex = d.targetIndex;
    const sourceId = d.sourceId;
    const moved = targetIndex !== null && targetIndex !== d.sourceStartIndex;
    _endDrag({ commit: true, suppressClick: true });
    if (moved) kairon.reorderTab(sourceId, targetIndex);
  }

  // Window lost focus (Alt+Tab etc.) — cancel; the order must stay untouched.
  function _onDragBlur() {
    if (!_drag) return;
    _endDrag({ commit: false, suppressClick: false });
  }

  // The pointer left the window entirely — cancel rather than commit
  // somewhere invisible; the order stays untouched.
  function _onDragMouseLeave() {
    if (!_drag) return;
    _endDrag({ commit: false, suppressClick: false });
  }

  // Escape cancels the drag; the release that follows must not count as a click.
  function _onDragKeydown(e) {
    if (e.key !== 'Escape' || !_drag) return;
    const wasActive = _drag.active;
    _endDrag({ commit: false, suppressClick: wasActive });
  }

  // Start a potential drag from any non-interactive part of a tab. The close
  // button and middle/right buttons keep their existing behaviors.
  function _attachTabDrag(el, tabId, axis) {
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // left button only
      if (e.target.closest && e.target.closest('.tab-close, .top-tab-close')) return;
      _startPotentialDrag(tabId, e, axis);
    });
  }

  function _renderTabs() {
    const tabs   = store.getTabs();
    const active = store.getActiveTab();
    const currentTabPosition = document.body.dataset.tabPosition || 'top';

    // Any tab that disappeared from the authoritative state is closing: keep its
    // element in the DOM for the collapse animation, out of the live patch map.
    const incomingIds = new Set();
    for (const tab of tabs) incomingIds.add(tab.id);
    for (const [id, entry] of _tabEls) {
      if (!incomingIds.has(id)) _animateTabClose(id, entry);
    }

    // Fast path: same strip layout + same set/order of tabs → patch in place.
    if (_tabElsTabPosition === currentTabPosition && _sameTabIds(tabs)) {
      _patchTabs(tabs, active);
      return;
    }

    // Capture the pre-render tab ids for new-tab detection before clearing.
    const prevIds = new Set(_tabEls.keys());
    const isFirstRender = !_hasRendered;

    // A full rebuild invalidates any in-flight drag (the DOM is about to be
    // replaced) — cancel cleanly so no stale drag state survives.
    _cancelDragForRebuild();

    _tabElsTabPosition = currentTabPosition;
    _tabEls.clear();
    tabList.innerHTML = '';

    // Save the New Tab button before clearing
    const newTabButton = topTabBar.querySelector('.btn-new-tab-top');
    topTabBar.innerHTML = '';
    if (newTabButton) topTabBar.appendChild(newTabButton);

    for (const tab of tabs) {
      // Defensive: if a tab id reappears in the authoritative state while its
      // close animation is still pending, cancel the visual close and render it
      // fresh instead of leaving it permanently hidden.
      if (_closingTabs.has(tab.id)) {
        const pending = _closingTabs.get(tab.id);
        _closingTabs.delete(tab.id);
        clearTimeout(pending.timer);
        pending.sidebar.remove();
        pending.top.remove();
      }

      const isActive = active && tab.id === active.id;
      const isNew = !isFirstRender && !prevIds.has(tab.id);
      const favDesc = _computeFaviconDesc(tab.url);

      // Create sidebar tab (original)
      const sidebarTab = document.createElement('div');
      sidebarTab.className = `tab-item${isActive ? ' active' : ''}${tab.sleeping ? ' sleeping' : ''}${isNew ? ' tab-enter' : ''}`;
      sidebarTab.dataset.id = String(tab.id);
      sidebarTab.setAttribute('role', 'tab');
      sidebarTab.setAttribute('aria-selected', String(isActive));
      sidebarTab.title = _buildTabTooltip(tab);

      const faviconEl1 = document.createElement('div');
      faviconEl1.className = 'tab-favicon';
      _applyFavicon(faviconEl1, favDesc);

      const titleEl1 = document.createElement('div');
      titleEl1.className = 'tab-title';
      titleEl1.textContent = tab.title || (tab.url || 'New Tab');

      let dot1 = null;
      if (tab.loading) {
        dot1 = document.createElement('span');
        dot1.className = 'tab-loading-dot';
        dot1.setAttribute('aria-hidden', 'true');
        dot1.textContent = '●';
        titleEl1.appendChild(dot1);
      }
      _setSleepBadge(titleEl1, !!tab.sleeping);

      const closeBtn1 = document.createElement('button');
      closeBtn1.className = 'tab-close';
      closeBtn1.setAttribute('aria-label', 'Close tab');
      closeBtn1.innerHTML = ICON_CLOSE;
      closeBtn1.addEventListener('click', (e) => {
        e.stopPropagation();
        closeBtn1.style.transform = 'scale(0.8)';
        setTimeout(() => kairon.closeTab(tab.id), 80);
      });

      sidebarTab.appendChild(faviconEl1);
      sidebarTab.appendChild(titleEl1);
      sidebarTab.appendChild(closeBtn1);
      sidebarTab.addEventListener('click', () => kairon.switchTab(tab.id));
      sidebarTab.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); kairon.closeTab(tab.id); }
      });
      sidebarTab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        kairon.openTabContextMenu(tab.id);
      });
      _attachTabDrag(sidebarTab, tab.id, 'y');
      tabList.appendChild(sidebarTab);

      // Create top tab
      const topTab = document.createElement('div');
      topTab.className = `top-tab${isActive ? ' active' : ''}${tab.sleeping ? ' sleeping' : ''}${isNew ? ' tab-enter' : ''}`;
      topTab.dataset.id = String(tab.id);
      topTab.setAttribute('role', 'tab');
      topTab.setAttribute('aria-selected', String(isActive));
      topTab.title = _buildTabTooltip(tab);

      const faviconEl2 = document.createElement('div');
      faviconEl2.className = 'top-tab-favicon';
      _applyFavicon(faviconEl2, favDesc);

      const titleEl2 = document.createElement('div');
      titleEl2.className = 'top-tab-title';
      titleEl2.textContent = tab.title || (tab.url || 'New Tab');

      let dot2 = null;
      if (tab.loading) {
        dot2 = document.createElement('span');
        dot2.className = 'tab-loading-dot';
        dot2.setAttribute('aria-hidden', 'true');
        dot2.textContent = '●';
        titleEl2.appendChild(dot2);
      }
      _setSleepBadge(titleEl2, !!tab.sleeping);

      const closeBtn2 = document.createElement('button');
      closeBtn2.className = 'top-tab-close';
      closeBtn2.setAttribute('aria-label', 'Close tab');
      closeBtn2.innerHTML = ICON_CLOSE;
      closeBtn2.addEventListener('click', (e) => {
        e.stopPropagation();
        closeBtn2.style.transform = 'scale(0.8)';
        setTimeout(() => kairon.closeTab(tab.id), 80);
      });

      topTab.appendChild(faviconEl2);
      topTab.appendChild(titleEl2);
      topTab.appendChild(closeBtn2);
      topTab.addEventListener('click', () => kairon.switchTab(tab.id));
      topTab.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); kairon.closeTab(tab.id); }
      });
      topTab.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        kairon.openTabContextMenu(tab.id);
      });
      _attachTabDrag(topTab, tab.id, 'x');

      _tabEls.set(tab.id, {
        sidebar: sidebarTab,
        top: topTab,
        title1: titleEl1,
        title2: titleEl2,
        favicon1: faviconEl1,
        favicon2: faviconEl2,
        faviconKind1: favDesc.kind,
        faviconSrc1: favDesc.src,
        faviconKind2: favDesc.kind,
        faviconSrc2: favDesc.src,
        _favUrl: tab.url,
        _favDesc: favDesc,
        isActive,
        _lastTitle: tab.title || (tab.url || 'New Tab'),
        _hasDot: !!tab.loading,
        // Track the live dot spans so a loading->finished transition can fade
        // them out and a rapid reload can cancel/remove them cleanly.
        _dotEls: dot1 && dot2 ? [dot1, dot2] : null,
        _sleeping: !!tab.sleeping,
      });

      // Insert the new top tab before the New Tab button
      if (newTabButton) {
        topTabBar.insertBefore(topTab, newTabButton);
      } else {
        topTabBar.appendChild(topTab);
      }

      // Drop the one-shot enter animation class once it has played (only react
      // to the tab-enter animation itself, not bubbled child animations).
      if (isNew) {
        const clearEnter = (el) => {
          const onEnd = (e) => {
            if (e.animationName !== 'tab-enter') return;
            el.classList.remove('tab-enter');
            el.removeEventListener('animationend', onEnd);
          };
          el.addEventListener('animationend', onEnd);
        };
        clearEnter(sidebarTab);
        clearEnter(topTab);
      }
    }

    // Re-attach any tabs still playing their close animation so the rebuild
    // never interrupts the collapse or leaves an orphaned element behind.
    for (const [, pending] of _closingTabs) {
      if (pending.sidebar.isConnected) continue;

      const refSidebar = pending.nextId ? tabList.querySelector(`[data-id="${pending.nextId}"]`) : null;
      if (refSidebar) tabList.insertBefore(pending.sidebar, refSidebar);
      else tabList.appendChild(pending.sidebar);

      const refTop = pending.nextId ? topTabBar.querySelector(`[data-id="${pending.nextId}"]`) : null;
      if (refTop) topTabBar.insertBefore(pending.top, refTop);
      else if (newTabButton) topTabBar.insertBefore(pending.top, newTabButton);
      else topTabBar.appendChild(pending.top);
    }

    _hasRendered = true;
  }

  // ── SUGGESTIONS ────────────────────────────────────────────
  // Suggestions are rendered in a dedicated overlay BrowserWindow so they can overlap BrowserView content.

  function _hideSuggestions() {
    kairon.hideOverlaySuggestions();
    suggVisible = false;
    selectedSuggIdx = -1;
    suggestionItems = [];
  }

  function _getOmnibarRect() {
    const domRect = omnibar.getBoundingClientRect();
    return {
      top: domRect.top,
      bottom: domRect.bottom,
      left: domRect.left,
      right: domRect.right,
      width: domRect.width,
      height: domRect.height,
    };
  }

  function _showSuggestions(input) {
    const query = input.trim().toLowerCase();
    if (!query) { _hideSuggestions(); return; }

    const fromTabs   = store.getTabs().map(t => t.url).filter(Boolean);
    const pool       = [...new Set([...addressHistory, ...fromTabs])];
    const urlMatches = pool.filter(item => item.toLowerCase().includes(query)).slice(0, 4);

    suggestionItems = [
      ...urlMatches,
      `https://search.brave.com/search?q=${encodeURIComponent(input.trim())}`,
    ].slice(0, 6);

    const rect = _getOmnibarRect();
    // Augment payload with comprehensive renderer window dimensions for main-process cross-reference
    const rendererInfo = {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      bodyClientWidth: document.body.clientWidth,
      docClientWidth: document.documentElement.clientWidth,
      screenWidth: window.screen.width,
      screenAvailWidth: window.screen.availWidth,
    };
    if (UI_DIAG) console.info('[OVERLAY-DIAG] omnibar getBoundingClientRect:', JSON.stringify(rect), '| rendererInfo:', JSON.stringify(rendererInfo));
    kairon.showOverlaySuggestions({ items: suggestionItems, rect, selectedIndex: -1, rendererInfo });

    suggVisible = true;
    selectedSuggIdx = -1;
  }

  function _navigateSuggestions(direction) {
    if (!suggestionItems.length) return;
    selectedSuggIdx = (selectedSuggIdx + direction + suggestionItems.length) % suggestionItems.length;
    const selectedValue = suggestionItems[selectedSuggIdx];
    addressBar.value = selectedValue;
    kairon.showOverlaySuggestions({ items: suggestionItems, rect: _getOmnibarRect(), selectedIndex: selectedSuggIdx });
  }

  // ── PUBLIC CALLBACKS ────────────────────────────────────────
  function onTabsState(payload) {
    store.applyTabsState(payload);
    _renderNavigationState();
    _renderTabs();
  }

  function onUrlChanged(url) {
    const nextUrl = typeof url === 'string' ? url : '';
    _pushHistory(nextUrl); // preserved: dedupes by URL, so repeating is a no-op
    const active = store.getActiveTab();
    if (active && active.url === nextUrl) return; // nothing changed — skip DOM work
    store.updateActiveTabPatch({ url: nextUrl });
    store.updateActiveTabPatch({ favicon: getFaviconUrl(nextUrl) });
    _renderNavigationState();
    _renderTabs();
  }

  function onTitleChanged(title) {
    const nextTitle = title || 'Untitled';
    const active = store.getActiveTab();
    if (active && active.title === nextTitle) return; // nothing changed
    store.updateActiveTabPatch({ title: nextTitle });
    _renderNavigationState();
    _renderTabs();
  }

  function onLoading(loading) {
    const nextLoading = !!loading;
    const active = store.getActiveTab();
    if (active && !!active.loading === nextLoading) return; // nothing changed
    store.updateActiveTabPatch({ loading: nextLoading });
    _renderNavigationState();
    _renderTabs();
  }

  function onAdblockEvent(payload) {
    totalCount += 1;
    const wasBlocked = !!(payload && payload.blocked);
    if (wasBlocked) blockedCount += 1;
    const notBlocked = Math.max(0, totalCount - blockedCount);
    if (totalNum) totalNum.textContent = String(totalCount);
    if (blockedNum) blockedNum.textContent = String(blockedCount);
    if (notBlockedNum) notBlockedNum.textContent = String(notBlocked);
    if (wasBlocked && blockedNum) {
      // Theme token: resolves to #34d39b in dark mode (unchanged) and the
      // darker light-theme green in light mode.
      blockedNum.style.color = 'var(--color-success)';
      setTimeout(() => { blockedNum.style.color = ''; }, 500);
    }
  }

  function onNavigationInvalid() {
    omnibar.classList.add('invalid-url');
    _setStatus('Invalid address — try a URL or search query');
    setTimeout(() => omnibar.classList.remove('invalid-url'), 900);
  }

  // ── EVENT BINDING ───────────────────────────────────────────
  function bindEvents() {
    const debouncedShowSuggestions = debounce(() => _showSuggestions(addressBar.value), 100);

    btnCollapseRail.addEventListener('click', () => {
      _setRailCollapsed(leftRail.dataset.collapsed !== 'true');
    });

    const btnHistory = document.getElementById('btn-open-history');
    if (btnHistory) {
      btnHistory.addEventListener('click', () => kairon.navigate('kairon://history'));
    }

    btnBack.addEventListener('click',    () => kairon.goBack());
    btnForward.addEventListener('click', () => kairon.goForward());
    btnReload.addEventListener('click',  () => {
      const tab = store.getActiveTab();
      if (tab?.loading) kairon.stopLoading?.();
      else kairon.reload();
    });
    btnNewTab.addEventListener('click', () => kairon.createTab(HOME_PAGE_URL));
    btnNewTabTop.addEventListener('click', () => kairon.createTab(HOME_PAGE_URL));
    btnZoomOut?.addEventListener('click',   () => kairon.zoomOut());
    btnZoomIn?.addEventListener('click',    () => kairon.zoomIn());
    btnZoomReset?.addEventListener('click', () => kairon.resetZoom());

    addressBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const val = addressBar.value.trim();
        kairon.navigate(val);
        _pushHistory(val);
        addressBar.blur();
        _hideSuggestions();
        return;
      }
      if (e.key === 'Escape')    { addressBar.blur(); _hideSuggestions(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); _navigateSuggestions(1);  return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); _navigateSuggestions(-1); return; }
    });

    addressBar.addEventListener('focus', () => {
      requestAnimationFrame(() => addressBar.select());
      _showSuggestions(addressBar.value);
    });

    addressBar.addEventListener('input', debouncedShowSuggestions);
    addressBar.addEventListener('blur',  () => setTimeout(_hideSuggestions, 150));

    // ── CHROME FOCUS TRACKING ────────────────────────────────────
    // Report to the main process when the browser chrome's text inputs (address
    // bar, AI chat input) hold keyboard focus, so window-level focus handling
    // never steals it (e.g. Alt+Tab return while typing in the address bar).
    // Non-input chrome (buttons) is intentionally NOT preserved — after
    // returning to the app the active page should take keyboard focus.
    const isChromeInput = (el) => !!(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
    let chromeInputAtBlur = null;
    document.addEventListener('focusin', () => {
      kairon.setChromeUiFocus(isChromeInput(document.activeElement));
    });
    document.addEventListener('focusout', () => {
      kairon.setChromeUiFocus(false);
    });
    window.addEventListener('blur', () => {
      chromeInputAtBlur = isChromeInput(document.activeElement) ? document.activeElement : null;
      kairon.setChromeUiFocus(!!chromeInputAtBlur);
    });
    window.addEventListener('focus', () => {
      if (chromeInputAtBlur && typeof chromeInputAtBlur.focus === 'function') {
        try { chromeInputAtBlur.focus(); } catch (e) { }
      }
    });

    // Shields menu (Off / Standard / Aggressive)
    let shieldsMenu = null;
    function hideShieldsMenu() {
      if (shieldsMenu) { shieldsMenu.remove(); shieldsMenu = null; }
      document.removeEventListener('click', docClick);
    }
    function docClick(e) { if (shieldsMenu && !shieldsMenu.contains(e.target) && e.target !== shieldEl) hideShieldsMenu(); }

    shieldEl?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (shieldsMenu) { hideShieldsMenu(); return; }
      try {
        const snapshot = await kairon.getSettingsState();
        const ad = snapshot.state?.adBlocker || { enabled: false, settings: { mode: 'off' } };
        const currentMode = ad.settings?.mode || 'off';
        const enabled = !!ad.enabled;

        shieldsMenu = document.createElement('div');
        shieldsMenu.className = 'shields-menu';
        shieldsMenu.style.position = 'absolute';
        shieldsMenu.style.zIndex = '9999';
        shieldsMenu.style.minWidth = '200px';
        shieldsMenu.style.background = 'var(--surface-1)';
        shieldsMenu.style.border = '1px solid var(--shields-border)';
        shieldsMenu.style.borderRadius = '8px';
        shieldsMenu.style.boxShadow = '0 8px 30px rgba(0,0,0,0.45)';
        shieldsMenu.style.padding = '8px';
        shieldsMenu.style.color = 'var(--text)';

        const items = [
          { id: 'off', label: 'Off' },
          { id: 'standard', label: 'Standard (network + cosmetic)' },
          { id: 'aggressive', label: 'Aggressive (network + aggressive host fallback)' },
        ];
        for (const it of items) {
          const row = document.createElement('button');
          row.className = 'shields-item';
          row.style.display = 'block';
          row.style.width = '100%';
          row.style.padding = '8px 10px';
          row.style.textAlign = 'left';
          row.style.background = 'transparent';
          row.style.border = 'none';
          row.style.color = 'inherit';
          row.style.cursor = 'pointer';
          row.textContent = it.label;
          if ((it.id === currentMode && enabled) || (it.id === 'off' && !enabled)) {
            row.style.fontWeight = '700';
          }
          row.addEventListener('click', () => {
            if (it.id === 'off') {
              kairon.disableFeature('adBlocker');
              _setStatus('Shields: Off');
            } else {
              kairon.updateFeatureConfig('adBlocker', { mode: it.id });
              kairon.enableFeature('adBlocker');
              _setStatus(`Shields: ${it.label}`);
            }
            hideShieldsMenu();
          });
          shieldsMenu.appendChild(row);
        }

        document.body.appendChild(shieldsMenu);
        const rect = shieldEl.getBoundingClientRect();
        shieldsMenu.style.left = `${Math.round(rect.left)}px`;
        shieldsMenu.style.top = `${Math.round(rect.bottom + 8)}px`;
        document.addEventListener('click', docClick);
      } catch (err) {
        console.error('shields-menu-failed', err);
      }
    });

    document.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd')) { e.preventDefault(); kairon.zoomIn(); return; }
      if (mod && (e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract')) { e.preventDefault(); kairon.zoomOut(); return; }
      if (mod && (e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0')) { e.preventDefault(); kairon.resetZoom(); return; }
      if (mod && e.key === 'k') { e.preventDefault(); addressBar.focus(); addressBar.select(); return; }
      if (mod && e.key === 'l') { e.preventDefault(); addressBar.focus(); addressBar.select(); return; }
      if (mod && e.key === 't') { e.preventDefault(); kairon.createTab(HOME_PAGE_URL); return; }
      if (mod && e.key === 'w') { e.preventDefault(); const tab = store.getActiveTab(); if (tab) kairon.closeTab(tab.id); return; }
      if (mod && e.key === 'r') { e.preventDefault(); kairon.reload(); return; }
      if (mod && e.key === 'h') { e.preventDefault(); kairon.navigate('kairon://history'); return; }
      if ((mod && e.key === '[') || (e.altKey && e.key === 'ArrowLeft'))  { e.preventDefault(); kairon.goBack();    return; }
      if ((mod && e.key === ']') || (e.altKey && e.key === 'ArrowRight')) { e.preventDefault(); kairon.goForward(); return; }
    });
  }

  return {
    bindEvents,
    onTabsState,
    onUrlChanged,
    onTitleChanged,
    onLoading,
    onAdblockEvent,
    onNavigationInvalid,
    setTabPosition,
    get tabPosition() { return tabPosition; }
  };
}
