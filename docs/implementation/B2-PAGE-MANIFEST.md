# B2 – Immutable checkpoint page manifest (2026-10-29)

- Work ID: `XMN-B2-MANIFEST-20261029`.
- Source branch: `task/xmn-b2-manifest-20261029`, based on clean nonpublic development commit `d34253c27d090e87dd3c3a109cd86b07ce87b025`.
- Parent achievements: B0 regression tests, B1 isolated MV3 storage, B2 whole-post local prefetch window, B2 immutable page snapshots, B3 cancellation, B4 image cache.
- This stage **does not change X gallery navigation, active URLs, normal Chrome installation, private QA installation, released main, or existing Draft PR**.

## Implementation

`src/checkpoint-manifest.ts` defines versioned `PublicPageManifest` and `PublicPageDescriptor` contracts. Descriptors identify an immutable page number, first and last media URL, its exact media-ref count, incoming FxEmbed cursor, and outgoing cursor. The manifest binds them to a single public profile, X media-tab filter, expiration and active page.

The worker adds `manifest.put`, `manifest.get`, `manifest.clear` behind the **existing** origin/frame/tab/explicit third-party-consent guard. It requires all referenced `checkpoint.put` pages to already exist, be valid and unexpired, to match the descriptor's owner/timeline/first/last refs/count/outgoing cursor, and to outlive the manifest.

Additional invariants:

- Page indexes must be contiguous, starting at 0, with 1–64 pages.
- Page groups must strictly descend by status ID. The same post must not straddle an immutable page boundary.
- The first incoming cursor is null. Every later incoming cursor must equal the preceding page's outgoing cursor; only the final page may have a null outgoing cursor.
- Each page contains 1–450 validated refs. The manifest cannot claim a verified page that was not actually stored.
- Unknown manifest/descriptor fields, unexpected profile/filter, malformed cursor, future expiration beyond the allowed window, changed earlier page descriptors, a regressed page count, and artificial TTL extension are rejected.
- The manifest is committed **after** page validation as a separate one-object `chrome.storage.session.set`. Revalidation occurs on every get; missing/corrupted/expired pages invalidate the manifest.
- Existing page storage is immutable. Manifest changes are serialized per tab/profile, preserve earlier descriptors, and permit changes only to activePage or verified append of a subsequent page.
- Clearing a checkpoint, manifest, or entire saved session removes its manifest; closing the Chrome tab also removes its manifests. Other tabs and public profiles are unaffected.

`SessionStore` now exposes `savePageManifest`, `loadPageManifest`, `clearPageManifest`, leaving the existing UI unaffected.

## Testing

`tests/session-worker.test.mjs` covers: denied storage without consent, missing page refusal, a valid two-page cursor chain, active-page updates, different tabs, corruption, expired/missing page invalidation, out-of-order IDs, malformed descriptors, an invented cursor, active index outside range, overwrite/rollback prevention, and explicit/tab-close cleanup.

`tools/mv3-worker-smoke.mjs` adds an actual Chrome for Testing test: save a checkpoint + manifest, verify it across an HTTP document transition, and preserve the existing X-like modal and replies. Its worker host check is intentionally modified **only inside a disposable localhost test extension**, not in production.

## Explicit limitation and next gates

This is a **validated manifest foundation** rather than a working 450+ media browser. The production Controller still has a 450-ref accumulation limit and does not yet archive/activate manifest pages or evict and restore the native gallery. No guess of a real X URL or signed-in API cursor is made.

Before enabling page switching, prove correct forward/backward transitions, current-photo grouping, cursor provenance from the actual API response, saved scroll/route ownership, storage quota behavior, cross-document recovery and cancel/retry reentrancy. Require signed-in real X acceptance for the full behavior before releasing.

## Verification checkpoint – 2026-10-29

- `npm test`: **273 cases / 264 PASS / 0 FAIL / 3 SKIP / 6 real-X TODO**.
- `npm run typecheck`: both Content Script and MV3 Service Worker pass.
- Edge Chromium synthetic gallery: **4 PASS / 0 FAIL**.
- Actual Chrome for Testing MV3 test: verifies an immutable committed manifest with its checkpoint exists both before and after cross-document navigation, **PASS**.
- Real MV3 denied-origin test using independent Edge Chromium: **PASS**.
- The implementation is confined to the private development task branch. It does not bypass the third-party FxEmbed consent or weaken Chrome host ownership checks.
- Release, current Chrome installation, browser user data, existing public main and Draft PR are untouched. This stage will not be described as infinite media paging.
