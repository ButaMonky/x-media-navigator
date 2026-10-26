# X Media Navigator v2.4.2 — 画像を開く前の先読み・遅延サムネイル監査

調査日：2026-10-26 / 基点コミット：3112fced / GitHub非公開開発ブランチ

## 調査の目的と既存制約

ユーザー報告では、投稿間の視覚引継ぎが半分程度しか成功せず、右側投稿欄の開閉アニメーションが残る。また、先読みをさらに早めたい要望がある。v2.4.1ではSPAモーダルを検出してから0msタイマーで先読みを開始するが、**モーダルが存在することが開始条件**のため、開く前の時間は使っていなかった。

XのSPAとプロフィールのメディアタブは公式UIが所有する。ユーザーがクリックするリンクやスクロール先を横取りしたり、ページのReact内部APIや認証済みGraphQLを呼ぶことは避ける。

## AUD-030：Xの遅延サムネイルURLを取り逃がす（SOURCE VERIFIED）

v2.4.1の一覧監視は `childList:true` のみだった。Xがタイルを挿入後、同じ `img` の `src/srcset` 属性だけ書き換えて実画像をロードする場合、監視の通知がなく、保存した `imageSources` が更新されない可能性がある。

v2.4.2修正：メディア一覧に限定して `attributeFilter:['src','srcset']` を追加。無関係なプロフィールアイコン・サイドバーの画像属性変化は、対象がメディアタイルの子孫である場合を除き無視する。DOMの子ノード追加も従来どおり監視する。パスが別投稿へ移った場合はリストのスキャンを行わない。

根拠：`src/content.ts` の `ensureListObserver`、FakeDOMにおける監視オプションと遅延サムネイル更新テスト。

## AUD-031：クリックからモーダル表示までの時間を先読みに活用していなかった（SOURCE VERIFIED）

v2.4.1では `preloadAdjacentImages()` が `viewer.isConnected` を前提としていた。クリックからReactモーダル生成の待ち時間を活用できなかった。

v2.4.2修正：`/profile/media` の一覧にある実際の画像リンクを **左クリック**したときに、ネイティブX操作を妨げずに、そのリンクと現在の一覧順位を確認して **クリックイベントの時点で最大2件を先行取得**する。残りはキューへ入れ、従来の最大5画像と2同時通信・80MiB概算上限を維持する。Ctrl/Shift/Alt/Metaクリック、中ボタン、ほかの投稿への移動、引用投稿リンク、無関係なページでは動作させない。

低速回線（3G相当以下）やメモリ申告4GiB以下、Save-Dataの場合は、初回表示のためのXネイティブ画像ダウンロードと競合しないようクリック時の先読みだけをスキップ。モーダルを開かなかった場合は約2秒後に先読みキューを空にし、不要な連続読み込みを止める。既に始まった最大2通信はブラウザ側で完了する可能性がある。

根拠：`onMediaTileClick`／`preloadAdjacentImages(preopen)`／`drainPrefetchQueue(allowMediaGrid)`、Nodeのクリック・修飾キー試験とChromeの初回クリック試験。

## AUD-032：DOM監視の不要な全件スキャン負担（SOURCE VERIFIED）

`src/srcset`属性を監視するだけでは、メディアタブに関係のないアイコン等の読み込みでも全タイルを再走査するリスクがある。属性変化は `li[role=listitem]` の内部に限って反応し、それ以外は無視する。全体のDOM子要素が変化した場合は従来のスキャン処理を維持する。

## 実際のXでの検証が必要な点（LIVE X NOT VERIFIED）

- 最初のユーザークリックで画像が先読みされ、クリック後のX本来の画像読み込みを遅くしないか。
- Xが使用する表示URL（`name=large`・`orig`・サイズ別URL）と当拡張の先読みURLが完全一致するか。MDN `fetchPriority=low` はブラウザへのヒントであり、通信優先度やキャッシュ命中を保証しない。
- 動画・GIF・省データ・3G・低メモリ・ページ非表示・改行/引用リンクの混在時に誤った取得がないか。
- モーダルを閉じて開き直す従来設計のため、右側の投稿欄がアニメーションで再展開する根本原因は本バージョンでは未解決。
- Reactの内部Routerを操作したり、非公開APIの認証を複製したりする方式は採用していない。クリック前先読みは **DOMから確認できた既知の画像に限定**する。

## SPAの根本改善に向けた比較

**A 現行方式**: Xのネイティブモーダルを閉じる→次のタイルをクリック。URL・履歴・コメント欄のデータ整合はX本体に任せられるが、右投稿欄の再アニメーションは残りやすい。

**B ネイティブのモーダルを維持したまま別投稿リンクを操作**: 実際のXのクリック遷移が既存モーダルを再利用するか、遷移先のhistoryや戻る操作が一致するか、証拠がないため **製品版への投入は保留**。実サイトで安全なテストが必要。

**C 独自の持続的なギャラリーを描画**: 画像自体は滑らかだが、X本来の返信・投稿欄まで再現するのは難しい。ユーザーが望む左右のレイアウトをそのまま維持するとは限らない。オープンソースのX.com Enhanced Galleryや別のX Media Viewerはアーキテクチャ参考にはなるが、X本体の右投稿欄と完全一致する根拠にはならない。

## テスト・資料とインシデント

- `npm test`、TypeScript型検査、Chrome合成Xテスト、GitHub Actions push/PRをそれぞれ確認する。模擬テストがX実サイトの速度を保証するわけではない。
- 先読み件数・同時通信上限は5件・2件、既存のキャッシュメモリ上限は概算80MiB。権限・常駐更新アプリは追加しない。
- 編集ツール障害（TOOL-XMN-20261026-FUZZY-01）：ローカル編集ツールの依存 `fastest-levenshtein` が不足し、1回のテスト修正が拒否された。正規のPowerShellの完全一致置換で同じユーザー認可PC上の編集を継続し、失敗した編集は保存されず、最終差分とテストで確認した。以後の他ファイル変更には影響なし。

### 参照
- https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver/observe
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/fetchPriority
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode
- https://github.com/PiesP/xcom-enhanced-gallery/blob/master/docs/media-sources.md （表示の観測URLとダウンロードのURLは別に扱う）
- https://chromewebstore.google.com/detail/x-media-viewer/hlnejegokbfmimhajpdnlpojkffepilj （独自の持続的ギャラリーという別方針の例）
