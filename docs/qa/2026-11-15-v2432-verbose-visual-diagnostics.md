# X Media Navigator v2.4.32 — 詳細診断ログ（非公開QA）

- Date: 2026-11-15 JST
- Tracking: GitHub Issue #18
- Based on: v2.4.31 / commit a71fa4aca8f9440d1d1e38e17c22d16ddbc3e2bc
- Purpose: **Do not guess the next UI fix.** Capture the real user's visual geometry, DOM structure and occlusion evidence before changing navigation logic.
- This version adds *diagnostics only*. Navigation semantics, native-X-only default, no background scrolling, no third-party API, original icon, and X media support up to 20 attachments remain unchanged.

## Usage

1. In Chrome Extensions, reload the X Media Navigator QA extension after deploying.
2. Refresh X's Media tab and open a photo, keeping DevTools → Console open.
3. Filter Console messages using the string **XMN 2.4.32-dev** (or **visual.snapshot**).
4. Wait while the issue reproduces. Detailed snapshots appear automatically every 2.5 seconds, immediately on route changes; at most 160 periodic snapshots per page session, with later route transitions still logged.
5. Attempt Left/Right arrows and the on-screen controls. Only direction / modifiers / whether the viewer is active are logged.
6. Copy the XMN-filtered Console log and share it to diagnose the next step.

## What is recorded

- Route category only (Media tab / post), current photo or video index, photo/video filter mode
- Viewport/visualViewport size, zoom scale, pixel ratio, scrolling, browser visibility/fullscreen state
- Whether the Media tab and media index are ready, number of verified refs and posts, current ordinal
- Observers, navigation busy, prefetch in-flight/cached counts, and health diagnostic code
- DOM counts for media list items, X cells, media links, viewer elements, dialogs, modal/popover top layers, images and videos
- All XMN layer and button dimensions, disabled state, computed style, inline display/opacity
- On-screen hit-testing and a limited, sanitized stack of overlapping elements at the button center
- Limited ancestors with geometry and computed CSS (clipping/overflow/transforms/z-index)
- Selected image/video dimensions and readiness (without source URLs)
- Native modal vs popover context and whether their layers contain the XMN controls

## Privacy

The snapshot routine deliberately excludes X URLs, search queries, post IDs, account handles,
post text, image source URLs, image alt text, cookies, session identifiers,
authorization headers, API cursors and request payloads. Class names are not emitted
except for a known XMN class presence flag; data-testid and role values are restricted
to an allowlist. CSS url(...) values in filter/clip-path are replaced with url_redacted.
No network requests or new Chrome permissions. All snapshots stay within the local
browser Console; they are not saved to GitHub or sent to a third party.

**Important:** DevTools logs from *other* extensions may contain URLs, IDs or more.
Filter to the XMN messages before sharing a saved Console log.

## Known limitations

- The browser can render behind a compositor layer while hit-testing succeeds; snapshots
  are read-only evidence and cannot guarantee that the user visually saw the button.
- The original user's real-X DOM has not been inspected directly by this work session.
- Do not close Issue #18 until the user confirms actual visibility and navigation.
