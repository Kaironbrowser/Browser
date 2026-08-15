// One-off structural edit for src/renderer/settings.html (CRLF preserved).
const fs = require('fs');
const path = require('path');

const p = path.join(__dirname, '..', 'src', 'renderer', 'settings.html');
let s = fs.readFileSync(p, 'utf8');
s = s.replace(/\r\n/g, '\n');

const reps = [
  // 1. search box -> real input
  ['<div class="search" role="search" tabindex="0" aria-label="Search settings"><svg viewBox="0 0 24 24">\n          <circle cx="10.8" cy="10.8" r="6.6" />\n          <path d="m16 16 5 5" />\n        </svg><span>Search settings</span><kbd>Ctrl+F</kbd></div>',
   '<div class="search" role="search" aria-label="Search settings"><svg viewBox="0 0 24 24">\n          <circle cx="10.8" cy="10.8" r="6.6" />\n          <path d="m16 16 5 5" />\n        </svg><input id="settings-search" type="text" placeholder="Search settings" aria-label="Search settings" spellcheck="false"><kbd>Ctrl+F</kbd></div>'],
  // 2. nav id
  ['<nav class="nav">', '<nav class="nav" id="nav">'],
  // 3-6. nav-item data-cat
  ['<div class="nav-item active" role="button" tabindex="0" aria-current="page"><svg viewBox="0 0 24 24">',
   '<div class="nav-item active" data-cat="appearance" role="button" tabindex="0" aria-current="page"><svg viewBox="0 0 24 24">'],
  ['<div class="nav-item" role="button" tabindex="0"><svg viewBox="0 0 24 24">\n            <path d="M12 3 19 6v5c0 4.6-2.8 8.1-7 10-4.2-1.9-7-5.4-7-10V6l7-3Z" />',
   '<div class="nav-item" data-cat="privacy" role="button" tabindex="0"><svg viewBox="0 0 24 24">\n            <path d="M12 3 19 6v5c0 4.6-2.8 8.1-7 10-4.2-1.9-7-5.4-7-10V6l7-3Z" />'],
  ['<div class="nav-item" role="button" tabindex="0"><svg viewBox="0 0 24 24">\n            <rect x="5" y="10" width="14" height="11" rx="2" />',
   '<div class="nav-item" data-cat="security" role="button" tabindex="0"><svg viewBox="0 0 24 24">\n            <rect x="5" y="10" width="14" height="11" rx="2" />'],
  ['<div class="nav-item" role="button" tabindex="0"><svg viewBox="0 0 24 24">\n            <path d="M5 4v5M5 15v5M12 4v9M12 19v1M19 4v2M19 12v8" />',
   '<div class="nav-item" data-cat="advanced" role="button" tabindex="0"><svg viewBox="0 0 24 24">\n            <path d="M5 4v5M5 15v5M12 4v9M12 19v1M19 4v2M19 12v8" />'],
  // 7. page-subtitle id
  ['<p class="page-subtitle">Customize how Kairon looks and how tabs are arranged.</p>',
   '<p id="page-subtitle" class="page-subtitle">Customize how Kairon looks and how tabs are arranged.</p>'],
  // 8-12. section data-cat (+ hidden on non-appearance)
  ['      <section class="section">\n        <h2 class="section-label">Theme</h2>',
   '      <section class="section" data-cat="appearance">\n        <h2 class="section-label">Theme</h2>'],
  ['      <section class="section">\n        <h2 class="section-label">Tabs</h2>',
   '      <section class="section" data-cat="appearance">\n        <h2 class="section-label">Tabs</h2>'],
  ['      <section class="section privacy">\n        <h2 class="section-label">Privacy</h2>',
   '      <section class="section privacy" data-cat="privacy" hidden>\n        <h2 class="section-label">Privacy</h2>'],
  ['      <section class="section security">\n        <h2 class="section-label">Security</h2>',
   '      <section class="section security" data-cat="security" hidden>\n        <h2 class="section-label">Security</h2>'],
  ['      <section class="section">\n        <h2 class="section-label">Advanced</h2>',
   '      <section class="section" data-cat="advanced" hidden>\n        <h2 class="section-label">Advanced</h2>'],
  // 13-14. segments
  ['<div class="segmented"><button class="segment selected">Dark</button><button class="segment">Light</button>',
   '<div class="segmented"><button class="segment selected" data-feature="themeSystem" data-setting="mode" data-value="dark">Dark</button><button class="segment" data-feature="themeSystem" data-setting="mode" data-value="light">Light</button>'],
  ['<div class="segmented"><button class="segment selected">Sidebar</button><button class="segment">Top</button>',
   '<div class="segmented"><button class="segment selected" data-feature="themeSystem" data-setting="tabPosition" data-value="sidebar">Sidebar</button><button class="segment" data-feature="themeSystem" data-setting="tabPosition" data-value="top">Top</button>'],
  // 15-18. switches
  ['Block ads and trackers across the web.</div>\n            </div><span class="switch" role="switch" tabindex="0" aria-checked="true" aria-label="On"></span>',
   'Block ads and trackers across the web.</div>\n            </div><span class="switch" role="switch" tabindex="0" aria-checked="true" aria-label="On" data-feature="adBlocker"></span>'],
  ['Always connect to websites using HTTPS when available.</div>\n            </div><span class="switch" role="switch" tabindex="0" aria-checked="true" aria-label="On"></span>',
   'Always connect to websites using HTTPS when available.</div>\n            </div><span class="switch" role="switch" tabindex="0" aria-checked="true" aria-label="On" data-feature="httpsOnlyMode"></span>'],
  ['Prevent websites from discovering your real IP via WebRTC.</div>\n            </div><span class="switch" role="switch" tabindex="0" aria-checked="true" aria-label="On"></span>',
   'Prevent websites from discovering your real IP via WebRTC.</div>\n            </div><span class="switch" role="switch" tabindex="0" aria-checked="true" aria-label="On" data-feature="webRtcProtection"></span>'],
  ['Resolve DNS queries over an encrypted connection.</div>\n            </div><span class="switch" role="switch" tabindex="0" aria-checked="true" aria-label="On"></span>',
   'Resolve DNS queries over an encrypted connection.</div>\n            </div><span class="switch" role="switch" tabindex="0" aria-checked="true" aria-label="On" data-feature="dnsOverHttps"></span>'],
  // 19. blocking level select
  ['</div><select class="select" aria-label="Blocking level">\n              <option>Standard</option>\n            </select>',
   '</div><select class="select" data-feature="adBlocker" data-setting="mode" aria-label="Blocking level">\n              <option value="off">Off</option>\n              <option value="standard">Standard</option>\n              <option value="aggressive">Aggressive</option>\n            </select>'],
  // 20. DNS provider select
  ['</div><select class="select" aria-label="DNS provider">\n                <option>Cloudflare (1.1.1.1)</option>\n              </select>',
   '</div><select class="select" data-feature="dnsOverHttps" data-setting="provider" aria-label="DNS provider">\n                <option value="off">Off \u2014 use system DNS</option>\n                <option value="cloudflare">Cloudflare (1.1.1.1)</option>\n                <option value="quad9">Quad9</option>\n                <option value="custom">NextDNS / custom URL</option>\n              </select>'],
  // 21-22. nested rows
  ['<div class="row">\n              <div class="row-copy">\n                <div class="row-title">DNS provider</div>',
   '<div class="row" data-dns-row="provider">\n              <div class="row-copy">\n                <div class="row-title">DNS provider</div>'],
  ['<div class="row">\n              <div class="row-copy">\n                <div class="row-title">Custom DNS URL</div>',
   '<div class="row" data-dns-row="customUrl" hidden>\n              <div class="row-copy">\n                <div class="row-title">Custom DNS URL</div>'],
  // 23. custom url input
  ['</div><input class="text-input" placeholder="https://dns.example.com/dns-query"\n                aria-label="Custom DNS URL">',
   '</div><input class="text-input" type="url" data-feature="dnsOverHttps" data-setting="customUrl" placeholder="https://dns.example.com/dns-query"\n                aria-label="Custom DNS URL">'],
  // 24. site blocker row
  ['<div class="row" role="button" tabindex="0"><svg class="row-icon" viewBox="0 0 24 24">\n              <circle cx="12" cy="12" r="8.5" />\n              <path d="m6 6 12 12" />',
   '<div class="row" data-action="site-blocker" role="button" tabindex="0"><svg class="row-icon" viewBox="0 0 24 24">\n              <circle cx="12" cy="12" r="8.5" />\n              <path d="m6 6 12 12" />'],
  // 25-27. advanced actions
  ['<div class="action" role="button" tabindex="0"><svg class="row-icon" viewBox="0 0 24 24">\n              <path d="M12 3v12M8 7l4-4 4 4M5 13v6h14v-6" />',
   '<div class="action" data-action="export" role="button" tabindex="0"><svg class="row-icon" viewBox="0 0 24 24">\n              <path d="M12 3v12M8 7l4-4 4 4M5 13v6h14v-6" />'],
  ['<div class="action" role="button" tabindex="0"><svg class="row-icon" viewBox="0 0 24 24">\n              <path d="M12 3v12M8 11l4 4 4-4M5 13v6h14v-6" />',
   '<div class="action" data-action="import" role="button" tabindex="0"><svg class="row-icon" viewBox="0 0 24 24">\n              <path d="M12 3v12M8 11l4 4 4-4M5 13v6h14v-6" />'],
  ['<div class="action" role="button" tabindex="0"><svg class="row-icon" viewBox="0 0 24 24">\n              <circle cx="12" cy="12" r="8.5" />',
   '<div class="action" data-action="reset" role="button" tabindex="0"><svg class="row-icon" viewBox="0 0 24 24">\n              <circle cx="12" cy="12" r="8.5" />'],
];

let failed = 0;
for (const [o, n] of reps) {
  if (!s.includes(o)) { console.error('MISS:', JSON.stringify(o.slice(0, 90))); failed++; continue; }
  s = s.split(o).join(n);
}

// CSS additions before </style>
const cssAdd = `
    [hidden] { display: none !important; }
    .search input { flex: 1; min-width: 0; background: transparent; border: 0; outline: 0; padding: 0; font-size: 10px; color: #e2e2e2; }
    .search input::placeholder { color: #555; }
    .search:focus-within { border-color: #3a3a3a; }
    .row.is-dimmed { opacity: .4; pointer-events: none; }
    .row.flash { animation: row-flash .9s ease; }
    @keyframes row-flash { 0% { background: #1d1d1d; } 100% { background: transparent; } }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, .55); display: flex; align-items: flex-start; justify-content: center; padding: 76px 20px 20px; z-index: 50; opacity: 0; transition: opacity .18s ease; }
    .modal-overlay.open { opacity: 1; }
    .modal { width: 100%; max-width: 460px; background: var(--panel); border: 1px solid var(--line); border-radius: 3px; padding: 22px 24px; }
    .modal-title { margin: 0 0 8px; font-size: 15px; font-weight: 600; color: var(--text); }
    .modal-text { margin: 0 0 14px; font-size: 11px; line-height: 17px; color: var(--muted); }
    .modal-label { display: block; font-size: 9px; letter-spacing: .25px; text-transform: uppercase; color: #909090; margin: 0 0 6px; }
    .modal-textarea { width: 100%; min-height: 120px; background: #070707; border: 1px solid #242424; border-radius: 4px; color: #ddd; font-size: 11px; line-height: 16px; padding: 9px 11px; resize: vertical; outline: none; font-family: inherit; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
    .modal-btn { height: 30px; padding: 0 16px; border: 1px solid #202020; background: #080808; color: #9b9b9b; border-radius: 3px; font-size: 10px; transition: background .16s ease, border-color .16s ease; }
    .modal-btn:hover { background: #101010; border-color: #303030; }
    .modal-btn-solid { background: #f1f1f1; border-color: #f1f1f1; color: #171717; }
    .modal-btn-solid:hover { background: #fff; border-color: #fff; }
    .modal-btn.btn-danger { background: #f1f1f1; border-color: #f1f1f1; color: #171717; }
    .toast { position: fixed; left: 50%; bottom: 26px; transform: translate(-50%, 8px); background: #f1f1f1; color: #171717; font-size: 10px; padding: 9px 16px; border-radius: 3px; z-index: 60; opacity: 0; transition: opacity .18s ease, transform .18s ease; pointer-events: none; }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
  </style>`;
if (!s.includes('  </style>')) { console.error('MISS: </style>'); failed++; }
else s = s.replace('  </style>', cssAdd);

// Replace the placeholder inline script with modal + toast + settings-page.js
const scriptStart = s.lastIndexOf('<script>');
const scriptEnd = s.lastIndexOf('</script>');
if (scriptStart === -1 || scriptEnd === -1 || scriptEnd < scriptStart) { console.error('MISS: script block'); failed++; }
else {
  const modalHtml = '  <div id="modal-overlay" class="modal-overlay" hidden>\n' +
    '    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">\n' +
    '      <h3 id="modal-title" class="modal-title"></h3>\n' +
    '      <p id="modal-text" class="modal-text" hidden></p>\n' +
    '      <label id="modal-textarea-label" class="modal-label" for="modal-textarea" hidden></label>\n' +
    '      <textarea id="modal-textarea" class="modal-textarea" rows="6" spellcheck="false" hidden></textarea>\n' +
    '      <div class="modal-actions">\n' +
    '        <button id="modal-cancel" class="modal-btn" type="button">Cancel</button>\n' +
    '        <button id="modal-confirm" class="modal-btn modal-btn-solid" type="button">Confirm</button>\n' +
    '      </div>\n' +
    '    </div>\n' +
    '  </div>\n' +
    '  <div id="toast" class="toast" hidden></div>\n' +
    '\n' +
    '  <script src="settings-page.js"></script>';
  s = s.slice(0, scriptStart) + modalHtml + s.slice(scriptEnd + '</script>'.length);
}

fs.writeFileSync(p, s.replace(/\n/g, '\r\n'));
console.log(failed === 0 ? 'ALL REPLACEMENTS APPLIED' : failed + ' REPLACEMENT(S) MISSED');
process.exit(failed === 0 ? 0 : 1);
