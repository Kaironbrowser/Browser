/**
 * database.js — Kairon Browser SQLite Connection Manager
 *
 * Manages local SQLite connection and pragma settings for performance
 * and crash durability.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_FILENAME = 'kairon.db';

class DatabaseManager {
  /**
   * @param {string} userDataPath - Electron's app.getPath('userData')
   */
  constructor(userDataPath) {
    if (!userDataPath || typeof userDataPath !== 'string') {
      throw new Error('[database] Invalid userDataPath provided');
    }

    this._dbPath = path.join(userDataPath, DB_FILENAME);
    this._db = null;
    this._init();
  }

  /**
   * Initialize SQLite connection with WAL mode and durability pragmas.
   */
  _init() {
    try {
      const dir = path.dirname(this._dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      this._db = new Database(this._dbPath);
      // Enable WAL mode for high performance concurrent reads & writes
      this._db.pragma('journal_mode = WAL');
      // Set synchronous mode to NORMAL for optimum safety without unnecessary disk flushes
      this._db.pragma('synchronous = NORMAL');
      console.info('[database] SQLite connection initialized at:', this._dbPath);
    } catch (err) {
      console.error('[database] Failed to open SQLite database:', err.message || err);
      throw err;
    }
  }

  /**
   * Get underlying better-sqlite3 database handle.
   * @returns {import('better-sqlite3').Database}
   */
  getDb() {
    if (!this._db) {
      throw new Error('[database] Database instance is not initialized or closed');
    }
    return this._db;
  }

  /**
   * Run a set of operations inside a transaction.
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  transaction(fn) {
    const db = this.getDb();
    const tx = db.transaction(fn);
    return tx();
  }

  /**
   * Close the database connection cleanly.
   */
  close() {
    if (this._db) {
      try {
        this._db.close();
        console.info('[database] SQLite database connection closed');
      } catch (err) {
        console.error('[database] Error closing database:', err.message || err);
      } finally {
        this._db = null;
      }
    }
  }
}

module.exports = { DatabaseManager, DB_FILENAME };
