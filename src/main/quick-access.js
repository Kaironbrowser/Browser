/**
 * quick-access.js — Kairon Browser Quick Access Service
 *
 * Persistent store for the Quick Access (speed dial) section on the home /
 * new-tab page. Exactly the same shape and rules as BookmarkService: a small
 * flat ordered list (title, url, favicon, createdAt), no folders/sync/cloud,
 * persisted through the app's existing electron-store layer (the same store
 * that backs the FeatureStore and BookmarkService). Everything is validated
 * here in the main process; renderer input can never write directly into
 * storage.
 *
 * On first run the store is seeded with the same default dials the home page
 * has always shown, so the new-tab page looks identical until the user adds
 * or removes entries (removals persist).
 *
 * Schema (per entry):
 *   { id, url, title, favicon, createdAt }
 *
 * Exported API:
 *   add(url, title, faviconOverride)
 *   remove(url)
 *   toggle(url, title, faviconOverride)
 *   isInQuickAccess(url)
 *   getEntries()
 *   getEntryById(id)
 *   deleteEntry(id)
 *   getCount()
 *   deriveFaviconUrl(pageUrl)
 */

const QUICK_ACCESS_STORE_KEY = 'quickAccess.v1';
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 1024;
const MAX_FAVICON_LENGTH = 2048;

// The home page's long-standing default dials (title + URL + the exact
// favicon URLs home.html uses). Seeded once so the Quick Access section
// starts exactly as it always looked; users can then add or remove entries.
const DEFAULT_ENTRIES = [
  { title: 'YouTube', url: 'https://youtube.com', favicon: 'https://www.google.com/s2/favicons?domain=youtube.com&sz=32' },
  { title: 'GitHub', url: 'https://github.com', favicon: 'https://www.google.com/s2/favicons?domain=github.com&sz=32' },
  { title: 'Brave Search', url: 'https://search.brave.com', favicon: 'https://www.google.com/s2/favicons?domain=search.brave.com&sz=32' },
  { title: 'Gmail', url: 'https://mail.google.com', favicon: 'https://www.google.com/s2/favicons?domain=mail.google.com&sz=32' },
  { title: 'X', url: 'https://x.com', favicon: 'https://www.google.com/s2/favicons?domain=x.com&sz=32' },
  { title: 'Reddit', url: 'https://reddit.com', favicon: 'https://www.google.com/s2/favicons?domain=reddit.com&sz=32' },
  { title: 'Stack Overflow', url: 'https://stackoverflow.com', favicon: 'https://www.google.com/s2/favicons?domain=stackoverflow.com&sz=32' },
  { title: 'Hacker News', url: 'https://news.ycombinator.com', favicon: 'https://www.google.com/s2/favicons?domain=news.ycombinator.com&sz=32' },
];

class QuickAccessService {
  /**
   * @param {object} store - electron-store instance (shared with FeatureStore)
   */
  constructor(store) {
    this.store = store;
    this.entries = this._load();
  }

  // ── HELPERS ────────────────────────────────────────────────

  _load() {
    const raw = this.store.get(QUICK_ACCESS_STORE_KEY);
    if (!Array.isArray(raw)) {
      // First run (or a store wipe): seed the historical defaults so the home
      // page keeps its familiar look. Persisted immediately so removals stick.
      const seeded = this._sanitizeList(DEFAULT_ENTRIES.map((d, i) => ({ ...d, id: i + 1, createdAt: Date.now() })));
      this.store.set(QUICK_ACCESS_STORE_KEY, seeded);
      return seeded;
    }
    return this._sanitizeList(raw);
  }

  _sanitizeList(raw) {
    const cleaned = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const url = typeof item.url === 'string' ? item.url : '';
      if (!this._isValidQuickAccessUrl(url)) continue;
      cleaned.push({
        id: Number.isInteger(item.id) ? item.id : this._nextId(cleaned),
        url: this._normaliseUrl(url),
        title: (typeof item.title === 'string' ? item.title : '').slice(0, MAX_TITLE_LENGTH),
        favicon: (typeof item.favicon === 'string' ? item.favicon : '').slice(0, MAX_FAVICON_LENGTH),
        createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      });
    }
    return cleaned;
  }

  _persist() {
    this.store.set(QUICK_ACCESS_STORE_KEY, this.entries);
  }

  _nextId(list) {
    let max = 0;
    for (const e of list) {
      if (Number.isInteger(e.id) && e.id > max) max = e.id;
    }
    return max + 1;
  }

  /**
   * Normalise a URL for deduplication: lowercase host, remove fragment,
   * remove trailing slash (same rules as BookmarkService / history).
   */
  _normaliseUrl(rawUrl) {
    try {
      const u = new URL(rawUrl);
      u.hash = '';
      let normalised = u.href;
      if (normalised.endsWith('/')) normalised = normalised.slice(0, -1);
      return normalised;
    } catch {
      return rawUrl;
    }
  }

  /**
   * Only http/https web URLs are allowed — internal Kairon pages
   * (kairon://*, file:, data:, etc.) are always rejected.
   */
  _isValidQuickAccessUrl(rawUrl) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim() || rawUrl.length > MAX_URL_LENGTH) return false;
    try {
      const u = new URL(rawUrl);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }

  _safeFavicon(faviconOverride) {
    if (typeof faviconOverride === 'string' && /^https?:/i.test(faviconOverride)) {
      return faviconOverride.slice(0, MAX_FAVICON_LENGTH);
    }
    return '';
  }

  // ── PUBLIC API ────────────────────────────────────────────

  /**
   * Derive a plausible favicon URL from a page URL (Google's public favicon
   * service — the same standard BookmarkService/history use).
   * @param {string} pageUrl
   * @returns {string}
   */
  deriveFaviconUrl(pageUrl) {
    try {
      const u = new URL(pageUrl);
      return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
    } catch {
      return '';
    }
  }

  /**
   * Add an entry for a URL. If the URL is already present, its title/favicon
   * are refreshed in place (never duplicated) and the original creation time
   * is preserved.
   *
   * @param {string} url
   * @param {string} [title]
   * @param {string} [faviconOverride] - real page favicon URL if available
   * @returns {{ entry: object|null, added: boolean }}
   */
  add(url, title, faviconOverride) {
    if (!this._isValidQuickAccessUrl(url)) return { entry: null, added: false };
    const normalised = this._normaliseUrl(url);
    const safeTitle = (title && typeof title === 'string') ? title.trim().slice(0, MAX_TITLE_LENGTH) : '';

    const existing = this.entries.find((e) => e.url === normalised);
    if (existing) {
      let changed = false;
      if (safeTitle && existing.title !== safeTitle) {
        existing.title = safeTitle;
        changed = true;
      }
      const favicon = this._safeFavicon(faviconOverride);
      if (favicon && existing.favicon !== favicon) {
        existing.favicon = favicon;
        changed = true;
      }
      if (changed) this._persist();
      return { entry: existing, added: false };
    }

    const entry = {
      id: this._nextId(this.entries),
      url: normalised,
      title: safeTitle || normalised,
      favicon: this._safeFavicon(faviconOverride) || this.deriveFaviconUrl(normalised),
      createdAt: Date.now(),
    };
    this.entries.push(entry);
    this._persist();
    return { entry, added: true };
  }

  /**
   * Remove an entry by URL. Returns the removed entry, or null when the URL
   * was not in Quick Access.
   * @param {string} url
   * @returns {object|null}
   */
  remove(url) {
    if (typeof url !== 'string') return null;
    const normalised = this._normaliseUrl(url);
    const existing = this.entries.find((e) => e.url === normalised);
    if (!existing) return null;
    this.entries = this.entries.filter((e) => e.id !== existing.id);
    this._persist();
    return existing;
  }

  /**
   * Toggle the Quick Access state for a URL. Returns the new state so callers
   * can show accurate feedback ("Added to Quick Access" / "Removed from
   * Quick Access").
   *
   * @param {string} url
   * @param {string} [title]
   * @param {string} [faviconOverride]
   * @returns {{ inQuickAccess: boolean, entry: object|null }}
   */
  toggle(url, title, faviconOverride) {
    if (!this._isValidQuickAccessUrl(url)) return { inQuickAccess: false, entry: null };
    const normalised = this._normaliseUrl(url);
    const existing = this.entries.find((e) => e.url === normalised);
    if (existing) {
      this.entries = this.entries.filter((e) => e.id !== existing.id);
      this._persist();
      return { inQuickAccess: false, entry: null };
    }
    const result = this.add(normalised, title, faviconOverride);
    return { inQuickAccess: result.added, entry: result.entry };
  }

  /**
   * Return the entry for a URL (normalised), or null when not present.
   * @param {string} url
   * @returns {object|null}
   */
  isInQuickAccess(url) {
    if (typeof url !== 'string') return null;
    const normalised = this._normaliseUrl(url);
    return this.entries.find((e) => e.url === normalised) || null;
  }

  /**
   * All entries, newest first.
   * @returns {Array<object>}
   */
  getEntries() {
    return [...this.entries].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Look up a single entry by numeric id.
   * @param {number} id
   * @returns {object|null}
   */
  getEntryById(id) {
    if (!Number.isInteger(id)) return null;
    return this.entries.find((e) => e.id === id) || null;
  }

  /**
   * Delete an entry by numeric id.
   * @param {number} id
   * @returns {boolean} True when an entry was removed
   */
  deleteEntry(id) {
    if (!Number.isInteger(id)) return false;
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.entries.length === before) return false;
    this._persist();
    return true;
  }

  /**
   * Total number of stored entries.
   * @returns {number}
   */
  getCount() {
    return this.entries.length;
  }
}

module.exports = { QuickAccessService };
