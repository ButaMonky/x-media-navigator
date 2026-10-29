# X Media Navigator｜B2 checkpoint storage foundation

## Scope and provenance

- Task ID: XMN-B2-CHECKPOINT-20261029
- Candidate branch: `task/xmn-b2-checkpoint-20261029`, independently created from the clean, remote-matching `task/xmn-b0-b3-20261029` commit `6b9a7a5bccc83538e077aef496c83b11302102b4`.
- Research: R-001, R-002, R-006, R-029, R-039, R-041, and the B2 model integration checkpoint in `docs/implementation/B0-B3-STATUS.md`.
- Product restrictions: **no published main, stable extension, installed v2.4.18 or QA v2.4.20 changes**; no authenticated X browsing or production release.

## Implemented

1. New immutable checkpoint operations in the existing MV3 worker: `checkpoint.put`, `checkpoint.get`, `checkpoint.list`, and `checkpoint.clear`. No new host privileges or broad tab-inspection permissions.
2. Worker keys are namespaced by **Chrome tab ID + public profile + integer page index 0–63**. The same 120,000-character, up to 450-ref, 30-minute, ordered/status-owner schema-1 validation applies to all stored pages. Checkpoints additionally require a verified API anchor and prior third-party consent.
3. Unrecognized fields are rejected instead of storing arbitrary nested data. Chrome may reorder object fields during extension-storage serialization, so immutable-page idempotency compares a known, canonically ordered schema, not raw `JSON.stringify()` key iteration. Duplicate identical writes succeed; conflicting same-page snapshots fail.
4. Per-page pending writes serialize. Checkpoint clear and tab close wait for already-started writes before enumerating and deleting, preventing abandoned asynchronous writes from resurrecting page content. Session clear also removes its profile checkpoints; tab close removes all checkpoints and consent for that tab.
5. `SessionStore` provides `saveCheckpoint(page, data)`, `loadCheckpoint(profile, page)`, `listCheckpoints(profile)`, and `clearCheckpoints(profile, page?)`, all through the existing origin-validated worker.
6. R-041: with an unexhausted external continuation cursor, the post indicator shows `投稿 X / Y+` rather than implying `Y` is the definite historical total; the tooltip explains that `Y` counts loaded posts. When the provider is exhausted, it displays `投稿 X / Y` again.

## Verification and guardrails

- Unit tests use a disposable MV3 worker VM to exercise tab/profile separation, explicit consent, valid page ranges, expiry, malformed sequences, extra fields, immutable duplicates, conflicting writes, a delayed write versus clear-all, and tab closure.
- The real Chrome-for-Testing MV3 smoke test saves a checkpoint with consent, validates list/read/replay/conflict, then verifies it can still read the immutable page after navigating to another document in the same tab.
- The Edge Chromium synthetic gallery test independently covers both the known-terminal plain label and the real worker smoke covers the uncertain `+` indicator.
- Failed initial MV3 test: the browser storage serializer reordered object keys, so the first immutable replay compared unequal on the same data. The worker was corrected to canonicalize only the strict public-session fields; local MV3 then passed. This is recorded instead of hidden.

## Explicitly NOT implemented

- **The checkpoint store is ready but the main Controller does not yet archive or page through the 450+ complete-post history.** Cursor ownership, page-manifest commitment, correct forward/backward restoration, and the distinction between X DOM and FxEmbed sources must be integrated and tested before changing the existing 450-ref accumulation limit.
- No website screenshots, actual signed-in X navigation, 28→29-page media proof, Chrome permission prompts, memory consumption or real user timing evidence have been collected.
- Do not claim progress beyond the checkpoint-storage foundation and loaded-total UI wording. Further paging must not invent URLs, evict an active album, bypass API consent, or change unrelated Chrome installations.

## Next safe steps

Introduce a separately versioned page manifest with immutable committed page boundaries and a mutable active page; atomically persist the manifest and current page (or fail without changing the visible index). On cross-document navigation restore only pages proven to belong to the current tab/profile/timeline, validate adjacency, and retain a reversible left/right position. Prove storage quota behavior, restart recovery, stale completion cancellation, and native DOM ownership in synthetic tests before enabling automatic eviction or increasing the 450-ref limit.

## Local acceptance (candidate branch only)

- `npm test`: 264 total, **255 PASS / 0 FAIL / 3 SKIP / 6 real-X TODO**.
- `npm run typecheck`: Content Script and MV3 Service Worker PASS.
- `XMN_RUN_CHROMIUM=1 npm run test:browser`: 4 PASS / 0 FAIL on isolated Edge Chromium.
- `npm run test:mv3`: Chrome for Testing actual MV3 Worker PASS including consent, immutable checkpoint save/replay/collision/list/read, and cross-document session recovery.
- `npm run test:mv3:reject`: isolated Edge MV3 Worker rejects a localhost sender, PASS. The unmodified production origin restrictions were preserved in this negative test.
- All temporary browser profiles and their test-owned browser processes are removed. These are isolated synthetic fixtures, **not authenticated X production acceptance**.
- The first real MV3 smoke run detected a same-content replay failure because Chrome serializes object property order differently. Fixed with strict schema-key ordering; re-run PASSED without loosening the same-page collision refusal.
