# X Media Navigator v2.4.15 — hidden-tab prefetch lifecycle / idle CPU audit

Date: 2026-10-28 JST
Repository: `ButaMonky/x-media-navigator` (PRIVATE)
Branch: `fix/prefetch-startup-v241`, Draft PR #17 (stay Draft)
Baseline: `1b57b32d900559941ab51b4b2e946e1fbe396e61` private v2.4.14.
Research issue ID: XMN-PERF-20261028-BACKGROUND
Status: SOURCE VERIFIED, SYNTHETIC CHROMIUM VERIFIED; **LIVE X NOT TESTED**.

## Audit finding

- The v2.4.14 `preloadAdjacentImages()` already skipped starting NEW prefetches on hidden tabs. However, the content script did not register a `visibilitychange` listener. Existing `Image.decode()` operations and their 12-second watchdog timers could keep two optional CDN downloads in-flight after the user switched away.
- The 450ms route-polling interval also continued calling `tick()` during a hidden tab. Chromium throttles background timers, but it does not guarantee no callbacks, so unnecessary media-grid DOM state checks remained possible.
- The resume path deduplicated a previously visited route using `preloadForPath`, which could suppress reconsideration of nearby images after background cancellation.
- This is a code-level opportunity, not evidence that the user's normal Chrome suffered a particular CPU/bandwidth cost. Actual CDN timing and cache-hit measurements are unavailable.

## Implemented v2.4.15

1. Subscribe once to the browser's standard `document.visibilitychange` event. No extension permissions, persistent telemetry, worker, scheduler, service, X API, GraphQL or history patching.
2. On hidden: clear the existing queued/desired prefetch list and its startup timer; cancel optional in-flight `Image` transfers, but NEVER cancel an image currently owned by the short visual handoff. Retain already decoded nearby images in the existing bounded LRU (at most six records, estimated 80MiB) so short tab switches do not always require redownloading everything.
3. During hidden: `tick()` returns before traversing X's media grid or recalculating viewer state. The old 450ms interval remains as a cheap safety fallback rather than adding a new timer.
4. On visible: immediately run one ordinary `tick()` reconciliation; invalidate only `preloadForPath` and schedule the original bounded up-to-five-photo/two-concurrent prefetch if a connected media viewer belongs to the active profile.
5. Existing load/decode cancellation is idempotent; late `decode()` fulfillment after tab hidden cannot release a slot twice, resurrect a removed cache record, start a stale third image transfer, or poison the failed-CDN cache.

## Test-first evidence

- Two new controller tests were intentionally run against v2.4.14 first and failed because `onVisibilityChange` did not exist.
- A third test uses real `drainPrefetchQueue()` + unresolved mock decode Promises: two transfers in flight before hide, both canceled after hide with 0 remaining slots, third queued transfer never started, late Promise callbacks never restarted work, and 12-second watchdogs cleared.
- Another new test first failed against old `tick()`, proving a hidden tab's 450ms poll still touched media DOM and that resuming needed one reconciliation.
- Chromium synthetic-X browser fixture simulates the `visibilitychange` event and ensures that hiding a tab does not spawn new optional requests or remove the existing ◀▶ layer; resuming retains the existing controls.
- All preexisting photo no-skip, one-press ArrowRight, SPA modal and replies persistence, fixed-position arrows, virtualized media grid and bounded prefetch tests must continue to pass.

## Comparable synthetic performance measurement (NOT real-world Chrome FPS)

Node VM evaluated old `git show 1b57b32:extension/content_script.js` and optimized compiled JavaScript with the same fake hidden media tab and 1000 interval ticks:

| Measurement | v2.4.14 | New implementation |
|---|---:|---:|
| tick() calls | 1000 | 1000 |
| observer/grid checks invoked | 1000 | 0 |
| elapsed Node VM time (one run) | 13.33 ms | 1.04 ms |

These figures verify avoided work in a synthetic controlled test. They do not measure normal X.com power draw, CPU time, memory savings or page navigation speed.

## Standards research

- MDN `Document.visibilitychange` — a recommended point to stop unwanted background tasks: https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event
- Chrome Page Lifecycle API — browsers can freeze/discard hidden pages and suspend tasks; code must tolerate asynchronous lifecycle: https://developer.chrome.com/docs/web-platform/page-lifecycle-api
- MDN `HTMLImageElement.decode()` — Promise may reject on failed load or altered src; guard asynchronous completions: https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode
- web.dev Fetch Priority — browser `fetchPriority=low` is a hint, not guaranteed to prevent competition; no change made to existing low-priority fetching: https://web.dev/articles/fetch-priority

## Risks and deferred optimizations

- Returning to the same media tab after a very short hide can re-request partially fetched images that were canceled. The previous behavior could keep downloading while hidden. This is an intentional data/battery-vs-resume-latency trade-off and should be evaluated on real X before adding more cancellation thresholds.
- Already decoded images remain within the existing LRU; no claim of an 80MiB decrease. This change primarily reduces unnecessary active transfers/DOM work while backgrounded.
- Real X image/CDN URL cache matching (`name=large` vs `name=orig`) is NOT MEASURED. Do not switch prefetch variants or initiate extra network requests without evidence.
- A dedicated `ResizeObserver` on X's moving `swipe-to-dismiss` node risks reintroducing the recently fixed ◀▶ drift; no new observer attached.
- A new `IntersectionObserver` on X's virtualized media grid would add callback work without a demonstrated latency gain; defer.
- Browser tab inspection is BLOCKED with "originating browser context" in this session. No attempt to access user cookies, browser profile, X internal GraphQL or any alternative origin/workaround.
- Keep Draft PR #17 and main unchanged. Only update the fixed six-file unpacked extension directory after local tests + GitHub push/PR CI success with a SHA256-verified backup. User live-X acceptance still required before calling it a proven production improvement.

## Final local verification before private CI (2026-10-28 JST)

- `npm ci`: PASS; npm reported zero dependency vulnerabilities.
- `npm test`: **139 total / 132 PASS / 0 FAIL / 1 SKIP / 6 LIVE-X TODO**. The four new lifecycle regressions cover non-handoff cancellation, decoded-image retention, stale Promise rejection/fulfillment cleanup, one visible resync, and no hidden DOM scanning.
- `npm run typecheck`: PASS.
- `XMN_RUN_CHROMIUM=1`, installed Edge `CHROMIUM_PATH`, `npm run test:browser`: **2 PASS / 0 FAIL / 0 SKIP**. The Chromium synthetic fixture now checks 33 labeled behaviors, including hidden/visible event delivery without disappearing ◀▶ controls, and all previous SPA one-press, photo boundary, panel retention and arrow drift regressions.
- Disposable isolated MV3 Navigation API probe: PASS all four checks, without modifying the user's Chrome profile.
- `git diff --check`: PASS. Baseline HEAD equal to origin before new commit: `1b57b32d900559941ab51b4b2e946e1fbe396e61`. Main unchanged at `47b23d56257ee272f4adc1dea21900340e673c98`.
- Generated `extension/content_script.js` baseline size was **109,479 bytes**; new LF-built file **111,119 bytes**. The +1,640-byte increase is expected for the listener/lifecycle handler. **Do not describe this as bundle-size reduction**; it is a controlled runtime background-load reduction.
- Actual background-tab CPU/bandwidth, memory reduction and live CDN `name=large/orig` HTTP cache-hit rate remain **unmeasured**. Do not merge or release based only on synthetic tests.

## Private CI and fixed-folder deployment (verified 2026-10-28 JST)

- Runtime implementation commit `c043fabc717083a21c10ce152f0b4ab3b1a317d5` was pushed to private branch `fix/prefetch-startup-v241`. Both GitHub push and Draft PR #17 `TypeScript check / verify` jobs concluded **SUCCESS on that exact SHA** before deployment.
- Installed manifest v2.4.14 confirmed before replacement; built source v2.4.15 confirmed, with clean local worktree matching CI HEAD. Main remained at `47b23d56257ee272f4adc1dea21900340e673c98`.
- The six original installed files were copied and SHA256-verified under the rollback directory:
  `C:\Users\Saito\Downloads\X-Media-Navigator-Backups\pre-v2415-20261028_152529`.
  The backup includes `SHA256-OLD.txt`; no ZIP was created.
- Updated exactly the original six unpacked-extension files at `C:\Users\Saito\Downloads\X-Media-Navigator-Current`. All installed SHA256 values matched the built `extension/` sources:
  - `content_script.js` `02B182D266BD0BD25DBD33AE1B6F71DA225278A639B817C03DF5261B58446D31`
  - `manifest.json` `4AF58D7BB127E357787E5A2A2E6A9D2FBE6D5397D1F4424136BF9AAF9FF96D6A`
  - `style.css` `C0EB781242DD69F40F0F7A474A3D6D497E6290B60CA9F153ED8E4DB96D2E4543`
  - `icon16.png` `A6A5FBFB08884932B4F2DE8C5AE72EA33C5FDD8D29C36A7F943C472A6F765350`
  - `icon48.png` `131F87AEEB140C8AE516BF4B33F4F9E66EAA0C3A4A1A8D405D5EE16EC3438BC9`
  - `icon128.png` `C2415B4E7097B660840FC65D84C07E2D3B25F7DE9087346BD8643E8D16B1BDA0`
- Installed manifest `2.4.15` verified after replacement. Existing loaded Chrome extension has **not** been Reloaded and the signed-in X tab has **not** been re-tested. Do not claim live-X performance/CPU/HTTP cache improvement from this isolated code/test evidence. Reload the unpacked extension and X media tab before real acceptance.
- The existing Draft PR remains open/draft; no main merge, public release, app permission changes, outside-X network requests, browser profile restart or new persistent background task was performed.
