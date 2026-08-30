const { cloneRegistry, getDefaultFeatureState } = require('./features');

const FEATURES_STORE_KEY = 'settings.features.v1';

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sanitizeStringArray(input) {
  if (!Array.isArray(input)) return [];
  return input.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 500);
}

class FeatureStore {
  constructor(store) {
    this.store = store;
    this.registry = cloneRegistry();
    this.defaultState = getDefaultFeatureState();
    this.state = this.loadState();
    // Cache for getPublicSnapshot: invalidated on every mutation (persist/reset/import).
    this._snapshotCache = null;
  }

  loadState() {
    const raw = this.store.get(FEATURES_STORE_KEY);
    if (!raw || typeof raw !== 'object') return deepClone(this.defaultState);
    const next = deepClone(this.defaultState);
    for (const feature of this.registry) {
      const item = raw[feature.id];
      if (!item || typeof item !== 'object') continue;
      if (typeof item.enabled === 'boolean') next[feature.id].enabled = item.enabled;
      if (item.settings && typeof item.settings === 'object') {
        next[feature.id].settings = this.mergeSettings(next[feature.id].settings, item.settings);
      }
    }
    return next;
  }

  persist() {
    this.store.set(FEATURES_STORE_KEY, this.state);
    this._snapshotCache = null;
  }

  mergeSettings(base, patch) {
    const result = deepClone(base);
    for (const key of Object.keys(result)) {
      if (!(key in patch)) continue;
      const patchValue = patch[key];
      if (Array.isArray(result[key])) {
        result[key] = sanitizeStringArray(patchValue);
      } else if (typeof result[key] === 'boolean') {
        result[key] = Boolean(patchValue);
      } else if (typeof result[key] === 'number') {
        if (Number.isFinite(patchValue)) result[key] = patchValue;
      } else if (typeof result[key] === 'string') {
        result[key] = String(patchValue).slice(0, 4096);
      } else if (result[key] && typeof result[key] === 'object' && patchValue && typeof patchValue === 'object') {
        result[key] = this.mergeSettings(result[key], patchValue);
      }
    }
    return result;
  }

  getPublicSnapshot() {
    // Cached: the snapshot is expensive (deep-clone of the full state tree)
    // and callers (settings-get-state IPC) don't mutate the result.
    if (this._snapshotCache) return this._snapshotCache;
    this._snapshotCache = {
      registry: this.registry,
      state: deepClone(this.state),
    };
    return this._snapshotCache;
  }

  isEnabled(featureId) {
    return !!this.state[featureId]?.enabled;
  }

  getFeatureSettings(featureId) {
    // Return a frozen reference instead of cloning: callers in hot paths
    // (adblock-mode check, HTTPS-only, download-location) only read the
    // returned object. Mutations go through updateFeatureConfig() which
    // calls persist() to invalidate this cache.
    const settings = this.state[featureId]?.settings;
    if (!settings) return {};
    return settings;
  }

  setFeatureEnabled(featureId, enabled) {
    if (!this.state[featureId] || typeof enabled !== 'boolean') return false;
    this.state[featureId].enabled = enabled;
    this.persist();
    return true;
  }

  updateFeatureConfig(featureId, patch) {
    if (!this.state[featureId] || !patch || typeof patch !== 'object') return false;
    this.state[featureId].settings = this.mergeSettings(this.state[featureId].settings, patch);
    this.persist();
    return true;
  }

  resetFeature(featureId) {
    if (!this.state[featureId]) return false;
    this.state[featureId] = deepClone(this.defaultState[featureId]);
    this.persist();
    this._snapshotCache = null;
    return true;
  }

  resetAll() {
    this.state = deepClone(this.defaultState);
    this.persist();
    this._snapshotCache = null;
    return true;
  }

  exportJson() {
    return JSON.stringify({ version: 1, state: this.state }, null, 2);
  }

  importJson(jsonText) {
    if (typeof jsonText !== 'string' || jsonText.length > 2_000_000) return false;
    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object' || !parsed.state || typeof parsed.state !== 'object') return false;
    const next = deepClone(this.defaultState);
    for (const feature of this.registry) {
      const input = parsed.state[feature.id];
      if (!input || typeof input !== 'object') continue;
      if (typeof input.enabled === 'boolean') next[feature.id].enabled = input.enabled;
      if (input.settings && typeof input.settings === 'object') {
        next[feature.id].settings = this.mergeSettings(next[feature.id].settings, input.settings);
      }
    }
    this.state = next;
    this.persist();
    this._snapshotCache = null;
    return true;
  }
}

module.exports = {
  FeatureStore,
};
