# X Media Navigator private v2.4.10 — idle CPU, memory allocation and album prefetch audit

Date: 2026-10-26 JST
Baseline: private v2.4.9 commit `2f7125f38a180948c2a2d00698ad4b446d2d4594`
Scope: `fix/prefetch-startup-v241`, Draft PR #17 only. No main merge or public release.

## Findings and fixes (source-verified)

1. **Unchanged gallery polling recomputed the whole timeline every 450ms.** `tick()` -> `syncViewer()` -> `ensureViewerButtons()` -> `updateViewerState()` rebuilt a Set of unique status IDs and looked up the current item, even with identical URL, media list and navigation state. For a long timeline this is repeated O(N) work. The controller now caches a viewer-identity/status fingerprint (pathname, active profile, refs count, navigation busy) and skips redundant work. It invalidates on viewer removal, native modal replacement, new extension buttons/indicator, route changes, new indexed media and busy transitions. Native ArrowLeft/Right still query X's live controls.
2. **Temporary O(N) arrays on status fallback.** `findCurrentIndex` previously mapped all media refs to temporary objects and filtered by status, then `activeIndex` did the same again on incomplete photo links. Both now use allocation-free index/loops, retaining exact-match and ambiguous-status semantics.
3. **Redundant per-tile image subtree scanning.** `recordTileImageSource` queried both the correct owned anchor image and the entire tile even when the anchor image was found. It now searches the whole tile only as a fallback, preserving X's legacy image-outside-anchor layout.
4. **Equivalent CDN URL parameter permutations occupied separate prefetch keys.** `preloadImageUrl` now canonicalizes URLSearchParams ordering after choosing `name=large`; identical allowed parameters share a queue entry. No origins were broadened and extra query parameters are retained. CDN HTTP-cache hit rates remain unmeasured on real X.
5. **Next post with several photos did not warm its second photo.** The bounded five-target lookahead now includes one additional image of the nearest next post when already indexed, alongside later posts and the reserved previous-photo slot from v2.4.9. Existing limits remain five targets, at most two concurrent transfers, six retained image records and estimated 80 MiB decoded budget.

## Test-first evidence

- All five new focused regressions **failed on the old compiled version** before changes: unchanged viewer O(N) rescans, O(N) arrays, redundant tile-wide queries, unseen second photo from the nearest album and CDN query-order duplication.
- Additional regression verifies that a remounted indicator invalidates the viewer-state cache even with an unchanged URL.
- Existing tests cover ambiguous photo totals, no unseen-photo skipping, native gallery arrows, SPA modal retention, fallback and overlay cleanup, video/GIF isolation, cross-post ordering, slow prefetch watchdog, prefetch cancellation and bounded queues.

## Synthetic microbenchmark (NOT real X.com FPS or CPU usage)

Local Node.js VM loads the old `git show 2f7125f:extension/content_script.js` and new compiled `extension/content_script.js`; uses the same 4000-entry media-ref array, fixed status route and simulated controls, then calls `updateViewerState()` 1000 times with no changes.

| Version | Time | Expensive state computations |
| --- | ---: | ---: |
| v2.4.9 baseline | 1052.01 ms | 1000 |
| New optimized build | 5.39 ms | 1 |

These single-run Node VM figures illustrate *avoidable work*, not production UI latency; they must not be presented as a real X.com performance benchmark.

## Local validation (2026-10-26 JST)

- `npm ci` success; npm reports 0 dependency vulnerabilities.
- `npm test`: **114 total / 107 pass / 0 fail / 1 skip / 6 LIVE-X TODO**.
- `npm run typecheck`: pass.
- `XMN_RUN_CHROMIUM=1 CHROMIUM_PATH=<local Microsoft Edge>` with `npm run test:browser`: **2 pass / 0 fail / 0 skip** using a synthetic X page in the Chromium engine.
- The existing native modal-preserving SPA navigation, photo-1/last-photo keyboard behavior, right replies-panel DOM continuity fixture, rollback route, priority cancellation and memory/transfer limits remain tested.
- No runtime package, permission, background task, external transfer or updater added. The generated extension JavaScript is the only source code artifact installed with the existing manifest/style/icons.

## Remaining risks and next studies

- **LIVE X NOT VERIFIED**: HTML/JS synthetic tests cannot prove actual X photo URLs, network cache reuse, right-panel animation behavior, or real-world FPS/CPU improvements. Real X CDN `name=large` prefetch vs X display `name=orig` may use distinct HTTP cache keys even for the same media ID.
- Modal route transitions may still use the old close-and-reopen fallback if X does not handle a native in-modal tile click. Do not monkeypatch React/history or touch the X authentication/GraphQL layer to guess a solution.
- Before calling real-X optimization complete, record DevTools Performance/Network observations for 1–4-image posts, sustained right/left arrows, large virtualized media feeds, slow image loads, and video/GIF behavior.
- Keep user-facing private v2.4.10 beta isolated from main and public releases until explicit real-X acceptance. Update only the fixed six-file folder after push+PR CI success, with a timestamped exact-SHA backup; no ZIP churn.
