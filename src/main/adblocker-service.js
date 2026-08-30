const path = require('path');

// Per-request debug logging is gated behind this so production builds emit no
// console output for every blocked request. Enable with KAIRON_ADBLOCK_DIAG=1.
const ADBLOCK_DIAG = process.env.KAIRON_ADBLOCK_DIAG === '1';

function safeRequire(name) {
  try { return require(name); } catch (e) { return null; }
}

class AdblockerService {
  constructor({ lists, updateIntervalMs, onCss, onBlocked, mode } = {}) {
    // mode: 'off' | 'cosmetic' | 'full' | 'standard' | 'aggressive'
    // normalize to lowercase for consistent comparisons
    this.mode = typeof mode === 'string' ? String(mode).toLowerCase() : 'off';
    this.lists = Array.isArray(lists) && lists.length ? lists.slice() : [
      'https://easylist.to/easylist/easylist.txt',
      'https://easylist.to/easylist/easyprivacy.txt',
    ];
    this.updateIntervalMs = typeof updateIntervalMs === 'number' ? updateIntervalMs : 24 * 60 * 60 * 1000;
    this.onCss = typeof onCss === 'function' ? onCss : () => {};
    this.onBlocked = typeof onBlocked === 'function' ? onBlocked : () => {};
    this.blocker = null;
    this.css = '';
    this.ready = false;
    this.networkAttached = false; // whether enableBlockingInSession succeeded
    this._enableBlockingError = null;
    this._readyPromise = null;
    this._readyResolve = null;
    this._readyReject = null;
    this._blockedCount = 0;
    this._engineConfig = null;
  }

  async init(electronSession) {
    if (this.blocker) return this.blocker;
    this._readyPromise = new Promise((resolve, reject) => { this._readyResolve = resolve; this._readyReject = reject; });

    try {
      const pkg = safeRequire('@cliqz/adblocker-electron');
      if (!pkg) throw new Error('@cliqz/adblocker-electron not available');
      const fetchImpl = safeRequire('cross-fetch');
      const fetchFn = (fetchImpl && (fetchImpl.default || fetchImpl)) || global.fetch;

      const ElectronBlocker = pkg.ElectronBlocker || pkg.FiltersEngine || null;
      if (!ElectronBlocker || typeof ElectronBlocker.fromLists !== 'function') throw new Error('ElectronBlocker.fromLists not available');

      // Configure engine according to requested mode.
      // Support modes: 'off' | 'cosmetic' | 'full' | 'standard' | 'aggressive'
      // Standard and Aggressive enable network + cosmetic filters; cosmetic enables CSS-only.
      const envEnableNetwork = process.env.KAIRON_ENABLE_NATIVE_BLOCKER === '1';
      const normalized = (this.mode || 'off');
      const networkEnabled = envEnableNetwork || normalized === 'full' || normalized === 'standard' || normalized === 'aggressive';
      const cosmeticEnabled = normalized === 'cosmetic' || normalized === 'standard' || normalized === 'full' || normalized === 'aggressive';
      const engineConfig = {
        loadNetworkFilters: !!networkEnabled,
        loadCosmeticFilters: !!cosmeticEnabled,
        enableMutationObserver: true,
        guessRequestTypeFromUrl: true,
      };
      this._engineConfig = engineConfig;
      // Select appropriate lists based on mode
      let selectedLists = this.lists;
      if (normalized === 'aggressive' || normalized === 'full') {
        selectedLists = pkg.fullLists || selectedLists;
      } else if (normalized === 'standard') {
        selectedLists = pkg.adsAndTrackingLists || selectedLists;
      }

      // Build blocker using library helper
      this.blocker = await ElectronBlocker.fromLists(fetchFn, selectedLists, engineConfig);

      // Attach listeners to record blocked network filters
      // Try both event names for compatibility with different versions of @cliqz/adblocker-electron
      let eventAttached = false;
      try {
        // Try 'request-blocked' (correct event for v1.5.1+)
        if (typeof this.blocker.on === 'function') {
          this.blocker.on('request-blocked', (request) => {
            try {
              if (!request) return;
              this._blockedCount += 1;
              const payload = { 
                url: request.url || '', 
                rule: 'network-filter', 
                resourceType: request.type || request.resourceType || 'xhr', 
                domain: request.hostname || (() => { try { return new URL(request.url).hostname; } catch (e) { return ''; } })() 
              };
              if (payload.url) {
                if (ADBLOCK_DIAG) console.info('[adblock][native] blocked via request-blocked', payload.url, 'type=', payload.resourceType, 'domain=', payload.domain);
                try { this.onBlocked(payload); } catch (cbErr) { console.error('[adblock] onBlocked callback failed', cbErr && cbErr.stack ? cbErr.stack : cbErr); }
              }
            } catch (e) {
              console.error('[adblock] request-blocked handler error', e && e.stack ? e.stack : e);
            }
          });
          eventAttached = true;
          console.info('[adblock] attached request-blocked listener');
        }
      } catch (e) {
        console.error('[adblock] failed to attach request-blocked listener', e && e.stack ? e.stack : e);
      }

      // Also try filter-matched (older event name, for compatibility)
      try {
        if (typeof this.blocker.on === 'function' && !eventAttached) {
          this.blocker.on('filter-matched', (info, ctx) => {
            try {
              if (!ctx || ctx.filterType === undefined) return;
              const FilterType = pkg.FilterType || (pkg.FiltersEngine && pkg.FiltersEngine.FilterType) || null;
              const isNetwork = FilterType ? ctx.filterType === FilterType.NETWORK : (ctx.filterType === 'network' || ctx.filterType === 1);
              if (!isNetwork) return;
              const req = (ctx && ctx.request) || (ctx && ctx.requestObj) || null;
              const blocked = !!(info && info.filter) && !(info && info.exception);
              const rule = info && info.filter && typeof info.filter.getId === 'function' ? info.filter.getId() : (info && info.filter ? String(info.filter) : null);
              if (blocked) {
                this._blockedCount += 1;
                try {
                  const payload = { url: req && req.url, rule, resourceType: req && req.type, domain: req && req.hostname };
                  if (ADBLOCK_DIAG) console.info('[adblock][native] blocked via filter-matched', payload.url, 'rule=', payload.rule, 'type=', payload.resourceType, 'domain=', payload.domain);
                  try { this.onBlocked(payload); } catch (cbErr) { console.error('[adblock] onBlocked callback failed', cbErr && cbErr.stack ? cbErr.stack : cbErr); }
                } catch (e) {
                  console.error('[adblock] filter-matched handler error', e && e.stack ? e.stack : e);
                }
              }
            } catch (e) {
              console.error('[adblock] filter-matched inner error', e && e.stack ? e.stack : e);
            }
          });
          console.info('[adblock] attached filter-matched listener');
        }
      } catch (e) {
        console.error('[adblock] failed to attach filter-matched listener', e && e.stack ? e.stack : e);
      }

      // Enable network blocking in session only when configured
      if (engineConfig.loadNetworkFilters) {
        this.networkAttached = false;
        this._enableBlockingError = null;
        const electron = require('electron');
        let targetSession = electronSession || (electron.session && electron.session.defaultSession);
        try {
          if (!targetSession && electron && electron.session && typeof electron.session.fromPartition === 'function') {
            targetSession = electron.session.fromPartition('persist:browser');
            console.warn('[adblock] electronSession not provided; falling back to persist:browser session');
          }
        } catch (e) {
          console.error('[adblock] failed to resolve target session', e && e.stack ? e.stack : e);
        }

        const partitionStr = (targetSession && typeof targetSession.getPartition === 'function') ? targetSession.getPartition() : '(unknown)';
        if (partitionStr !== 'persist:browser') {
          console.warn('[adblock] target session partition is not "persist:browser" — ensure BrowserViews use same partition');
        }

        if (targetSession && typeof this.blocker.enableBlockingInSession === 'function') {
          try {
            this.blocker.enableBlockingInSession(targetSession);
            this.networkAttached = true;
            console.info('[adblock] ✓ NATIVE BLOCKING ENABLED IN SESSION', partitionStr);
          } catch (e) {
            this.networkAttached = false;
            this._enableBlockingError = e && (e.stack || e.message || String(e));
            console.error('[adblock] ✗ NATIVE enableBlockingInSession failed:', this._enableBlockingError);
          }
        } else if (targetSession) {
          console.warn('[adblock] ✗ enableBlockingInSession method NOT AVAILABLE on blocker or session');
          this.networkAttached = false;
          this._enableBlockingError = 'enableBlockingInSession method not available';
        } else {
          console.warn('[adblock] ✗ target session is null/undefined - cannot enable network blocking');
          this.networkAttached = false;
          this._enableBlockingError = 'target session is null';
        }
      }

      // Provide CSS for cosmetic filters if available
      try {
        let css = '';
        if (typeof this.blocker.getCSS === 'function') css = this.blocker.getCSS();
        else if (typeof this.blocker.getCss === 'function') css = this.blocker.getCss();
        else if (typeof this.blocker.generateCSS === 'function') css = this.blocker.generateCSS();
        this.css = css || '';
        try { this.onCss(this.css); } catch (e) { console.error('[adblock] onCss callback failed', e && e.stack ? e.stack : e); }
      } catch (e) { console.error('[adblock] failed to generate/get CSS', e && e.stack ? e.stack : e); }

      this.ready = true;
      if (this._readyResolve) this._readyResolve(true);
      console.info('[adblock] native engine ready');
      return this.blocker;
    } catch (err) {
      if (this._readyReject) this._readyReject(err);
      console.error('[adblock] init failed', err && err.stack ? err.stack : err);
      throw err;
    }
  }

  async requestUpdate() {
    // The native engine supports building from lists again; for now just rebuild
    if (!this.blocker) return;
    try {
      const pkg = safeRequire('@cliqz/adblocker-electron');
      const fetchImpl = safeRequire('cross-fetch');
      const fetchFn = (fetchImpl && (fetchImpl.default || fetchImpl)) || global.fetch;
      const ElectronBlocker = pkg && (pkg.ElectronBlocker || pkg.FiltersEngine);
      if (ElectronBlocker && typeof ElectronBlocker.fromLists === 'function') {
        const normalized = String(this.mode || 'off').toLowerCase();
        let selectedLists = this.lists;
        if (normalized === 'aggressive' || normalized === 'full') {
          selectedLists = pkg.fullLists || selectedLists;
        } else if (normalized === 'standard') {
          selectedLists = pkg.adsAndTrackingLists || selectedLists;
        }

        const newBlocker = await ElectronBlocker.fromLists(fetchFn, selectedLists, this._engineConfig || {});
        // Swap and re-enable on same sessions
        if (this._engineConfig.loadNetworkFilters) {
          try {
            if (typeof newBlocker.enableBlockingInSession === 'function') {
              newBlocker.enableBlockingInSession(require('electron').session.fromPartition('persist:browser'));
              this.networkAttached = true;
              console.info('[adblock] re-enabled network blocking on new blocker');
            }
          } catch (e) {
            this.networkAttached = false;
            console.error('[adblock] re-enableBlockingInSession failed', e && e.stack ? e.stack : e);
          }
        }
        this.blocker = newBlocker;
      }
    } catch (e) {
      console.error('[adblock] requestUpdate failed', e && e.stack ? e.stack : e);
    }
  }

  getStats() {
    return { blocked: this._blockedCount || 0 };
  }

  destroy() {
    try {
      if (this.blocker && typeof this.blocker.disableBlockingInSession === 'function') {
        try {
          this.blocker.disableBlockingInSession(require('electron').session.fromPartition('persist:browser'));
          console.info('[adblock] disabled blocking in session');
        } catch (e) {
          console.error('[adblock] disableBlockingInSession failed', e && e.stack ? e.stack : e);
        }
      }
    } catch (e) {
      console.error('[adblock] destroy error', e && e.stack ? e.stack : e);
    }
    this.blocker = null;
    this.ready = false;
    this.networkAttached = false;
  }
}

module.exports = { AdblockerService };
