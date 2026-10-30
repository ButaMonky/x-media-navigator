# X Media Navigator｜B4 先読み中の通信ポリシー変更を即時反映

- 作業ID: `XMN-B4-NETWORK-POLICY-20261030`
- 専用ブランチ: `task/xmn-b4-network-budget-20261030`
- 初期正本: `2e8587fa9c6b12b84c9a0918d4c2950b70a41b55`
- 非公開`v2.4.22-dev.1`を対象。公開main、Draft PR #17、通常Chrome
  v2.4.18、旧QA v2.4.20、B4 QA v2.4.21、B5 QA v2.4.22の
  保存済み配布物は未変更。
- 元のB0〜B5の成果を再実行せず、追加の通信予算・省データ監査に限定。

## 確認された不具合（RED）

- 高速回線で2つの任意CDN画像を先読みし、3番目を待機キューに
  入れた後に、端末の`Save-Data`をONにしても
  進行中の画像リクエストが止まらず、待機分を残す。
- `navigator.onLine`がオフラインに変化しても、
  既に進んでいる`Image.decode()`の完了ハンドラが
  `drainPrefetchQueue()`を呼び、**オフライン後に3件目まで取得開始**。
  検証では3番目の`pbs.twimg.com`リソースURLへの開始を再現。
- 再接続時、同じ経路の`preloadForPath`キーが残っていると、
  追加読み込みが始まらない可能性がある。
- 4件の独立テストを先に作成し、修正前に全件REDを確認。
  既存ネイティブ画像、画廊のクリック操作、ユーザーのCookie、
  XのAPI実通信はテストに使っていない。

## 修正

- `window.online`、`window.offline`と、サポートされる
  `navigator.connection.change`でネットワークポリシーを追跡。
  Chromeの最小権限のまま、別のAPIや常駐ポーリングを追加しない。
- オフライン、`Save-Data=true`、低速`slow-2g`/`2g`では、
  **新たな先読み開始を止め、未使用の転送2枠と待機キューを解放**。
  未完了のタイマーは消すが、完了済みのデコード画像と
  **今まさに表示中のhandoff画像**は維持する。
- `cancel()`が同期的に`drainPrefetchQueue()`を呼んでも
  無限再入しない`prefetchPolicyStopping`ガードを追加。
  意図的な取消しは`prefetchFailed`へ登録しない。
- ネットワーク再開時は旧経路の重複抑止キーを消し、
  表示中ビューアの通常の先読みスケジューラーを再利用。
  隠れているタブから勝手に通信を再開しない。
- **X本体が取得している画像には一切介入しない**。
  拡張機能の投機的CDN先読みだけを対象にする。

## 検査

- 新しい4件のRED→GREEN（Data Saver、オフライン、
  再接続、デコード完了後の誤った3件目取得）PASS。
- `npm test`: **335件、326 PASS、0 FAIL、3 SKIP、
  実際のXについてTODO6**。
- `npm run typecheck`、`npm run build`: PASS。
- 必須合成Chromium: **4/4 PASS**。
- 実Chrome for Testingの隔離MV3: 正規セッション復元、
  440→20件のアーカイブ、往復、ネイティブ28→29、
  4枚境界、同意拒否、不正アンカー、未認可オリジン拒否の
  **8系統すべてPASS**。
- テストは独立localhostと一時Chromeプロファイルで実行。
  実際のXでの通信量や画面のPaint、体感速度の改善は
  まだ測定していない。

## 未完了と次回再開位置

- 他のB2容量、B3 stream、B5履歴、provider integrity、CIの担当には
  並行した未コミット成果が存在する。担当別の作業ツリーは触らない。
- GitHub privateの本ブランチCIが成功した場合のみ、
  最新主開発正本との差分を再照合してFF-only統合。
- 実際のXでの28→29、複数メディア、レスポンス、
  画像転送・Paint・CPU/RAMを最終受入するまで公開しない。
