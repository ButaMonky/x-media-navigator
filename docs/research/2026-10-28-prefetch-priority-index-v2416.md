# X Media Navigator v2.4.16 — recycled thumbnail correctness, post-index efficiency and memory eviction priority

Date: 2026-10-28 JST
Research ID: XMN-20261028-CACHE-INDEX-001
Baseline: private `fix/prefetch-startup-v241` at `51061e259025371456949685c41eb05ff1286f59` (v2.4.15)
Scope: private Draft PR #17 only; no main merge/public release.
Verification classes: SOURCE REVIEW / RED→GREEN REGRESSIONS / SYNTHETIC BENCHMARK / CHROMIUM FIXTURE; **NO REAL X CACHE-LATENCY MEASUREMENT**.

## Finding 1 — recycled media-thumbnail src may supersede stale currentSrc

Before: `recordTileImageSource()` always tried `img.currentSrc` before `img.src`. When X reuses the same thumbnail DOM element for another tile and begins loading a new assigned `src`, the displayed/selected `currentSrc` can temporarily still refer to a previous resource. In that state v2.4.15 incorrectly stored the OLD media ID against the NEW post and could prefetch the wrong photo.

Fix: inspect both URL candidates after the existing strict `pbs.twimg.com/media` origin/path validator. If both IDs differ and the image is not fully loaded, prefer the newly assigned `src`. When a valid image is already completely loaded (`complete===true` and positive `naturalWidth`), favor the browser-selected `currentSrc`, which can reflect a loaded `srcset`/`picture` candidate instead of the fallback `src`. Invalid/data: placeholders are always ignored. Once the desired photo finishes loading, its normalized source URL remains identical, so we do not increment `imageSourcesRevision` or requeue a redundant fetch.

Red tests: recycled thumbnail OLD currentSrc + NEW assigned src failed, then passed; loaded srcset candidate, data: fallback and unchanged post-image revision all pass. The Chromium synthetic-X DOM fixture also now checks an actual `img[src]` element with stale `currentSrc` and newly assigned `src`, without initiating a CDN request.

Browser reference: https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/currentSrc
Browser reference: https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/complete

## Finding 2 — repeated linear media-position and status-number lookups

Before: `activeIndex()` called a full `findCurrentIndex()` scan of `refs` even when the controller already held a verified `indexes` map from media key to index. `updateViewerState()` rebuilt a full `Array.from(new Set(this.refs.map(...)))` of unique post IDs on every changed route, generating temporary arrays and garbage collection pressure on long feeds.

Fix: use the indexed O(1) lookup only if `refs[index].key` exactly matches the current X media route, otherwise use the existing conservative exact/fallback scan so stale and virtualized DOM indexes never create a wrong post jump. Cache first-seen post ordinal in a `Map`, rebuilding only when the append-only `refs` array identity/length changes; invalidate the cache on session reset. Preserve repeated/noncontiguous status IDs and the exact existing `投稿 N / M` display.

Red tests: an indexed 3000-entry feed must not touch more than five array slots; 2000-post route changes must not rebuild the old status list; stale indexes fall back safely; repeated status groups retain first-seen numbering; appending a new post correctly updates count.

### Reproducible synthetic benchmark (NOT actual X FPS or network latency)

Both old `git show c043fab:extension/content_script.js` and patched compiled JS were run in the same Node.js VM with 3000 media refs and 400 route changes. The UI update/label code path was used, not X's real DOM. Three runs:

| Trial | v2.4.15 baseline | Patched |
| --- | ---: | ---: |
| 1 | 168.22ms | 4.21ms |
| 2 | 168.45ms | 3.55ms |
| 3 | 155.31ms | 3.93ms |

The same final status label `投稿 784 / 3000` appeared in both builds. This is fewer duplicate scans/allocations under a controlled large-list workload; it is **NOT evidence of a 40x real-world speedup**. The new ordinal Map consumes some additional memory proportional to the number of distinct indexed posts and is invalidated when list length/identity changes.

## Finding 3 — decoded memory trimming evicted nearest wanted photo before distant ones

Before: `trimPrefetched()` preferred evicting non-wanted cache entries, but when all decoded entries were still wanted and exceeded the 80MiB cap, it evicted the oldest Map entry. `preloadAdjacentImages()` orders wanted URLs from NEAREST to FARTHEST, so the oldest entry often represented the most immediately useful photo. This could throw away the next photo while preserving a distant one.

Fix: preserve the original no-handoff-eviction and no-in-flight-eviction safeguards. First evict an obsolete URL if present (oldest first among ties); otherwise evict the farthest-ranked wanted URL first. Priority uses the existing ordered five-entry `prefetchWanted` Set. The decoded 80MiB cap, max six records, up-to-five target URLs and two concurrent transfers are unchanged; no new requests or extra permissions are added.

Red test: three wanted 35MiB decoded images (`near`, `middle`, `far`) over the 80MiB cap formerly kept `middle+far`; patched code keeps `near+middle`. Another regression ensures an obsolete cached URL is removed first.

## Safety constraints and research left open

- Keep standard X gallery arrows for unseen photos, one-key post boundaries where proven, modal/replies continuity, fixed custom ▶◀, no unsafe navigation guesses.
- No React internals, `history.pushState` hook, GraphQL, authentication, external telemetry, extra host permissions, updater/scheduler or background service.
- The bundled read-only `tools/media-cache-audit.js` in v2.4.14 remains available. Cross-origin Resource Timing `transferSize=0` is NOT proof of cache hit without positive decoded size/TAO evidence: https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming/transferSize
- Live X CDN `name=large` versus actually displayed `name=orig` cache reuse is still unmeasured. Access to the browser tab in Chat requires the originating extension context; do not obtain credentials or browser-profile data to bypass this.
- A gallery may legitimately change layout without a viewport resize; stable outer-pane geometry/ResizeObserver deserves further *read-only live-X DOM research* before adding a new observer.
- Future testing: slow-loading/virtualized media tiles, multi-image posts, mixed-format srcset, fast back/forward, memory pressure with 2–4 high-resolution images, prefetch data-saving modes and window/fullscreen transitions.

## Final local verification (2026-10-28 JST, prior to private CI)

- `npm ci`: PASS, 0 npm-reported vulnerabilities.
- `npm test`: **148 cases / 141 PASS / 0 FAIL / 1 SKIP / 6 LIVE-X TODO**.
- `npm run typecheck`: PASS.
- Real Chromium-based Microsoft Edge headless synthetic-X fixture with `XMN_RUN_CHROMIUM=1`: **2 PASS / 0 FAIL / 0 SKIP**. Existing 33 end-to-end behaviors remain and one new actual-DOM test confirms a recycled tile thumbnail preheats the NEW assigned CDN resource rather than the OLD `currentSrc`, without any external network request.
- Disposable MV3 isolated-world Navigation API test: PASS all four expected signals. No Chrome user profile or X credentials accessed.
- `git diff --check`: PASS. Before commit, local HEAD and origin `fix/prefetch-startup-v241` match `51061e259025371456949685c41eb05ff1286f59`; main unchanged.
- `extension/content_script.js` baseline committed blob: **111,119 bytes**; new LF-generated file: **113,956 bytes**. The +2,837-byte increase comes from the safety logic and ordinal cache. This is **not a reduction in bundle size**; the performance claim concerns less redundant runtime work on long timelines.
- No authenticated X site testing could be performed from the current chat's connected Browser originating context; cannot assert actual transfer/cache hit, tab memory footprint, page FPS or 40x real-world speedup.

## Verified CI and fixed-folder private deployment (2026-10-28 JST)

- Implementation commit `a4e8ff8bf629f54e0d6a358db7abf404c847abff` was pushed to private `fix/prefetch-startup-v241`. Both GitHub `TypeScript check / verify` runs for push and Draft PR #17 concluded **SUCCESS on this exact commit** before deployment.
- The fixed unpacked-extension folder was verified at v2.4.15 before replacement; its six old files were backed up under `Downloads/X-Media-Navigator-Backups/pre-v2416-20261028_155137/` with per-file SHA256 before any overwrite. `SHA256-OLD.txt` preserves the old values. No ZIP created.
- Exactly six built source files were copied to the existing `Downloads/X-Media-Navigator-Current/` unpacked-extension folder. Installed manifest v2.4.16 confirmed. Each installed file had an exact SHA256 match to its source:
  - `content_script.js` — `2C8CD049FE33C1A555D586A3B37EA900471D480F64B16DA756068BA8BD73E090`
  - `manifest.json` — `96443D1AE3A8736A927DCF206E51CBD03ECBADC7E5D54DB29F3FC06DA786B2AC`
  - `style.css` — `C0EB781242DD69F40F0F7A474A3D6D497E6290B60CA9F153ED8E4DB96D2E4543`
  - `icon16.png` — `A6A5FBFB08884932B4F2DE8C5AE72EA33C5FDD8D29C36A7F943C472A6F765350`
  - `icon48.png` — `131F87AEEB140C8AE516BF4B33F4F9E66EAA0C3A4A1A8D405D5EE16EC3438BC9`
  - `icon128.png` — `C2415B4E7097B660840FC65D84C07E2D3B25F7DE9087346BD8643E8D16B1BDA0`
- This operation changed no public release, main branch, extension permissions, persistent workers, user browser processes or X account settings. Main still points at `47b23d56257ee272f4adc1dea21900340e673c98`.
- **NOT TESTED**: the already loaded Chrome extension was not force-reloaded and X's authenticated live UI, resource timing and CDN cache hits remain unmeasured in Chat. For live acceptance, Reload the unpacked extension, refresh the X tab, and verify 1–4-photo native galleries, 10+ forwards/backwards posts, ▶◀ position, modal/right-panel persistence, and large-feed status positions before any main/public merge.
