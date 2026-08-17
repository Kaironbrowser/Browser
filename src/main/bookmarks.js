/**
 * bookmarks.js — Kairon Browser Bookmark Service
 *
 * Simple, flat, persistent bookmark store. Bookmarks are a small ordered
 * list (title, url, favicon, createdAt) with no folders/sync/cloud — a
 * dedicated database would be overkill, so this reuses the app's existing
 * persistent storage layer (the same electron-store that backs the
 * FeatureStore). Everything is validated here in the main process; renderer
 * input can never write directly into storage.
 *
 * Schema (per bookmark):
 *   { id, url, title, favicon, createdAt }
 *
 * Exported API:
 *   addBookmark(url, title, faviconOverride)
 *   removeBookmark(url)
 *   toggleBookmark(url, title, faviconOverride)
 *   isBookmarked(url)
 *   getBookmarks()
 *   getBookmarkById(id)
 *   deleteBookmark(id)
 *   searchBookmarks(query)
 *   getCount()
 *   deriveFaviconUrl(pageUrl)
 */

const BOOKMARKS_STORE_KEY = 'bookmarks.v1';
const MAX_URL_LENGTH = 2048;
const MAX_TITLE_LENGTH = 1024;
const MAX_FAVICON_LENGTH = 2048;

class BookmarkService {
  /**
   * @param {object} store - electron-store instance (shared with FeatureStore)
   */
  constructor(store) {
    this.store = store;
    this.bookmarks = this._load();
  }

  // ── HELPERS ────────────────────────────────────────────────

  _load() {
    const raw = this.store.get(BOOKMARKS_STORE_KEY);
    if (!Array.isArray(raw)) return [];
    const cleaned = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const url = typeof item.url === 'string' ? item.url : '';
      if (!this._isValidBookmarkUrl(url)) continue;
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
    this.store.set(BOOKMARKS_STORE_KEY, this.bookmarks);
  }

  _nextId(list) {
    let max = 0;
    for (const b of list) {
      if (Number.isInteger(b.id) && b.id > max) max = b.id;
    }
    return max + 1;
  }

  /**
   * Normalise a URL for deduplication: lowercase host, remove fragment,
   * remove trailing slash (same rules as the history service).
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
   * Only http/https web URLs are bookmarkable — internal Kairon pages
   * (kairon://*, file:, data:, etc.) are always rejected.
   */
  _isValidBookmarkUrl(rawUrl) {
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
   * service — the same standard the history service uses).
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
   * Add a bookmark for a URL. If the URL is already bookmarked, its
   * title/favicon are refreshed in place (never duplicated) and the original
   * creation time is preserved.
   *
   * @param {string} url
   * @param {string} [title]
   * @param {string} [faviconOverride] - real page favicon URL if available
   * @returns {{ bookmark: object|null, added: boolean }}
   */
  addBookmark(url, title, faviconOverride) {
    if (!this._isValidBookmarkUrl(url)) return { bookmark: null, added: false };
    const normalised = this._normaliseUrl(url);
    const safeTitle = (title && typeof title === 'string') ? title.trim().slice(0, MAX_TITLE_LENGTH) : '';

    const existing = this.bookmarks.find((b) => b.url === normalised);
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
      return { bookmark: existing, added: false };
    }

    const bookmark = {
      id: this._nextId(this.bookmarks),
      url: normalised,
      title: safeTitle || normalised,
      favicon: this._safeFavicon(faviconOverride) || this.deriveFaviconUrl(normalised),
      createdAt: Date.now(),
    };
    this.bookmarks.push(bookmark);
    this._persist();
    return { bookmark, added: true };
  }

  /**
   * Remove a bookmark by URL. Returns the removed bookmark, or null when the
   * URL was not bookmarked.
   * @param {string} url
   * @returns {object|null}
   */
  removeBookmark(url) {
    if (typeof url !== 'string') return null;
    const normalised = this._normaliseUrl(url);
    const existing = this.bookmarks.find((b) => b.url === normalised);
    if (!existing) return null;
    this.bookmarks = this.bookmarks.filter((b) => b.id !== existing.id);
    this._persist();
    return existing;
  }

  /**
   * Toggle the bookmark state for a URL. Returns the new state so callers can
   * show accurate feedback ("Bookmark added" / "Bookmark removed").
   *
   * @param {string} url
   * @param {string} [title]
   * @param {string} [faviconOverride]
   * @returns {{ bookmarked: boolean, bookmark: object|null }}
   */
  toggleBookmark(url, title, faviconOverride) {
    if (!this._isValidBookmarkUrl(url)) return { bookmarked: false, bookmark: null };
    const normalised = this._normaliseUrl(url);
    const existing = this.bookmarks.find((b) => b.url === normalised);
    if (existing) {
      this.bookmarks = this.bookmarks.filter((b) => b.id !== existing.id);
      this._persist();
      return { bookmarked: false, bookmark: null };
    }
    const result = this.addBookmark(normalised, title, faviconOverride);
    return { bookmarked: result.added, bookmark: result.bookmark };
  }

  /**
   * Return the bookmark for a URL (normalised), or null when not bookmarked.
   * @param {string} url
   * @returns {object|null}
   */
  isBookmarked(url) {
    if (typeof url !== 'string') return null;
    const normalised = this._normaliseUrl(url);
    return this.bookmarks.find((b) => b.url === normalised) || null;
  }

  /**
   * All bookmarks, newest first.
   * @returns {Array<object>}
   */
  getBookmarks() {
    return [...this.bookmarks].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Look up a single bookmark by numeric id.
   * @param {number} id
   * @returns {object|null}
   */
  getBookmarkById(id) {
    if (!Number.isInteger(id)) return null;
    return this.bookmarks.find((b) => b.id === id) || null;
  }

  /**
   * Delete a bookmark by numeric id.
   * @param {number} id
   * @returns {boolean} True when a bookmark was removed
   */
  deleteBookmark(id) {
    if (!Number.isInteger(id)) return false;
    const before = this.bookmarks.length;
    this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
    if (this.bookmarks.length === before) return false;
    this._persist();
    return true;
  }

  /**
   * Filter bookmarks by title or URL (case-insensitive substring match).
   * @param {string} query
   * @returns {Array<object>}
   */
  searchBookmarks(query) {
    if (typeof query !== 'string' || !query.trim()) return this.getBookmarks();
    const needle = query.trim().toLowerCase();
    return this.getBookmarks().filter((b) =>
      b.title.toLowerCase().includes(needle) || b.url.toLowerCase().includes(needle)
    );
  }

  /**
   * Total number of stored bookmarks.
   * @returns {number}
   */
  getCount() {
    return this.bookmarks.length;
  }
}

module.exports = { BookmarkService };
