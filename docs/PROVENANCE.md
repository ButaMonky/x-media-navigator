# 出所・保全記録

- 取得日: 2026-10-24 JST
- Chrome拡張ID: `fkljpdamgibhefcblfeabdhkfenmbnik`
- 元版: `1.3`, Manifest V3
- 元の配布ページ: https://chromewebstore.google.com/detail/fkljpdamgibhefcblfeabdhkfenmbnik
- 同名 Firefox アドオン (MIT表記): https://addons.mozilla.org/ja/firefox/addon/mediabutton/
- 取得元: ローカルのインストール済み Chrome 拡張フォルダ (外部送信なしで読み取り)
- 元PCのユーザー名や絶対パスはGitHubには保存しない。

## 元コード整合性
- `upstream/chrome-v1.3/content_script.js` の SHA-256:
  `B3185DC554E2B981C65970192D750AC82ADAE5BAC0A043E2084D4BB85D153CB0`
- 元のインストール済みファイルと参照用スナップショットはバイト同一で保存する方針。
- Chrome の `_metadata/` は署名検証由来の生成情報であり、リポジトリへ含めない。
- `upstream/chrome-v1.3/manifest.json` は元の配布物のまま保存 (公開鍵および更新URLを含む)。
- `extension/manifest.json` は開発用として `key` と `update_url` を除外し、名称を変更。
- 開発版を読み込むのは `extension/` ディレクトリであり、`upstream/` ではない。

## 出版・著作権上の留意点
- Firefoxアドオンの配布ページのMIT表記は確認済みだが、Chrome版と完全に同じ内容・権利表示かは未検証。
- 配布元のクレジットおよび元コード由来の表記を消さない。
- 公開・再配布は権利関係を追加確認するまで保留。

## 検証水準
- Source review: VERIFIED (installed source read)
- Syntax check: VERIFIED (Node.js `--check`)
- Real browser reproduction: NOT RUN
- Browser extension installation of development build: NOT RUN
- Navigational bug fix: NOT STARTED
