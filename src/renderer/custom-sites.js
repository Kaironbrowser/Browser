// ============================================================
//  CUSTOM SITES — compact pinned-website tiles for the side rail
//  Self-contained: localStorage persistence, no IPC, no main-process deps.
// ============================================================

const STORAGE_KEY = 'kairon:custom-sites';

// ── FAVICON PROTOCOL VALIDATION (defense-in-depth) ─────────
// Validates that a favicon URL uses only safe protocols before DOM assignment.
// Prevents javascript:/vbscript: URLs from reaching img.src even if stored data
// is compromised. HTML escaping is not needed for DOM API assignment.
const SAFE_FAVICON_PROTOCOLS = new Set(['http:', 'https:', 'data:']);
function _isSafeFaviconUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    if (!SAFE_FAVICON_PROTOCOLS.has(parsed.protocol)) return false;
    if (parsed.protocol === 'data:' && !url.toLowerCase().startsWith('data:image/')) return false;
    return true;
  } catch { return false; }
}

// ── DATA LAYER ──────────────────────────────────────────────
function _load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

function _save(sites) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sites));
  } catch { /* quota — silently drop */ }
}

function _genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── HELPERS ─────────────────────────────────────────────────
function _faviconUrl(url) {
  try {
    const { hostname } = new URL(url);
    if (!hostname) return '';
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return '';
  }
}

function _hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
}

// Canonical URL for comparison: strip www., trailing slashes, normalize.
// Does NOT mutate the stored URL — only used for duplicate detection.
function _canonicalUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch { return url; }
}

function _sanitize(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function _normalizeUrl(raw) {
  const v = raw.trim();
  if (!v) return '';
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(v)) return v;
  if (/^localhost(\b|:|\/)/.test(v)) return v;
  if (v.includes('.') && !v.includes(' ') && v.length < 200) return `https://${v}`;
  if (!v.includes(' ') && v.length >= 2 && v.length < 60 && /^[a-zA-Z]/.test(v)) return `https://${v}`;
  return `https://search.brave.com/search?q=${encodeURIComponent(v)}`;
}

// Validate that a raw user input normalizes to a usable http(s) URL.
// Returns { ok, url, error }.
function _validateUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return { ok: false, url: '', error: 'Enter a URL' };
  const normalized = _normalizeUrl(trimmed);
  if (!normalized) return { ok: false, url: '', error: 'Invalid URL' };
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { ok: false, url: normalized, error: 'Only http/https URLs are supported' };
    }
    if (!parsed.hostname || parsed.hostname.length < 2) {
      return { ok: false, url: normalized, error: 'Invalid hostname' };
    }
    return { ok: true, url: normalized, error: '' };
  } catch {
    return { ok: false, url: normalized, error: 'Invalid URL' };
  }
}

// ── ICONS (monochrome SVGs matching Kairon's visual language) ──
const ICON_GLOBE = `<svg width="16" height="16" viewBox="0 0 12 12" fill="none">
  <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/>
  <path d="M1 6h10M6 1C4.5 3 4.5 9 6 11M6 1c1.5 2 1.5 8 0 10" stroke="currentColor" stroke-width="1.2"/>
</svg>`;

// ── PUBLIC API ──────────────────────────────────────────────
export function initCustomSites(navigate) {
  const grid = document.getElementById('custom-sites-grid');
  if (!grid) return;

  let sites = _load();
  let _draggedId = null;

  // ── RENDER ──────────────────────────────────────────────
  function _render() {
    grid.innerHTML = '';

    // Detect the currently active page URL for highlight
    let activeUrl = '';
    try {
      const raw = (document.getElementById('address-bar')?.value || '').trim();
      if (raw) activeUrl = _normalizeUrl(raw);
    } catch {}

    for (const site of sites) {
      const tile = document.createElement('div');
      tile.className = 'cs-tile';
      tile.dataset.id = site.id;
      tile.draggable = true;

      // Highlight tile if its URL matches the active page
      if (activeUrl && _canonicalUrl(site.url) === _canonicalUrl(activeUrl)) {
        tile.classList.add('cs-active');
      }

      // Favicon container
      const fav = document.createElement('div');
      fav.className = 'cs-favicon';
      if (site.favicon && _isSafeFaviconUrl(site.favicon)) {
        const img = document.createElement('img');
        img.src = site.favicon;
        img.alt = '';
        img.loading = 'lazy';
        img.onerror = () => {
          img.remove();
          fav.innerHTML = ICON_GLOBE;
        };
        fav.appendChild(img);
      } else {
        fav.innerHTML = ICON_GLOBE;
      }

      // Label
      const label = document.createElement('div');
      label.className = 'cs-label';
      label.textContent = site.name;

      tile.appendChild(fav);
      tile.appendChild(label);

      // Tooltip: show full name + URL on hover
      tile.title = `${site.name}\n${site.url}`;

      // Click → navigate
      tile.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.defaultPrevented) return;
        navigate(site.url);
      });

      // Middle-click → new tab (handled via navigate if needed)
      tile.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          navigate(site.url);
        }
      });

      // Context menu
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        _showContextMenu(e.clientX, e.clientY, site);
      });

      // Drag & drop reorder
      tile.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', site.id);
        e.dataTransfer.effectAllowed = 'move';
        tile.classList.add('cs-dragging');
        _draggedId = site.id;
      });
      tile.addEventListener('dragend', () => {
        tile.classList.remove('cs-dragging');
        _draggedId = null;
        // Clean up any lingering drop indicators
        grid.querySelectorAll('.cs-drag-over').forEach(el => el.classList.remove('cs-drag-over'));
      });
      tile.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        // Only highlight the target if it's not the dragged item itself
        if (_draggedId && _draggedId !== site.id) {
          tile.classList.add('cs-drag-over');
        }
      });
      tile.addEventListener('dragleave', () => {
        tile.classList.remove('cs-drag-over');
      });
      tile.addEventListener('drop', (e) => {
        e.preventDefault();
        tile.classList.remove('cs-drag-over');
        const draggedId = e.dataTransfer.getData('text/plain');
        if (draggedId && draggedId !== site.id) {
          _reorder(draggedId, site.id);
        }
      });

      grid.appendChild(tile);
    }
  }

  // ── ACTIONS ─────────────────────────────────────────────
  function _addSite(url, name) {
    const normalized = _normalizeUrl(url);
    if (!normalized) return;
    // Prevent duplicates (canonical: strips www., trailing slash)
    if (sites.some((s) => _canonicalUrl(s.url) === _canonicalUrl(normalized))) return;
    sites.push({
      id: _genId(),
      url: normalized,
      name: name || _hostFromUrl(normalized),
      favicon: _faviconUrl(normalized),
    });
    _save(sites);
    _render();
  }

  function _removeSite(id) {
    sites = sites.filter((x) => x.id !== id);
    _save(sites);
    _render();
  }

  function _reorder(draggedId, targetId) {
    const fromIdx = sites.findIndex((x) => x.id === draggedId);
    const toIdx = sites.findIndex((x) => x.id === targetId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const [moved] = sites.splice(fromIdx, 1);
    sites.splice(toIdx, 0, moved);
    _save(sites);
    _render();
  }

  function _moveSite(id, direction) {
    const idx = sites.findIndex((x) => x.id === id);
    if (idx === -1) return;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= sites.length) return;
    [sites[idx], sites[newIdx]] = [sites[newIdx], sites[idx]];
    _save(sites);
    _render();
  }

  // ── CONTEXT MENU ────────────────────────────────────────
  function _showContextMenu(x, y, site) {
    _removeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'cs-context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const idx = sites.findIndex((s) => s.id === site.id);

    const items = [
      { label: 'Open', action: () => navigate(site.url) },
      { label: 'Rename…', action: () => _promptRename(site) },
      { type: 'separator' },
      { label: 'Move left', action: () => _moveSite(site.id, -1), disabled: idx <= 0 },
      { label: 'Move right', action: () => _moveSite(site.id, 1), disabled: idx >= sites.length - 1 },
      { type: 'separator' },
      { label: 'Remove', action: () => _removeSite(site.id), danger: true },
    ];

    for (const item of items) {
      if (item.type === 'separator') {
        const sep = document.createElement('div');
        sep.className = 'cs-cm-sep';
        menu.appendChild(sep);
        continue;
      }
      const row = document.createElement('div');
      row.className = 'cs-cm-item' + (item.danger ? ' cs-cm-danger' : '');
      if (item.disabled) row.classList.add('cs-cm-disabled');
      row.textContent = item.label;
      if (!item.disabled) {
        row.addEventListener('click', (e) => {
          e.stopPropagation();
          _removeContextMenu();
          item.action();
        });
      }
      menu.appendChild(row);
    }

    document.body.appendChild(menu);

    // Clamp to viewport
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 6}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 6}px`;

    const closeHandler = (e) => {
      if (!menu.contains(e.target)) {
        _removeContextMenu();
        document.removeEventListener('click', closeHandler, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeHandler, true), 0);
  }

  function _removeContextMenu() {
    const old = document.querySelector('.cs-context-menu');
    if (old) old.remove();
  }

  // ── RENAME DIALOG ───────────────────────────────────────
  function _promptRename(site) {
    _showEditDialog(site);
  }

  function _showEditDialog(site) {
    const overlay = document.createElement('div');
    overlay.className = 'cs-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'cs-dialog';

    dialog.innerHTML = `
      <div class="cs-dialog-title">Edit site</div>
      <label class="cs-dialog-label">Name</label>
      <input class="cs-dialog-input" type="text" value="${_sanitize(site.name)}" placeholder="Site name" />
      <label class="cs-dialog-label">URL</label>
      <input class="cs-dialog-input cs-dialog-input-url" type="text" value="${_sanitize(site.url)}" placeholder="https://example.com" />
      <div class="cs-dialog-error" hidden></div>
      <div class="cs-dialog-actions">
        <button class="cs-dialog-btn cs-dialog-cancel" type="button">Cancel</button>
        <button class="cs-dialog-btn cs-dialog-save" type="button">Save</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = dialog.querySelector('input:first-of-type');
    const urlInput = dialog.querySelector('.cs-dialog-input-url');
    const errorEl = dialog.querySelector('.cs-dialog-error');
    nameInput.focus();
    nameInput.select();

    function _showError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
      urlInput.classList.add('cs-dialog-input-error');
    }

    function _clearError() {
      errorEl.textContent = '';
      errorEl.hidden = true;
      urlInput.classList.remove('cs-dialog-input-error');
    }

    // Clear error on input
    urlInput.addEventListener('input', _clearError);

    const close = () => overlay.remove();

    dialog.querySelector('.cs-dialog-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handler); }
    });

    const save = () => {
      _clearError();
      const newName = nameInput.value.trim();
      const newUrl = urlInput.value.trim();

      // Validate URL
      const validation = _validateUrl(newUrl);
      if (!validation.ok) {
        _showError(validation.error);
        urlInput.focus();
        return;
      }

      // Check for duplicates (excluding the site being edited)
      const isDuplicate = sites.some((s) => s.id !== site.id && _canonicalUrl(s.url) === _canonicalUrl(validation.url));
      if (isDuplicate) {
        _showError('This site is already added');
        urlInput.focus();
        return;
      }

      if (newName) site.name = newName;
      site.url = validation.url;
      site.favicon = _faviconUrl(site.url);
      _save(sites);
      _render();
      close();
    };

    dialog.querySelector('.cs-dialog-save').addEventListener('click', save);
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') urlInput.focus(); });
  }

  // ── PUBLIC API (exposed for IPC from overlay) ──────────
  function isCustomSite(url) {
    if (!url) return false;
    try {
      const normalized = _normalizeUrl(url);
      return sites.some((s) => _canonicalUrl(s.url) === _canonicalUrl(normalized));
    } catch { return false; }
  }

  function toggleCustomSite(url, name, favicon) {
    if (!url) return false;
    const normalized = _normalizeUrl(url);
    if (!normalized) return false;
    const existing = sites.find((s) => _canonicalUrl(s.url) === _canonicalUrl(normalized));
    if (existing) {
      sites = sites.filter((s) => s.id !== existing.id);
      _save(sites);
      _render();
      return false; // removed
    }
    sites.push({
      id: _genId(),
      url: normalized,
      name: name || _hostFromUrl(normalized),
      favicon: favicon || _faviconUrl(normalized),
    });
    _save(sites);
    _render();
    return true; // added
  }

  // Listen for IPC-driven updates (when overlay toggles a custom site)
  if (window.kairon && typeof window.kairon.onCustomSitesUpdated === 'function') {
    window.kairon.onCustomSitesUpdated(() => {
      sites = _load();
      _render();
    });
  }

  // Listen for toggle requests from the overlay (via main process forwarding)
  if (window.kairon && typeof window.kairon.onCustomSitesToggleRequest === 'function') {
    window.kairon.onCustomSitesToggleRequest((payload) => {
      if (payload && payload.url) {
        toggleCustomSite(payload.url, payload.name || '', payload.favicon || '');
        // Broadcast update to overlay so it can refresh star popup state
        if (typeof window.kairon.notifyCustomSitesUpdated === 'function') {
          try { window.kairon.notifyCustomSitesUpdated(); } catch (e) {}
        }
      }
    });
  }

  // ── INIT ────────────────────────────────────────────────
  _render();
}
