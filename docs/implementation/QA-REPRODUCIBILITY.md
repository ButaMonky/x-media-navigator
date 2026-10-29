# X Media Navigator｜private QA update safety

Task: `XMN-QA-REPRODUCIBILITY-20261029` (R-018)

## Change

- `tools/update-chrome-qa.ps1` now rejects a source with tracked content changes, untracked files, a different Git branch, or a local HEAD not identical to the private GitHub branch tip. The source is checked both **before quality tests** and **after quality tests**.
- The status comparison uses Git's canonical content diff, not Windows file timestamps. TypeScript's LF-generated output can have different physical line endings from Git's CRLF checkout while the committed JavaScript content remains identical.
- Reinstalling the *same Chrome version* with changed JS/CSS/icons/worker is rejected; new content requires a version increment. It still prevents downgrade and backs up the previous QA install.
- The QA README now carries the full verified Git SHA and does not claim that `preview.visible` proves actual screen Paint. The event proves the overlay reveal instruction succeeded.
- No source-branch default was changed: the on-demand script still explicitly expects `handoff/fxembed-media-continuation-20261029`. The v2.4.21 B0–B4 candidate must not be deployed to installed QA until a later explicit acceptance/deployment decision.

## Verification and boundaries

- `npm test`: 265 tests, **256 PASS / 0 FAIL / 3 SKIP / 6 real-X TODO**.
- `npm run typecheck`: TypeScript Content and Worker PASS.
- Synthetic Edge Chromium: 4 PASS / 0 FAIL.
- PowerShell's own PSParser: 0 syntax errors.
- This task changes the QA deployment **script**, tests, and documentation only. The script has **not been run to deploy** the extension. Stable installation v2.4.18, current QA v2.4.20, public main and Draft PR #17 remain unchanged.
- Remote availability is deliberately a precondition for a reproducible on-demand installation. Offline research/build may continue separately without treating a non-verifiable QA deployment as authorized.
