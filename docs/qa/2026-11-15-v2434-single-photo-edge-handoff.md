# v2.4.34 single-photo edge and handoff geometry (private QA)

## User report (v2.4.33)

1. A post with one photo is not treated as its last photo: → / ← should move to the next/previous post at once.
2. During post-to-post navigation an image of a different size flashes briefly.

## Evidence (v2.4.33 console log)

- Every `input.arrow` was followed by `navigation.native_spa`, but `photoTotals: 0` throughout: the
  photo count was never known, so → on a single-photo post went through `handleUnknownRightBoundary`
  (X gets the key first; XMN moves only after a ~1 s stability probe).
- `preview.prepared/visible/finished` ran on every move (`quality: high`, visible 0.5–1.8 s).
- The X viewer is a fixed `div[role=dialog]`; viewer photo e.g. 513×631 (portrait) in an 844×679 window.

## Causes

1. The x-web viewer exposes no gallery counter/aria-setsize. Its pager (from X's bundle) renders
   `[role=group] > [role=list] > [role=listitem]` — one item per attachment, inactive items
   `aria-hidden`+`inert` — and renders **no pager at all** for a single attachment.
2. The handoff overlay was sized to the *current* photo's box (previous photo's aspect ratio) and the
   next image was drawn with `width/height: auto`, so it appeared at a different size/position.

## Fix

- `pagerPhotoTotal()`: count = number of pager slides when the displayed, loaded photo is the active
  slide at the route's position; no pager around the displayed photo at `/photo/1` → total 1.
  Abstains while a loading `role=status`/`aria-busy`/progressbar is present (Suspense preview), or for
  unknown list shapes. Used first in `photoCount()`, so single-photo posts and last slides move at once.
- Handoff geometry: find the photo stage (nearest ancestor larger than the photo along its free axis,
  content box), contain-fit the next photo's natural aspect inside it, size the overlay to that rect,
  and fill it (`.xmn-handoff-image { width/height: 100% }`). New diagnostic `preview.geometry`.

## Verified here

- `npm test`: 374 pass / 0 fail / 6 skipped.
- jsdom mock of the x-web dialog: single → 1, 4-slide pager at 1 and 4 → 4, loading frame → null;
  stage bounds resolved to the stage container.

## Needs real-X check

- → on a single-photo post moves immediately; → on the last photo of a multi-photo post moves immediately;
  → on photos before the last still lets X change photos.
- No different-size flash. If it persists, `preview.geometry` (source/fitted size) in the console helps.

Note: very fast repeated navigation made X's own `tweetMediaViewerQuery` return HTTP 429 (rate limit).
