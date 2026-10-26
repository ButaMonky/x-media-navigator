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
