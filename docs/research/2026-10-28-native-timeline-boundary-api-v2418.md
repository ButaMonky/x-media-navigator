# X Media Navigator v2.4.18 — no hidden timeline scrolling / official API batch discovery study

Date: 2026-10-28 JST
Research ID: XMN-API-NOSCROLL-20261028-01
Private repository: `ButaMonky/x-media-navigator`
Baseline: `ca1031cc1e01bed9cfe00d5dab98e49c4a989232` (v2.4.17)
Working branch: `fix/prefetch-startup-v241`; Draft PR #17; **main and public versions must not be changed**.
Status: SOURCE REVIEW + OFFICIAL API DOCS + TEST-FIRST LOCAL + SYNTHETIC CHROMIUM. **NOT VERIFIED ON SIGNED-IN LIVE X**.

## User observation and exact code-path audit

The user noticed that when the last photo index is exceeded, the underlying X media page scrolls/moves and then the viewer reopens, and suggested fetching URL batches via an API instead.

v2.4.17 `src/content.ts` has THREE distinct crossing behaviors:

1. **Known, connected destination media tile:** `navigate()` uses `tryNativeInModalNavigation()`, clicking X's own exact media link while the modal is still mounted. A successful X-owned SPA route retains the modal and right replies panel and does not scroll the underlying grid from our code. This is already the preferred route.
2. **Known target but X does not accept in-modal click:** The old safe fallback closes the modal then clicks the existing exact native tile. This may visibly remount the image or the replies panel, but is distinct from the hidden-timeline auto-loading bug. URLs alone do not guarantee that X's React router will update its current modal. Do not replace this with raw `history.pushState()`, `navigation.navigate()`, synthetic GraphQL, or DOM image rewrites without real-X evidence.
3. **UNKNOWN next POST — nothing in `refs` past the current contiguous status group:** Old code computed a `startingGrid`, closed X's modal, then called `loadNextPost()`. That helper repeatedly scanned the media grid up to 20 times and invoked `lastTile.scrollIntoView({block:'end'})` plus `window.scrollTo({top: document.documentElement.scrollHeight})` every third attempt, waiting 200ms per probe (up to roughly 4s). It then clicked a native link if one appeared, or attempted to restore the former viewer. This automatically changed the original background reading position and was the root of the user's complaint about extra behind-the-modal movement.

## Implemented v2.4.18 behavior

- Remove `loadNextPost()` completely and eliminate its implicit `scrollIntoView` and `window.scrollTo` calls. No background grid scrolling to discover a new post on a right-arrow key.
- `navigate()` now checks the next actually INDEXED post BEFORE reading X's close button, taking a grid snapshot, modifying busy state, or changing the native viewer. If no next observed post exists, retain the exact modal, current photo, URL, original page scroll position and right replies panel; show a short Japanese explanation that the loaded list has ended and further posts must first be loaded in the X media tab.
- Left end stays a quiet no-op, and visible next/previous post links still use the existing X-owned SPA link path. Native 1–4 photo carousel navigation, unknown-gallery 1050ms safety probe and single-key behavior are unchanged.
- A known target that has been virtualized away from X's DOM still preserves the current modal and reports that it is unavailable. No speculative URL or manual `history.pushState` is ever constructed from status ID arithmetic.
- A user-driven X timeline scroll can naturally append more observed native tiles. The existing session's `MutationObserver`/indexed refs then make those links available, and post navigation resumes. Only user action, not the extension, advances the background grid.
- Filter-normalization fallback for a **known exact live link** still exists; it no longer relies on a snapshot of a background grid for an unknown destination.

**User-visible trade-off (MUST DISCLOSE):** reaching the end of the loaded slice stops with the original native viewer still open. Previously the extension tried to scroll/load older posts automatically; the user must now voluntarily close the viewer and scroll X's media grid to load more before continuing. No claim is made that infinite scrolling has been replaced by a seamless API implementation.

## Official X API: is batch URL acquisition possible?

Yes in principle, subject to developer authentication/billing and semantics:

- `GET https://api.x.com/2/users/{id}/tweets` returns an authored user's Posts with `max_results` range **5 to 100** and `pagination_token` for further pages. `post.fields=attachments&expansions=attachments.media_keys&media.fields=media_key,type,url,width,height` can include expanded attached media objects. Requires OAuth bearer token, app/developer access and a numeric **user ID**. The official timeline reference advertises access to up to **3,200 most recent posts**; historical access/rate limits vary.
  - https://docs.x.com/x-api/users/get-posts
  - https://docs.x.com/x-api/posts/timelines/introduction
- `GET /2/tweets?ids=...` supports batch lookup for up to **100 KNOWN Post IDs**. It does not itself discover unknown next Post IDs or guarantee Media tab ordering.
  - https://docs.x.com/x-api/posts/lookup/introduction
- X official pay-per-use documentation (reviewed 2026-10-28): **Post Read = $0.005 per returned resource**, so 100 Posts can cost approximately $0.50 in Post-read charges at that published unit rate. Costs are not based solely on the number of HTTP requests; other resource types/limits and current Developer Console rates may apply.
  - https://docs.x.com/x-api/getting-started/pricing
- `Get Users Posts` is NOT a `GET user/media-tab-in-exact-web-order` endpoint. Its support for `exclude=replies,retweets` does not promise identical filtering to the web Media tab; attached photo/video/GIF semantics, reposts, quotes, protected status visibility, native pagination and order may differ.
- An API response with photo URLs also does not instruct X's *existing* React modal and right replies panel to swap to that Post. Native X route handling must still be involved. An independent custom viewer using only CDN image URLs would not inherently preserve replies, media gallery controls, permissions or video.
- Therefore DO NOT embed OAuth/client tokens into an unpacked extension, piggyback on X session cookies or undocumented web GraphQL endpoints, or incur pay-per-use charges without separate explicit opt-in/consent. No X API request was sent by this work.

## Safe research-only batch adapter (not shipped in content script)

`tools/x-api-batch-research.mjs` contains ONLY pure functions:
- `buildUserPostsApiUrl(userId, paginationToken)` constructs the documented URL with up to 100 results/media expansions; it cannot send a request.
- `studyUserPostsPage(fixture, profile)` maps one hypothetical API response to validated photo URL and candidate `/handle/status/ID/photo/N` links, rejecting unknown/mixed media types, missing expansions, duplicate keys, invalid numeric IDs, non-X media URLs and untrusted handle text. Its result explicitly sets `exactXMediaTabOrderProven:false` to prevent accidental promotion to live navigator authority.
- There is no bearer token, no user cookie access, no network fetch, no API cost and no invocation from `extension/content_script.js`. `tests/x-api-batch-research.test.mjs` has four offline scenarios. This is a source-backed integration design exploration, not a falsely advertised functional API connection.

## Test-first evidence and backwards compatibility

- Three newly written red regression cases exposed v2.4.17's premature grid snapshot, viewer closing and background loader: terminal ArrowRight must not close, scroll or guess a URL; a naturally appended next Post must resume SPA; a proven end-of-album key must not initiate hidden browsing. They pass after removing the background loader.
- Replaced three outdated lazy-scroll tests with native no-scroll tests that verify unknown next group, filter normalization for an EXACT known destination only, and natural user-driven X grid growth.
- Chromium synthetic X fixture explicitly checks the last loaded post keeps its existing modal, URL and replies panel with **zero hidden grid scroll**, then simulates an explicit X media-grid scroll loading new /33 and confirms that the existing observed native route resumes without remount guessing. A final terminal post asserts the same behavior even at the end of a longer list.
- Existing native gallery first/last-key behavior, 1–4-photo counters, correct user profile scoping, protected panel, v2.4.17 progressive low→high image handoff and 5-image/2-concurrent/80MiB bounds remain covered by regression tests.
- `tests/package-integrity.test.mjs` explicitly disallows `window.scrollTo`, `scrollIntoView`, calls to `api.x.com`, and undocumented `graphql/UserMedia` within shipping code to prevent accidental regression or unapproved charged API use.

## Open questions / future improvements

1. **Real X observation blocked** in current Chat browser context: originating extension browser context unavailable. No cookies, user login, HAR, private browsing history or X API credentials were requested. The code can be tested in local synthetic Chromium, but must not be called production-proof until verified by the user.
2. **Known target link's native in-modal SPA not always honored by X**. The safe close/reopen fallback is retained; removing it would break crossing known posts in those layouts. Need real-X DOM event/route evidence, not speculative routing or separate hidden browsing pages, before simplifying.
3. Optional future paid X API batch provider requires separate explicit developer-account/OAuth permissions, budget approval and a verified mapping to X's Media tab/React. It should be opt-in and **must not** mix its speculative candidate order with verified native DOM refs.
4. At boundary where no next URL is known, a choice could be an explicitly user-triggered “Load more” action; automatic scroll is intentionally removed now. This would still have to coordinate X's own virtualization and scrollbar. Avoid prematurely adding UI settings.
5. Browser `Navigation API` only observes an already committed SPA route. It does not provide post IDs, media lists, CDN URLs or a magic way to make X render a different post. It remains a helpful synchronization event, not a replacement for a timeline API.

No public release/main changes, forced Chrome restart, new background service, scheduler, extra CDN request, extension permission or ZIP planned.

## Local validation and source audit (2026-10-28 JST)

- `npm ci`: **PASS**, npm reports zero vulnerabilities.
- `npm test`: **166 tests / 158 PASS / 0 FAIL / 2 SKIP / 6 LIVE-X TODO**. The default Node run skips browser-dependent tests, which were then run explicitly.
- `npm run typecheck`: **PASS**.
- `XMN_RUN_CHROMIUM=1`, `CHROMIUM_PATH=<installed Edge>`, `npm run test:browser`: **3 PASS / 0 FAIL / 0 SKIP** (synthetic X and localhost-only cross-origin fixture). The synthetic X suite checks **40 labels** including terminal-no-scroll, retained modal/replies, explicit manual timeline loading, and resumed X-owned in-modal SPA.
- Disposable isolated MV3 Navigation API probe: **PASS** all four signals, no user's signed-in browser profile used.
- `node --test tests/x-api-batch-research.test.mjs`: four offline pure URL/media-response-study tests passed. No official API network call/token/user-account access.
- `tests/package-integrity.test.mjs`: source and compiled JS explicitly contain **no** `window.scrollTo(...)` / `scrollIntoView(...)`, `api.x.com` access or undocumented GraphQL media endpoint calls. Manifest remains without new permissions/host_permissions.
- `git diff --check`: PASS. Baseline HEAD matched origin `ca1031cc1e01bed9cfe00d5dab98e49c4a989232`, and public main remained `47b23d56257ee272f4adc1dea21900340e673c98`.
- Compiled JS baseline blob size **118,079 bytes**; new generated build **116,397 bytes** (1,682 bytes smaller), primarily from removing the 20-attempt background autoscroller. These are source-artifact bytes, not a measured memory/FPS/network difference.
- **Known-post fallback still exists:** an observed native tile that X refuses to navigate while the modal remains open may still trigger the original one-time close+reopen fallback. This preserves functionality while the authenticated X router cannot be instrumented from Chat; never claim all modals are now always retained.

## Tool/refusal incident log

- Read-only Chat browser tab listing failed with "Browser access requires the originating browser context" on 2026-10-28 JST. **BLOCKED scope:** inspecting the real signed-in X Media tab/DOM to distinguish X-owned close+reopen from our known-link fallback and to measure actual scroll/route/network timing. Work continued via official public documentation, private Git checkout, Node and isolated synthetic Chromium. No browser-context safety boundary was bypassed, no credentials/profile data retrieved. Next position: authorized browser context or user live-X observations.
- One parallel `Desktop_Commander_Local_Compact.edit_block` version-edit call reported its local fuzzy-search dependency `fastest-levenshtein` missing. The subsequent exact read of all three version files confirmed that `package.json`, `package-lock.json` and the private manifest were ALL correctly set to 2.4.18; `npm ci` and all tests parsed and validated those files. No reset/stash/rebase/force or unsafe replacement was used; failure details retained here for future agents.
