const { session } = require('electron');

class FallbackBlocker {
  constructor({ partition = 'persist:browser', onBlocked } = {}) {
    this.session = session.fromPartition(partition);
    this.onBlocked = onBlocked || (() => {});

    // FAST LOOKUPS
    this.blockedDomains = new Set([
      'doubleclick.net',
      'googlesyndication.com',
      'googleadservices.com',
      'adservice.google.com',
      'pagead2.googlesyndication.com',
      'ads.yahoo.com',
      'adnxs.com',
      'taboola.com',
      'outbrain.com',
      'facebook.com/tr',
      'analytics.twitter.com',
    ]);

    this.blockedKeywords = [
      'ads', 'doubleclick', 'adserver', 'tracker',
      'analytics', 'pixel', 'beacon', 'promo'
    ];

    this.enabled = false;
  }

  start() {
    if (this.enabled) return;
    this.enabled = true;

    this.session.webRequest.onBeforeRequest(
      { urls: ['*://*/*'] },
      (details, callback) => {
        const url = details.url;
        const type = details.resourceType;
        const hostname = this._getHostname(url);

        let blocked = false;
        let reason = null;

        // 1. DOMAIN BLOCK
        if (hostname && this._isBlockedDomain(hostname)) {
          blocked = true;
          reason = 'domain';
        }

        // 2. KEYWORD BLOCK (URL PATH)
        if (!blocked && this._hasBlockedKeyword(url)) {
          blocked = true;
          reason = 'keyword';
        }

        // 3. RESOURCE TYPE FILTERING
        if (!blocked) {
          if (type === 'image' && this._isAdImage(url)) {
            blocked = true;
            reason = 'image-ad';
          }

          if (type === 'script' && this._isScriptAd(url)) {
            blocked = true;
            reason = 'script-ad';
          }

          if (type === 'iframe' && this._isBlockedDomain(hostname)) {
            blocked = true;
            reason = 'iframe-ad';
          }
        }

        if (blocked) {
          try {
            this.onBlocked({ url, hostname, type, reason });
          } catch (e) {}

          return callback({ cancel: true });
        }

        callback({});
      }
    );

    console.info('[fallback-blocker] ACTIVE');
  }

  stop() {
    try {
      this.session.webRequest.onBeforeRequest(null);
    } catch (e) {}
    this.enabled = false;
  }

  _getHostname(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return null;
    }
  }

  _isBlockedDomain(hostname) {
    if (!hostname) return false;

    if (this.blockedDomains.has(hostname)) return true;

    // subdomain support
    for (const domain of this.blockedDomains) {
      if (hostname.endsWith('.' + domain)) return true;
    }

    return false;
  }

  _hasBlockedKeyword(url) {
    const lower = url.toLowerCase();
    return this.blockedKeywords.some(k => lower.includes(k));
  }

  _isAdImage(url) {
    return url.includes('ad') || url.includes('banner') || url.includes('promo');
  }

  _isScriptAd(url) {
    return url.includes('ads') || url.includes('tracker') || url.includes('pixel');
  }
}

module.exports = { FallbackBlocker };