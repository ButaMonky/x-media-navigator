# v2.4.12 private beta — persistent post controls and idle carousel efficiency

Date: 2026-10-26 JST
Source branch: `fix/prefetch-startup-v241`, from v2.4.11 commit `ad5313805a555c079ac3c716871147b7450a2155`.
Status: SOURCE VERIFIED / SYNTHETIC TESTED; **LIVE X NOT REVALIDATED**.

## User report
v2.4.11 is markedly better, but custom ◀/▶ post buttons only appear on the first gallery image. User also wants further speed and memory improvements without regressing smooth native SPA transitions.

## Root cause and mitigation
- Previously `ensureViewerButtons()` appended the post controls and status label directly into X's `[data-testid="swipe-to-dismiss"]` subtree. When X replaces a native photo slide or leaves the old viewer hidden while mounting the next, this React-owned subtree can discard or hide injected children. The first `querySelector` is not necessarily the active viewer.
- A new `.xmn-controls-layer` is mounted outside the React-controlled photo subtree (normally under `document.body`, within `document.fullscreenElement` while fullscreen). It uses `position:fixed` with a photo-pane-bounded rectangle, never the full right replies panel. The layer has `pointer-events:none`; only the 44px post buttons receive clicks.
- Detect visible connected viewer nodes, excluding hidden/inert/offscreen carousel slides. Preserve the same control-layer DOM when X swaps between viewers inside the same modal; reanchor on native photo route, structural changes, window resize, or fullscreen transition.
- On modal close, session reset, or navigation away, remove the layer and its click targets. Keep X's own native photo arrows, keyboard behavior and five-photo/two-concurrent prefetch unchanged.
- When geometry is unavailable in an older DOM, fall back to legacy in-viewer controls rather than inventing a pane position. Do not add permissions, browser secrets, React/History/GraphQL hooks, new background workers or extra image requests.

## Measured synthetic work reduction
- The earlier 450ms idle `tick()` could query for the active X viewer on every unchanged cycle; the optimized `activeViewerForRoute()` returns a cached connected visible pane for the same route. Requery on photo route change, hidden viewer, or viewer DOM insertion/removal. Unit regression simulates **100 unchanged calls with only 1 full selection**, then forces selection on route and visibility changes.
- This is a DOM-query reduction in a controlled test, **not** measured real-X frame time, CPU load, memory use, or actual CDN cache performance.

## Test-first regressions
- Before the code change, both a Node/FakeDOM test for hidden first-slide selection and a real Chromium synthetic-X test for arrows surviving native photo rerender failed.
- Browser synthetic fixture additionally checks hidden first slide + visible second slide (same image pane), stable identical controls host, clicking ▶ on photo 2 to open the next POST, click-through styling, resizing the browser image pane, and cleanup after X modal closes.
- An additional static CSS test asserts pointer-events safety if Chromium integration isn't available.

## Final local validation and limits

- Added an extra regression for carousel slides hidden only via CSS opacity while still connected (the next slide must win). It failed on the initial active-viewer selector and passed after adding computed-style visibility checks.
- Local `npm ci`: PASS, 0 npm-reported dependency vulnerabilities.
- `npm test`: **124 cases, 117 PASS, 0 FAIL, 1 SKIP, 6 live-X TODO**.
- `npm run typecheck`: PASS.
- `XMN_RUN_CHROMIUM=1` with locally installed Chromium-based Microsoft Edge, `npm run test:browser`: **2 PASS, 0 FAIL, 0 SKIP**. The synthetic browser suite now checks 28 labeled behaviors, including durable arrows on photo 2, visible-slide selection, a successful next-post button click, window resize positioning and overlay cleanup.
- Important distinction: this change *adds* a small dedicated DOM layer and TypeScript code; it primarily reduces needless runtime layout/DOM work on idle polls, not the extension bundle's byte size. Do not claim a measured real X CPU/FPS improvement without Performance profiling.
- Unresolved risks: actual X's modal may not use exactly these aria/CSS hide behaviors; X login DOM is unavailable through the connected browser context, so real X multi-photo button persistence, keyboard focus trap and fullscreen interaction must be user-verified. We do not call this LIVE X PASS.
- No changes to 5-image prefetch, 2-concurrent request limit, approximate 80MiB memory budget, native gallery keys, X-owned SPA routes or permissions.

## CI and installed private beta (deployment verified)

- Implementation commit: `210e4bb86d80aee30d1d421bb3454fda0536da9f` pushed to private `fix/prefetch-startup-v241`. GitHub TypeScript `verify` concluded **SUCCESS for both push and Draft PR #17** before installation; main remains unchanged.
- Installed-folder preflight: original manifest version `2.4.11`, source `2.4.12`.
- The original six files were copied with independently verified hashes and retained in `C:\Users\Saito\Downloads\X-Media-Navigator-Backups\pre-v2412-20261027_005522`, including `SHA256-OLD.txt`.
- Exactly six fixed-folder files were refreshed under `C:\Users\Saito\Downloads\X-Media-Navigator-Current`. All installed SHA256 values match source:
  - `content_script.js` `7DCC4BAF8EB0BDC99AD63554F513AEE9BF489B1C87E8EF8F209AC0D8B12E35A0`
  - `manifest.json` `B057D74B8723325E9688F37378B3FF242C753B21E18E1E538F8FB86FD9BD8195`
  - `style.css` `C0EB781242DD69F40F0F7A474A3D6D497E6290B60CA9F153ED8E4DB96D2E4543`
  - `icon16.png` `A6A5FBFB08884932B4F2DE8C5AE72EA33C5FDD8D29C36A7F943C472A6F765350`
  - `icon48.png` `131F87AEEB140C8AE516BF4B33F4F9E66EAA0C3A4A1A8D405D5EE16EC3438BC9`
  - `icon128.png` `C2415B4E7097B660840FC65D84C07E2D3B25F7DE9087346BD8643E8D16B1BDA0`
- Installed manifest `2.4.12` verified. No ZIP, release, user Chrome restart, public/main changes, new service or updater. The loaded Chrome extension still needs user Reload and X tab refresh.
