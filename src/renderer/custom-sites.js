// ============================================================
//  CUSTOM SITES — compact pinned-website tiles for the side rail
//  Self-contained: localStorage persistence, no IPC, no main-process deps.
// ============================================================

const STORAGE_KEY = 'kairon:custom-sites';

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
    return `https://www.google.com/s2/favicons?domain=${hostname}&sz=32`;
  } catch {
    return '';
  }
}

function _hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return url; }
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

// ── ICONS (monochrome SVGs matching Kairon's visual language) ──
const ICON_GLOBE = `<svg width="16" height="16" viewBox="0 0 12 12" fill="none">
  <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/>
  <path d="M1 6h10M6 1C4.5 3 4.5 9 6 11M6 1c1.5 2 1.5 8 0 10" stroke="currentColor" stroke-width="1.2"/>
</svg>`;

const ICON_PLUS = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
  <path d="M7 2.5v9M2.5 7h9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
</svg>`;

// ── PUBLIC API ──────────────────────────────────────────────
export function initCustomSites(navigate) {
  const grid = document.getElementById('custom-sites-grid');
  if (!grid) return;

  let sites = _load();

  // ── RENDER ──────────────────────────────────────────────
  function _render() {
    grid.innerHTML = '';

    for (const site of sites) {
      const tile = document.createElement('div');
      tile.className = 'cs-tile';
      tile.dataset.id = site.id;
      tile.title = `${site.name}\n${site.url}`;
      tile.draggable = true;

      // Favicon container
      const fav = document.createElement('div');
      fav.className = 'cs-favicon';
      if (site.favicon) {
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

      // Click → navigate
      tile.addEventListener('click', (e) => {
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
      });
      tile.addEventListener('dragend', () => {
        tile.classList.remove('cs-dragging');
      });
      tile.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tile.classList.add('cs-drag-over');
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

    // "+" add button
    const addBtn = document.createElement('div');
    addBtn.className = 'cs-tile cs-add';
    addBtn.title = 'Add custom site';
    addBtn.innerHTML = `<div class="cs-favicon cs-favicon-add">${ICON_PLUS}</div>`;
    addBtn.addEventListener('click', () => _promptAdd());
    grid.appendChild(addBtn);
  }

  // ── ACTIONS ─────────────────────────────────────────────
  function _promptAdd() {
    _showAddDialog();
  }

  function _addSite(url, name) {
    const normalized = _normalizeUrl(url);
    if (!normalized) return;
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
      <input class="cs-dialog-input" type="text" value="${_sanitize(site.url)}" placeholder="https://example.com" />
      <div class="cs-dialog-actions">
        <button class="cs-dialog-btn cs-dialog-cancel" type="button">Cancel</button>
        <button class="cs-dialog-btn cs-dialog-save" type="button">Save</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = dialog.querySelector('input:first-of-type');
    const urlInput = dialog.querySelector('input:last-of-type');
    nameInput.focus();
    nameInput.select();

    const close = () => overlay.remove();

    dialog.querySelector('.cs-dialog-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handler); }
    });

    const save = () => {
      const newName = nameInput.value.trim();
      const newUrl = urlInput.value.trim();
      if (newUrl) site.url = _normalizeUrl(newUrl);
      if (newName) site.name = newName;
      if (site.url) site.favicon = _faviconUrl(site.url);
      _save(sites);
      _render();
      close();
    };

    dialog.querySelector('.cs-dialog-save').addEventListener('click', save);
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') urlInput.focus(); });
  }

  // ── ADD DIALOG ──────────────────────────────────────────
  function _showAddDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'cs-dialog-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'cs-dialog';

    dialog.innerHTML = `
      <div class="cs-dialog-title">Add custom site</div>
      <label class="cs-dialog-label">URL</label>
      <input class="cs-dialog-input" type="text" placeholder="https://example.com or search term" autofocus />
      <label class="cs-dialog-label">Name <span style="color:var(--text-tertiary)">(optional)</span></label>
      <input class="cs-dialog-input" type="text" placeholder="Auto-detected from URL" />
      <div class="cs-dialog-actions">
        <button class="cs-dialog-btn cs-dialog-cancel" type="button">Cancel</button>
        <button class="cs-dialog-btn cs-dialog-save" type="button">Add</button>
      </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const urlInput = dialog.querySelector('input:first-of-type');
    const nameInput = dialog.querySelector('input:last-of-type');
    urlInput.focus();

    const close = () => overlay.remove();

    dialog.querySelector('.cs-dialog-cancel').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', handler); }
    });

    const add = () => {
      const url = urlInput.value.trim();
      if (!url) return;
      const name = nameInput.value.trim() || _hostFromUrl(_normalizeUrl(url));
      _addSite(url, name);
      close();
    };

    dialog.querySelector('.cs-dialog-save').addEventListener('click', add);
    urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.focus(); });
    nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  }

  // ── INIT ────────────────────────────────────────────────
  _render();
}
