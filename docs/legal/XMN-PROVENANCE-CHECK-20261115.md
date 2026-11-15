# 元版コードの残存確認（2026-11-15）

これは技術的な比較の記録であり、法律上の最終判断ではない。

## 対象

- 元版: `upstream/chrome-v1.3/content_script.js`（KT作 v1.3、502行）、`style.css`、アイコン
- 現行: `src/content.ts`、`src/core.ts`（v2.4.36、`extension/content_script.js` の生成元）、`extension/style.css`、`extension/icon*.png`

## 結果

| 項目 | 結果 |
| --- | --- |
| 25文字超の行（空白正規化）で一致 | 元版191行中 **1行**（`event.stopImmediatePropagation();` という汎用API呼び出しのみ） |
| 8トークン連続一致（shingle） | 元版3,796個中 **42個（約1%）**。いずれも `document.querySelector(...)` 等の汎用的なDOM API列 |
| 元版固有の識別子 | `closeMediaAndThen`、`navigateToTile`、`tileIndexMap`、`globalTileCounter`、`custom-navigation` は **いずれも現行に無し** |
| 構造 | 現行はTypeScriptの名前空間＋Controllerクラス、MV3ワーカー、先読み・診断等を新規実装。元版のIIFE＋setInterval構造は残っていない |
| CSS | ボタン配置の値（`top: 70%`、`translateY(-50%)`、左右`20px`、`z-index: 9999`、半透明黒背景）が元版 `.custom-navigation` と類似。クラス名・その他の宣言は別 |
| アイコン | v2.4.28で新規デザイン（`docs/qa/2026-10-31-v2428-neon-icon.md`）に置換済み。元版アイコンは配布物に含まれない |
| 発想・機能 | 「メディア一覧に通し番号」「ビューアに前後ボタン」という機能の発想は元版由来 |

## 判断と対応

- 配布物のJavaScriptとアイコンに元版のコードは実質的に残っていない。
- 類似はボタン配置のCSS値と機能の発想。念のため `CREDITS.md` に元作者・出典・MIT表示（Firefox配布ページ上の表示）を記載し、配布ZIPに同梱する。
- `upstream/chrome-v1.3/` は元版そのものなので、公開リポジトリや配布ZIPには含めない（含める場合は元作者の許諾・ライセンス原文を確認）。
- ストア掲載文にも「KT氏の拡張機能を参考に新規実装した非公式ツール」である旨を記載する。
