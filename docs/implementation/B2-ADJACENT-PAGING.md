# B2 – Reversible navigation between already committed immutable pages

- Task ID: `XMN-B2-ADJACENT-20261029`.
- Dedicated branch: `task/xmn-b2-adjacent-20261029` from the clean, remote-matching private development commit `e93c3234e87029a438c8d14904d6311869b93be9`.
- Existing immutable snapshots, validated manifest, cross-document restore and X-owned media routes remain authoritative. No new permissions, no X scraping, no guessed URL, and no modification to published main or installed Chrome.

## Implemented safely

1. The MV3 Worker implements `checkpoint.adjacent` using the same strict **exact current pathname / sender origin / top frame / tab ID / profile / consent / whole-manifest validation** as `checkpoint.find`. It returns only the URL of an already committed adjacent page.
2. Right from the final post of a page can return the **first media of the next older page**. Left from the first post can return the **first photo of the last post on the immediately newer page** (not the last photo, and not an invented X URL). Any nonboundary request returns null. This is safe for posts containing 1–4 photos; no album may cross a page boundary.
3. `SessionStore.findAdjacentCheckpoint(profile, href, direction)` enforces typed direction and canonical media URL again before returning it to the Content Script.
4. `Controller.navigate()` consults this committed checkpoint only when the current session was previously restored and the current post is at a known edge. The previous button is enabled for a historical page index greater than zero. Ordinary X pages and intra-page gallery transitions are unchanged.
5. A single pending lookup suppresses rapid repeated keys. Before navigating, the Controller rechecks its generation, pathname, owner, viewer connectivity, active navigation state and tab visibility. Chronology and media URL ownership are checked independently.
6. Successful transitions use an ordinary **full document** URL navigation rather than writing History API state or simulating a React SPA route. Upon the new document, the already implemented exact-worker-checkpoint restore reactivates only its matching page. A missing, expired, corrupted or unrelated page refuses to navigate; it is never silently repaired using a speculative API URL.

## Tested

- `tests/session-worker.test.mjs` validates both directions, a previous album with multiple photos, first/last page boundaries, same-tab and same-path origin checks, invalid directions, no fabricated URLs or cross-profile lookup.
- `tests/b2-adjacent-navigation.test.mjs` checks right/left page hops, an enabled back button on historical pages, a single request despite repeated keys, a changed route while awaiting worker, incorrect chronological replies, and stale-page controls.
- Actual Chrome for Testing MV3 round trip: a newer **500/400** page is the main tab session while an older **300/200** page is immutable and committed. A synthetic gallery starts on older 300, clicks **previous → newer 400**, then clicks **next → older 300**, and verifies the original replies panel and correct per-page status labels on all document transitions. The Worker origin guard is patched **only in the disposable localhost test copy**, never in product code.
- The existing Node regression suite, Edge Chromium synthetic browser, Chrome for Testing and unauthorized-sender negative MV3 test must all pass before publication to the private task branch. GitHub Actions are the final CI gate.

## Not yet implemented

- **Automatic creation of new committed pages when FxEmbed reaches 450 refs**, eviction and quota-safe storage, and backward/forward paging into thousands of posts. This module only navigates between previously archived and worker-verified pages, without downloading content or expanding scope.
- Smooth retained React SPA across page boundaries, real X network timing and drawing, photo/GIF/video mixtures, and signed-in X acceptance.
- No release/QA installation, official main merge, stable branch changes or existing Draft PR updates.

Next stage: prove that the current 450-ref accumulation can be safely archived as a complete page without losing the active post or its album, then save the next complete page using its provider cursor; publish the manifest only after all parts have passed worker validation and the tab/route is unchanged.
