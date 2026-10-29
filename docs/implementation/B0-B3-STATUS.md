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
| B1 | CODE+SYNTHETIC TEST COMPLETE / LIVE-X PENDING | 同意／セッションを拡張所有の一時状態へ |
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

## B1｜拡張所有の同意・セッション（実装済み、実Xは未受入）

- 実装：`src/background.ts`、`src/session.ts`、`tsconfig.background.json`。MV3 Service Workerへ`chrome.runtime.sendMessage`を使用し、`chrome.storage.session`に保存。これはXのページ所有`sessionStorage`から独立。
- 新権限：`storage`のみ。URL・タブ全件を閲覧する`tabs`権限や`host_permissions`は追加しない。既存のX/Twitterマッチだけを維持。Chrome標準`tabs.onRemoved`で当該タブの短期保存を削除。
- Workerが照合：送信元URL/トップフレーム/タブID/プロフィール一致、スキーマ版1、TTL、投稿URLのホスト/所有者/時系列、重複・分断投稿、APIキー・写真CDN形式、最大450参照、保存120,000文字。
- Content Scriptが照合：現在のX投稿URL・世代・プロフィール、復元先の登録済みキー。非同期保存が失敗するとDocument handoffとAPI追加を安全に中止。
- 第三者FxEmbed同意：従来のページ所有ストレージを信頼せず、本人の確認後に当該タブ/公開プロフィール用の許可をWorkerへ保存。保存失敗時はFxEmbedへ接続しない。
- 移行：従来のXページ`xmn-public-media-v1`および当該プロフィールの旧同意フラグを削除するが、その値は新Workerへ取り込まない。**既存ユーザーには再度FxEmbedへの同意を求める。**
- 型検査・Node単体/Chrome互換のEdge合成テスト・Worker拒否/タブ分離の独立テストを実施。実Xの署名済みChromeでの検証は**NOT RUN**。
- B1の公開/Chrome導入は実X受入まで保留。作業ブランチの成果は非公開GitHubに保存する。

- B1チェックポイント：`npm test` 207件（191成功、0失敗、10スキップ、実X TODO 6）、Edge Chromium 4件合格、TypeScript Content/Worker 2ビルドとも型検査合格。
- B0受入テスト`R-001`を有効化して合格。残り7件は未達を明記してRED契約として保持。旧ページストレージの値を信頼するフォールバックは追加していない。
- Chromeの実機でのService Worker起動・セッション継続・追加`storage`権限の受入は**未実行**。既存ブラウザのインストールは変更しない。
