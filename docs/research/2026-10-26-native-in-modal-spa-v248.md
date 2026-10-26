# v2.4.8 private beta: X-owned in-modal SPA navigation experiment

Date: 2026-10-26 JST
Status: SOURCE VERIFIED / IMPLEMENTED / SYNTHETIC TESTED; **LIVE X NOT VERIFIED**
Scope: private branch `fix/prefetch-startup-v241`; Draft PR #17. main/public release unchanged.

## User incident and root cause

The user reported that SPA behavior has again become incomplete after installing v2.4.7. Audit of v2.4.7 `Controller.navigate()` confirms every cross-post action unconditionally invoked the X modal close button, waited for removal, then clicked the next media-timeline tile. The decoded-image bridge hides some left-photo flicker but **cannot preserve the native right tweet/replies panel**. This same close-first design already existed in older branches, including upstream v1.3. It was not a newly introduced full-SPA implementation that later regressed.

## v2.4.8 guarded in-modal trial

1. For an already observed, connected, same-profile **photo-to-photo adjacent post**, preflight the destination's native X media-timeline anchor and check its current href still matches exactly.
2. First `click()` that X-owned link **without closing the current X modal**. Do not modify `history`, URL, React internals or X GraphQL. A temporary window-bubble listener cancels an unhandled hard browser-document navigation after X's own delegated click listeners, then removes itself immediately.
3. Observe pathname for up to 300ms in six 50ms intervals. If the route becomes exactly the observed destination, accept X's SPA navigation without a second close/reopen. Identify whether the original dialog or viewer DOM was actually retained.
4. If the route and old dialog remain unchanged, fall back to the existing close-then-open route with decoded-photo handoff. If the route changed to an unexpected target, a modal disappeared, a link was evicted, or the session generation changed, stop rather than issue a duplicate click.
5. Keep the existing native gallery ArrowLeft/ArrowRight semantics, no-skip constraints, video isolation, bounded five-image prefetch, and existing permissions unchanged.

## Important limitations

The technique relies on X's native link router processing a click while the media dialog is mounted. Real X may ignore it, replace the dialog, or route to a standalone post. A synthetic DOM can only demonstrate behavior **if X preserves that dialog**; it does not prove production preservation. If X replaces its right panel even on direct link navigation, an actual native-modal preservation solution needs read-only X DOM/route evidence before changing anything else.

## Test evidence and fallbacks

- Regression first confirmed: the pre-change controller *closed* the X dialog on every cross-post transition. Newly added in-modal DOM-retention test failed against the prior build with one close; now it passes.
- Node/FakeDOM regression tests: native link preserves dialog; delayed route within probe does not duplicate; unexpected route aborts without close; unhandled in-modal link falls back once; temporary click guard cancels hard navigation and is removed. Existing tests for first/last gallery photo, modal close/open fallback, virtualized tiles, focus, slow image, unknown totals, video isolation remain.
- The synthetic X Chromium/Edge fixture now has a persistent right replies-panel node. It covers both direct in-modal X-owned navigation (panel identity retained) and an intentionally ignored direct click (one close/reopen fallback), without changing the real X site.
- Local `npm test`: 103 cases, 96 pass, 0 fail, 1 skip, 6 LIVE-X TODO. The genuine Chromium-based Edge headless test previously passed 2/2 with 22 synthetic assertions. This is not authenticated X testing.
- `mcp Browser.list_tabs` is inaccessible because the active browser lacks the originating extension context. An isolated public-X Edge headless probe returned no HTML, so it supplied no usable DOM evidence; no user cookies/tokens or browser profile were read.
- The 300ms bounded probe is a heuristic for whether the native link responds. A longer-delayed X route update could still race with the fallback. This remains an explicit unresolved risk, not evidence of native SPA success.
- Do not update main, close Issue #16 or mark Draft PR ready on synthetic QA alone.
