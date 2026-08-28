/**
 * history.js — Kairon Browser History Service
 *
 * High-level history service interface backed by local SQLite storage.
 * Preserves exact URL normalization, internal protocol filtering, favicon
 * derivation, and callers contract while delegating persistent operations to
 * the SQLite HistoryRepository.
 *
 * Schema (per entry):
 *   { id, url, title, favicon, lastVisited, visitCount }
 *
 * Exported API:
 *   addHistoryEntry(url, title, faviconOverride)
 *   getHistory(limit, offset)
 *   searchHistory(query, limit, offset)
 *   deleteHistoryEntry(id)
 *   clearHistory()
 *   getEntryCount()
 *   flushNow()
 */

const { DatabaseManager } = require('./database/database');
const { MigrationManager } = require('./database/migrations');
const { HistoryRepository } = require('./database/history-repository');

// Internal browser page protocols that must never be recorded.
const INTERNAL_PROTOCOLS = new Set([
  'about:',
  'chrome:',
  'devtools:',
  'file:',
  'data:',
  'blob:',
  'chrome-extension:',
  'kairon:',
]);

// Default page title used when a loaded page has none.
const DEFAULT_TITLE = 'Untitled';

class HistoryService {
  /**
   * @param {string} userDataPath - Electron's app.getPath('userData')
   */
  constructor(userDataPath) {
    this._userDataPath = userDataPath;
    this._dbManager = new DatabaseManager(userDataPath);
    this._migrationManager = new MigrationManager(this._dbManager, userDataPath);
    this._migrationManager.runMigrations();
    this._repository = new HistoryRepository(this._dbManager);

    console.info('[history] HistoryService initialized with SQLite storage, total entries:', this.getEntryCount());
  }

  // ── HELPERS ────────────────────────────────────────────────

  /**
   * Normalise a URL for deduplication: lowercase host, remove fragment,
   * remove trailing slash.
   * @param {string} rawUrl
   * @returns {string}
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
   * Derive a plausible favicon URL from a page URL.
   * Uses Google's public favicon service (standard in many browsers).
   * @param {string} pageUrl
   * @returns {string}
   */
  _deriveFavicon(pageUrl) {
    try {
      const u = new URL(pageUrl);
      return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=64`;
    } catch {
      return '';
    }
  }

  /**
   * Return true if the URL belongs to an internal browser page that
   * should never be persisted to history.
   * @param {string} rawUrl
   * @returns {boolean}
   */
  _isInternalUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return true;
    for (const proto of INTERNAL_PROTOCOLS) {
      if (rawUrl.startsWith(proto)) return true;
    }
    // Also skip about:blank, about:srcdoc, etc.
    if (rawUrl === 'about:blank' || rawUrl === 'about:srcdoc') return true;
    return false;
  }

  // ── PUBLIC API ────────────────────────────────────────────

  /**
   * Record a page visit.
   *
   * If the URL already exists in history, the existing entry is
   * updated (title, favicon, lastVisited refreshed). visitCount is
   * incremented ONLY when the page is actually navigated to
   * (increment === true); title/favicon metadata updates keep the
   * existing visit count unchanged so a single navigation is not
   * counted multiple times.
   * If the URL is new, a fresh entry is created (visitCount = 1).
   *
   * Internal browser URLs (about:, chrome:, file:, kairon://, etc.)
   * are silently ignored.
   *
   * @param {string} url         - The visited URL
   * @param {string} title       - The page title (may be updated later)
   * @param {string} [faviconOverride] - Actual page favicon URL if available;
   *                                     otherwise derived from domain
   * @param {boolean} [increment=true] - Whether this call counts as a visit
   *                                     (true for real navigation events)
   * @returns {object|null} The recorded/updated entry, or null if skipped
   */
  addHistoryEntry(url, title, faviconOverride, increment = true) {
    if (this._isInternalUrl(url)) {
      return null;
    }

    const normalised = this._normaliseUrl(url);
    const now = Date.now();
    const favicon = (faviconOverride && typeof faviconOverride === 'string')
      ? faviconOverride
      : this._deriveFavicon(normalised);
    const safeTitle = (title && typeof title === 'string') ? title.slice(0, 1024) : DEFAULT_TITLE;

    try {
      return this._repository.upsertEntry({
        url: normalised,
        title: safeTitle,
        favicon,
        lastVisited: now,
        increment: increment !== false,
      });
    } catch (err) {
      console.error('[history] failed to record history entry:', err.message || err);
      return null;
    }
  }

  /**
   * Retrieve a slice of the history, sorted by lastVisited descending
   * (most recent first).
   *
   * @param {number} [limit=50]  - Maximum number of entries to return
   * @param {number} [offset=0]  - Number of entries to skip
   * @returns {Array<object>}
   */
  getHistory(limit = 50, offset = 0) {
    try {
      return this._repository.getHistory(limit, offset);
    } catch (err) {
      console.error('[history] failed to fetch history:', err.message || err);
      return [];
    }
  }

  /**
   * Search history entries by title or URL (case-insensitive substring match).
   *
   * @param {string} query       - Search term
   * @param {number} [limit=50]  - Maximum entries to return
   * @param {number} [offset=0]  - Entries to skip
   * @returns {Array<object>}
   */
  searchHistory(query, limit = 50, offset = 0) {
    try {
      return this._repository.searchHistory(query, limit, offset);
    } catch (err) {
      console.error('[history] search history failed:', err.message || err);
      return [];
    }
  }

  /**
   * Delete a single history entry by its numeric id.
   *
   * @param {number} id
   * @returns {boolean} True if an entry was removed
   */
  deleteHistoryEntry(id) {
    try {
      return this._repository.deleteHistoryEntry(id);
    } catch (err) {
      console.error('[history] delete history entry failed:', err.message || err);
      return false;
    }
  }

  /**
   * Remove all history entries.
   */
  clearHistory() {
    try {
      this._repository.clearHistory();
      console.info('[history] all history entries cleared');
    } catch (err) {
      console.error('[history] clear history failed:', err.message || err);
    }
  }

  /**
   * Return the total number of stored entries.
   * @returns {number}
   */
  getEntryCount() {
    try {
      return this._repository.getEntryCount();
    } catch (err) {
      console.error('[history] get entry count failed:', err.message || err);
      return 0;
    }
  }

  /**
   * Get autocomplete suggestions for the omnibox.
   * Matches against URL and title, scored by prefix relevance,
   * visit frequency, and recency.
   *
   * @param {string} query - The user's typed text
   * @param {number} [limit=8] - Maximum results
   * @returns {Array<object>}
   */
  getAutocompleteSuggestions(query, limit = 8) {
    try {
      return this._repository.getAutocompleteSuggestions(query, limit);
    } catch (err) {
      console.error('[history] autocomplete suggestions failed:', err.message || err);
      return [];
    }
  }

  /**
   * Force an immediate flush or clean database shutdown.
   */
  flushNow() {
    if (this._dbManager) {
      try {
        this._dbManager.close();
      } catch (err) {
        console.error('[history] flush/close error:', err.message || err);
      }
    }
  }
}

module.exports = { HistoryService };
