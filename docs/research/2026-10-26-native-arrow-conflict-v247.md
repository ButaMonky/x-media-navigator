# Native next-photo control conflict — 2026-10-26 JST

- Found source-level false-terminal hazard: nativeGalleryArrowDisabled() returned true on the first disabled `Next photo` node, even if a second native `Next photo` remained enabled.
- Wrote failing regression first: mixed disabled+enabled controls must NOT prove gallery end; both disabled may prove it. Failure reproduced (true !== false).
- Fixed to scan all matching photo-specific controls, veto terminal inference if any matching control is enabled; generic Next is excluded.
- npm test, npm run typecheck, npm run test:browser passed after fix. Browser tests are synthetic, not authenticated LIVE X acceptance.
- Main/public release unchanged. Native modal close/reopen animation and slow (>1050ms) right-arrow observation remain unverified/unsolved on LIVE X.
