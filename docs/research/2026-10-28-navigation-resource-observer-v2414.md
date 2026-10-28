# X Media Navigator private v2.4.14 — Navigation API route events and privacy-safe CDN audit

Date: 2026-10-28 JST
Base commit: `ff1e38f141af7e59787f6eb8a8d977757ea3f323` (private v2.4.13)
Branch: `fix/prefetch-startup-v241`; Draft PR #17; **do not merge to main or publicly release**.
Research IDs: XMN-NAV-001 / XMN-RESOURCE-001.

## Goals and source-level results

**SPA route change latency.** In v2.4.13, a 450ms interval remains as the fallback route monitor. The modal MutationObserver detects mounting/removal quickly but does not observe a History API URL change when X reuses an existing mounted modal without childList mutations. Therefore the next photo/post route could be discovered by the 450ms fallback.

**v2.4.14 Navigation API integration:** The MV3 content controller now registers the standard `window.navigation.currententrychange` listener when available, then coalesces changes to a **0ms next-task route reconciliation**. It tracks path+search changes, not just path, so photo/video filter changes can also be seen. This does not alter X's routing, history methods, credentials, GraphQL, network requests, or extension permissions. A lightweight `popstate` listener is the fallback if the Navigation API is missing. The existing 450ms interval and DOM observers remain intact for unsupported behavior and asynchronous X render. During navigationBusy or when a newly committed status route has not mounted a viewer, immediate event-based DOM teardown is skipped; X's mount observer and fallback interval remain in control.

Reference: https://developer.mozilla.org/en-US/docs/Web/API/Navigation/currententrychange_event

## True isolated-world Chrome test

A separate disposable MV3 test extension was created under a temporary directory with `content_scripts.matches=["http://127.0.0.1/*"]` and `run_at="document_start"`, using a throwaway Edge (Chromium) profile. A local HTTP fixture performed `history.pushState` and checked if the real content script's isolated-world Navigation API received `currententrychange`. Executed via:
`CHROMIUM_PATH=<installed Chromium/Edge> npm run test:navigation-isolated`

Observed on the Windows Edge/Chromium executable:
- disposableExtensionLoaded: **true**
- navigationAvailableInIsolatedWorld: **true**
- currentEntryChangeObserved: **true**
- pageHistoryUpdateObserved: **true**

The isolated probe leaves no extension installed into the user's normal Chrome profile, does not visit X.com and cleans up the temporary browser profile after the run. This demonstrates isolated-world browser support. **It does not show that live X uses the same navigation pattern in every path.**

## Test-first evidence

- Three new Node regressions first failed on the v2.4.13 implementation: Navigation API route event coalescing and near-immediate schedule; unsupported Navigation API falling back safely to popstate; and no premature DOM teardown during in-flight X SPA navigation.
- A fourth route regression checks that a URL event arriving before the new photo modal mounts also cannot destroy the old UI.
- A real Chromium synthetic-X fixture listens for `currententrychange` alongside native gallery `history.replaceState()`, and continues verifying SPA close/fallback, one-key gallery boundaries, preserved reply panels and fixed ▶◀ positions.
- Actual browser timing after URL change is intentionally **not** claimed as a real-X performance improvement without signed-in, in-situ measurements.

## Performance Resource Timing diagnostic

Added `tools/media-cache-audit.js`: a single-shot DevTools Snippet suitable for private X photo-viewer diagnosis. It uses existing `performance.getEntriesByType('resource')` and visible photo DOM in a **read-only** manner; does not start its own network requests, store anything, install listeners, set cookies, log personal media URLs/IDs or send data externally. It reports only counts:
- all observed resources; matching `pbs.twimg.com/media/` entries and distinct normalized IDs
- same media IDs loaded with multiple `name=` variants (e.g. `large` and `orig`); *potential mismatch*, not measured wasted bytes
- positive transfers, high-confidence cache hits where `transferSize===0` AND `decodedBodySize>0`, cross-origin/opaque timing entries where cache use is unknown
- counts of visible X media photos with or without matching Resource Timing entries, and median *observed* resource duration when available

**Cross-origin limitation:** a cross-origin `transferSize=0` with `decodedBodySize=0` MUST remain UNKNOWN rather than "cache hit"; the CDN might not supply `Timing-Allow-Origin`. Browser buffers are finite and may omit old requests. The tool never changes buffer size or clears timings.

Reference: https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming/transferSize

Unit regressions use synthetic performance entries to prove correct variant accounting, exclusion of third-party URLs, safety of aggregated output (raw URLs not emitted), opaque timing classification and empty buffers.

### Optional real-X use (no upload required)

In Chrome on the open X media tab: DevTools → Sources → Snippets; paste/run the content of `tools/media-cache-audit.js` after a few gallery navigations. Compare the aggregated output before/after another sequence. It displays counts only in the local DevTools console. **No real-X Resource Timing observations were collected by ChatGPT in this session:** the connected Browser tab-read action returned "Browser access requires the originating browser context" (BLOCKED, 2026-10-28 JST). No workarounds requiring cookies, other browser profiles or X internal APIs were attempted.

## Why ResizeObserver and IntersectionObserver are not shipped yet

`ResizeObserver` could monitor the stable *outer* media pane if its live-X DOM identity is proved. Observing X's animated `swipe-to-dismiss` image itself would recreate the just-repaired ◀▶ drift. Until the real stable pane is identified, keep v2.4.13 viewport/fullscreen invalidation.

`IntersectionObserver` could prioritize nearby media cards. However X virtualizes its grid, and v2.4.13 already has bounded five-target/two-concurrent prefetch and low-memory/network safeguards. Introducing more observer callbacks without a measured cache or latency gain would increase overhead and risk out-of-order/incorrect candidate selection. Defer pending actual DOM and Resource Timing evidence.

No new permissions, listener scripts, services, persistent telemetry, schedulers, ZIP snapshots, main branch changes or public release.

## Final local validation (2026-10-28 JST)

- `npm ci`: PASS; npm reported 0 vulnerabilities.
- `npm test`: **135 total / 128 PASS / 0 FAIL / 1 SKIP / 6 LIVE-X TODO**. These include Navigation API event coalescing and fallback tests, no DOM teardown during in-flight SPA, and the privacy-safe performance audit unit tests.
- `npm run typecheck`: PASS.
- Real Chromium-based Edge synthetic-X browser fixture (`XMN_RUN_CHROMIUM=1`): **2 PASS / 0 FAIL / 0 SKIP**; includes native photo gallery arrows, cross-post SPA and retained right panel, modal fallbacks, fixed-position ▶◀, 1-key slow-photo behavior and a Navigation API committed photo-route event.
- `CHROMIUM_PATH=<local Edge> npm run test:navigation-isolated`: PASS all four fields (disposable extension loaded, Navigation API available in isolated world, currententrychange observed, page History pushState observed).
- `git diff --check`: PASS.
- No real X network request was initiated. Browser tab access in Chat remained BLOCKED with originating-context error, so real-X `name=large` vs `name=orig` Resource Timing/HTTP cache hits remain **UNMEASURED**.

## Verified private CI and deployment (2026-10-28 JST)

- Implementation SHA `f175bd0e7912314a805e42e8017c4cffeb2703f8` was pushed to private `fix/prefetch-startup-v241`; both GitHub `TypeScript check / verify` runs (push + Draft PR #17) concluded **SUCCESS** on that exact commit before deployment. The main branch remained unchanged.
- Fixed unpacked extension folder `C:\Users\Saito\Downloads\X-Media-Navigator-Current` was verified at **v2.4.13** before replacement and **v2.4.14** after.
- Exactly the original six installed files were backed up with SHA256 checks under `C:\Users\Saito\Downloads\X-Media-Navigator-Backups\pre-v2414-20261028_025121`; the backup contains `SHA256-OLD.txt`.
- Exactly six files were refreshed from compiled `extension/` with source/installed SHA256 equality:
  - `content_script.js`: `BA748962D08668A817B62C82347EFB1612986EE9959D5CC288A84C772B4734E9`
  - `manifest.json`: `1DBD670D30EBF331F0BBA46BC5ACDEC12D892175D35CBD78DDE4C3E4DED76A1A`
  - `style.css`: `C0EB781242DD69F40F0F7A474A3D6D497E6290B60CA9F153ED8E4DB96D2E4543`
  - `icon16.png`: `A6A5FBFB08884932B4F2DE8C5AE72EA33C5FDD8D29C36A7F943C472A6F765350`
  - `icon48.png`: `131F87AEEB140C8AE516BF4B33F4F9E66EAA0C3A4A1A8D405D5EE16EC3438BC9`
  - `icon128.png`: `C2415B4E7097B660840FC65D84C07E2D3B25F7DE9087346BD8643E8D16B1BDA0`
- Old version is restorable from the timestamped backup, no ZIP created. No public release, main merge, extra permissions, scheduler, new service, user-profile Chrome restart or automatic extension reload.
- **LIVE X NOT YET VERIFIED FOR v2.4.14:** User must Reload the unpacked extension in `chrome://extensions`, refresh the X tab, and confirm new route events do not regress stable ◀▶, gallery arrows, modal/reply panel continuity or arrow-once behavior. CDN cache reuse statistics remain unmeasured on the user's authenticated X session.
- An ancillary PowerShell `ConvertFrom-Json` invocation could not parse the lockfile in the remote terminal, but `node JSON.parse(...)`, `npm pkg get`, `npm ci`, and the full project test pipeline parsed/validated the lockfile successfully. This was a tool/parser limitation, not evidence of corrupted package metadata.
