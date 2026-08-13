const DEFAULT_MAX_HOSTS = 2000;

function getFetch() {
  try {
    const fetchImpl = require('cross-fetch');
    return (fetchImpl && (fetchImpl.default || fetchImpl)) || global.fetch;
  } catch (e) {
    return global.fetch;
  }
}

function extractDomainsFromEasyList(text) {
  const domains = new Set();
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = String(raw || '').trim();
    if (!line) continue;
    // skip comments and cosmetic rules
    if (line.startsWith('!') || line.startsWith('[') || line.startsWith('#') || line.startsWith('@@')) continue;
    if (line.includes('##') || line.includes('#@#')) continue;

    let domain = null;
    try {
      if (line.startsWith('||')) {
        let rest = line.slice(2);
        const end = rest.search(/[\^\/\:\|]/);
        domain = end === -1 ? rest : rest.slice(0, end);
      } else if (/^https?:\/\//i.test(line) || line.startsWith('|http')) {
        // try to parse a URL
        let candidate = line.replace(/^\|?/, '');
        const splitAt = candidate.indexOf('^');
        if (splitAt !== -1) candidate = candidate.slice(0, splitAt);
        try {
          const u = new URL(candidate);
          domain = u.hostname;
        } catch (e) {
          domain = null;
        }
      } else {
        // fallback: look for domain-like substring
        const m = line.match(/(^|[^A-Za-z0-9-_.])([a-z0-9.-]+\.[a-z]{2,})([\/\^]|$)/i);
        if (m) domain = m[2];
      }
    } catch (e) { domain = null; }

    if (domain) {
      domain = domain.replace(/^\*\./, '').replace(/:.*$/, '').toLowerCase();
      if (domain && domain.length > 3 && domain.length < 255 && !domain.includes('*')) domains.add(domain);
    }
  }
  return Array.from(domains);
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function generateHostPatterns(listUrls, maxHosts = DEFAULT_MAX_HOSTS) {
  const fetch = getFetch();
  if (!Array.isArray(listUrls) || listUrls.length === 0) return [];
  const domains = new Set();
  for (const url of listUrls) {
    try {
      if (!fetch) break;
      const resp = await fetch(url, { redirect: 'follow' });
      if (!resp || !resp.ok) continue;
      const txt = await resp.text();
      const found = extractDomainsFromEasyList(txt);
      for (const d of found) {
        if (domains.size >= maxHosts) break;
        domains.add(d);
      }
      if (domains.size >= maxHosts) break;
    } catch (e) {
      // ignore fetch errors
    }
  }
  const patterns = Array.from(domains).map((d) => `*://*.${d}/*`);
  return patterns;
}

module.exports = { extractDomainsFromEasyList, generateHostPatterns };
