# TypeScript v2 再設計・検証計画 (2026-10-25)

## 現段階の判定

- `IMPLEMENTED`: `src/` にロジックを実装、`tsc` で `extension/content_script.js` を生成。
- `TESTED-UNIT`: Node.jsのpure/core + モックDOMテストで確認。
- `NOT VERIFIED`: 実際のX Web UI、Chromeに読み込んだ実運用。
- `BLOCKED-LOCAL`: PCローカル操作は安全性チェックで拒否。GitHub側のみ修正し、元のPCファイルは変更しない。

## v1.3 → v2 の違い

| 機能 | v1.3 | v2 開発版 |
| --- | --- | --- |
| 言語 | JavaScript直編集 | TypeScript正本・JS自動生成 |
| 左右キー | X標準処理を強制停止、一覧へ移動 | X標準処理に完全委譲 |
| 投稿間移動 | 左右キー・独自矢印 | Shift+左右・独自矢印 |
| タイル識別 | statusIdのみ | statusId + kind + mediaIndex |
| タイル探索 | ページ全体 | プロフィールメディア一覧のmain領域に限定 |
| DOM要素 | 古いElement参照を保持 | 移動時に現在のDOMから再検索 |
| DOM変化 | 固定ポーリング中心 | MutationObserver（一覧） + 450ms安全側フォールバック |
| 遅延読み込み | scrollから300msで完了と推定 | 新規タイルを最大4秒確認、なければ誤遷移しない |
| UI部品 | div疑似ボタン | button + aria-label + disabled状態 |
| 拡張権限 | host_permissions | host_permissionsなし・content_scriptsのみ |

## 解決した不具合（コードレベル）

- AUD-001: 未修飾の左右キーを横取りしない。
- AUD-002: URLに記載されている画像/動画の番号を別のタイルとして追跡。
- AUD-003: DOMノードを持続キャッシュせず再探索。
- AUD-004: アカウントを切り替えたら採番もゼロから再構築。
- AUD-005: 新規項目検知後だけ遷移。新規項目がなければ既存タイルへの誤移動を防止。
- AUD-006: `/media`で取得した一覧の文脈を保持。`/status`に入った際は関連投稿を収集しない。
- AUD-007: 日本語と英語の閉じるボタンを検出。検出不能なら移動せずに通知。
- AUD-008: 入力中・修飾キー・長押しによる競合の一部を防止。
- AUD-009: 他プロフィールのタイルを除外。

## 既知の制約と残余リスク

1. XがDOMや `data-testid` を変更した場合、ビューア認識に失敗する可能性。
2. メディアタイルへのリンクに `/photo/N` や `/video/N` がなければ、同一投稿の複数メディアを常に区別できるわけではない。
3. 仮想スクロールで画面外のDOMが消えた場合、記録済み項目の再検索・復元が不十分。発見できないときは移動を中止。
4. 次の未ロードの項目がない場合は、ビューアをいったん閉じて最大4秒探索する。その後に原項目へ戻すベストエフォート動作はX実機では未検証。
5. 閉じるUIのラベルが日本語・英語以外の場合、独自遷移が停止する可能性。意図しないリンクは開かない方を優先。
6. `querySelector('main [data-testid="primaryColumn"]')` と `li[role="listitem"]` の形は現行X実機で未検証。
7. ユーザーのPC上の既存拡張はまだv1.3。ローカルへの同期と導入は未実施。

## 検証済み

- TypeScript `tsc -p tsconfig.json`: PASS。
- JavaScript `node --check`: PASS。
- Node.js pure/core・モックController・manifest検査: PASS。
- Chromium headless integration: **NOT RUN/ENVIRONMENT BLOCKED** (環境でブラウザ起動がタイムアウト)。
- Chrome + X実サイトの操作検証: **NOT RUN**。

## 次に必要な実機検証

1. 2～4枚投稿でX標準の左右キーが正しく動く。
2. Shift+左右と専用ボタンがメディア一覧順に移動する。
3. 投稿の終端、追加読み込み、動画・GIF、入力フォーム、メディアタブに戻る操作。
4. 長距離スクロールとDOM仮想化、英語・日本語UI、Chromeのズーム率差。
5. 安定が確認できたらPRレビューの上でmainへマージし、開発用拡張の導入を選択する。

## 故障時の戻し方

開発版の拡張を無効化し、ストア版v1.3だけを有効化する。ユーザープロファイルや元拡張のファイルを書き換えていないため、元の状態に戻せる構成。

## 原本ハッシュの扱い

Windows上の元インストールファイルは SHA-256 `B3185DC554E2B981C65970192D750AC82ADAE5BAC0A043E2084D4BB85D153CB0`。Gitへ保存された `upstream/chrome-v1.3/content_script.js` はGitの改行正規化後のLFテキストなので SHA-256 `BC67D0F31B7482B3FB06EB686E7CE944B4014746375696D8CDD9D915117190BE`。**バイト同一とは記述しない**。意味内容の比較とソース照合は残る。
