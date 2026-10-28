# X Media Navigator v2.4.9 — bidirectional prefetch + native SPA image bridge
Date: 2026-10-26 JST
Status: PRIVATE BETA / SOURCE VERIFIED / TESTED-SYNTHETIC / LIVE X NOT YET VERIFIED
Branch: `fix/prefetch-startup-v241`; Draft PR #17; main/public release unchanged.

## Goal
Continue the user's satisfactory v2.4.8 behavior without forcing React-router, cookies, GraphQL, history changes, or additional extension permissions. Keep native gallery arrows and the post-boundary no-skip guard.

## Source-level findings
- v2.4.8 already decodes/preloads up to 5 CDN images, at most 2 simultaneous transfers, a 6-record/~80MiB bound, and Save-Data/low-memory safeguards.
- The priority list included all distant future posts *before* the previous media. When more than five future photos were indexed, a directly adjacent previous post could never be warmed, despite frequent left-arrow navigation.
- In-modal X-owned SPA navigation in v2.4.8 deliberately bypassed the existing visual photo handoff, even if the next photo was already decoded and the X viewer had not finished rendering it.
- The old close-button preflight prevented a working native in-modal SPA route on X variants missing that close control; fallback still needs it.

## v2.4.9 implementation
- Preserve up to two near-future posts and all immediately following photos; reserve one slot (when present) for the adjacent previous photo/post, then fill remaining slots with later future posts. The five-image, concurrent-transfer and memory budgets are unchanged.
- Prepare an *invisible*, already-decoded CDN image bridge before the native in-modal link attempt. Show it only after X confirms the exact destination URL and only when the currently displayed photo is not already the loaded matching target. It covers only the image pane, never the reply panel, and remains non-interactive.
- Reuse the existing source-identity, decode and 1.8s expiry safeguards; abort/unexpected route changes remove the handoff without double navigation. If the direct link is ignored, the proven close/reopen fallback reuses the prepared bridge.
- Initiate the next bounded lookahead after successful navigation, instead of waiting for the next 450ms status poll.
- Permit a native SPA link to work without finding X's close button; require that button only when the fallback path is needed.

## Test-first evidence
- Added four tests; all four failed against v2.4.8 before implementation: backward lookahead reservation, pending native-SPA photo bridge, suppression of an unnecessary overlay over a loaded target, and missing-close-control native SPA.
- Existing tests for photo counting, native arrows, no skipped unseen photos, long-tail image loading, back/forward, virtualized media, overlay cleanup, timeout and URL ownership remain.
- Chromium synthetic-X integration test now correctly distinguishes successful in-modal SPA without a close button from a case that legitimately requires fallback.

## Additional rapid-navigation regression

- A fifth red regression test found that successive arrow presses could reuse an earlier still-mounted decoded-photo bridge (the old handoff expires after up to 1.8s). The new destination now invalidates the stale handoff before creating any preview, preventing an unrelated image from covering the next post.
- Regular Node suite after this fix: **108 tests / 101 passed / 0 failed / 1 skipped / 6 LIVE-X TODO**.
- Final CI and file deployment must verify this new test and its compiled JavaScript before installation.
- Technical limitations: X may display `name=orig` even when prefetch stores `name=large`; identical CDN media identity is *not* proof of an HTTP cache hit. Actual X media timing and DOM-driven right-panel persistence are not measured. Do not overclaim faster real-X navigation.

## CI timing difference (do not ignore)
- Initial commit `f9d8407` had 1/2 GitHub checks FAIL (Linux Chrome) despite local Edge PASS. The failing assertion demanded that the optional fallback photo bridge disappear within **950ms after the key**, but the existing runtime contract permits a full **1800ms after X closes its modal and the preview becomes visible**. The native link probe itself can take up to 300ms, and Linux painting/decode timing differs from Windows.
- Browser fixture now waits in short 100ms checks until the preview is removed, bounded by an additional 1500ms after the original 950ms; it still fails if the overlay persists. The Chromium virtual-time budget increased from 19s to 22s to accommodate the bounded verification. No runtime timeout or SPA navigation logic was weakened.
- GitHub CI rerun on the new commit must pass before any update to the fixed unpacked-extension directory.

## CI verification and private unpacked-extension deployment

- Code commit `f9d8407d95d94db97a7c323514c262240632991b`; Linux Chrome CI initially failed on the too-early cleanup assertion, while the other CI check succeeded. Follow-up test-only/docs commit `4bf90371bdc6f021d507194a3eb0f6bc39a452d3` confirmed **both push and PR verify check runs SUCCESS** for its SHA.
- Final local `npm ci` completed with 0 npm-reported vulnerabilities; `npm test` 108 total / 101 PASS / 0 FAIL / 1 SKIP / 6 LIVE-X TODO; `npm run typecheck` PASS; headless Microsoft Edge (Chromium engine) synthetic browser suite 2 PASS / 0 FAIL / 0 SKIP.
- Private fixed destination `C:\Users\Saito\Downloads\X-Media-Navigator-Current`: verified prior manifest 2.4.8, copied and SHA256-verified exactly the six previous installed files to `C:\Users\Saito\Downloads\X-Media-Navigator-Backups\pre-v249-20261026_205940` (plus `SHA256-OLD.txt`).
- Updated exactly the same six fixed-folder files from `extension/`; all source/installed SHA256 hashes match:
  - `content_script.js`: `13F780D38367A02942179D3EA5BC105F5D8F19C6AF4FCF1278601BF63CFFA1A9`
  - `manifest.json`: `65BA23BBEC08774E9286A05661B5EA0DD6A5A83E7451E0877CEF43E5B77AB7D3`
  - `style.css`: `5C96ED2A77B8BB3F972550FE7F5453C26F4CBF352A1E51A1D878FA585D47A32F`
  - `icon16.png`: `A6A5FBFB08884932B4F2DE8C5AE72EA33C5FDD8D29C36A7F943C472A6F765350`
  - `icon48.png`: `131F87AEEB140C8AE516BF4B33F4F9E66EAA0C3A4A1A8D405D5EE16EC3438BC9`
  - `icon128.png`: `C2415B4E7097B660840FC65D84C07E2D3B25F7DE9087346BD8643E8D16B1BDA0`
- Installed manifest verified 2.4.9. **LIVE X STILL NOT VERIFIED:** Chat's attached browser reports that its originating browser context is unavailable; do not claim production speed, prefetch cache-hit improvement, X pane permanence, or loaded Chrome extension reload.
- No public release, main merge, forced Chrome restart, new updater/scheduler/service, or repeated ZIP.
