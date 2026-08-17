// ============================================================
//  DOWNLOAD MANAGER — Kairon Browser
//  Handles Electron's session 'will-download' events with modern
//  browser UX: every download starts automatically and saves
//  straight to the configured directory (the system Downloads
//  folder by default, or a user-chosen folder persisted in the
//  settings FeatureStore). A Windows "Save As" dialog is never
//  shown for normal downloads. The manager also exposes a live,
//  persisted download list to the browser chrome, the downloads
//  panel, and the internal kairon://downloads page.
//
//  State model per download:
//    state: 'downloading' | 'paused' | 'completed' | 'interrupted' | 'failed' | 'cancelled'
//
//  Persistence: completed (and failed/interrupted) entries are
//  stored in electron-store under downloads.history.v1 so the
//  downloads list survives restarts. Cancelled entries are kept
//  in-session only (never persisted) so the UI can show "Cancelled"
//  until the list is cleared. Clearing the list only removes entries
//  — files on disk are never deleted. The chosen
//  download directory is stored in the settings FeatureStore
//  (feature 'downloadManager', setting 'defaultPath') so it
//  survives restarts and participates in export/import/reset.
// ============================================================

const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const STORE_KEY = 'downloads.history.v1';
const MAX_HISTORY = 200;
const PUSH_THROTTLE_MS = 150;
const DOWNLOAD_FEATURE_ID = 'downloadManager';
const CUSTOM_PATH_SETTING = 'defaultPath';

// The system Downloads folder, resolved through Electron's OS APIs so the
// real per-user directory is always used (never a hardcoded username).
function getDefaultDownloadDirectory() {
  try {
    const dir = app.getPath('downloads');
    if (typeof dir === 'string' && dir.trim()) return dir;
  } catch (e) { /* fall through */ }
  try {
    return path.join(app.getPath('home'), 'Downloads');
  } catch (e) {
    return process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Downloads') : '.';
  }
}

// Strip characters that are invalid in Windows file names (Chromium usually
// sanitizes these already, but be defensive since we build paths ourselves).
function safeFilename(name) {
  const s = typeof name === 'string' ? name : '';
  const cleaned = s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return cleaned || 'download';
}

// Chrome-style collision handling: if "report.pdf" already exists, save as
// "report (1).pdf", "report (2).pdf", etc., so parallel/repeated downloads
// never overwrite a file and never fail because the path is taken.
function resolveUniqueSavePath(dir, filename) {
  const candidate = path.join(dir, filename);
  if (!fs.existsSync(candidate)) return candidate;
  const parsed = path.parse(filename);
  for (let i = 1; i < 1000; i++) {
    const next = path.join(dir, `${parsed.name} (${i})${parsed.ext}`);
    if (!fs.existsSync(next)) return next;
  }
  return path.join(dir, `${parsed.name} (${Date.now()})${parsed.ext}`);
}

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
   * @param {object} opts.featureStore     - FeatureStore instance; the download directory
   *                                         preference is persisted through it
   * @param {Function} opts.onStateChange  - callback fired (throttled) whenever the list changes
   */
  constructor({ store, featureStore, onStateChange } = {}) {
    this._store = store;
    this._featureStore = featureStore || null;
    this._onStateChange = typeof onStateChange === 'function' ? onStateChange : null;

    // id -> { record, item } — live DownloadItems currently being tracked.
    this._live = new Map();
    // id -> record — persisted + in-session completed/failed entries (no DownloadItem).
    this._history = this._loadHistory();
    // id -> record — terminal cancelled entries kept in-session only (never
    // persisted) so the panel/page can show "Cancelled" until cleared.
    this._cancelled = [];

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

  // ── DOWNLOAD LOCATION ────────────────────────────────────

  // Effective download directory: the user's custom folder when one is set,
  // otherwise the system Downloads folder. Never null.
  getDownloadDirectory() {
    return this._getCustomDownloadDirectory() || getDefaultDownloadDirectory();
  }

  _getCustomDownloadDirectory() {
    try {
      const settings = this._featureStore ? this._featureStore.getFeatureSettings(DOWNLOAD_FEATURE_ID) : null;
      const custom = settings && typeof settings[CUSTOM_PATH_SETTING] === 'string' ? settings[CUSTOM_PATH_SETTING].trim() : '';
      return custom || null;
    } catch (e) {
      return null;
    }
  }

  getDownloadLocationInfo() {
    const custom = this._getCustomDownloadDirectory();
    return { path: custom || getDefaultDownloadDirectory(), isDefault: !custom };
  }

  // Persist a user-chosen directory. Creates the directory if it does not
  // exist yet so the very first download into it cannot fail. Returns the
  // new location info, or null if the path could not be created.
  setDownloadDirectory(dir) {
    if (typeof dir !== 'string' || !dir.trim()) return null;
    let target;
    try {
      target = path.resolve(dir.trim());
      fs.mkdirSync(target, { recursive: true });
    } catch (e) {
      return null;
    }
    if (this._featureStore) {
      try {
        this._featureStore.updateFeatureConfig(DOWNLOAD_FEATURE_ID, { [CUSTOM_PATH_SETTING]: target });
      } catch (e) {
        return null;
      }
    }
    return { path: target, isDefault: false };
  }

  // Clear the custom location so future downloads go to the system Downloads
  // folder again. Existing files are never moved.
  resetDownloadDirectory() {
    if (this._featureStore) {
      try {
        this._featureStore.updateFeatureConfig(DOWNLOAD_FEATURE_ID, { [CUSTOM_PATH_SETTING]: '' });
      } catch (e) { /* best-effort */ }
    }
    return this.getDownloadLocationInfo();
  }

  // ── DOWNLOAD OBSERVATION ─────────────────────────────────

  _onWillDownload = (event, item) => {
    // Modern browser UX: never show a Save As dialog. Setting the save path
    // makes Electron skip its prompt and save straight to the configured
    // directory (creating it first if needed) while the download proceeds
    // through the normal lifecycle (updated/done fire as usual, so the
    // existing progress UI keeps working).
    //
    // CRITICAL: event.preventDefault() must NOT be called here — per
    // Electron's docs, calling it CANCELS the download ("the download and
    // item will not be available from next tick of the process"). Merely
    // setting the save path is what suppresses the save dialog while letting
    // the download run to completion.
    try {
      const dir = this.getDownloadDirectory();
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* best-effort; Electron also creates it */ }
      const filename = safeFilename(item.getFilename());
      const savePath = resolveUniqueSavePath(dir, filename);
      try {
        item.setSavePath(savePath);
      } catch (e) {
        // setSavePath can throw (e.g. unresolvable path). Fall back to the
        // system Downloads folder so the download still completes.
        try {
          item.setSavePath(resolveUniqueSavePath(getDefaultDownloadDirectory(), filename));
        } catch (e2) { /* leave the default pipeline to handle it */ }
      }
    } catch (e) {
      // Without preventDefault, failing to set a path only means Electron
      // uses its default routine — the download still proceeds.
    }
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
        // real failures (failed/interrupted). Cancelled entries are kept
        // in-session only (never persisted) so the UI can show "Cancelled"
        // until the list is cleared.
        if (r.state === 'completed' || r.state === 'failed' || r.state === 'interrupted') {
          this._history.unshift(r);
          this._history = this._history.slice(0, MAX_HISTORY);
          this._persistHistory();
        } else if (r.state === 'cancelled') {
          this._cancelled.unshift(r);
          this._cancelled = this._cancelled.slice(0, MAX_HISTORY);
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
    const all = [...active, ...this._cancelled, ...this._history];
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
    // In-session cancelled entries are terminal too — drop them from the
    // visible list (active downloads are untouched; files stay on disk).
    this._cancelled = [];
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
      // Open the folder downloads are actually saved to (custom or default).
      const dir = this.getDownloadDirectory();
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
