# X Media Navigator: 投稿順序・画像所有者・編集キーの追加監査

調査日: 2026-10-26 JST
対象基準: TypeScript v2.2.3 / commit 762c629
変更状態: CODE IMPLEMENTED in research branch, NOT YET INSTALLED to user beta; X LIVE NOT VERIFIED.

## 調査動機

ユーザーがv2.2.3を実機確認している間に、Chrome用の固定フォルダを触らず、ソースコードと合成DOMで誤遷移の潜在原因を解析した。

参考実装：
- https://github.com/PiesP/xcom-enhanced-gallery
  - DOMFallbackExtractorでは、投稿所有者の再確認、引用元/自分の投稿の分離、操作対象メディアの再検証を行う。本リポジトリにはコードを転載せず、設計上の着眼点のみ参照。
- https://developer.chrome.com/docs/extensions/mv3/content_scripts/
  - Content Scripts は既存DOMの読み取り・操作ができ、ページ内Reactの非公開状態に直接依存せず実装可能。

## AUD-020: 非連続の同一投稿IDによる誤ジャンプ（SOURCE VERIFIED）

旧版の adjacentPostIndex(refs,statusId,direction) は、同じ投稿IDに属する全項目を一度収集し、右移動では最後の出現位置、左移動では最初の出現位置から探索していた。

例：一覧が [A/1, B/1, A/2, C/1] となった場合、A/1を表示しているにもかかわらず、右で C/1 を選ぶ可能性がある。

修正：実際に開いている currentIndex を渡し、その位置を起点に **連続する同一投稿** のみをスキップする。対象は、画面表示、左右キー前提判定、先読み、実際のnavigate、遅延読み込み後の選択。

証拠：tests/core.test.mjs の repeated noncontiguous status IDs never skip intervening posts。

## AUD-021: 引用投稿・複数リンクからの誤選択（SOURCE VERIFIED）

旧版の usableTileLink は、同一プロフィールに所属するリンクのうち最初の /photo/N または /video/N を採用するだけで、タイルに内包された引用画像などを区別できない。

修正：quoteTweet 内リンクは対象から除外。画像/動画を実際に内包するリンクを優先し、同じタイルに複数の異なる投稿IDがあり所有元が特定できなければ登録しない。XのDOMで画像がリンクの外にある場合には、所有者が一意な場合のみ許可。

証拠：tests/controller.test.mjs、tests/browser.test.mjs 合成Xの quoted and ambiguous scenarios。

残るリスク：実際のXのメディアタイルに複数の異なる投稿が配置される特殊なUIでは、対応できないタイルを意図的に無視する場合がある。誤移動より安全を優先し、本番DOM確認後に再評価。

## AUD-022: 先読みするサムネイルの取り違え（SOURCE VERIFIED）

元コードは媒体タイル内の最初の img[src] を使用していた。引用画像や複数の画像を含むタイルでは、選択した投稿と画像の所有元がずれる可能性がある。

修正：優先的に選択した a[href] が包む img[src] を利用。そうでない場合は、タイルに一つしか画像が存在しない場合のみ先読み元を取得する。識別できない場合の追加通信を避ける。

証拠：tests/controller.test.mjs の thumbnail URL cache bounded test のモック更新と、quoted/ambiguous media tile tests。

## AUD-023: 編集中の方向キー競合（SOURCE VERIFIED）

旧版は contenteditable="" と contenteditable="true" しか明示しておらず、contenteditable="plaintext-only"、combobox、spinbutton などでは、キーを奪う可能性があった。

修正：有効な contenteditable とコンボボックス、数値入力系を保護。動画シークや既存フォームも引き続き保護する。

証拠：tests/controller.test.mjs arrow shortcuts never run while a plaintext editor or combobox has focus。

## 検証・運用境界

- Node/模擬DOM：46 PASS、0 FAIL、1 SKIP（Chromium optional）、6 TODO。実行は Windows ローカル。
- TypeScript の strict typecheck：PASS。
- Chromium Synthetic X は GitHub Actions で評価予定。追加シナリオは「引用／曖昧リンクの誤収集」を対象とする。
- **現在ユーザーがテスト中のC:\Users\Saito\Downloads\X-Media-Navigator-Currentには未反映。** ベータv2.2.3は変更していない。
- 公式X APIや内部GraphQLへの追加通信は導入しない。Cookie、認証、閲覧履歴も収集しない。
- X LIVEの現行DOM、引用投稿の表示方法、画像連続性、キャッシュ転送量は引き続き未確認。

## AUD-024: 画像未ロード時に消えるタイル（SOURCE VERIFIED）

一部のDOM実装ではサムネイルの <img> が遅延読み込み中にまだ存在しない可能性がある。所有者選別の安全化で「img/videoが無ければ一律除外」とすると、明確な /photo/N または /video/N リンクまで失う危険がある。

修正：引用でない正規プロフィールの **単独かつ明示的なメディア位置付きリンク** なら、まだ画像がDOMに無くても一覧の位置だけを登録可能にする。投稿一般リンクしか無い場合や複数の候補がある場合は受理しない。サムネイルが無いので画像の先読みは行わない。

証拠：tests/controller.test.mjs の one explicit media link remains indexable before its thumbnail loads。

## 更新した検査結果

- Windows Node/VM: 47 PASS, 0 FAIL, 1 SKIP, 6 TODO。
- Chromium模擬Xの新しい「引用／曖昧リンク」シナリオ：GitHub Actionsで検証。
- TypeScript strict typecheck：PASS。
- 実サイトXにおける低速画像読み込み、投稿順、引用画像のDOM所有権は未検証。
