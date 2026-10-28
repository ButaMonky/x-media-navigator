# X Media Navigator v2.4.11 — one-key unknown album / fast native SPA fallback

Date: 2026-10-26 JST
Branch: `fix/prefetch-startup-v241` (PRIVATE), Draft PR #17. Public main and release are out of scope.
Source baseline: `9c1e50596148a0c015fd6616932e1a11d885f65e` (v2.4.10).

## LIVE user report
The user reported that ArrowRight again needs two presses, with a screenshot, and that real-X navigation is still slow despite a perceived speed improvement. The screenshot/report is **LIVE USER REPORTED**, but no authenticated X DOM was inspected or copied.

## Source-verified defects
1. Unknown album boundary `handleUnknownRightBoundary` waited 1050ms, then abandoned the first press if the active image was not ready. The toast erroneously instructed another ArrowRight, while the second key could simply rearm/restart the probe; repeated keys were not reliable.
2. `currentPhotoSignature` included `complete/naturalWidth`, so an image going from loading to ready changed its signature and caused an early abort.
3. `currentSrc` can still represent the OLD visible resource while `src` is already assigned to the target photo. Treating old `currentSrc` as the identity of a pending target likewise aborted the first key.
4. Multiple same-size CDN photos mounted in X's carousel could make `displayedPhoto()` return null even when the route's thumbnail identifies one of the images. An offscreen or hidden preloaded photo is not reliable evidence of user-visible image readiness.
5. `tryNativeInModalNavigation` always waited up to 300ms before fallback even when X's delegated click handler had not claimed an observed native anchor click.

## Implemented
- Preserve the first right-arrow probe while X's route-assigned photo is loading. Check the same photo identity and current route again in 150ms intervals after the initial 1050ms native response window, with a bounded additional 2400ms; do not jump if the source or route changes, an enabled native next-photo control is present, or an indexed later photo exists.
- Another ArrowRight while a probe is pending does not restart it. The key remains available to X's own gallery. Do not display any instruction suggesting a second press can prove album end; after an unidentifiable image fallback, leave X in control.
- Match the current media's CDN identity from already-owned/validated media-tile sources before using image geometry. Ignore offscreen and DOM-hidden images and veto readiness when X still displays a previous image rather than the current route's known photo.
- Track `img.src` assigned-resource identity ahead of stale `currentSrc` during load; `currentPhotoReady()` still requires a fully loaded, identity-consistent image.
- When a native in-modal anchor click reaches the window without a prior `preventDefault` from X's handler, allow only a 100ms courtesy delay before the existing safe close/reopen fallback. Keep the 300ms probe when X claimed the click or it was not observed at window level, to avoid races.
- Removed obsolete `pendingRightConfirmation` state; no permissions, background services, X internals, credentials, network interfaces, or uncontrolled photo-count inference added.

## Test-first evidence
- Four original red cases: slow photo completes after the initial right-key probe, repeated ArrowRight must not restart it, route-owned media identification among equal-size images, and old `currentSrc` becoming current after load. Each failed against the previous implementation.
- Additional red regressions: unclaimed in-modal click spends at most 100ms probing, and an offscreen predecoded duplicate must never masquerade as the current visible photo.
- Synthetic Chromium fixture exercises a delayed photo that finishes after the 1050ms observation window and still proceeds from one ArrowRight, without skipping an unready image or sending a second key.
- The initial 1050ms **unknown album boundary** caution remains. Faster immediate navigation already applies to explicitly proven gallery ends; unproven counts must not cause unseen-photo skipping.

## Final local validation before CI

- The private GitHub repository was verified `isPrivate:true`. Baseline branch and origin match `9c1e50596148a0c015fd6616932e1a11d885f65e`, public main remains `47b23d56257ee272f4adc1dea21900340e673c98`.
- Clean `npm ci`: success, 0 npm-audit vulnerabilities reported. `npm test`: **120 tests / 113 PASS / 0 FAIL / 1 SKIP / 6 LIVE TODO**; `npm run typecheck`: success.
- Real Chromium-based Edge headless **synthetic** X test: **2 PASS / 0 FAIL / 0 SKIP**, now including a scenario where a route-owned image completes loading AFTER the first 1050ms probe and automatically navigates after one keypress. The browser's X DOM/login was not examined.
- The unclaimed native SPA click fallback saves at most 200ms of code-imposed waiting (300ms → 100ms in that narrowly detected case), NOT a measured whole-page loading speed claim.
- SPA reply panel retention, confirmed photo boundary behavior and five-photo/two-concurrent transfer prefetch remain covered by prior regression suites.
- **LIMITATIONS:** unknown gallery sizes still use the 1050ms observation window; image loading may extend the first-key completion by bounded time. X itself might move later than the observation window, so the heuristic remains less certain than an explicit native counter or disabled next-photo control. Never claim a zero-risk unknown gallery edge or X LIVE PASS.

## Verified private commit, CI and six-file deployment

- Implementation commit `a4f61ca396c6ac7119e9a56a24ac2f8584d42847` was pushed to the PRIVATE branch. Draft PR #17 stayed open/draft. The push and PR GitHub `verify` checks both completed SUCCESS on that exact commit before deployment.
- The installed fixed directory was verified at v2.4.10 before any replacement: `C:\Users\Saito\Downloads\X-Media-Navigator-Current`.
- The six old files were copied, byte-verified and backed up (no ZIP) under:
  `C:\Users\Saito\Downloads\X-Media-Navigator-Backups\pre-v2411-20261026_223409`.
  Backup folder contains the old SHA256 audit `SHA256-OLD.txt`.
- Updated the same six files from the built `extension/` into the fixed folder, all with exact source→installed SHA256 matches:
  - `content_script.js` = `FC4D1130DF6B416981570E596166A2623AAE24F2DAA363A78EF4C767E4B911F9`
  - `manifest.json` = `8101C19A35728494F8870E406EE532ED2D13889903B07A2898777F3BB5ED9282`
  - `style.css` = `5C96ED2A77B8BB3F972550FE7F5453C26F4CBF352A1E51A1D878FA585D47A32F`
  - `icon16.png` = `A6A5FBFB08884932B4F2DE8C5AE72EA33C5FDD8D29C36A7F943C472A6F765350`
  - `icon48.png` = `131F87AEEB140C8AE516BF4B33F4F9E66EAA0C3A4A1A8D405D5EE16EC3438BC9`
  - `icon128.png` = `C2415B4E7097B660840FC65D84C07E2D3B25F7DE9087346BD8643E8D16B1BDA0`
- Installed version checked as **2.4.11**. No Chrome profile restart, extension reload, public release, main merge, new updater or background job was performed.
- **User LIVE X acceptance still needed:** extension Reload + X tab Reload, one-photo and 2–4-photo posts, slow/loading gallery, one-key ArrowRight, rapid subsequent keys, no unseen-photo skip, measured SPA transition latency.
