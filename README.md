# X Media Navigator — private development

X (Twitter) のプロフィール「メディア」タブ用ナビゲーション拡張の解析・改良プロジェクト。
元製品の著作者・配布元とは独立した非公式の開発用リポジトリです。

## 現在の状態 (2026-10-24)
- Chrome Web Store 版 v1.3 (extension ID: fkljpdamgibhefcblfeabdhkfenmbnik) をユーザーのインストール環境から**読み取りのみ**で取得。
- `upstream/chrome-v1.3/` は改変禁止の参照用スナップショット。Chrome生成の `_metadata/` は含めない。
- `extension/` は改良用コピー。現段階で動作ロジックは同一。`manifest.json` の拡張名を開発用に変更し、`key` と `update_url` を除外した。
- **元のインストール済み拡張機能は未変更**。X上での動作・回帰テストはまだ未実施。
- 静的解析で左右キーがX標準の画像送りを奪う直接原因を確認。詳細: `docs/analysis/baseline-v1.3.md`。

## ディレクトリ
- `upstream/chrome-v1.3/`: 配布済みの参照スナップショット（編集禁止）
- `extension/`: ローカル開発用拡張（Manifest V3）
- `docs/PROVENANCE.md`: 出所・検証情報・ライセンス上の注意
- `docs/analysis/baseline-v1.3.md`: 初回ソースコード監査
- `docs/TEST_PLAN.md`: 再現・回帰テスト設計
- `tests/`: 将来の動作テスト項目と配布物の健全性検査

## 開発ルール
1. まず原因・根拠・対象コードを記録し、最小修正と回帰テストをセットにする。
2. 元拡張の上書きやChromeのプロファイルへの書き込みをしない。
3. テスト用の開発版とストア版を同時に有効化しない（キー処理などが競合する）。
4. Cookie、認証トークン、実ユーザーの投稿、閲覧履歴、Chromeプロファイルをコミットしない。
5. GitHub Issuesに発見・仮説・再現・修正済み・検証待ちを区別して記録する。

## 検証
Node.js があれば `npm test` および `npm run check` で基本的な健全性検査を実行可能。
ブラウザ上の結合テストは別途必要。TODO項目はテスト済みを意味しない。

## ライセンス
対応する Firefox アドオン v1.3 の配布ページは MIT License と表示している。
Chrome配布ファイル中には明示的な LICENSE ファイルが見つからなかったため、再配布時は出典と著作者表示を再確認すること。
このリポジトリを第三者に公開する前に権利確認と第三者素材の点検を行う。
