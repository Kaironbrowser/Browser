// ============================================================
//  TAB SLEEP MANAGER — Phase 2 (Smart Sleeping Tabs)
//  Puts inactive background tabs to sleep after 7 minutes using
//  native webContents throttling APIs that preserve page state,
//  and wakes them instantly when reactivated. Tabs that are
//  pinned, playing media, capturing camera/mic/screen, running a
//  download, or active are never slept. No UI, no IPC, no logging.
// ============================================================

const SLEEP_THRESHOLD_MS = 7 * 60 * 1000; // 7 minutes of inactivity
const CHECK_INTERVAL_MS = 30 * 1000;      // lightweight sweep every 30s
const DEFAULT_FRAME_RATE = 60;
const SLEEP_FRAME_RATE = 1;

class TabSleepManager {
  constructor({ getTabs, getActiveTabId, onStateChange } = {}) {
    this._getTabs = typeof getTabs === 'function' ? getTabs : () => new Map();
    this._getActiveTabId = typeof getActiveTabId === 'function' ? getActiveTabId : () => null;
    this._onStateChange = typeof onStateChange === 'function' ? onStateChange : null;
    this._intervalHandle = null;

    // Smart-sleep state. Weak-keyed by webContents so entries are reclaimed
    // automatically when a tab or view is destroyed.
    this._mediaCount = new WeakMap();       // webContents -> number of playing media streams
    this._capturing = new WeakSet();        // webContents currently capturing camera/mic/screen
    this._downloads = new WeakMap();        // webContents -> Set of active DownloadItems
    this._tabIdByWebContents = new WeakMap(); // webContents -> owning tab id
    this._tracked = new WeakSet();          // webContents that already have listeners attached
    this._sessionAttached = false;
  }

  start() {
    if (this._intervalHandle) return;
    this._intervalHandle = setInterval(() => this.checkSleepingTabs(), CHECK_INTERVAL_MS);
    this._attachSessionListeners();
  }

  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }

  // Called once per tab at creation so its webContents events are observed.
  trackTab(tab) {
    if (!tab || !tab.view || !tab.view.webContents) return;
    const wc = tab.view.webContents;
    if (this._tracked.has(wc)) return;
    this._tracked.add(wc);
    this._tabIdByWebContents.set(wc, tab.id);
    try {
      wc.on('media-started-playing', this._onMediaStarted);
      wc.on('media-paused', this._onMediaPaused);
      // Media streams end when the page navigates; drop capture + media state.
      wc.on('did-navigate', this._onDidNavigate);
    } catch (e) { }
  }

  // Called whenever a tab becomes the active tab: refreshes its activity
  // timestamp and wakes it if it was sleeping.
  updateTabActivity(tabId) {
    const tab = this._getTab(tabId);
    if (!tab) return;
    tab.lastActiveAt = Date.now();
    this.wakeTab(tabId);
  }

  // Centralized eligibility check for every sleep rule.
  shouldSleepTab(tab) {
    if (!tab) return false;
    if (tab.pinned) return false;                     // pinned tabs never sleep
    if (tab.id === this._getActiveTabId()) return false; // the active tab never sleeps
    if (typeof tab.lastActiveAt !== 'number' || Date.now() - tab.lastActiveAt < SLEEP_THRESHOLD_MS) return false;
    const wc = tab.view && tab.view.webContents;
    if (!wc || wc.isDestroyed()) return false;
    if ((this._mediaCount.get(wc) || 0) > 0) return false;  // audio/media playing
    if (this._capturing.has(wc)) return false;              // camera/mic/screen capture
    const downloads = this._downloads.get(wc);
    if (downloads && downloads.size > 0) return false;      // active downloads
    return true;
  }

  sleepTab(tabId) {
    const tab = this._getTab(tabId);
    if (!tab || tab.sleeping) return;
    tab.sleeping = true;
    try {
      tab.view.webContents.setBackgroundThrottling(true);
      tab.view.webContents.setAudioMuted(true);
      tab.view.webContents.setFrameRate(SLEEP_FRAME_RATE);
    } catch (e) { }
    this._notifyStateChange();
  }

  wakeTab(tabId) {
    const tab = this._getTab(tabId);
    if (!tab || !tab.sleeping) return;
    tab.sleeping = false;
    try {
      tab.view.webContents.setBackgroundThrottling(false);
      tab.view.webContents.setAudioMuted(false);
      tab.view.webContents.setFrameRate(DEFAULT_FRAME_RATE);
    } catch (e) { }
    this._notifyStateChange();
  }

  // ── MEMORY SAVER HELPERS ─────────────────────────────────────
  // Expose sleeping statistics for future UI (e.g. a memory-saver tooltip or
  // status chip). The renderer does not call these today; keeping them on the
  // manager means real measurements can be added later without any renderer
  // changes — callers always use the same API shape.

  getSleepingTabCount() {
    let count = 0;
    for (const [, tab] of this._getTabs()) {
      if (tab && tab.sleeping) count += 1;
    }
    return count;
  }

  getEstimatedMemorySaved() {
    // Actual per-tab RSS accounting is not measured yet, so this safely returns
    // 0. When real measurement lands, it can be derived from webContents process
    // metrics without altering how this method is consumed.
    return 0;
  }

  // Notify the host (main.js) that a tab's sleeping state changed so the
  // renderer can refresh through the existing tabs-state flow — no polling.
  _notifyStateChange() {
    try {
      if (this._onStateChange) this._onStateChange();
    } catch (e) { }
  }

  // Lightweight sweep over the tabs Map. No allocations beyond the iteration,
  // no IPC, no renderer involvement.
  checkSleepingTabs() {
    const activeId = this._getActiveTabId();
    for (const [id] of this._getTabs()) {
      if (id === activeId) continue; // fast path: the active tab never sleeps
      const tab = this._getTab(id);  // guarded: missing/destroyed tabs are skipped
      if (!tab || tab.sleeping) continue;
      if (this.shouldSleepTab(tab)) {
        this.sleepTab(id);
      }
    }
  }

  // Guarded lookup: missing, destroyed, or malformed tabs are never touched.
  _getTab(tabId) {
    if (!Number.isInteger(tabId)) return null;
    const tab = this._getTabs().get(tabId);
    if (!tab || !tab.view || !tab.view.webContents || tab.view.webContents.isDestroyed()) return null;
    return tab;
  }

  // ── EVENT OBSERVERS ─────────────────────────────────────────

  // Session-wide observer for downloads. Permission handling is now managed
  // centrally in main.js and incognito.js with a deny-by-default policy,
  // so this module no longer installs any permission handler.
  _attachSessionListeners() {
    if (this._sessionAttached) return;
    this._sessionAttached = true;
    try {
      const electron = require('electron');
      if (!electron || !electron.session) return;
      const sess = typeof electron.session.fromPartition === 'function'
        ? electron.session.fromPartition('persist:browser')
        : (electron.session.defaultSession || null);
      if (!sess) return;

      if (typeof sess.on === 'function') {
        sess.on('will-download', this._onWillDownload);
      }
    } catch (e) { }
  }

  _onMediaStarted = (event) => {
    const wc = event && event.sender;
    if (!wc) return;
    this._mediaCount.set(wc, (this._mediaCount.get(wc) || 0) + 1);
    // If audio/media starts on a sleeping tab it must remain awake: wake it so
    // the sound is audible and execution resumes (page-level muted media stays
    // silent, so this only unmutes genuinely audible playback).
    const tabId = this._tabIdByWebContents.get(wc);
    if (tabId !== undefined) this.wakeTab(tabId);
  };

  _onMediaPaused = (event) => {
    const wc = event && event.sender;
    if (!wc) return;
    const next = (this._mediaCount.get(wc) || 1) - 1;
    if (next > 0) this._mediaCount.set(wc, next);
    else this._mediaCount.delete(wc);
  };

  _onDidNavigate = (event) => {
    const wc = event && event.sender;
    if (!wc) return;
    // A main-frame navigation ends any ongoing capture and media playback in
    // that page context, so both flags are reset for this webContents.
    this._capturing.delete(wc);
    this._mediaCount.delete(wc);
  };

  _onWillDownload = (event, item, webContents) => {
    if (!webContents) return;
    let active = this._downloads.get(webContents);
    if (!active) {
      active = new Set();
      this._downloads.set(webContents, active);
    }
    active.add(item);
    if (!item || typeof item.on !== 'function') return; // stay tracked defensively
    const done = () => {
      active.delete(item);
      if (active.size === 0) this._downloads.delete(webContents);
    };
    try {
      item.on('done', done);
    } catch (e) { }
  };

  // Called by main.js's permission request handler when a capture permission
  // (camera, microphone, screen capture) is requested or granted, so the
  // tab-sleep manager knows not to sleep the tab.
  onCapturePermissionGranted(webContents) {
    if (webContents) this._capturing.add(webContents);
  }

  // Called by main.js's permission request handler when a capture permission
  // is denied, so the tab-sleep manager can stop tracking the capture.
  onCapturePermissionDenied(webContents) {
    if (webContents) this._capturing.delete(webContents);
  }
}

module.exports = { TabSleepManager, SLEEP_THRESHOLD_MS, CHECK_INTERVAL_MS };
