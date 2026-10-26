# X Media Navigator v2.4.7 private beta - probe safety / modal handoff audit

Date: 2026-10-26 JST
Branch: `fix/prefetch-startup-v241`; based on `a78b33b` (v2.4.6).
Scope: private Draft PR #17 only. Never merge to main or create a public release on this evidence.

## Source-verified defects and fixes

- **AUD-048 / mixed native arrows:** A disabled photo-next button formerly proved a gallery edge even if another matching photo-next was enabled. The prior local worktree already contained a fix and failing-test coverage on session entry; kept and verified that fix.
- **AUD-049 / hidden native arrows:** A photo-next button hidden by `aria-hidden`, `hidden` or `inert` could block a valid boundary or falsely prove an end. Both native availability and native-disabled probes now ignore hidden controls and their hidden ancestors.
- **AUD-050 / still-unready image repeated right key:** Once a 1050ms probe saw an unready photo, a repeat press with unchanged URL/signature forced cross-post navigation despite zero evidence of last photo. This could skip a slow native X gallery slide. The repeat is now left native while the photo remains unready. Single-press crossing is retained when a loaded photo is stable after X's first chance, or a real boundary is proven.
- **AUD-051 / handoff deadline before modal close:** The optional decoded-image bridge's 1800ms watchdog started before X finished closing its prior dialog. Re-arm exactly once when the old modal has closed and the handoff becomes visible; old watchdog is cleared, and the new 1800ms watchdog still guarantees disposal.
- **AUD-052 / blank gap after close:** A 90ms CSS fade-in was applied only after the old dialog had closed, showing a blank/intermediate frame. Use immediate opacity and reduce the modal-closure poll interval from 125ms to 50ms, preserving its overall 1500ms limit.

## Regression evidence

- First added assertions that failed against prior behavior for unsafe repeated-right, reveal-window timing, overlay fade, hidden native arrows, and 125ms closure poll; then made source changes.
- `npm ci` succeeded; npm reported zero package vulnerabilities.
- `npm test`: 98 cases, 91 passed, 0 failed, 1 skipped, 6 TODO. TODO entries require real X acceptance.
- `npm run typecheck`: pass.
- `XMN_RUN_CHROMIUM=1` and `CHROMIUM_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` then `npm run test:browser`: 2 passed, 0 failed, 0 skipped. This is a synthetic X fixture in real Chromium-based Edge, not a live X.com acceptance test.

## Remaining risks / research queue

- **LIVE X NOT VERIFIED:** browser-tab connector still requires the originating browser context. Synthetic DOM tests do not reveal X's current actual gallery controls, visibility, React event handling, modal lifecycle or CDN cache behavior.
- The 1050ms stable-photo no-op probe for unknown album totals remains a heuristic; an X response delayed beyond that window can still cause a wrong post jump. Never describe a stable image alone as proof of final-photo position. Prioritize observed gallery counters, visible native arrow state, and later-link evidence.
- While the left photo can now bridge without a fade, X still closes and remounts its native modal when crossing posts. The right tweet/replies panel can reanimate. Do not monkeypatch `history.pushState`, React internals, X GraphQL, credentials, or add permissions without separate real-X evidence.
- Cache hit of preloaded `name=large` CDN URL versus X's actually displayed URL is NOT measured. Check Network / Performance read-only in an authorized X tab: media URL identities, transferred vs cache bytes, photo decode timing, and long-tail latency.
- Live QA: single and 2-4 photo albums in both directions; slow image and virtualized media grid; video/GIF isolation; multiple posts; photo/replies pane geometry and animation; safe fallback; post close/open with photo filter.
- Do not automatically update main, PR readiness, release, or global Chrome profile. Refresh only the fixed unpacked-extension six-file directory after CI success, with a separate backup and per-file SHA256 check.
