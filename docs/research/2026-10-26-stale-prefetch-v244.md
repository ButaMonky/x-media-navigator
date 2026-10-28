# X Media Navigator v2.4.4 — 先読みの通信枠・停止処理・CDN URL補完

記録日：2026-10-26 / 基点：v2.4.3 commit cfe3491 / 開発ブランチ：fix/prefetch-cancellation-v244

## 調査目的

ユーザーから「投稿切替時の成功率が安定しない」「先読みの速度をさらに上げたい」との報告がある。v2.4.3の先読みは最大5画像までキュー、同時2転送に制限していた。これは帯域節約として有効だが、**旧投稿の遅い画像取得が2転送枠を占有したまま、現在必要な次投稿の画像を待たせる**可能性があった。また画像ロードのPromiseが永久に解決しなければ、その同時枠が解放されない。

## AUD-035：不要な進行中画像が現在の先読みを塞ぐ（SOURCE VERIFIED）

- 原因：`preloadAdjacentImages` で`prefetchWanted`を現在の投稿に合わせて更新しても、既に起動中の`Image.decode()`とその`prefetchInFlight`をキャンセルしていなかった。
- 修正：投稿移動などで新しい必要URL集合が決まったら、**不要になった進行中画像だけ**をキャンセル。デコード済み画像はキャッシュとして保持し、画面に表示中のSPA引継ぎ画像はキャンセルしない。
- 画像の`src`を無意味な空文字列へ書き換えない。可能な場合は`removeAttribute('src')`、テスト等の代替環境ではネットワーク要求にならない`data:,`を使用。
- 明示的な不要画像キャンセルはCDNの不具合として記録せず、次に戻った際に再取得できる。

## AUD-036：永続的な画像読み込み待ち（SOURCE VERIFIED）

- 原因：`decode()`や読み込みイベントが戻らなければ、同時転送2枠の1枠が長時間占有される。
- 修正：ブラウザでタイマーが利用できる環境では各先読みに**12秒のウォッチドッグ**を設定。未完了ならローディング画像を中断し、今の投稿のキューを進める。同じ投稿で直ちに連続再試行しないよう失敗URLの短期記録を維持する。
- 一度成功・失敗・キャンセルしたらタイマーを解除。Promiseが後から完了しても同時枠を二重解放しない。メディアタブから離れる場合は全ての保留画像を中断してから、配列・Map・タイマーを消す。
- これはWebのリクエストキャンセルを画像要素の範囲で依頼するものであり、ブラウザの既に送信済みのバイトを必ず取り戻すと断定しない。

## AUD-037：遅延ロード中の無効なcurrentSrcを優先（SOURCE VERIFIED）

- 原因：タイル画像の`img.currentSrc || img.src`は、`currentSrc`が`data:`の旧プレースホルダーで`src`に既に正しいX CDN URLが入っている場合、`preloadImageUrl`による検証に失敗し、画像URLが取得できなかった。
- 修正：`currentSrc`をX CDN URLとして検証してから採用し、不正なら`src`も個別検証。任意ホストへの通信は許可せず、従来どおり`https://pbs.twimg.com/media/`で妥当なフォーマットとサイズを持つ写真だけを先読みする。

## 検証結果・範囲

- Node/FakeDOM: 古い2つの進行中Imageをキャンセルし、新しい2画像の取得へ枠を渡すテスト。12秒のタイムアウト後に待機中の画像を開始するテスト。旧セッション離脱時の中断・次セッション隔離テスト。遅延currentSrcの代替src検証テスト。
- TypeScript strict型検査、Chromeでの合成X模擬試験、GitHub Actionsのpush/PRを各々評価する。
- **X実サイトでの体感速度・CDN転送バイト・右側投稿欄の再表示アニメーションは未測定／未解決**。試験したモックを本番の動作保証と扱わない。
- 先読み最大5候補・同時2取得・低速回線/省メモリ制限・概算80MiBの短期キャッシュ、1枚しか見えないカルーセルの終端安全判定、Web Store安定版mainの非変更は維持する。

## 今後の判断

- Xの実画像の表示URLと当拡張の`name=large` URLをChrome DevTools Networkで照合する。違うURLならHTTPキャッシュが共有されない可能性があり、複数先の先読みを増やすより、表示サイズの整合を優先して改善する。
- 右側投稿欄のアニメーションはXのモーダルを閉じ→開き直す構造に依存する。ネイティブモーダルを保持したまま別投稿へ移る方法は実DOM・ブラウザ履歴の根拠が得られるまで製品へ導入しない。
- GitHubと同じコミットをPCの固定フォルダへ直接同期するだけとし、タスクスケジューラや外部更新アプリは導入しない。

## 参考
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode
- https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/fetchPriority
- https://github.com/PiesP/xcom-enhanced-gallery/blob/master/docs/media-sources.md
