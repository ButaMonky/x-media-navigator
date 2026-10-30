# X Media Navigator — B2容量上限とB3通信量・連打競合の修復

- 作業ID: `XMN-B2-CAPACITY-B3-UTF8-20261030`
- 専用ブランチ: `task/xmn-b2-capacity-20261030`
- 基準GitHub開発正本: `2e8587fa9c6b12b84c9a0918d4c2950b70a41b55`
- 他担当のdirty worktreeは参照せず上書きしない。
- 公開`main`、安定Draft PR、通常Chrome v2.4.18、
  旧QA v2.4.20、B4 QA v2.4.21、B5 QA v2.4.22を変更しない。
- 正本B0～B5（330件以上の回帰）の完了工程を再実行して
  新機能扱いにしない。**従来未修正だった3つの境界不具合のみ扱う**。

## B2 64ページ上限

- 64個の不変チェックポイント（最大約28,800参照）を保存後、
  `manifest`に新ページを追加できないのに、右キーや先読みで
  FxEmbedへ何度も通信し、最後に`manifest.put`を拒否していた。
- **修正**：Workerが所有する現在のmanifestを、3rd partyへの
  リクエスト**前**に確認する。満64ページなら新規リクエストなしで
  終了。既存の64ページの前後移動と元の表示は維持。
- 誤って`publicApiExhausted`をtrueにはしない。
  上限は**拡張の保存上限**であり、Xに古い投稿がない証拠ではない。
  既存の投稿ラベルには「安全上限到達」の詳細説明をつけ、
  右キーでは具体的な日本語の上限通知を返す。
- `restoredCheckpointPage`とWorkerの`activePage`が不一致、
  またはmanifestが欠落した場合も、新しい公開API通信を開始しない。
  古いページからの利用では既存の安全なWorker隣接移動を優先。
- 上限到達後の自動先読み・毎回の同意再確認を停止し、
  タブのプロフィール/セッション再開時は上限フラグを初期化する。
## B2 非同期preflight競合

- 初回修復のpreflightに`await loadPageManifest`が追加されたため、
  連続した2回の右キーがそれぞれ同時にmanifestを調べ、
  **2つの公開APIリクエスト**を実行できる競合をREDで再現。
- ナビゲーション世代に紐づく`publicApiPreflightGeneration`で
  1つの状態照合だけを予約。別経路へ遷移した古い照合は
  次世代の予約を消さない。
- 明示操作中はpreflight/既存API取得を一つの保留操作として扱い、
  同時のウォームアップも無効化。
- DOMコントローラの模擬オブジェクトは未初期化の
  `undefined`を持ちうるため、判定は`!= null`を先に確認。
  実製品で初期値がnullの場合にも競合の隔離を維持。

## B3 非ストリーミング時UTF-8 wire bytes

- `Response.body`が利用できない互換処理で、従来
  `response.text().length`（UTF-16コード単位）と
  4,000,000を比較していた。日本語1,400,000字は
  4,200,000バイトにも関わらず許容されてしまった。
- **修正**：`TextEncoder().encode(text).byteLength`で
  UTF-8 wire bytesを検査し、stream版と同じ上限を適用。
  未ストリームの応答を最初から無制限に受ける
  古い互換経路は残存するため、「事前にメモリ割当を
  防止できる」とは主張しない。受信後の処理上限を修正した。
## RED→GREENと受入証拠

- 64ページ時のAPI未呼出し/Worker不変保存、manifest欠落・
  activePage不一致、ウォームアップ停止、日本語トースト、
  Cursor保持/非終端、2連打のAPI単発、UTF-8バイト厳密判定を
  再現試験に追加。
- RED確認：上限でも第三者API発行、preflight2回でAPI2回、
  日本語4.2MBが1.4M文字として許容される現象。
- 修正後：`npm test` **338件（329 PASS / 0 FAIL /
  3 SKIP / 実X TODO 6）**、`npm run typecheck` PASS。
- `npm run test:browser`：Chrome for Testingの合成X
  **4 PASS**。
- MV3 Worker実Chromeの9系統：
  正規復元、archive、roundtrip、初回28→29、
  native28→29、4枚投稿、同意拒否、未照合cursorの拒否、
  未認可元拒否を全てPASS。
- すべて使い捨てlocalhostブラウザと公開模擬投稿を使う試験で、
  認証済み実X・本物のGIF/動画と返信欄、画面Paint・転送速度は未受入。

## 再開点

- CIのNode/TypeScript/必須Chromium/生成JSを成功させてから
  新しい統合候補をFF-onlyで非公開開発正本へ適用する。
- 通常版・公開main・既存QAは変更しない。新規QA版は
  コミットSHAとGitHub CIを照合した別フォルダへ作る。
- 本番Xのユーザー実機受入までは公開・完成扱いにしない。
