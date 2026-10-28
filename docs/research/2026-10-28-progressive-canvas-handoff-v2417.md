# X Media Navigator v2.4.17 — 既読サムネイルを使う低画質→高画質プログレッシブ表示

Date: 2026-10-28 JST
Work ID: XMN-RESEARCH-LQIP-20261028-01
Repository: `ButaMonky/x-media-navigator` PRIVATE; branch `fix/prefetch-startup-v241`, PR #17 remains DRAFT
Baseline: `4e4d4653c5e4f4cfd470132f488632a09e6e46c5` (v2.4.16)
Status: SOURCE REVIEW + TEST-FIRST + SYNTHETIC CHROMIUM/CROSS-ORIGIN PROOF, **NOT LIVE X ACCEPTANCE**

## User proposal and decision

The user proposes showing a low-quality image quickly and replacing it with high quality, to make repeated profile-media navigation feel more responsive. **Adopt a strictly no-new-download variant**, not speculative additional `name=small` network prefetch.

Rejected alternatives:
- Fetch a new `name=small/medium` thumbnail alongside `name=large`: more connections/transfer bytes, may delay current X full image; the browser may use different cache keys for `name=small`, `name=large`, and `name=orig`. This is not justified until the user obtains actual Network timing evidence.
- Rewrite X's React `<img>` or its `srcset`, intercept X GraphQL, or change SPA history: risks flicker, native gallery errors and lost replies panel.
- Clone a thumbnail into a second DOM `<img src=...>`: may initiate a request even for a previously loaded URL, so it does not satisfy the strict no-new-CDN-request design.
- Always show a low-res preview: could obscure a high-quality photo that X already rendered. Instead use the existing `nativeSpaTargetRendered()` guard and prefer the decoded high-res prefetch.

## Technical design

1. The existing `imageSources` Map supplies a strictly validated CDN identity for the **specific target photo**. `navigate()` already finds an exact live native X media link; pass that link into `beginVisualHandoff(target, link)`.
2. If the prefetch record for the target URL is **already decoded and ready**, preserve v2.4.16 behavior: reuse its existing `HTMLImageElement` in the same bounded visual handoff overlay.
3. Otherwise, inspect ONLY the existing, connected target link's native thumbnail (or exactly one legacy outside-anchor thumbnail). Require:
   - exact parsed native media link key matches target key; only photo kind
   - `image.complete === true`, positive naturalWidth and naturalHeight
   - selected `currentSrc` (or `src` when empty) is on the strictly allowed `pbs.twimg.com/media` host and matches the target's own previously recorded CDN identity
   - a stale or still-loading source, unrelated media, quoted post, unavailable DOM, failed canvas drawing or unsupported browser always means NO PREVIEW, never wrong-photo guessing
4. Draw that **already decoded** image via `CanvasRenderingContext2D.drawImage()` onto a temporary canvas. Limit its bitmap dimensions to 256 pixels on the longest side (maximum 256×256×4 = 262,144 bytes = 0.25 MiB, plus per-object overhead). Never call `fetch`, `new Image`, `toDataURL`, `toBlob`, `captureStream` or `getImageData` for the low-res preview.
5. Attach the canvas under the existing `.xmn-visual-handoff` overlay which is positioned only over the left image pane and has `pointer-events:none`. **Keep it invisible** until X has accepted the requested SPA route (or the original viewer is confirmed closed in the existing fallback). Never interfere with native X arrows, reply panel, focus, keyboard events, or right/left status ordering.
6. `promoteVisualHandoff()` upgrades from the low-res canvas to the already-decoded, identity-matching existing high-res prefetch element if its `decode()` finishes during the handoff. This is an in-place DOM replacement, not another network request. If X has already rendered the right full-size image, suppress the preview and remove the overlay via the existing validated target-image `decode()`/90ms paint check.
7. The existing maximum 1.8-second visible handoff expiry, cancellation/cleanup on errors, new navigation and media-session exit, low-power/visibility safeguards, five-image/two-concurrent transfer cap and nominal 80MiB decoded-photo budget are unchanged. The temporary canvas is not persisted in caches or telemetry.

## Security and browser platform evidence

- Cross-origin loaded images can be drawn to a canvas, which becomes *tainted*; pixel readback/export is blocked by the browser. This code ONLY draws/displays and never attempts pixel access. MDN: https://developer.mozilla.org/en-US/docs/Web/HTML/How_to/CORS_enabled_image
- `CanvasRenderingContext2D.drawImage` can draw an already loaded `HTMLImageElement`; it does not require a separate URL fetch: https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage
- `HTMLImageElement.currentSrc` reports the browser-selected image (including responsive `srcset`); use strict target identity before showing anything: https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/currentSrc
- Prior UI performance research describes low-quality image placeholders and asynchronous decode tradeoffs: https://github.com/GoogleChrome/web.dev/blob/main/src/site/content/en/fast/lazy-loading-best-practices/index.md

## Tests and evidence (pre-CI)

- Four new tests were added **before** implementation and all four failed on v2.4.16: exact decoded thumbnail capture without a new Image request, rejecting stale/incorrect media IDs and recycled links, creating a safely hidden low-res handoff when high-res is still loading, and upgrading to decoded high-res in-place. They pass after implementation.
- Added delayed high-res `Image.decode()` completion regression proving the asynchronous prefetch result triggers automatic low→high promotion with one existing CDN request; wrong target ID / dismissed overlay cannot promote.
- Added optional Canvas `drawImage` failure and wrong-SPA-route abort tests: the low-quality preview is optional, never blocks native X routing and never shows a different post's photo.
- Chromium synthetic-X DOM fixture runs the actual extension script with a loaded thumbnail; verifies the low-quality canvas is capped at 256px, its overlay remains pointer-transparent and unshown until X routing, promotion reuses the decoded high image, and cleanup removes the overlay. Browser instrumentation confirms **no new extension Image fetch was launched** during capture/promotion.
- An independent Chromium test uses **different localhost ports** for HTML and a CORS-unapproved GIF to prove drawing a cross-origin loaded image to a canvas succeeds and causes no additional server request; reading its pixels is correctly denied by the browser. Only local fake images were used, not X/CDN traffic or user data.
- Static package-integrity regression ensures the extension's thumbnail capture never calls pixel readback, export or additional fetch and that CSS is click-through/contain.

## Explicit trade-offs and limitations

- Low-quality content may be visibly blurred or cropped compared with the uncropped native image, depending on X's thumbnail. The code preserves aspect ratio and never stretches/crops further. Users may still notice visual sharpness change; first-paint *perception* must be assessed on real X.
- A synchronously drawn 256px canvas consumes small main-thread work and temporary display memory, even though it saves additional network transfers. Actual production CPU, frame time, bandwidth and first-image latency are **NOT MEASURED**.
- X might remove the media-grid link under virtualized lists or provide only an unready thumbnail: the feature abstains and falls back to the previously tested v2.4.16 handoff/native SPA path.
- No new permissions, X API, React internals, history interceptors, background services, updaters, scheduler or repeated ZIP artifacts.
- The user must Reload the private unpacked extension and refresh the X tab; real X test 1–4 photo posts, rapid left/right, slow images, different aspect ratios, existing right reply-panel animation, full screen, browser tab background/return. Keep Draft PR #17, Issues #14/#16 and main/public version untouched until accepted.

## Tool incident log

- Work ID: XMN-RESEARCH-LQIP-20261028-01.
- Local time: 2026-10-28 JST. `Desktop_Commander_Local_Compact.edit_block` failed during test insertion because its fuzzy-search helper could not resolve the `fastest-levenshtein` package (`ERR_MODULE_NOT_FOUND`). The partially attempted operation made **no change** to the requested insertion anchor.
- Recovery: verified the exact target file and single matching insertion anchor; used the same authorized Desktop Commander terminal to perform an exact-text PowerShell replacement without discarding other files or changing branches. The resulting file was validated with Git diff and test runs. No tool safety/permission rejection was bypassed.

## Final local validation (2026-10-28 JST; before private GitHub CI)

- `npm ci`: **SUCCESS**, npm reports zero known package vulnerabilities.
- `npm test`: **158 total / 150 PASS / 0 FAIL / 2 SKIP / 6 LIVE-X TODO**. The skip items include Chromium-dependent browser tests when run without the explicit browser environment, which were then executed separately.
- `npm run typecheck`: **PASS**.
- `XMN_RUN_CHROMIUM=1` with a local Microsoft Edge executable and `npm run test:browser`: **3 PASS / 0 FAIL / 0 SKIP**. This includes the preexisting 34 synthetic-X UI assertions, three new Canvas/upgrade/cleanup assertions (total 37), and a separate actual cross-origin image/canvas test with distinct localhost ports.
- The cross-origin Chromium test performed **one local GIF download** and confirmed `drawImage()` generated **zero further image requests**; the canvas remained displayable while `getImageData()` was denied by same-origin security. It neither read nor stored any personal user images.
- Isolated MV3 `npm run test:navigation-isolated`: **PASS** on all four browser capabilities; does not alter the user's Chrome extension or profile.
- `git diff --check`: **PASS**.
- Source baseline and origin both equal `4e4d4653c5e4f4cfd470132f488632a09e6e46c5`; public main remains `47b23d56257ee272f4adc1dea21900340e673c98`.
- Compiled `extension/content_script.js` baseline **113,956 bytes**, new **118,079 bytes** (+4,123). CSS also grows slightly. This is a small runtime/feature overhead, NOT a smaller extension package. The optional preview Canvas is capped at 256×256×4=262,144 bytes (excluding browser object overhead) and is removed by the existing bounded handoff cleanup. Existing up-to-five `name=large` prefetches and two concurrent transfers are unchanged.
- The live user X DOM, HTTP cache-hit rate, perceived first-paint latency, frame jank and actual fullscreen/reply-panel behavior are **NOT VERIFIED**. These require user Chrome extension Reload, X tab refresh and direct acceptance.
