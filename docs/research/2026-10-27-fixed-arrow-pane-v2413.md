# X Media Navigator v2.4.13 — stop post-to-post arrow drift

Date: 2026-10-27 JST
Branch: `fix/prefetch-startup-v241` (PRIVATE)
Base SHA: `709b1d34a149641f5b78ee45ca307e31c0ceb0fc` (v2.4.12)
Draft PR: #17 (must remain Draft)
Audit ID: AUD-DRIFT-20261027-01
Verification status: SOURCE VERIFIED / SYNTHETIC CHROMIUM VERIFIED / **LIVE X NOT YET RE-VERIFIED**

## User incident

The user reported that as they advance across posts, custom ◀/▶ post navigation buttons progressively drift out of position. v2.4.12 had fixed disappearing arrows across photo slides; the current report is a different bug. Treat the report as real-X evidence that the positional drift exists, not proof of this new fix's acceptance.

## Source-level diagnosis

- `positionControls(viewer)` fetched the mutable `[data-testid="swipe-to-dismiss"]` viewer's `getBoundingClientRect()` whenever the route or active viewer changed and immediately changed a viewport-fixed portal's left/top/width/height.
- X may translate, animate or replace the inner swipe/photo viewer during SPA transitions. Its intermediate rectangle is not a stable photo-pane anchor. Reusing intermediate coordinates causes the arrows to move between posts.
- X's React render can remove the previous swipe element before mounting the new one. The prior `syncViewer` logic then failed to recognize that both slides belonged to the SAME retained dialog, detached and rebuilt the otherwise stable portal, and could clear its positional anchor.

## Implemented

1. Store the photo-pane rectangle in viewport-space coordinates on its first valid visible capture, and use this fixed anchor for subsequent posts while the viewport and fullscreen root remain unchanged. Repeated transitions no longer repeatedly call `getBoundingClientRect()` to move the portal.
2. Clear the anchor on an actual window resize, fullscreen transition, new media session, or explicit manual close back to the media grid. An invalid/minuscule transient viewer rectangle is never cached.
3. Preserve anchor and one existing portal DOM across native X's SPA slide recreation, even when the old viewer is already detached: remember the retained dialog identity separately.
4. Keep the overlay outside React-owned swipe elements, preserve pointer-events:none on non-button regions, and do not change the user's native photo arrows, keyboard semantics, reply panel handling, prefetch capacity, permissions, GraphQL or URL/history ownership.
5. Do not start a new worker, updater/scheduler or additional prefetch transfer.

## Test-first evidence

- A new Node test reproducing 14 sequential route changes with changing viewer rectangles failed against v2.4.12: previous fixed-layer left/top changed (from 16px/90px to 27px/101px on the first transition), and would continue drifting.
- A second test confirmed that the same anchor must invalidate for true viewport size changes.
- An additional RED test showed that when React detaches the old slide before mounting the next under the same dialog, prior code passed `preserveControls=false`; this destroyed and remounted the portal.
- A Chromium synthetic-X fixture now exercises native POST→POST navigation in both directions with simulated viewer transforms (+34px then -26px), asserts the same portal node and fixed position survive, and checks the normal X right reply-panel identity and native gallery navigation remain intact.
- A unit test checks fullscreen-root changes refresh the otherwise fixed anchor.

## Comparable synthetic microbenchmark (not real-X CPU/FPS)

Node VM evaluated both baseline `git show 709b1d3:extension/content_script.js` and the patched compiled JavaScript on the same mock viewer, with an assumed +3px temporary offset per transition, 20 subsequent POST changes, unchanged 1536×900 viewport.

| | v2.4.12 baseline | Patched |
|---|---:|---:|
| Initial position | left 16px, top 90px | left 16px, top 90px |
| After 20 transitions | left 76px, top 150px | left 16px, top 90px |
| Viewer bounding rect reads | 21 | 1 |

This compares a deliberately simulated moving inner viewer. It confirms the previous cumulative positional algorithm and new stabilizing behavior but does NOT imply real X slides shift exactly 3px per transition or that true network/image rendering is faster.

## Risks and pending verification

- **LIVE X NOT VERIFIED FOR v2.4.13.** The signed-in X DOM is unavailable through the current Chat browser connector, so real modal animations, resizing, keyboard focus, fullscreen and right-panel persistence need testing with the user's loaded extension.
- A stable viewport anchor intentionally does not follow incidental photo content transforms. If X legitimately restructures its media pane without firing a resize/fullscreen change, follow-up profiling may be needed. Never add recurring costly layout polling to "fix" it without proof.
- Real prefetch CDN cache reuse (e.g. `name=large` versus `name=orig` display) is still unmeasured; no speculative network changes here.
- Keep Draft PR #17, main unchanged, Issues #14/#16 open pending real-X acceptance. Deploy only after npm ci, full Node tests, typecheck, actual Chromium synthetic integration and GitHub push/PR CI success, with six-file SHA256-verified rollback backup.

## Pre-deployment validation (2026-10-27 JST)

- `npm ci`: PASS, 0 npm-audit vulnerabilities reported.
- `npm test`: **129 total, 122 PASS, 0 FAIL, 1 SKIP, 6 real-X TODO**.
- `npm run typecheck`: PASS.
- `XMN_RUN_CHROMIUM=1` with local Microsoft Edge `CHROMIUM_PATH` and `npm run test:browser`: **2 PASS, 0 FAIL, 0 SKIP** (synthetic X in a genuine Chromium engine; the fixture checks 30 labeled behaviors).
- Both native left/right post transitions with temporary swipe transforms preserve the same portal node, fixed rect, native gallery controls and retained reply-panel DOM in the fixture. The click-through and modal-close cleanup checks continue passing.
- Git worktree validated with `git diff --check` and branch HEAD confirmed equal to origin before committing. Main remained unchanged.
