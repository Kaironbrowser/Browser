# Kairon Browser Capabilities

This document describes what Kairon Browser **actually does right now**, verified against the current source code (`src/main`, `src/renderer`, `package.json`). Where a capability is only partially implemented, it is marked **partial**. Things that appear in settings or documentation but are not wired up in code are listed in **§15 Not Implemented / Planned** instead of being presented as capabilities.

---

## 1. Browser Core

- **Engine**: Electron + Chromium. Single frameless `BrowserWindow` (default 1400×900, min 900×600) with a **custom title bar** (minimize / maximize / close buttons) and an 8px `-webkit-app-region: drag` strip at the top of the chrome bar for dragging the window.
- **Tabs are `BrowserView` instances**, one per tab, all attached to the window one at a time. Each view uses `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and the `persist:browser` session partition.
- **Startup**: window is maximized at launch; if the saved window bounds are off-screen, it is repositioned onto the primary display (`ensureWindowVisible`). Window position/size are **not** persisted between launches.
- **Address bar (omnibar)**:
  - Typing `Enter` navigates. Input is normalized in the main process: explicit `http:`/`https:` URLs pass through, domain-like strings get `https://` prefixed, anything else becomes a **Brave Search** query (`https://search.brave.com/search?q=…`).
  - `home` or `kairon://home` opens the internal home page; `kairon://history`, `kairon://bookmarks`, and `kairon://downloads` open their internal pages; `kairon://settings` opens the internal settings page (deep links like `kairon://settings/privacy` open a specific category).
  - Invalid targets (non-http(s) protocols, >2048 chars, unparseable) are rejected and the UI flashes an "Invalid address" state.
  - Suggestions are rendered in a **separate transparent overlay window** (see §9).
- **Navigation buttons**: Back / Forward (enabled per the active tab's `navigationHistory.canGoBack/Forward`) and Reload (while a page is loading the same button acts as Stop via `webContents.stop()`). There is no dedicated Home button — the home page is reached via a new tab, the address bar (`home`), or `Ctrl+H`-style navigation to `kairon://home`.
- **Popups**: `window.open` is intercepted and opened as a new Kairon tab (`popup-blocker` rule); popups are never allowed as separate windows.
- **Open Link in New Window** (context menu) creates a standalone plain `BrowserWindow` (no Kairon chrome) loading the URL. Standalone windows are tracked in a set and **closed when the main browser window closes**, so the app never keeps running invisibly in the background after the browser UI is gone.
- **New Window** (`Ctrl+N` / app menu "New Window"): opens a fully independent browser window with its own tabs, overlay, and layout, sharing the same session (cookies, history, bookmarks) as the main window. Each window has its own tab management, sidebar state, and zoom controls. All additional windows are tracked and **closed when the main browser window closes**. The app menu (hamburger icon) in every window provides "New Window" as a top-level action alongside "New Tab" and "New Incognito Window".
- **Page zoom**: per-tab zoom factor clamped to 0.25–5.0, stepped presets, `Ctrl+=`/`Ctrl+-`/`Ctrl+0` and on-screen buttons with a live percentage readout. Zoom applies per-tab and is reapplied on `dom-ready`/`did-finish-load`; it is **not** persisted across restarts.
- **Search engine**: Brave Search is hardcoded as the only search provider (address bar, context menu "Search", home page form).
- **Internal pages**: home page (`kairon://home` → `home.html`), history page (`kairon://history` → `history.html`), bookmarks page (`kairon://bookmarks` → `bookmarks.html`), downloads page (`kairon://downloads` → `downloads.html`), settings page (`kairon://settings` → `settings.html`), HTTPS-Only warning page, a "This site cannot be reached" load-error page (shown on `did-fail-load`), and a dedicated DNS-resolution "IP not found" page (shown for DNS error codes −105/−137). All internal pages are local files loaded into a tab and are trusted only while their URL is the local file (see §13).

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
- **Downloads**: full download manager — every download saves automatically to the configured directory (system Downloads by default, or a user-chosen folder persisted in Settings) with no Save As dialog. The toolbar Downloads popup and the `kairon://downloads` page show live progress (received/total bytes, speed, ETA, progress bar), per-download status (Downloading / Paused / Download complete / Interrupted / Failed / Cancelled), cancel/pause/resume, open file / show in folder, and clear (removes list entries only — files on disk are never deleted). Completed/failed entries persist across restarts via `electron-store` (max 200); cancelled entries stay visible in-session only until cleared. `will-download` is also observed by tab-sleep so tabs with active downloads never sleep. Progress pushes (throttled to 150 ms) are **reconciled in place** by both the popup and the downloads page: rows are built once and updated by stable download id (status text, progress-bar fill), so active downloads never cause the list to flash, rebuild, or jump. "Save Image As…" (context menu) is the separate native save dialog path (`net.fetch`).

## 4. Keyboard Shortcuts

All verified in code. Modifier is **Ctrl** (Meta on macOS) unless noted.

| Shortcut                       | Where handled                                                       | Action                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `Ctrl+T`                       | Main (`before-input-event`, page & chrome) + renderer               | New tab                                                                                                 |
| `Ctrl+Shift+T`                 | Main only (page & chrome)                                           | Reopen last closed tab                                                                                  |
| `Ctrl+W`                       | Main (page & chrome) + renderer                                     | Close active tab                                                                                        |
| `Ctrl+Tab` / `Ctrl+Shift+Tab`  | Main (page & chrome)                                                | Cycle tabs (visual order, wraps)                                                                        |
| `Ctrl+N`                       | Main (page & chrome)                                                | Open new browser window (independent tabs, shared session)                                              |
| `F11`                          | Main (page & chrome)                                                | Toggle window fullscreen; exits content fullscreen if a site is fullscreen                              |
| `Ctrl+R`                       | Renderer (chrome focus); default Electron menu accelerator in pages | Reload                                                                                                  |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Main (page) + renderer (chrome)                                     | Zoom in / out / reset                                                                                   |
| `Ctrl+L`                       | Renderer                                                            | Focus + select address bar                                                                              |
| `Ctrl+K`                       | Renderer                                                            | Focus + select address bar (commands hint)                                                              |
| `Ctrl+H`                       | Renderer                                                            | Open history page in active tab                                                                         |
| `Ctrl+D`                       | Main (`before-input-event`, page & chrome)                          | Bookmark / un-bookmark the current page (star state updates live)                                       |
| `Ctrl+[` / `Ctrl+]`            | Renderer                                                            | Back / Forward                                                                                          |
| `Alt+Left` / `Alt+Right`       | Renderer                                                            | Back / Forward                                                                                          |
| `Ctrl+,`                       | Renderer (`renderer.js`)                                            | Open Settings page in active tab (`kairon://settings`)                                                  |
| `Enter`                        | Renderer                                                            | Navigate from address bar                                                                               |
| `Esc`                          | Renderer                                                            | Blur address bar / close suggestions; cancels a tab drag; closes settings; closes history confirm modal |
| `↑` / `↓`                      | Renderer                                                            | Navigate address-bar suggestions                                                                        |
| `Tab`                          | Renderer                                                            | Accept omnibar inline autocomplete                                                                      |
| `ArrowRight` at end of input   | Renderer                                                            | Accept omnibar inline autocomplete                                                                      |
| `Shift+Enter` in AI input      | Renderer                                                            | Newline (Enter alone sends)                                                                             |
| `Escape` / drag cancel         | Renderer                                                            | See §10                                                                                                 |

**Not implemented**: `F5`, `Ctrl+1…9` tab selection, `Ctrl+Shift+P`, `Ctrl+Shift+I`, and any other shortcuts not listed above. `Ctrl+N` is now implemented (opens a new browser window). `Ctrl+Alt+Tab` is deliberately left untouched (never intercepted).

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
- **History page UI** (`history.html`, loaded in a tab): loads up to 10,000 entries, groups by Today/Yesterday/This Week/Earlier This Month/Older, shows per-day stats (pages visited, total visits, unique domains, "time browsing" — which is always 0 because `timeSpent` is never recorded), "Most Visited Today" (top 5), per-entry delete, search-as-you-type, and collapsible groups. The per-row star buttons on this page are **decorative only** (in-memory, per-session) — real bookmarking happens through the ⭐ button, `Ctrl+D`, or the bookmarks bar (see §9).
- **Address-bar history** is separate: the last 100 entered URLs are kept in `localStorage` (`kairon:address-history`) and feed suggestions.

## 6. Fullscreen & Window Management

Two independent fullscreen modes that never fight:

- **F11 / window fullscreen** toggles the Kairon window itself (`userWindowFullscreen` tracks intent rather than `isFullScreen()`).
- **Content fullscreen** (HTML Fullscreen API — YouTube, `<video>`, etc.): on `enter-html-full-screen` the window is put into fullscreen so the active view covers the whole screen; on `leave-html-full-screen` (page ESC/`exitFullscreen()`) the window returns to whatever state it was in before (F11 state is remembered via `windowFullscreenBeforeHtml`).
- **F11 pressed while a site is fullscreen** exits the content fullscreen (same as ESC) instead of toggling the window.
- **Closing a tab that is in content fullscreen** restores the window state.
- **Transition handling**: `enter-full-screen` marks a ~400 ms transition window during which the view is _not_ repositioned with chrome-offset metrics (prevents the viewport jump / black band bug), then re-applies settled bounds.
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
  - Adblocker decision caches (LRU, 5,000 entries each) for the native engine and the aggressive fallback, keyed by URL/resource-type/referrer/rule-version; blocked verdicts are cached for 30 min and caches invalidate when the engine or rule set changes.
  - All hot-path diagnostics are gated (`DIAG`) so production builds emit no per-request/per-bounds logging.

## 8. Privacy & Security

Only mechanisms present in code are listed; none are guaranteed protections.

- **Chromium telemetry switches**: at startup, `app.commandLine.appendSwitch` disables background networking, crash reporting (`disable-breakpad`, `disable-crash-reporter`), metrics, sync, translate, variations/field trials, first-run UI, default apps, cloud import, component updates, and the Chromium hang monitor (`disable-hang-monitor`). `password-store basic` + `use-mock-keychain` are set.
- **Telemetry request blocker** (`installTelemetryRequestBlocker`): a `webRequest.onBeforeRequest` dispatcher on both `session.defaultSession` and `persist:browser` cancels requests to known Google telemetry hosts (`safebrowsing.googleapis.com`, `clients2.google.com`, `update.googleapis.com`, `optimizationguide-pa.googleapis.com`, `play.google.com/log*`, etc.). It preserves the adblocker's own listener by chaining it downstream (Electron allows one `onBeforeRequest` listener per session).
- **Ad blocking** — Kairon's own implementation built around the `@cliqz/adblocker-electron` filtering engine (not uBlock Origin). The native engine is built from EasyList + EasyPrivacy (fetched at init; `fullLists`/`adsAndTrackingLists` per mode), with network blocking via `enableBlockingInSession(persist:browser)` and block events via the `request-blocked` listener (with a `filter-matched` fallback). Modes: `off | cosmetic | full | standard | aggressive`; the UI exposes **Off / Standard / Aggressive** (shields menu + settings). Cosmetic-only mode loads no network filters.
  - **Performance (decision caching)**: every request passes through a main-process dispatcher with a **native decision cache** (LRU, 5,000 entries) keyed by URL/resource-type/referrer/rule-version, so repeated requests skip the synchronous engine match (the measured hot path); cached verdicts are invalidated whenever the engine is recreated.
  - **Reliability (fail-open)**: an internal blocker error never leaves a request hanging or cancels navigation — the dispatcher always answers the callback (`{}`), and the Chromium hang monitor is disabled at startup. Blocked verdicts carry a 30-min TTL.
  - **Main-frame/document protection**: an `onHeadersReceived` wrapper prevents the blocker from modifying or cancelling main-frame/document responses (e.g. filter-list `$csp` rules that would inject a CSP and break a page's scripts); the fallback handler also passes `mainFrame`/`document`/`stylesheet`/`font`/`cspReport` through untouched.
  - **Aggressive fallback**: active **only** in aggressive mode when native network blocking failed to attach (they never run on the same request together). A JS `webRequest.onBeforeRequest` handler blocks using static host patterns, a built-in tracker domain list, EasyList-derived domains (fetched at attach, up to 5,000), URL path keywords (`/ads/`, `/tracking/`, `/beacon/`, `/pixel/`, …), and its own LRU decision cache. **Scheme filtering**: only parseable `http(s)` URLs are evaluated — `file:`, `data:`, `blob:`, `chrome-extension:`, etc. are never blocked.
  - **Cosmetic filtering**: generated CSS is inserted per webContents (`insertCSS`, tracked and removed on update) and re-applied via a debounced DOM observer; the preload also stubs `navigator.sendBeacon`, injects invisible ad-element placeholders, and strips `rel=preload/preconnect` links (only when blocking is enabled).
  - **List updates**: native filter lists are fetched at init only — the configured 24 h `updateIntervalMs` is **not** scheduled (see §15); the aggressive fallback re-fetches EasyList-derived domains whenever it is (re)attached.
- **HTTPS-Only mode**: default on; upgrades http→https, blocks http redirects, warning page with proceed option (see §3).
- **WebRTC protection**: default on; `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')` applied to every tab's webContents (reapplied on settings change).
- **Secure DNS (DoH)**: default on with Cloudflare (`cloudflare-dns.com/dns-query`); options: Cloudflare, Quad9, or a custom HTTPS URL (NextDNS etc.). Applied via Chromium command-line flags (`DnsOverHttps`, `dns-over-https-mode=automatic` — falls back to system DNS on resolver failure). Takes effect after restart; settings shows a restart confirmation modal.
- **Site Blocker**: user-maintained host-pattern list blocks navigation (see §3).
- **Popup blocking**: every `window.open` becomes a new tab; a `popup-blocker` rule is reported.
- **Process/sandbox hardening**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on all tab views; `webviewTag: false` on the shell; a **preload channel allowlist** rejects any non-allowlisted IPC channel; all IPC handlers validate the sender (`isTrustedIpcSender` / tab views) and payloads.
- **Error logging**: uncaught exceptions / unhandled rejections / renderer errors are appended to `kairon-errors.log` under `userData/logs` (no crash-report upload).
- **Permissions** (deny-by-default): a session-level permission handler on both the main browsing session and the incognito session denies camera, microphone, geolocation, notifications, screen capture, and other sensitive hardware/system permissions for untrusted web content. Only clipboard operations (copy/paste) and fullscreen (HTML Fullscreen API) are always allowed. Trusted Kairon browser chrome (main window, overlay, additional windows, incognito chrome/overlay) receives all requested permissions. The handler also notifies the tab-sleep manager of capture permission grants/denials.
- **Incognito site blocking**: the Site Blocker list is enforced in incognito tabs — blocked navigations, redirects, popups, and address-bar entries are intercepted and reported via `incognito-adblock-event`.
- **Incognito partition isolation**: incognito tabs and overlay use a dedicated `incognito` session partition with `sandbox: true`, separate from the `persist:browser` partition used by normal browsing.
- **Sensitive store key protection**: incognito windows cannot access sensitive keys (e.g. `groqApiKey`) from the shared electron-store — generic `store-get`/`store-set` IPC checks a blocklist and throws on restricted keys; purpose-specific IPC (`incognito-get-groq-api-key`) is provided instead.

**Not implemented / not protected**: ClearURLs, first-party isolation, canvas/WebGL fingerprint protection, custom cookie controls, CNAME uncloaking, extensions, VPN, or any encrypted-sync/cloud account.

## 9. UI / UX

- **Tab placement**: sidebar (left rail) or top tab bar; toggled in Settings → Appearance → Tab Position (persisted in `localStorage` + synced with the `themeSystem` feature; works both directions).
- **Left rail**: collapsible (persisted), contains the tab list, New Tab, and AI / History / Settings buttons.
- **Omnibar suggestions & autocomplete**: shown in a dedicated transparent, always-on-top, click-through overlay window that can overlap page content. The omnibox now features **inline autocomplete**: as the user types, the best-matching history URL is shown as ghost text (protocol-stripped) with the auto-completed portion selected, ready to be accepted with **Tab** or **ArrowRight** at end-of-input. The dropdown shows history-based rich suggestions (url, title, favicon) plus a Brave Search fallback at the end (max 8). Debounced 60 ms input → async IPC `getAutocompleteSuggestions` → inline ghost + dropdown update. Arrow keys cycle the dropdown, Enter navigates, Esc first dismisses suggestions (restoring the typed query) then blurs on second Esc. Backspace suppresses ghost text to avoid re-applying the same suggestion. The overlay is clamped to the window bounds and consumes the same global theme (`?theme=` at load + live `settings-updated` sync), so the dropdown, suggestion rows, hover/selected state, icons, and search-row text are light in Light Mode and dark in Dark Mode.
- **Bookmark star (⭐)**: sits beside the omnibox. It reflects the active tab's live bookmark state (filled when bookmarked; disabled on internal/unsupported pages) and opens a small **Quick Access / Bookmarks / Custom Sites chooser popup** (rendered in the overlay window) with three rows: "Add/Remove from Bookmarks", "Add/Remove from Quick Access", and "Add/Remove from Custom Sites". `Ctrl+D` toggles the active page's bookmark directly.
- **Bookmarks bar**: appears beneath the toolbar whenever bookmarks exist (hidden when empty and in Incognito). Each item opens its URL; right-clicking opens a native menu (open in active tab / delete).
- **Quick Access vs Bookmarks vs Custom Sites**: three separate persistent stores (Quick Access and Bookmarks are `electron-store`-backed; Custom Sites is `localStorage`-backed). Quick Access feeds the home page's dial grid; Bookmarks feed the star state, the bookmarks bar, and the `kairon://bookmarks` page; Custom Sites renders a pinned-website tile grid in the side rail. Adding to one never affects the others.
- **Downloads panel & page**: the toolbar Downloads button opens a floating panel (rendered in the overlay window) with the live download list; "Show more" opens the full `kairon://downloads` page. Both render the same main-process-pushed list and reconcile progress updates in place (see §3).
- **Status strip**: "N total · N blocked · N allowed" counters + page title. Note: `adblock-event` is currently only emitted for _blocked_ requests, so "allowed" stays 0.
- **Custom Sites** (side rail): a renderer-only feature (`custom-sites.js`) that renders pinned-website tiles in the left rail. Entries are managed through the ⭐ chooser popup ("Add/Remove from Custom Sites"), stored in `localStorage` under `kairon:custom-sites`, and include name, URL, and favicon (derived from Google's favicon service). Duplicate detection uses canonical URL comparison. The grid updates live when entries are added/removed.
- **Shields menu** (shield icon): quick Off / Standard / Aggressive switching with toast feedback.
- **Zoom controls**: − / value% / + / reset.
- **AI panel** (see §12): collapsible right-side panel; toggling re-measures and re-applies the view layout.
- **Home page**: clock + greeting (updates every 5 s), search form (same normalization as the address bar), and a **Quick Access** dial grid rendered from the persistent Quick Access store (seeded with the historical 8 default dials — YouTube, GitHub, Brave Search, Gmail, X, Reddit, Stack Overflow, Hacker News — on first run). The grid updates live via `quick-access-updated` pushes when entries are added/removed through the ⭐ chooser, and hides when empty.
- **Settings page**: first-class internal page (`kairon://settings` → `settings.html`) opened in a tab. Monochrome sidebar layout (Appearance / Privacy / Security / Advanced — only categories with genuinely wired settings are shown), live registry-driven search with deep links to results, feature toggles and sub-settings, export/import JSON, Reset All, a DNS-restart confirmation modal, and keyboard navigation. The settings page is trusted only while its tab URL is the local `settings.html` file (same sender-validation model as the history page).
- **App menu** (hamburger icon, rendered in the overlay window): global actions — New Tab, New Window (`Ctrl+N`), New Incognito Window, Back, Forward, Reload, Zoom controls, Fullscreen toggle, Shields toggle, Tab Position toggle, Settings, and About. The menu also shows the **auto-updater status** (version text, "Update available" / "Update ready" indicator, and an "Install" button when an update has been downloaded). The menu height is measured dynamically by the overlay and reported back so it is never clipped.
- **Auto-updater** (`electron-updater`): checks for updates 5 seconds after startup (background); state transitions (checking → available → downloading → ready) are broadcast to every window via IPC and displayed in the app menu. "Install" triggers `quitAndInstall`. Pre-release versions are not offered.
- **Theming**: `themeSystem.mode` (dark default / light) is a **global application theme** — one FeatureStore value drives the entire Kairon UI. The browser chrome (left rail, tabs, toolbar, address bar, window controls, zoom, status strip), the omnibox suggestions overlay, and every Kairon-owned internal page (home, history, bookmarks, downloads, settings, HTTPS warning, load-error, DNS error) share the same CSS-variable palette. The main process passes the current mode as `?theme=` when loading the chrome, overlay, and internal pages (first paint), and live-syncs every change via the existing `settings-updated` push, so switching themes in Settings re-skins everything instantly without a restart. The selected mode is also exposed to websites through Chromium's standard `prefers-color-scheme` media feature via `nativeTheme.themeSource` (set on boot and on every settings change): sites that support the media query respond themselves, and sites that don't are never touched — no CSS/DOM injection into websites.

## 10. Context Menus

**Webpage context menu** (native Electron `Menu`, per right-click context):

- Page: Back (enabled per history), Forward, Reload.
- Link: Open Link, Open Link in New Tab, Open Link in New Window, Copy Link Address.
- Image: Open Image in New Tab, Save Image As… (native save dialog + fetch), Copy Image Address.
- Selection: Copy, Search "…" (opens Brave Search in a new tab).
- Editable: Undo/Redo/Cut/Copy/Paste/Delete/Select All (Electron roles).
- Dev builds only: "Inspect Element" (with the clicked coordinates).

**Tab context menu** (right-click a tab): New Tab, Reload Tab, Duplicate Tab, Wake Tab (only when sleeping), Pin/Unpin Tab, Close Tab, Close Other Tabs, Close Tabs to the Right, Reopen Closed Tab (enabled when the closed-tab stack is non-empty). Accelerator hints (Ctrl+T/R/W/Shift+T) are displayed but the actual handling is the main-process `before-input-event` interception.

**Bookmarks bar context menu** (right-click a bookmark): Open in Active Tab / Delete (native `Menu`; the bookmark is re-validated by id/URL in the main process before anything is shown or acted on).

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
- Not persisted: closed-tab stack, zoom factors, window bounds, tab order beyond the snapshot order (order _is_ persisted), pinned state, tab position preference (stored in `localStorage`/feature settings separately).

## 12. Database Architecture

- **SQLite (better-sqlite3)**, managed by `DatabaseManager` (`src/main/database/database.js`), WAL + `synchronous=NORMAL`, file `kairon.db` in `userData`.
- **Schema/migrations** (`migrations.js`): creates the `history` table + indexes idempotently; on first run migrates a legacy `history.json` into SQLite (transactional, keeps the JSON as backup).
- **Repository** (`history-repository.js`): upsert (with `RETURNING`, plus a fallback without it), paginated get, substring search, delete, clear (resets the sequence), count.
- **Service** (`history.js`): URL normalization (strip fragment, trailing slash), internal-URL filtering, favicon derivation, and the public API consumed over IPC.
- **electron-store** (JSON, not SQLite) is used for settings (`settings.features.v1`), the session snapshot (`session.tabs.v1`), bookmarks (`bookmarks.v1`), Quick Access (`quickAccess.v1`), and download history (`downloads.history.v1`). SQLite stores only browsing history.

## 13. Internal Pages

| Page          | URL                                                     | Contents                                                                                      |
| ------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Home          | `kairon://home`                                         | Clock/greeting, search form, Quick Access dial grid (see §9)                                  |
| History       | `kairon://history`                                      | History dashboard (see §5)                                                                    |
| Bookmarks     | `kairon://bookmarks`                                    | Searchable bookmark list — open / delete (see §9, §10)                                        |
| Downloads     | `kairon://downloads`                                    | Download manager list — live progress, per-download actions, clear with confirmation (see §3) |
| Settings      | `kairon://settings` (and `kairon://settings/<section>`) | Settings sidebar + category pages (see §9)                                                    |
| HTTPS warning | (loaded file)                                           | "This connection is not secure" — Proceed / Go back                                           |
| Load error    | (loaded file)                                           | "This site cannot be reached" with code/description                                           |
| DNS error     | (loaded file)                                           | "IP not found" page for DNS-resolution failures (codes −105/−137)                             |

## 14. Current Limitations

- Incognito mode exists but is the same chrome in an in-memory session: it stops Kairon from retaining local browsing data (history, the download list, cookies/storage) after the window closes, but provides **no anonymity** — no IP hiding, no protection from websites/ISPs/network administrators.
- The registered `downloadManager.askEveryDownload` setting is not consulted — downloads always auto-save with no Save As prompt.
- The history page's per-row star buttons are decorative (in-memory, per-session); real bookmarks live in the ⭐ chooser, the bookmarks bar, and `kairon://bookmarks`.
- No tab groups, no tab tear-off. (Multi-window via `Ctrl+N` is now supported — each additional window is a fully independent browser instance sharing the same session.)
- AI panel requires a Groq API key but **no UI exists to enter it** (the panel reads `groqApiKey` from the internal store); conversation is in-memory only, "streaming" is a simulated word-by-word reveal over a non-streaming request.
- Theme mode (dark/light) affects the whole Kairon UI (chrome + internal pages + omnibox overlay) and is exposed to normal websites only through the standard `prefers-color-scheme` media feature (via `nativeTheme.themeSource`) — websites are never forcibly restyled and non-supporting sites render exactly as they normally do; the chrome and internal pages share one monochrome palette.
- Adblocker filter lists are fetched at init only — no background refresh while running.
- History "time browsing" stat is always 0 (`timeSpent` is never recorded).
- Settings features with no wiring: see §15.
- `src/main/fallback-blocker.js` is dead code (not required anywhere).

## 15. Not Implemented / Planned

The following are **registered in settings/registry or mentioned in comments/docs but not wired up in code**, and are therefore **not capabilities**:

- **Performance Optimizer** (`performanceOptimizer`: `discardInactiveTabs`, `maxBackgroundTabs`) — registered only; actual tab sleeping is the hardcoded 7-min `TabSleepManager`.
- **Tab Behavior** (`tabBehavior`: `confirmOnCloseMultiple`, `restoreOnStartup`) — registered only; session restore always runs and bulk close never confirms.
- **Security Protections** (`securityProtections.blockInsecureContent`) — registered only.
- **Developer Tools** (`developerTools.allowDevtools`) — registered only; devtools only open in dev builds via `KAIRON_DEBUG_UI=1` or the dev-only "Inspect Element" menu item.
- **Theme compact mode** (`themeSystem.compactMode`) — registered only.
- **Adblocker scheduled list updates** — `requestUpdate()` exists but nothing schedules it; the aggressive fallback re-fetches EasyList-derived domains only when it is (re)attached.
- **Memory-saver statistics** (sleep manager returns 0).
- **ClearURLs, first-party isolation, canvas/WebGL fingerprint protection, cookie controls, CNAME uncloaking, extensions, VPN, encrypted sync, cloud accounts, mobile apps** — nothing in code.
- **Keyboard shortcuts `F5` and `Ctrl+1…9`** — not handled anywhere.
- **Groq API key settings UI** — none exists.

---

_Verified against the current source (commit state at time of writing). Where code and older docs disagreed, the code was treated as the source of truth._
