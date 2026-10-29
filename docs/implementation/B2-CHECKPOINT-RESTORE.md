# B2 immutable checkpoint: safe cross-document restoration

Task: `XMN-B2-CHECKPOINT-RESTORE-20261029`, private branch `task/xmn-b2-restore-20261029`.

Base: `e3dbbcae647914dedf3e7d2a9f5f5bd32478392c` (B2 validated immutable page manifest, B0–B4 fixes). This stage does not change public main, installed stable v2.4.18, installed private QA v2.4.20, stable developer branch, or existing PR #17.

## Changes

- The MV3 worker implements `checkpoint.find`. It receives only the public handle and exact X media pathname. A top-frame X/Twitter document with the identical URL is required; foreign origins, other profiles, bare status URLs, and mismatched sender paths are rejected.
- Before returning a checkpoint page, the worker confirms explicit FxEmbed consent, loads the published manifest and **revalidates every referenced immutable page** (owner, filter, TTL, cursor, first/last URL, length, ordering). A missing/corrupt page invalidates the manifest; no partial collection is restored. The route must belong to exactly one page.
- `SessionStore.findCheckpointForRoute(profile, href)` adds one typed and bounded worker call. It does not give the web page access to extension storage or reveal other tabs' snapshots.
- During full-document restore, `Controller` first checks the ordinary active tab snapshot. Only when its refs do not include the **exact media route** does it ask the worker for a committed historical page. This is a read-only fallback, not a new search, guessed X URL or forced React/SPA navigation. If the pathname, profile, or session generation changes while waiting, no stale state is restored.
- The original post/album group, photo URLs, API cursor, indexed media and known photo totals are restored from the chosen snapshot without inventing missing refs. Existing UI and replies remain native X-owned.

## Verification

- New worker tests: exact sender URL and owning page; another tab/profile rejection; bare route refusal; missing/corrupt committed page abort; uncommitted URL absent.
- New Controller tests: missing current-page media recovered from verified history, ordinary session fast path, absent/denied lookup, route/generation changes, bare posts and unrelated snapshots fail closed.
- Real Chrome for Testing MV3 smoke: the normal session contains a newer 500/400 page while the active document visits the **older 300/200 committed checkpoint**, proving the Worker, Content Script and native-like reply panel restore the correct historical page. Host origin rules are adjusted **only** inside the disposable localhost test extension.
- Node tests: **282 total, 273 PASS, 0 FAIL, 3 SKIP, 6 actual-X TODO**; TypeScript Content/Worker PASS; isolated Edge Chromium synthetic 4 PASS; actual Chrome for Testing MV3 historical restore PASS; Edge MV3 unauthorized-origin rejection PASS. GitHub Actions must be verified after committing.

## Remaining limits / next step

This feature enables **read-only restoration of already committed historical pages on an explicit document route**. It does not yet automatically archive API additions after the 450-ref limit, move to adjacent checkpoint pages on arrow presses, or evict in-memory posts. These features require preserving cursor provenance, page ownership, same-tab authorization, user intent, and fully verified manifest adjacency.

Do not update published main, stable Chrome or private installed QA before signed-in X acceptance.
