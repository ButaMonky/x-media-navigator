# Credits / 謝辞

X Media Navigator は、次の拡張機能の発想（メディア一覧の番号付け、ビューアに「前の／次のメディアへ」ボタンを置く仕組み）を出発点に、TypeScriptで新規に書き直したものです。

- 元の拡張機能: 「X(Twitter)のメディアページに「前のメディアへ」or「次のメディアへ」ボタンを追加」 v1.3
- 作者: KT
- Firefox版: https://addons.mozilla.org/ja/firefox/addon/mediabutton/ （配布ページ上のライセンス表示: MIT）
- Chrome版: https://chromewebstore.google.com/detail/fkljpdamgibhefcblfeabdhkfenmbnik

素晴らしい元の拡張機能を作ってくださったKTさんに感謝します。

本拡張機能は KT さんおよび X Corp. とは無関係の非公式ツールです。

## 由来コードの扱い

2026-11-15 の比較（`docs/legal/XMN-PROVENANCE-CHECK-20261115.md`）では、配布物（`extension/`）の JavaScript に元版のコードは実質的に残っていません。
ボタンの見た目に関する少数のCSS値（縦70%配置・左右20px など）は元版の配置を踏襲しています。
元版の配布ページがMITライセンスを表示していることから、念のため以下のMITライセンス条件に基づく帰属表示を行います。

> The original extension is published by KT under the MIT License (as indicated on its Firefox Add-ons page).
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.

`upstream/chrome-v1.3/` は検証用に保存した元版そのものです。リポジトリを公開する場合は、このフォルダを除外するか、元作者の許諾・ライセンス表示を確認してから公開してください。
