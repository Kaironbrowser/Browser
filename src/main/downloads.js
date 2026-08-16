// ============================================================
//  DOWNLOAD MANAGER — Kairon Browser
//  Observes Electron's session 'will-download' events (the same
//  default download pipeline Kairon already uses — no custom
//  download path or prompt is introduced) and exposes a live,
//  persisted download list to the browser chrome, the downloads
//  panel, and the internal kairon://downloads page.
//
//  State model per download:
//    state: 'downloading' | 'paused' | 'completed' | 'interrupted' | 'failed' | 'cancelled'
//
//  Persistence: completed (and failed/interrupted) entries are
//  stored in electron-store under downloads.history.v1 so the
//  downloads list survives restarts. Clearing the list only
//  removes entries — files on disk are never deleted.
// ============================================================

const { app, shell } = require('electron');

const STORE_KEY = 'downloads.history.v1';
const MAX_HISTORY = 200;
const PUSH_THROTTLE_MS = 150;

// Maps Electron DownloadItem states to Kairon states.
function normalizeState(item, updatedState) {
  if (item.isPaused()) return 'paused';
  if (updatedState === 'interrupted') {
    return item.canResume() ? 'interrupted' : 'failed';
  }
  if (updatedState === 'completed') return 'completed';
  if (updatedState === 'cancelled') return 'cancelled';
  return 'downloading';
}

// Small util for deriving a display state for rows.
function stateToStatus(state) {
  switch (state) {
    case 'downloading': return 'Downloading';
    case 'paused':      return 'Paused';
    case 'completed':   return 'Download complete';
    case 'interrupted': return 'Interrupted — click to resume';
    case 'failed':      return 'Failed';
    case 'cancelled':   return 'Cancelled';
    default:            return '';
  }
}

function isActiveState(state) {
  return state === 'downloading' || state === 'paused';
}

class DownloadManager {
  /**
   * @param {object} opts
   * @param {object} opts.store            - electron-store instance (same store as FeatureStore/session)
   * @param {Function} opts.onStateChange  - callback fired (throttled) whenever the list changes
   */
  constructor({ store, onStateChange } = {}) {
    this._store = store;
    this._onStateChange = typeof onStateChange === 'function' ? onStateChange : null;

    // id -> { record, item } — live DownloadItems currently being tracked.
    this._live = new Map();
    // id -> record — persisted + in-session completed/failed entries (no DownloadItem).
    this._history = this._loadHistory();

    // id generator: continues above any persisted ids so ids never collide.
    let maxId = 0;
    for (const record of this._history) {
      if (record && Number.isInteger(record.id) && record.id > maxId) maxId = record.id;
    }
    this._nextId = maxId + 1;

    this._pushTimer = null;
    this._attached = false;
  }

  // ── LIFECYCLE ────────────────────────────────────────────

  attach(sess) {
    if (!sess || this._attached) return;
    this._attached = true;
    // Multiple 'will-download' observers are fine — tab-sleep registers its
    // own; this one only adds bookkeeping, never preventDefault().
    try {
      sess.on('will-download', this._onWillDownload);
    } catch (e) { /* session not ready */ }
  }

  // ── PERSISTENCE ──────────────────────────────────────────

  _loadHistory() {
    try {
      const raw = this._store.get(STORE_KEY);
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((r) => r && typeof r === 'object' && typeof r.id === 'number' && typeof r.filename === 'string')
        .map((r) => ({
          id: r.id,
          filename: String(r.filename).slice(0, 512),
          url: typeof r.url === 'string' ? r.url.slice(0, 4096) : '',
          mimeType: typeof r.mimeType === 'string' ? r.mimeType.slice(0, 256) : '',
          totalBytes: Number.isFinite(r.totalBytes) ? r.totalBytes : 0,
          receivedBytes: Number.isFinite(r.receivedBytes) ? r.receivedBytes : 0,
          state: r.state === 'failed' || r.state === 'interrupted' ? r.state : 'completed',
          canResume: false,
          startedAt: Number.isFinite(r.startedAt) ? r.startedAt : Date.now(),
          updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
          completedAt: Number.isFinite(r.completedAt) ? r.completedAt : (Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now()),
          savePath: typeof r.savePath === 'string' ? r.savePath : '',
          speed: 0,
          etaSeconds: null,
        }))
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, MAX_HISTORY);
    } catch (e) {
      return [];
    }
  }

  _persistHistory() {
    try {
      this._store.set(STORE_KEY, this._history.slice(0, MAX_HISTORY));
    } catch (e) { /* persistence is best-effort */ }
  }

  // ── DOWNLOAD OBSERVATION ─────────────────────────────────

  _onWillDownload = (event, item) => {
    const id = this._nextId++;
    const startedAt = Date.now();
    const record = {
      id,
      filename: safeString(item.getFilename(), 512),
      url: safeString(item.getURL(), 4096),
      mimeType: safeString(item.getMimeType(), 256),
      totalBytes: finite(item.getTotalBytes()),
      receivedBytes: 0,
      state: 'downloading',
      canResume: false,
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
      savePath: '',
      speed: 0,
      etaSeconds: null,
    };
    this._live.set(id, { record, item, lastSample: { time: startedAt, bytes: 0 } });

    try {
      item.on('updated', (e, updatedState) => {
        const entry = this._live.get(id);
        if (!entry) return;
        const r = entry.record;
        r.receivedBytes = finite(item.getReceivedBytes());
        r.totalBytes = finite(item.getTotalBytes());
        r.updatedAt = Date.now();
        r.state = normalizeState(item, updatedState);

        // Transfer-rate sampling (smoothed) for the progress line.
        const now = r.updatedAt;
        const sample = entry.lastSample;
        const dt = (now - sample.time) / 1000;
        if (dt >= 0.5 && r.receivedBytes >= sample.bytes) {
          const instant = (r.receivedBytes - sample.bytes) / dt;
          r.speed = instant > 0 ? Math.round((r.speed * 0.6) + (instant * 0.4)) : 0;
          sample.time = now;
          sample.bytes = r.receivedBytes;
        } else if (r.receivedBytes < sample.bytes) {
          // Received bytes reset (new download attempt) — restart the sample.
          sample.time = now;
          sample.bytes = r.receivedBytes;
          r.speed = 0;
        }

        if (r.totalBytes > 0 && r.speed > 0) {
          const remaining = Math.max(0, r.totalBytes - r.receivedBytes);
          r.etaSeconds = Math.round(remaining / r.speed);
        } else {
          r.etaSeconds = null;
        }

        // The save path becomes available once the download starts writing.
        try {
          if (!r.savePath && item.getSavePath) {
            const p = item.getSavePath();
            if (typeof p === 'string' && p) r.savePath = p;
          }
        } catch (e) { }
        this._schedulePush();
      });

      item.on('done', (e, doneState) => {
        const entry = this._live.get(id);
        if (!entry) return;
        const r = entry.record;
        r.receivedBytes = finite(item.getReceivedBytes());
        r.totalBytes = finite(item.getTotalBytes());
        r.updatedAt = Date.now();
        r.completedAt = r.updatedAt;
        try {
          const p = item.getSavePath();
          if (typeof p === 'string' && p) r.savePath = p;
        } catch (err) { }
        r.state = normalizeState(item, doneState);
        r.canResume = !!item.canResume();
        r.speed = 0;
        r.etaSeconds = null;

        // Persist terminal entries that represent real files (completed) or
        // real failures (failed/interrupted) — cancelled ones stay in-session only.
        if (r.state === 'completed' || r.state === 'failed' || r.state === 'interrupted') {
          this._history.unshift(r);
          this._history = this._history.slice(0, MAX_HISTORY);
          this._persistHistory();
        }
        this._live.delete(id);
        this._flushPush();
      });
    } catch (e) {
      this._live.delete(id);
    }
  };

  // ── PUBLIC API ───────────────────────────────────────────

  getDownloads() {
    const active = [];
    for (const { record } of this._live.values()) active.push(record);
    const all = [...active, ...this._history];
    return all.sort((a, b) => b.startedAt - a.startedAt);
  }

  getActiveCount() {
    let count = 0;
    for (const { record } of this._live.values()) {
      if (isActiveState(record.state)) count += 1;
    }
    return count;
  }

  // Remove completed/failed/cancelled entries from the UI list.
  // Files on disk are intentionally never deleted.
  clearCompleted() {
    const activeIds = new Set();
    for (const { record } of this._live.values()) activeIds.add(record.id);
    const before = this._history.length;
    this._history = this._history.filter((r) => activeIds.has(r.id));
    if (this._history.length !== before) this._persistHistory();
    this._flushPush();
    return true;
  }

  _find(id) {
    const entry = this._live.get(id);
    if (!entry) return null;
    return entry;
  }

  pause(id) {
    const entry = this._find(id);
    if (!entry || !entry.item || typeof entry.item.pause !== 'function') return false;
    try { entry.item.pause(); return true; } catch (e) { return false; }
  }

  resume(id) {
    const entry = this._find(id);
    if (!entry || !entry.item || typeof entry.item.resume !== 'function') return false;
    try { entry.item.resume(); return true; } catch (e) { return false; }
  }

  cancel(id) {
    const entry = this._find(id);
    if (!entry || !entry.item || typeof entry.item.cancel !== 'function') return false;
    try { entry.item.cancel(); return true; } catch (e) { return false; }
  }

  async openFile(id) {
    const record = this._getRecord(id);
    if (!record || !record.savePath) return false;
    const err = await shell.openPath(record.savePath);
    return !err;
  }

  showInFolder(id) {
    const record = this._getRecord(id);
    if (!record || !record.savePath) return false;
    shell.showItemInFolder(record.savePath);
    return true;
  }

  async openDownloadsFolder() {
    try {
      const dir = app.getPath('downloads');
      const err = await shell.openPath(dir);
      return !err;
    } catch (e) {
      return false;
    }
  }

  _getRecord(id) {
    const entry = this._live.get(id);
    if (entry) return entry.record;
    return this._history.find((r) => r.id === id) || null;
  }

  // ── BROADCAST ────────────────────────────────────────────

  _schedulePush() {
    if (this._pushTimer) return;
    this._pushTimer = setTimeout(() => {
      this._pushTimer = null;
      this._emit();
    }, PUSH_THROTTLE_MS);
  }

  _flushPush() {
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
      this._pushTimer = null;
    }
    this._emit();
  }

  _emit() {
    if (this._onStateChange) {
      try { this._onStateChange(); } catch (e) { /* ignore */ }
    }
  }
}

function safeString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function finite(value) {
  return Number.isFinite(value) ? value : 0;
}

module.exports = {
  DownloadManager,
  STORE_KEY,
  stateToStatus,
  isActiveState,
};
