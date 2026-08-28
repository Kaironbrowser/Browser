/**
 * history-repository.js — Kairon Browser SQLite History Repository
 *
 * Direct database access layer for history entries. Operates strictly on SQLite
 * database tables without mixing raw UI or renderer logic.
 */

class HistoryRepository {
  /**
   * @param {import('./database').DatabaseManager} dbManager
   */
  constructor(dbManager) {
    this._dbManager = dbManager;
  }

  /**
   * Add or update a history entry by URL.
   * If URL already exists, increments visitCount and updates timestamp,
   * title, and favicon.
   *
   * @param {object} params
   * @param {string} params.url
   * @param {string} params.title
   * @param {string} params.favicon
   * @param {number} params.lastVisited
   * @returns {object} The saved/updated entry
   */
  upsertEntry({ url, title, favicon, lastVisited, increment = true }) {
    const db = this._dbManager.getDb();
    const safeTitle = typeof title === 'string' && title.trim() ? title.slice(0, 1024) : 'Untitled';
    const safeFavicon = typeof favicon === 'string' ? favicon : '';
    const now = Number.isInteger(lastVisited) ? lastVisited : Date.now();
    // Only actual navigations count as a visit. Title/favicon metadata updates
    // refresh the entry (title, favicon, lastVisited) without inflating
    // visitCount, so one navigation never registers as multiple visits.
    const visitCountSet = increment !== false
      ? 'visitCount = history.visitCount + 1'
      : 'visitCount = history.visitCount';

    const upsertStmt = db.prepare(`
      INSERT INTO history (url, title, favicon, lastVisited, visitCount)
      VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(url) DO UPDATE SET
        title = CASE
          WHEN excluded.title IS NOT NULL AND excluded.title != '' AND excluded.title != 'Untitled'
          THEN excluded.title
          ELSE history.title
        END,
        favicon = CASE
          WHEN excluded.favicon IS NOT NULL AND excluded.favicon != ''
          THEN excluded.favicon
          ELSE history.favicon
        END,
        lastVisited = excluded.lastVisited,
        ${visitCountSet}
      RETURNING id, url, title, favicon, lastVisited, visitCount;
    `);

    try {
      const row = upsertStmt.get(url, safeTitle, safeFavicon, now);
      if (row) return row;
    } catch {
      // Fallback for older SQLite engines without RETURNING
      db.prepare(`
        INSERT INTO history (url, title, favicon, lastVisited, visitCount)
        VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(url) DO UPDATE SET
          title = CASE
            WHEN excluded.title IS NOT NULL AND excluded.title != '' AND excluded.title != 'Untitled'
            THEN excluded.title
            ELSE history.title
          END,
          favicon = CASE
            WHEN excluded.favicon IS NOT NULL AND excluded.favicon != ''
            THEN excluded.favicon
            ELSE history.favicon
          END,
          lastVisited = excluded.lastVisited,
          ${visitCountSet};
      `).run(url, safeTitle, safeFavicon, now);
    }

    return db.prepare('SELECT id, url, title, favicon, lastVisited, visitCount FROM history WHERE url = ?').get(url);
  }

  /**
   * Retrieve entries sorted by lastVisited DESC (most recent first).
   *
   * @param {number} [limit=50]
   * @param {number} [offset=0]
   * @returns {Array<object>}
   */
  getHistory(limit = 50, offset = 0) {
    const db = this._dbManager.getDb();
    const safeLimit = Math.max(1, Math.min(10000, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);

    return db.prepare(`
      SELECT id, url, title, favicon, lastVisited, visitCount
      FROM history
      ORDER BY lastVisited DESC
      LIMIT ? OFFSET ?
    `).all(safeLimit, safeOffset);
  }

  /**
   * Substring search by title or URL.
   *
   * @param {string} query
   * @param {number} [limit=50]
   * @param {number} [offset=0]
   * @returns {Array<object>}
   */
  searchHistory(query, limit = 50, offset = 0) {
    if (!query || typeof query !== 'string' || !query.trim()) return [];
    const db = this._dbManager.getDb();
    const safeLimit = Math.max(1, Math.min(10000, Number(limit) || 50));
    const safeOffset = Math.max(0, Number(offset) || 0);
    const pattern = `%${query.trim().toLowerCase()}%`;

    return db.prepare(`
      SELECT id, url, title, favicon, lastVisited, visitCount
      FROM history
      WHERE LOWER(title) LIKE ? OR LOWER(url) LIKE ?
      ORDER BY lastVisited DESC
      LIMIT ? OFFSET ?
    `).all(pattern, pattern, safeLimit, safeOffset);
  }

  /**
   * Delete a single history entry by ID.
   *
   * @param {number} id
   * @returns {boolean} True if deleted
   */
  deleteHistoryEntry(id) {
    if (!Number.isInteger(id)) return false;
    const db = this._dbManager.getDb();
    const res = db.prepare('DELETE FROM history WHERE id = ?').run(id);
    return res.changes > 0;
  }

  /**
   * Remove all history entries and reset auto-increment ID counter.
   */
  clearHistory() {
    this._dbManager.transaction(() => {
      const db = this._dbManager.getDb();
      db.prepare('DELETE FROM history').run();
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'history'").run();
    });
  }

  /**
   * Get autocomplete suggestions for the omnibox.
   * Matches against URL and title, scored by:
   *   1. Prefix match (URL domain prefix) — highest
   *   2. Title prefix match
   *   3. URL contains match
   *   4. Title contains match
   * Within each tier, results are sorted by visit frequency then recency.
   *
   * @param {string} query - The user's typed text
   * @param {number} [limit=8] - Maximum results
   * @returns {Array<object>}
   */
  getAutocompleteSuggestions(query, limit = 8) {
    if (!query || typeof query !== 'string' || !query.trim()) return [];
    const db = this._dbManager.getDb();
    const safeLimit = Math.max(1, Math.min(15, Number(limit) || 8));
    const q = query.trim().toLowerCase();

    // Fetch all candidates that match (broad filter), then score in JS for
    // flexible prefix matching (strip protocol, www, etc.).
    const pattern = `%${q}%`;
    const rows = db.prepare(`
      SELECT url, title, favicon, visitCount, lastVisited
      FROM history
      WHERE LOWER(url) LIKE ? OR LOWER(title) LIKE ?
      ORDER BY lastVisited DESC
      LIMIT 200
    `).all(pattern, pattern);

    if (!rows.length) return [];

    function stripProtocolAndWww(url) {
      return url.replace(/^https?:\/\/(www\.)?/i, '');
    }

    // Score each row. Higher = better.
    const scored = [];
    const seen = new Set();
    for (const row of rows) {
      const normalised = stripProtocolAndWww(row.url).toLowerCase();
      const titleLower = (row.title || '').toLowerCase();
      let score = 0;

      if (normalised.startsWith(q)) score = 1000;
      else if (titleLower.startsWith(q)) score = 800;
      else if (normalised.includes(q)) score = 400;
      else if (titleLower.includes(q)) score = 200;
      else continue;

      // Frequency boost (log-ish scale so 1000 visits doesn't dominate).
      score += Math.min(200, Math.log2((row.visitCount || 1) + 1) * 20);
      // Recency boost: entries visited within the last day get a large bonus.
      const age = Date.now() - (row.lastVisited || 0);
      if (age < 86400000) score += 150;          // < 1 day
      else if (age < 604800000) score += 80;     // < 1 week
      else if (age < 2592000000) score += 30;    // < 1 month

      // Prefer shorter URLs (domain-only beats long path URLs).
      score -= Math.min(100, normalised.length * 0.3);

      // Deduplicate by normalised URL.
      const dedupKey = normalised.replace(/\/$/, '');
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      scored.push({ ...row, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, safeLimit).map(({ score, ...rest }) => rest);
  }

  /**
   * Get total number of stored history entries.
   * @returns {number}
   */
  getEntryCount() {
    const db = this._dbManager.getDb();
    const row = db.prepare('SELECT COUNT(*) AS total FROM history').get();
    return row ? row.total : 0;
  }
}

module.exports = { HistoryRepository };
