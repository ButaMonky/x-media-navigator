# X Media Navigator B0–B3 改修チェックポイント

- 依頼：2026-10-29、R1〜R5の研究を踏まえて順番に可能な限り改修
- 元の研究正本：`docs/research/XMN_RESEARCH_LEDGER.md`（R-001〜R-044）
- 基準コミット：`c73af36aa8dd46b71b8736a7032cab1fa5186e22`
- 専用ブランチ：`task/xmn-b0-b3-20261029`
- 作業ツリー：`C:\Users\Saito\Documents\x-media-navigator-b0-b3`
- 安定main、既存Draft PR #17、`fix/prefetch-startup-v241`、Chromeの固定インストールは不変更。
- Git操作：reset/stash/rebase/amend/force禁止。上流変更時は先に照合。

## 工程

| 工程 | 状態 | 目的 |
| --- | --- | --- |
| B0 | COMPLETE | 現行の回帰基盤と失敗する受入テストの固定 |
| B1 | NOT STARTED | 同意／セッションを拡張所有の一時状態へ |
| B2 | NOT STARTED | 投稿群の索引、APIカーソル、長い一覧 |
| B3 | NOT STARTED | 左右キーの単一状態管理・キャンセル |
| B4–B5 | DEFERRED | 実X未検証の画質/UI最適化、正式公開 |

## B0 証拠

- 独立作業ツリーで `npm ci`、既存 `npm test` 初期状態193件中184成功、失敗0、3スキップ、6実X TODO。
- `tests/b0-contract.test.mjs` にRED受入テスト群を追加。
- `XMN_B0_VERIFY_FIXES=1` であえてREDを確認。既定のCIでは新しい未達受入項目をスキップし、既存の合格テストを誤って失敗扱いにしない。
- 修正を進めた項目からスキップ解除し、実装の検査に移行する。

- B0完了時: npm test 202件・185 PASS・0 FAIL・11 SKIP・6実X TODO、型検査PASS。
pm test 202件・185 PASS/0 FAIL/11 SKIP/6実X TODO、TypeScript型検査成功。
- 受入RED: XMN_B0_VERIFY_FIXES=1 で意図的に失敗。通常CIは未修正項目8件をskipし、後続工程で個別に有効化。
