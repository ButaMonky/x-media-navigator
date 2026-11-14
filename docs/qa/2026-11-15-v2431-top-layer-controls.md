# X Media Navigator v2.4.31 — Browser top-layerを考慮した操作UIの修復

- 日付：2026-11-15 JST
- 対象：非公開開発QA、[Issue #18](https://github.com/ButaMonky/x-media-navigator/issues/18)
- 修復前の正本SHA：`f177a2123444cb7ba130f41365d89d2387549bf5`（v2.4.30）
- 公開 `main`、Web Store、既存Draft PRは変更しない

## 今回の利用者実機ログ

修復前の実Xでは、v2.4.30の`MEDIA_INDEX_READY`、`CONTROLS_LAYOUT_OK`、画像先読み成功が記録されたにもかかわらず、左右ボタンが一切表示されなかった。この状態はスクリプト注入失敗・画像の取得不能では説明できない。

`CONTROLS_LAYOUT_OK` は当初、ホスト要素のサイズ・CSSプロパティとボタン作成数しか検査しなかった。実際にクリックできる最前面の要素かどうかは確認していなかった。

## 再現できた問題

実際のChromiumを使った隔離テストで、Xの画像ビューアをHTMLの`dialog.showModal()`で最前面表示したところ、v2.4.30のボタンは生成されていても`document.elementFromPoint`ではクリック対象にならなかった（`FAIL-TOP-LAYER-DIV-false`）。ホストの`z-index:2147483647`は、ブラウザのnative top-layerより上には描画できない。

この再現は**実XのDOM自体を採取したものではない**。実際のXが同じtop-layerを採用したことの直接証拠ではなく、重要な未検証仮説として扱う。

## 修復

- `src/content.ts::controlContainer()`：従来のX UIでは`document.body`配下を保持する。対象ビューアがネイティブ`dialog:modal`や`[popover]:popover-open`の中にあるときのみ、その最前面要素へ操作UIを設置する。React管理下の通常ダイアログへの無条件挿入は避ける
- `controlsHealthCode()`：ボタンの大きさ・位置に加え、`document.elementFromPoint`で実際のクリック対象かを確認する。覆われていれば`CONTROLS_OCCLUDED`、画面外なら`CONTROLS_OUTSIDE_VIEWPORT`を報告する
- `extension/popup.js`に上記の診断表示を追加。ユーザーのURL・投稿ID・Cookie・トークン・HAR原本は記録しない。権限追加なし
- Xのネイティブ投稿リンク・先読み・1～20件の画像、旧FxEmbed既定OFF、バックグラウンド自動スクロール禁止を維持

## 必須検証

- 修正前にnative Chromiumのtop-layer再現テストが失敗することを確認
- 修正後はネイティブモーダルおよびpopoverの両方で、矢印中央のヒットテストが成功
- 新しい診断ユニットテストでは、画面上の別要素に覆われた状態と画面外を別コードに区別
- TypeScript/Node全件、Edge隔離Chromium、GitHub Actions同一SHAのMV3検証を確認してから配布
- 開発成果は`Documents\x-media-navigator\extension`に、Chrome用は`Downloads\X-Media-Navigator-Current`の1フォルダにのみ配布

## 残る実X受入

Chrome拡張カードを再読み込みし、Xタブも再読み込みする。メディア一覧から画像を開き、左右ボタンと投稿番号の表示を確認する。もしまだ見えない場合は、アイコンポップアップの診断コードで区別する。特に`CONTROLS_OCCLUDED`ではX側・他拡張の最前面要素とDOM構造、`CONTROLS_LAYOUT_OK`では実際の表示位置とスタイルを少数値のみで調査する。

**実Xで復旧したことを本人が確認するまでIssue #18はOpenのままとする。**
