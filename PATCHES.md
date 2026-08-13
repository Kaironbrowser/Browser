> **STATUS: HISTORICAL / SUPERSEDED — pre-Beta 3.0 fix notes.**
> The installed @cliqz/adblocker-electron version is **1.34.0** (package.json
> declares `^1.5.1`). Coverage figures (e.g. "90%+") are **expected/unverified**.
> See **docs/CAPABILITIES.md** for the current code-verified state.

# EXACT PATCHES - COPY-PASTE READY

## PATCH 1: src/main/adblocker-service.js - Event Listeners

### CHANGE: Line 74 → Add request-blocked listener (PRIMARY FIX)

Replace this section (lines 74-95):

```javascript
      // Attach listener to record blocked network filters
      try {
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
                console.info('[adblock][native] blocked', payload.url, 'rule=', payload.rule, 'type=', payload.resourceType, 'domain=', payload.domain);
                try { this.onBlocked(payload); } catch (cbErr) { console.error('[adblock] onBlocked callback failed', cbErr && cbErr.stack ? cbErr.stack : cbErr); }
              } catch (e) {
                console.error('[adblock] filter-matched handler error', e && e.stack ? e.stack : e);
              }
            }
          } catch (e) {
            console.error('[adblock] filter-matched inner error', e && e.stack ? e.stack : e);
          }
        });
      } catch (e) {
        console.error('[adblock] failed to attach filter-matched listener', e && e.stack ? e.stack : e);
      }
```

With this code:

```javascript
      // Attach listeners to record blocked network filters
      // Try both event names for compatibility with different versions of @cliqz/adblocker-electron
      let eventAttached = false;
      try {
        // Try 'request-blocked' (correct event for 1.34.0+)
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
                console.info('[adblock][native] blocked via request-blocked', payload.url, 'type=', payload.resourceType, 'domain=', payload.domain);
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
                  console.info('[adblock][native] blocked via filter-matched', payload.url, 'rule=', payload.rule, 'type=', payload.resourceType, 'domain=', payload.domain);
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
```

### CHANGE: Lines 141-155 → Better enableBlockingInSession logging

Replace:

```javascript
        if (targetSession && typeof this.blocker.enableBlockingInSession === 'function') {
          try {
            console.info('[adblock] calling enableBlockingInSession...');
            this.blocker.enableBlockingInSession(targetSession);
            this.networkAttached = true;
            console.info('[adblock] enabled network blocking in session', partitionStr);
          } catch (e) {
            this.networkAttached = false;
            this._enableBlockingError = e && (e.stack || e.message || String(e));
            console.error('[adblock] enableBlockingInSession failed', this._enableBlockingError);
          }
        } else {
          console.info('[adblock] enableBlockingInSession not available for this blocker or session');
        }
```

With:

```javascript
        if (targetSession && typeof this.blocker.enableBlockingInSession === 'function') {
          try {
            console.info('[adblock] calling enableBlockingInSession with method available...');
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
```

---

## PATCH 2: src/main/main.js - Enhanced Fallback Blocker

### CHANGE: Lines 156-277 → Complete rewrite of attachAggressiveFallbackToSession()

See the main.js file for the full implementation. Key additions:
- Lines 174-192: Built-in tracker domain list
- Lines 200-275: Multi-tier pattern matching
- Lines 244-260: URL path pattern detection
- Line 295: Proper logging

### CHANGE: Lines 301-320 → Better diagnostics

Replace the diagnostics section with JSON format output.

---

## VERIFICATION CHECKLIST

After applying patches, verify:

1. [ ] Console shows `[adblock] attached request-blocked listener`
2. [ ] Console shows `[adblock] ✓ NATIVE BLOCKING ENABLED IN SESSION`
3. [ ] Console shows `[adblock] ✓ FALLBACK BLOCKER ATTACHED to webRequest.onBeforeRequest`
4. [ ] No errors in browser console
5. [ ] Diagnostics show both nativeBlocked and aggressiveBlocked counters
6. [ ] Test adblock.turtlecute.org shows 90%+ coverage
7. [ ] YouTube plays videos normally
8. [ ] Tabs work as expected

