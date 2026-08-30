// ── FAVICON URL SANITIZER ──────────────────────────────────────
// Validates favicon URLs for safe use in img src attributes.
// Only allows http:, https:, and data:image/* protocols.
// Rejects javascript:, vbscript:, file:, blob:, and other dangerous schemes.
// Escapes HTML-attribute-breaking characters (", ', <, >, &).
// Returns empty string for any invalid/malicious URL.

const ALLOWED_FAVICON_PROTOCOLS = new Set(['http:', 'https:', 'data:']);

function sanitizeFaviconUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url);
    if (!ALLOWED_FAVICON_PROTOCOLS.has(parsed.protocol)) return '';
    // Only allow data: URLs that represent images (favicons are always images)
    if (parsed.protocol === 'data:') {
      const lower = url.toLowerCase();
      if (!lower.startsWith('data:image/')) return '';
    }
  } catch {
    return '';
  }
  // HTML-attribute safe: escape quotes, angle brackets, and other special chars
  return url.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export { sanitizeFaviconUrl };
