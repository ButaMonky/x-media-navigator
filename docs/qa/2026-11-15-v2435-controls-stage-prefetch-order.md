# v2.4.35 arrow placement and prefetch order (private QA)

## User report (v2.4.34)

1. The ◀ ▶ post arrows are misplaced (screenshots: outside the photo; with the replies drawer open the
   ▶ sat on top of the drawer).
2. The current photo should finish loading before the next posts' photos are prefetched.

## Causes

1. `positionControls()` captured the *first* viewer box (the photo's own rectangle) once per viewport
   size and reused it for every later post. A photo of a different width, or opening/closing the
   replies drawer (no viewport change), left the arrows at the old rectangle.
   v2.4.34 logs confirm the x-web structure: photo → … → `div[role=listitem]` (slide) →
   `div[role=list]` (translated, e.g. x = −621) inside the pager `[role=group]`.
2. `schedulePreload()` started lookahead at 0 ms after the viewer mounted, and a grid click started a
   pre-open prefetch, so lookahead competed with the photo being opened.

## Fix (x-web only, detected by `<html data-app-version>`)

- `controlsStageRect()`: arrows are pinned to the pager root `[role=group]` (never translated) or, for a
  single attachment, the nearest ancestor larger than the photo; re-evaluated on every poll, styles only
  written when the rounded rect changes. Legacy UI keeps the previous anchor logic.
  Vertical position is unchanged (70%, below X's own photo arrows).
- `schedulePreload()`: wait (100 ms polls, max 6 s) until `currentPhotoReady()` before
  `preloadAdjacentImages()`; diagnostic `prefetch.after_current`. Grid-click pre-open prefetch is skipped.

## Verified here

- `npm test`: 374 pass / 0 fail / 6 skipped.

## Needs real-X check

- Arrows at the left/right edges of X's photo area for every post, including after toggling replies.
- Console: `prefetch.after_current` appears before `prefetch.started` after each move.
