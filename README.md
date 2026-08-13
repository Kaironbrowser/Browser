# Kairon Browser Capabilities

This document describes what Kairon Browser **actually does right now**, verified against the current source code (`src/main`, `src/renderer`, `package.json`). Where a capability is only partially implemented, it is marked **partial**. Things that appear in settings or documentation but are not wired up in code are listed in **§15 Not Implemented / Planned** instead of being presented as capabilities.

---

## 1. Browser Core

- **Engine**: Electron + Chromium. Single frameless `BrowserWindow` (default 1400×900, min 900×600) with a **custom title bar** (minimize / maximize / close buttons) and an 8px `-webkit-app-region: drag` strip at the top of the chrome bar for dragging the window.
- **Tabs are `BrowserView` instances**, one per tab, all attached to the window one at a time. Each view uses `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and the `persist:browser` session partition.
- **Startup**: window is maximized at launch; if the saved window bounds are off-screen, it is repositioned onto the primary display (`ensureWindowVisible`). Window position/size are **not** persisted between launches.
- **Address bar (omnibar)**:
  - Typing `Enter` navigates. Input is normalized in the main process: explicit `http:`/`https:` URLs pass through, domain-like strings get `https://` prefixed, anything else becomes a **Brave Search** query (`https://search.brave.com/search?q=…`).
  - `home` or `kairon://home` opens the internal home page; `kairon://history` opens the internal history page.
  - Invalid targets (non-http(s) protocols, >2048 chars, unparseable) are rejected and the UI flashes an "Invalid address" state.
  - Suggestions are rendered in a **separate transparent overlay window** (see §9).
- **Navigation buttons**: Back / Forward (enabled per the active tab's `navigationHistory.canGoBack/Forward`) and Reload (see note on stop, §15). There is no dedicated Home button — the home page is reached via a new tab, the address bar (`home`), or `Ctrl+H`-style navigation to `kairon://home`.
- **Popups**: `window.open` is intercepted and opened as a new Kairon tab (`popup-blocker` rule); popups are never allowed as separate windows.
- **Open Link in New Window** (context menu) creates a standalone plain `BrowserWindow` (no Kairon chrome) loading the URL.
- **Page zoom**: per-tab zoom factor clamped to 0.25–5.0, stepped presets, `Ctrl+=`/`Ctrl+-`/`Ctrl+0` and on-screen buttons with a live percentage readout. Zoom applies per-tab and is reapplied on `dom-ready`/`did-finish-load`; it is **not** persisted across restarts.
- **Search engine**: Brave Search is hardcoded as the only search provider (address bar, context menu "Search", home page form).
- **Internal pages**: home page (`kairon://home` → `home.html`), history page (`kairon://history` → `history.html`), HTTPS-Only warning page, and a generated "This site cannot be reached" load-error page (shown on `did-fail-load`).

## 2. Tab Management

- **New tab**: New Tab buttons (rail + top bar), `Ctrl+T`, and the tab context menu → opens the home page.
- **Close tab**: close button, **middle-click** on a tab, `Ctrl+W`, and tab context menu. Closing the last tab creates a fresh home tab; closing the active tab activates the tab at its former position (or the new last tab).
- **Reopen closed tab**: `Ctrl+Shift+T` and the tab context menu item. An **in-memory** stack (max 20) records url, title, zoom, pinned state, and position; restore returns the tab to its original slot within its pinned/normal group. The stack is **not** persisted across restarts.
- **Switching**: click a tab, or `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle in visual order (Map insertion order, wraps at both ends). Keyboard focus is handed to the switched page so shortcuts work immediately.
- **Reordering**: drag-and-drop in both tab modes (see §10 "Tab Reorder").
- **Duplicate tab**: tab context menu → new tab with same URL + zoom, inserted immediately right of the source, preserves pinned state, becomes active.
- **Pin / unpin**: tab context menu toggle. Pinned tabs always lead the tab order; bulk-close actions (Close Others / Close to the Right) never close pinned tabs.
- **Close Others / Close Tabs to the Right**: tab context menu actions.
- **Restore on startup**: last session (up to 20 tabs + active id) is restored from `electron-store` (see §11). This happens unconditionally — the `restoreOnStartup` setting is registered but not consulted (see §15).
- **Animations**: new tabs fade in, closed tabs collapse (with the neighbors reflowing), loading dots fade out; `prefers-reduced-motion` disables these.
- **Indicators**: loading dot per tab + omnibar spinner; sleeping badge; hover tooltips.

## 3. Navigation

- Address-bar navigation, back/forward/reload buttons, `Ctrl+[` / `Ctrl+]` and `Alt+Left` / `Alt+Right` back/forward.
- **URL validation** in the main process on every `will-navigate`: only `http:`/`https:` (plus `about:`, `data:`, `blob:`, `file:`) are allowed; blocked navigation sends an `adblock-event` with rule `navigation-invalid` or `site-blocker`.
- **HTTPS-Only mode** (default **on**): plain-http main-frame navigations are upgraded to HTTPS; failed upgrades show a warning page with "Proceed to insecure site" / "Go back"; `will-redirect` to http is also prevented.
- **Site Blocker** (default **off**): a user-managed list of host patterns (supports `*.example.com` wildcards) blocks navigation in the address bar, history entries, and `will-navigate`.
- **Popups** open as tabs (see §1); the popup host allowlist is empty, so every `window.open` becomes a new tab.
- **Downloads**: there is **no download manager** — downloads are handled by Electron/Chromium defaults (no Kairon prompts or progress UI). `will-download` is only observed to keep tabs with active downloads from sleeping. "Save Image As…" (context menu) is the one implemented download path (native save dialog + `net.fetch`).

## 4. Keyboard Shortcuts

All verified in code. Modifier is **Ctrl** (Meta on macOS) unless noted.

| Shortcut | Where handled | Action |
|---|---|---|
| `Ctrl+T` | Main (`before-input-event`, page & chrome) + renderer | New tab |
| `Ctrl+Shift+T` | Main only (page & chrome) | Reopen last closed tab |
| `Ctrl+W` | Main (page & chrome) + renderer | Close active tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Main (page & chrome) | Cycle tabs (visual order, wraps) |
| `F11` | Main (page & chrome) | Toggle window fullscreen; exits content fullscreen if a site is fullscreen |
| `Ctrl+R` | Renderer (chrome focus); default Electron menu accelerator in pages | Reload |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Main (page) + renderer (chrome) | Zoom in / out / reset |
| `Ctrl+L` | Renderer | Focus + select address bar |
| `Ctrl+K` | Renderer | Focus + select address bar (commands hint) |
| `Ctrl+H` | Renderer | Open history page in active tab |
| `Ctrl+[` / `Ctrl+]` | Renderer | Back / Forward |
| `Alt+Left` / `Alt+Right` | Renderer | Back / Forward |
| `Ctrl+,` | Renderer (`renderer.js`) | Open Settings window |
| `Enter` | Renderer | Navigate from address bar |
| `Esc` | Renderer | Blur address bar / close suggestions; cancels a tab drag; closes settings; closes history confirm modal |
| `↑` / `↓` | Renderer | Navigate address-bar suggestions |
| `Shift+Enter` in AI input | Renderer | Newline (Enter alone sends) |
| `Escape` / drag cancel | Renderer | See §10 |

**Not implemented**: `F5`, `Ctrl+1…9` tab selection, `Ctrl+Shift+P`, `Ctrl+Shift+I`, and any other shortcuts not listed above. `Ctrl+Alt+Tab` is deliberately left untouched (never intercepted).

## 5. History & Local Storage

- **Browsing history** is stored in an embedded **SQLite** database via **better-sqlite3**:
  - File: `kairon.db` inside Electron's `userData` directory.
  - `journal_mode = WAL`, `synchronous = NORMAL`.
  - Table `history(id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT NOT NULL UNIQUE, title TEXT, favicon TEXT, lastVisited INTEGER NOT NULL, visitCount INTEGER NOT NULL DEFAULT 1)`.
  - Indexes: unique `idx_history_url(url)` and `idx_history_last_visited(lastVisited DESC)`.
- **Recording**: entries are upserted on main-frame `did-navigate`, on `page-title-updated`, and on `page-favicon-updated`. Revisits increment `visitCount` and refresh `lastVisited`/title/favicon. Internal protocols (`about:`, `chrome:`, `devtools:`, `file:`, `data:`, `blob:`, `chrome-extension:`, `kairon:`) are never recorded.
- **Favicons**: the real page favicon (from `page-favicon-updated`) is stored; otherwise one is derived from Google's public favicon service (`google.com/s2/favicons`).
- **Search**: case-insensitive substring match on `title` and `url`, ordered `lastVisited DESC` (IPC: `history-search`).
- **Delete / Clear**: single-entry delete by id and full clear (clear also resets the autoincrement sequence). The history page confirms "Clear History" via a modal.
- **Migration**: on first run with an existing legacy `history.json`, entries are imported transactionally into SQLite and the original `history.json` is **retained as a backup**. No other backup/corruption handling exists beyond try/catch around operations.
- **History page UI** (`history.html`, loaded in a tab): loads up to 10,000 entries, groups by Today/Yesterday/This Week/Earlier This Month/Older, shows per-day stats (pages visited, total visits, unique domains, "time browsing" — which is always 0 because `timeSpent` is never recorded), "Most Visited Today" (top 5), per-entry delete, search-as-you-type, and collapsible groups. Bookmark buttons are **decorative only** (in-memory, per-session).
- **Address-bar history** is separate: the last 100 entered URLs are kept in `localStorage` (`kairon:address-history`) and feed suggestions.

## 6. Fullscreen & Window Management

Two independent fullscreen modes that never fight:

- **F11 / window fullscreen** toggles the Kairon window itself (`userWindowFullscreen` tracks intent rather than `isFullScreen()`).
- **Content fullscreen** (HTML Fullscreen API — YouTube, `<video>`, etc.): on `enter-html-full-screen` the window is put into fullscreen so the active view covers the whole screen; on `leave-html-full-screen` (page ESC/`exitFullscreen()`) the window returns to whatever state it was in before (F11 state is remembered via `windowFullscreenBeforeHtml`).
- **F11 pressed while a site is fullscreen** exits the content fullscreen (same as ESC) instead of toggling the window.
- **Closing a tab that is in content fullscreen** restores the window state.
- **Transition handling**: `enter-full-screen` marks a ~400 ms transition window during which the view is *not* repositioned with chrome-offset metrics (prevents the viewport jump / black band bug), then re-applies settled bounds.
- Window controls: minimize, maximize/unmaximize toggle, close (all via IPC from the custom title bar).
- Alt+Tab return: the window `focus` handler hands keyboard focus to the active page **unless** a chrome text input (address bar / AI input) was focused at blur — that focus is preserved.

## 7. Tab Sleeping & Performance

- **Tab Sleep** (main process `tab-sleep.js` + `TabSleepManager`):
  - A tab sleeps after **7 minutes** of inactivity (checked by a **30-second** sweep). `lastActiveAt` refreshes whenever a tab is activated.
  - Never slept: the active tab, pinned tabs, tabs playing media (`media-started-playing`), tabs capturing camera/mic/screen, tabs with active downloads.
  - On sleep: `setBackgroundThrottling(true)`, `setAudioMuted(true)`, `setFrameRate(1)`.
  - On wake: throttling off, audio unmuted, `setFrameRate(60)`.
  - Automatic wake: activating the tab, or media starting on it. Manual wake: tab context menu "Wake Tab" (background wake, no focus change).
  - Sleeping tabs are **throttled, never destroyed or reloaded** — page state is preserved.
  - UI: crescent-moon badge + "Sleeping Tab / Paused after 7 minutes of inactivity" tooltip; state flows through `tabs-state` (no polling).
  - Memory-saver statistics are **not** implemented (`getEstimatedMemorySaved()` returns 0; no UI).
- **Other verified optimizations**:
  - Patch-based tab rendering: tab strip DOM is patched in place; unchanged fields (title/favicon/active) skip DOM writes.
  - Favicon caching per tab URL (description recomputed only when the URL changes).
  - Bounds caching in the main process: redundant `setBounds()` calls are skipped (`_lastBounds`).
  - Debounced layout-metrics IPC (150 ms) with immediate variants for deliberate actions (AI panel toggle, startup).
  - Debounced session persistence (500 ms) with a final flush on quit.
  - No-op render guards: URL/title/loading handlers bail when the value didn't change.
  - Debounced (150 ms) DOM-MutationObserver → cosmetic CSS re-application.
  - `requestAnimationFrame`-throttled scroll handling in the AI panel.
  - Fallback adblocker URL decision cache (LRU, 5,000 entries, 30-min TTL for blocked URLs).
  - All hot-path diagnostics are gated (`DIAG`) so production builds emit no per-request/per-bounds logging.

## 8. Privacy & Security

Only mechanisms present in code are listed; none are guaranteed protections.

- **Chromium telemetry switches**: at startup, `app.commandLine.appendSwitch` disables background networking, crash reporting (`disable-breakpad`, `disable-crash-reporter`), metrics, sync, translate, variations/field trials, first-run UI, default apps, cloud import, and component updates. `password-store basic` + `use-mock-keychain` are set.
- **Telemetry request blocker** (`installTelemetryRequestBlocker`): a `webRequest.onBeforeRequest` dispatcher on both `session.defaultSession` and `persist:browser` cancels requests to known Google telemetry hosts (`safebrowsing.googleapis.com`, `clients2.google.com`, `update.googleapis.com`, `optimizationguide-pa.googleapis.com`, `play.google.com/log*`, etc.). It preserves the adblocker's own listener by chaining it downstream (Electron allows one `onBeforeRequest` listener per session).
- **Ad blocking** (`@cliqz/adblocker-electron`): engine built from EasyList + EasyPrivacy (fetched at init; `fullLists`/`adsAndTrackingLists` per mode); network blocking via `enableBlockingInSession(persist:browser)`; block events via the `request-blocked` listener (with `filter-matched` fallback). Modes: `off | cosmetic | full | standard | aggressive`; the UI exposes **Off / Standard / Aggressive** (shields menu + settings).
  - **Aggressive fallback**: when native network blocking fails to attach, a JS `webRequest.onBeforeRequest` handler blocks using static host patterns, a built-in tracker domain list, EasyList-derived domains, URL path keywords (`/ads/`, `/tracking/`, `/beacon/`, `/pixel/`, …), an LRU decision cache, and defensive exclusions (mainFrame/document/stylesheet/font and app-critical scripts). The fallback is active **only** when the native engine is not attached — they never run redundantly on the same request.
  - **Cosmetic filtering**: generated CSS is inserted per webContents (`insertCSS`, tracked and removed on update) and re-applied via a debounced DOM observer; the preload also stubs `navigator.sendBeacon`, injects invisible ad-element placeholders, and strips `rel=preload/preconnect` links (only when blocking is enabled).
  - **List updates**: lists are fetched on init only; the configured 24 h `updateIntervalMs` is **not** scheduled (see §15).
- **HTTPS-Only mode**: default on; upgrades http→https, blocks http redirects, warning page with proceed option (see §3).
- **WebRTC protection**: default on; `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` applied to every tab's webContents (reapplied on settings change).
- **Secure DNS (DoH)**: default on with Cloudflare (`cloudflare-dns.com/dns-query`); options: Cloudflare, Quad9, or a custom HTTPS URL (NextDNS etc.). Applied via Chromium command-line flags (`DnsOverHttps`, `dns-over-https-mode=automatic` — falls back to system DNS on resolver failure). Takes effect after restart; settings shows a restart confirmation modal.
- **Site Blocker**: user-maintained host-pattern list blocks navigation (see §3).
- **Popup blocking**: every `window.open` becomes a new tab; a `popup-blocker` rule is reported.
- **Process/sandbox hardening**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on all tab views; `webviewTag: false` on the shell; a **preload channel allowlist** rejects any non-allowlisted IPC channel; all IPC handlers validate the sender (`isTrustedIpcSender` / tab views) and payloads.
- **Error logging**: uncaught exceptions / unhandled rejections / renderer errors are appended to `kairon-errors.log` under `userData/logs` (no crash-report upload).
- **Permissions**: no permission UI exists; a session permission handler always grants (installed to observe camera/mic/screen capture for tab-sleep).

**Not implemented / not protected**: private/incognito mode (everything shares `persist:browser`), ClearURLs, first-party isolation, canvas/WebGL fingerprint protection, custom cookie controls, CNAME uncloaking, extensions, VPN, or any encrypted-sync/cloud account.

## 9. UI / UX

- **Tab placement**: sidebar (left rail) or top tab bar; toggled in Settings → Appearance → Tab Position (persisted in `localStorage` + synced with the `themeSystem` feature; works both directions).
- **Left rail**: collapsible (persisted), contains the tab list, New Tab, and AI / History / Settings buttons.
- **Omnibar suggestions**: shown in a dedicated transparent, always-on-top, click-through overlay window that can overlap page content. Suggestions = address-bar history + open-tab URLs + a final Brave Search entry (max 6); arrow keys cycle, Enter navigates, Esc closes. The overlay is clamped to the window bounds.
- **Status strip**: "N total · N blocked · N allowed" counters + page title. Note: `adblock-event` is currently only emitted for *blocked* requests, so "allowed" stays 0.
- **Shields menu** (shield icon): quick Off / Standard / Aggressive switching with toast feedback.
- **Zoom controls**: − / value% / + / reset.
- **AI panel** (see §12): collapsible right-side panel; toggling re-measures and re-applies the view layout.
- **Home page**: clock + greeting (updates every 5 s), search form (same normalization as the address bar), and 8 hardcoded speed-dial tiles (YouTube, GitHub, Brave Search, Gmail, X, Reddit, Stack Overflow, Hacker News).
- **Settings window**: separate frameless child window (skips taskbar, no shadow) with category sidebar (Privacy / Security / Performance / Appearance / Advanced), live search, feature toggles, per-feature sub-settings, per-feature reset, export/import JSON, Reset All, and a DNS-restart confirmation modal.
- **Theming**: `themeSystem.mode` (dark default / light) exists and the CSS defines a light palette, but the theme is applied **only to the settings window** — the main browser window always renders dark (partial; see §15).

## 10. Context Menus

**Webpage context menu** (native Electron `Menu`, per right-click context):
- Page: Back (enabled per history), Forward, Reload.
- Link: Open Link, Open Link in New Tab, Open Link in New Window, Copy Link Address.
- Image: Open Image in New Tab, Save Image As… (native save dialog + fetch), Copy Image Address.
- Selection: Copy, Search "…" (opens Brave Search in a new tab).
- Editable: Undo/Redo/Cut/Copy/Paste/Delete/Select All (Electron roles).
- Dev builds only: "Inspect Element" (with the clicked coordinates).

**Tab context menu** (right-click a tab): New Tab, Reload Tab, Duplicate Tab, Wake Tab (only when sleeping), Pin/Unpin Tab, Close Tab, Close Other Tabs, Close Tabs to the Right, Reopen Closed Tab (enabled when the closed-tab stack is non-empty). Accelerator hints (Ctrl+T/R/W/Shift+T) are displayed but the actual handling is the main-process `before-input-event` interception.

**Tab reorder** (verified against `ui.js` + `main.js`):
- Works in both modes: horizontal axis in top-tab mode, vertical axis in sidebar mode.
- Left-button drag only, from any non-button part of a tab; **6 px threshold** before a drag activates (plain clicks are never drags).
- The dragged tab is lifted out of flow, anchored at its start position, and follows the pointer along the strip axis only (`translate(…)`, cross-axis stays 0), scale 1.03; a same-size placeholder holds its slot and an insertion caret marks the drop point.
- **Pinned-tab boundaries are enforced in the renderer AND re-clamped in the main process** — a drag can never pin or unpin a tab.
- Cancellation: `Esc`, window blur (Alt+Tab), or pointer leaving the window — order stays untouched; a capture-phase click-guard swallows the trailing click so dropping never accidentally switches tabs.
- Edge auto-scroll while dragging (36 px margin, 14 px step), only during active pointer moves.
- Commit: the renderer reports the desired **final index** over the `tab-reorder` IPC; the main process re-validates (trusted sender, integer ids, tab exists, section clamping) and reorders its authoritative `tabs` Map, then broadcasts `tabs-state`.
- Persistence: the Map order is the order persisted in the session snapshot, so reordering survives restart (up to the 20-tab cap).
- Interaction with `Ctrl+Tab`: cycling follows the same authoritative Map order, so it uses the post-drag order. `Ctrl+Shift+T` restore re-inserts at the tab's recorded original slot within its group.

## 11. Session Persistence

- Stored in **electron-store** (JSON `config.json` under `userData`) under key `session.tabs.v1`.
- Snapshot = ordered tab list (`{id, url, title}`) + `activeTabId`; only http(s) URLs and `kairon://home` are persistable; URLs are sanitized; **max 20 tabs**.
- Written debounced (500 ms) after every tabs-state change; flushed synchronously on quit/restart (a `flushSessionPersist` guard avoids writing a cleared tabs Map).
- Restored at startup: recreates tabs (with their original ids), sets titles, restores the active tab. Restored tabs start fresh (no scroll position / form state / back-forward history).
- Not persisted: closed-tab stack, zoom factors, window bounds, tab order beyond the snapshot order (order *is* persisted), pinned state, tab position preference (stored in `localStorage`/feature settings separately).

## 12. Database Architecture

- **SQLite (better-sqlite3)**, managed by `DatabaseManager` (`src/main/database/database.js`), WAL + `synchronous=NORMAL`, file `kairon.db` in `userData`.
- **Schema/migrations** (`migrations.js`): creates the `history` table + indexes idempotently; on first run migrates a legacy `history.json` into SQLite (transactional, keeps the JSON as backup).
- **Repository** (`history-repository.js`): upsert (with `RETURNING`, plus a fallback without it), paginated get, substring search, delete, clear (resets the sequence), count.
- **Service** (`history.js`): URL normalization (strip fragment, trailing slash), internal-URL filtering, favicon derivation, and the public API consumed over IPC.
- **electron-store** is used for settings (`settings.features.v1`) and the session snapshot (JSON, not SQLite). No other data stores exist.

## 13. Internal Pages

| Page | URL | Contents |
|---|---|---|
| Home | `kairon://home` | Clock/greeting, search form, 8 speed dials (see §9) |
| History | `kairon://history` | History dashboard (see §5) |
| HTTPS warning | (loaded file) | "This connection is not secure" — Proceed / Go back |
| Load error | (inline data URL) | "This site cannot be reached" with code/description |

## 14. Current Limitations

- No private/incognito mode; single `persist:browser` partition for everything.
- No download manager UI (default Electron behavior); no stop-loading control (the reload button calls an unexposed `stopLoading` which is a no-op).
- No bookmarks (history-page star buttons are decorative), no tab groups, no tab tear-off, no window multi-instance management beyond one main window + child windows.
- AI panel requires a Groq API key but **no UI exists to enter it** (the panel reads `groqApiKey` from the internal store); conversation is in-memory only, "streaming" is a simulated word-by-word reveal over a non-streaming request.
- Theme mode (dark/light) only affects the settings window.
- Adblocker filter lists are fetched at init only — no background refresh while running.
- History "time browsing" stat is always 0 (`timeSpent` is never recorded).
- Settings features with no wiring: see §15.
- `src/main/fallback-blocker.js` is dead code (not required anywhere).

## 15. Not Implemented / Planned

The following are **registered in settings/registry or mentioned in comments/docs but not wired up in code**, and are therefore **not capabilities**:

- **Private / incognito browsing** — no non-persistent partition.
- **Download manager** (`downloadManager` feature: `askEveryDownload`, `defaultPath`) — registered only.
- **Performance Optimizer** (`performanceOptimizer`: `discardInactiveTabs`, `maxBackgroundTabs`) — registered only; actual tab sleeping is the hardcoded 7-min `TabSleepManager`.
- **Tab Behavior** (`tabBehavior`: `confirmOnCloseMultiple`, `restoreOnStartup`) — registered only; session restore always runs and bulk close never confirms.
- **Security Protections** (`securityProtections.blockInsecureContent`) — registered only.
- **Developer Tools** (`developerTools.allowDevtools`) — registered only; devtools only open in dev builds via `KAIRON_DEBUG_UI=1` or the dev-only "Inspect Element" menu item.
- **Theme compact mode** (`themeSystem.compactMode`) — registered only.
- **Adblocker scheduled list updates** — `requestUpdate()` exists but nothing schedules it.
- **Memory-saver statistics** (sleep manager returns 0).
- **ClearURLs, first-party isolation, canvas/WebGL fingerprint protection, cookie controls, CNAME uncloaking, extensions, VPN, encrypted sync, cloud accounts, mobile apps** — nothing in code.
- **Keyboard shortcuts `F5` and `Ctrl+1…9`** — not handled anywhere.
- **Groq API key settings UI** — none exists.

---

*Verified against the current source (commit state at time of writing). Where code and older docs disagreed, the code was treated as the source of truth.*
