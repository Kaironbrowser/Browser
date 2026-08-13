const { webContents } = require('electron');

class ContentBlockingRuntime {
  constructor(adblockerService, { debounceMs = 150 } = {}) {
    this.adblockerService = adblockerService;
    this.debounceMs = debounceMs;
    this.timers = new Map(); // webContentsId -> timeout
    this.insertedKeys = new Map(); // webContentsId -> cssKey
  }

  // Called when renderer notifies a DOM change for a given webContents id
  handleDomChanged(webContentsId) {
    if (!webContentsId) return;
    const existing = this.timers.get(webContentsId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(webContentsId);
      this._applyCssToWebContentsId(webContentsId).catch(() => {});
    }, this.debounceMs);
    this.timers.set(webContentsId, t);
  }

  async _applyCssToWebContentsId(id) {
    try {
      const wc = webContents.fromId(id);
      if (!wc) return;
      // Skip injecting cosmetic CSS into the app shell (renderer pages)
      try {
        const url = (typeof wc.getURL === 'function') ? (wc.getURL() || '') : '';
        if (url) {
          try {
            const parsed = new URL(url);
            if (parsed.protocol === 'file:') {
              const u = url.toLowerCase();
              if (u.includes('/renderer/') || u.endsWith('/index.html') || u.endsWith('/home.html') || u.endsWith('/overlay.html') || u.endsWith('/settings.html')) return;
            }
          } catch (e) {
            // ignore parse errors and continue
          }
        }
      } catch (e) {}
      const css = (this.adblockerService && this.adblockerService.css) || '';
      if (!css) return;
      // Remove previously inserted CSS for this webContents
      const prev = this.insertedKeys.get(id);
      if (prev) {
        try { await wc.removeInsertedCSS(prev); } catch (e) {}
        this.insertedKeys.delete(id);
      }
      // Insert updated CSS and store key
      try {
        const key = await wc.insertCSS(css);
        if (key) this.insertedKeys.set(id, key);
      } catch (e) {
        // insertCSS may fail on certain pages; ignore
      }
    } catch (e) {
      // ignore
    }
  }

  // Apply CSS to a webContents when it's first created/ready
  applyCssOnDomReady(wc) {
    if (!wc || !wc.id) return;
    // schedule immediate insertion (no debounce) so initial styling is quick
    try {
      const id = wc.id;
      if (this.timers.has(id)) clearTimeout(this.timers.get(id));
      this._applyCssToWebContentsId(id).catch(() => {});
    } catch (e) {}
  }

  // Re-apply CSS to all tracked webContents (best-effort)
  async applyToAll() {
    try {
      const all = webContents.getAllWebContents();
      for (const wc of all) {
        try { await this._applyCssToWebContentsId(wc.id); } catch (e) {}
      }
    } catch (e) {}
  }

  destroy() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    // try to remove inserted CSS
    for (const [id, key] of this.insertedKeys.entries()) {
      try {
        const wc = webContents.fromId(id);
        if (wc && typeof wc.removeInsertedCSS === 'function') wc.removeInsertedCSS(key).catch(() => {});
      } catch (e) {}
    }
    this.insertedKeys.clear();
  }
}

module.exports = { ContentBlockingRuntime };
