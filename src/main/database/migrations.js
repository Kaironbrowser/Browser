/**
 * migrations.js — Kairon Browser SQLite Migrations & Legacy Import
 *
 * Handles database schema creation, indexing, and seamless atomic migration
 * from legacy history.json while retaining original files as backups.
 */

const path = require('path');
const fs = require('fs');

const LEGACY_HISTORY_FILE = 'history.json';
const LEGACY_VERSION = 1;

class MigrationManager {
  /**
   * @param {import('./database').DatabaseManager} dbManager
   * @param {string} userDataPath
   */
  constructor(dbManager, userDataPath) {
    this._dbManager = dbManager;
    this._userDataPath = userDataPath;
    this._legacyFilePath = path.join(userDataPath, LEGACY_HISTORY_FILE);
  }

  /**
   * Run schema setup and check for pending legacy migrations.
   */
  runMigrations() {
    const db = this._dbManager.getDb();

    // Check if table already exists prior to schema creation
    const tableCheck = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='history'"
    ).get();

    const isFirstRun = !tableCheck;

    // Create table & indexes atomically
    this._dbManager.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          url TEXT NOT NULL UNIQUE,
          title TEXT,
          favicon TEXT,
          lastVisited INTEGER NOT NULL,
          visitCount INTEGER NOT NULL DEFAULT 1
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_history_url ON history(url);
        CREATE INDEX IF NOT EXISTS idx_history_last_visited ON history(lastVisited DESC);
      `);
    });

    // If fresh database and legacy history.json exists, perform atomic migration
    if (isFirstRun && fs.existsSync(this._legacyFilePath)) {
      this._migrateFromLegacyJson();
    }
  }

  /**
   * Migrate history entries from legacy history.json into SQLite.
   * Safe to run, transactional, and preserves history.json as backup.
   */
  _migrateFromLegacyJson() {
    console.info('[migrations] Legacy history.json detected. Starting migration...');
    const db = this._dbManager.getDb();

    try {
      const raw = fs.readFileSync(this._legacyFilePath, 'utf-8');
      const data = JSON.parse(raw);

      if (!data || !Array.isArray(data.entries) || data.entries.length === 0) {
        console.info('[migrations] Legacy history.json is empty or invalid. Skipping entry import.');
        return;
      }

      let maxId = 0;
      let importedCount = 0;

      const insertStmt = db.prepare(`
        INSERT INTO history (id, url, title, favicon, lastVisited, visitCount)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          title = COALESCE(excluded.title, history.title),
          favicon = COALESCE(excluded.favicon, history.favicon),
          lastVisited = MAX(excluded.lastVisited, history.lastVisited),
          visitCount = MAX(excluded.visitCount, history.visitCount)
      `);

      this._dbManager.transaction(() => {
        for (const entry of data.entries) {
          if (!entry || typeof entry.url !== 'string' || !entry.url.trim()) {
            continue;
          }

          const entryId = Number.isInteger(entry.id) && entry.id > 0 ? entry.id : null;
          const url = entry.url.trim();
          const title = typeof entry.title === 'string' ? entry.title.slice(0, 1024) : 'Untitled';
          const favicon = typeof entry.favicon === 'string' ? entry.favicon : '';
          const lastVisited = Number.isInteger(entry.lastVisited) ? entry.lastVisited : Date.now();
          const visitCount = Number.isInteger(entry.visitCount) && entry.visitCount > 0 ? entry.visitCount : 1;

          if (entryId && entryId > maxId) {
            maxId = entryId;
          }

          insertStmt.run(entryId, url, title, favicon, lastVisited, visitCount);
          importedCount++;
        }

        // Adjust autoincrement sequence to prevent ID collisions on subsequent inserts
        if (maxId > 0) {
          db.prepare("DELETE FROM sqlite_sequence WHERE name = 'history'").run();
          db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('history', ?)").run(maxId);
        }
      });

      console.info(`[migrations] Successfully migrated ${importedCount} entries from history.json to SQLite.`);
    } catch (err) {
      console.error('[migrations] Error during legacy history migration:', err.message || err);
      // Migration error must NOT corrupt or delete history.json. It remains safe on disk.
    }
  }
}

module.exports = { MigrationManager };
