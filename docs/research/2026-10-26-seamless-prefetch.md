# 2026-10-26 — TypeScript v2.3.0 先読みとSPA表示引継ぎ研究

## 目的・定義

XのWeb版は既にSPAである。完全にモーダルを閉じずに別投稿へ移動させるためにReactの内部Router／非公開GraphQLへ介入する方式は、認証・DOM整合性・履歴互換に重大なリスクがある。

本研究では **XのURL・履歴・DOM操作を元のまま維持**し、画像をあらかじめ取得・デコードしてから、短時間だけ別投稿への切り替え中の画面に引き継ぐ。これは「SPAの滑らかな表示」へ向けた第一段階で、**React内部遷移を置き換える機能ではない**。

## 技術上の根拠

- Chrome Content Scripts（ISOLATED WORLD）はDOMの読取と表示要素の追加ができる。ページの内部関数を書き換えずに表示を補助できる。https://developer.chrome.com/docs/extensions/mv3/content_scripts/
- HTMLImageElement.decode()は画像のデコード済み状態をPromiseで確認でき、DOMへ貼付する際の空白フレームを防ぎやすい。https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode
- fetchPriority=low はヒントにすぎず通信順や高速化を保証しない。https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/fetchPriority
- メディア一覧の分離などの実装例： https://github.com/PiesP/xcom-enhanced-gallery 。コード流用なし、設計上の着眼点のみ比較。

## 新しい処理（CODE IMPLEMENTED / v2.3.0）

1. **2件までの先読み**：次の写真だけでなく、続く別投稿の最初の写真も、アルバムの先頭写真閲覧時から取得開始。隣接写真＋次投稿を優先し、余裕があれば前投稿に割り当てる。
2. **デコード完了管理**：CDNから読み込んでdecode()が成功した写真のみ、遷移用候補として管理。成功前は単に先読み済みとはみなさない。URLは既存の許可リスト pbs.twimg.com/media のみ。
3. **視覚的引継ぎ**：投稿移動時、目的投稿の写真がデコード済みなら、同じHTMLImageElementを短時間画面に表示。モーダル閉じ→次投稿のXビューア表示後に削除。
4. **タイムアウトと後片付け**：Xのビューアが出ない場合でも最大1.8秒で必ず表示要素を除去。セッション切替、失敗、Xのビューア切替でもDOM参照を残さない。
5. **副作用を避ける**：引継ぎレイヤーは pointer-events:none、aria-hidden=true。動画の全量先読み、追加API要求、Cookie収集、更新用常駐プログラムは追加しない。prefers-reduced-motion が有効なら視覚的引継ぎは停止。
6. **変更時再評価**：ページURLだけでなく、登録済みメディアタイル数が変わった場合も先読み対象を再計算。ただし画面が非表示／低速・省データ環境では新たな先読みを行わない。

## テスト判定・証拠

- Node / FakeDOM：次画像と次ポストの両方を2枠で先読みするケース、decode()成功前の使用禁止、ユーザーのモーション低減設定、Overlay生成と削除、1.8秒タイムアウトを検証。
- Chromium模擬X：独立ページにHTML/CSS/コンテンツスクリプトを読み込み、画像の中間・末尾操作、視覚引継ぎの表示・削除とpointer-events:noneを追加シナリオで検証。
- 実際のX：**未検証**。模擬Xでの成功は実サイトの動作や体感速度の保証ではない。ユーザーが現在v2.2.3を確認中のため、PC固定インストール先には配布しない。

## 次の判断と実機測定

- 2枚/3枚/4枚画像と動画の混在、末尾の右キー、リストの仮想化、写真/動画タブ切替。
- DevTools Networkで先読みとX実際の表示の URL（特にname=large/orig）を照合する。別URLならブラウザのキャッシュ命中を断定しない。
- 前後の画像切替と投稿切替を録画し、ちらつき、描画空白時間、メモリ増加、ダブルリクエストの有無を比較する。
- 遅延ロード・エラー・省データ・モーション低減・画面タブ非表示・モーダルを閉じる操作について、視覚レイヤーが残らないことを検証。
- 完全にモーダルを閉じない表示方式は上記の実測後に別設計として検討し、URL/履歴/アクセシビリティ整合を満たさないなら採用しない。

状態の用語：SOURCE VERIFIED=静的確認、CODE IMPLEMENTED=実装、TESTED-SYNTHETIC=模擬試験合格、LIVE X NOT VERIFIED=実際のXで未検証。
