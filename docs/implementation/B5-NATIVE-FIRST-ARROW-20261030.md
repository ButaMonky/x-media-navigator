# X Media Navigator — B5 ネイティブ28件の境界受入拡充

- 作業ID: `XMN-B5-NATIVE-FIRST-ARROW-20261030`
- ブランチ: `task/xmn-b5-native-28to29-20261030`
- 基準: `f85dc47e32e61bc4861570542691f4da6ba3041a`
- 非公開開発版: `2.4.22-dev.1` / Chrome MV3 `2.4.22`
- 既存B0–B4、B5-28to29、実Worker、QAの保存済み成果は
  変更・再構築しない。**本作業は独立実ブラウザの受入検査拡充のみ**。
- 公開main、安定Draft PR #17、通常v2.4.18、旧QA
  v2.4.20、B4 QA v2.4.21、B5 QA v2.4.22の既存フォルダ、
  Chromeの通常プロフィールは未変更。

## A：公開API保存を一度も行っていないネイティブ28件

- `npm run test:mv3:native` は、実Chrome for Testingの
  使い捨てlocalhostプロファイルで、正本のContent Scriptと
  実MV3 Service Workerをロードする。
- 初期indexはX画面から得た想定のネイティブ28投稿で、
  `apiKeys`は空、`publicApiCursor=null`、
  Workerセッションは空。前回のAPI全件seed方式とは異なる。
- 独立の同意が保存されたことを確認してから、実装の
  `onKeyDown`へ**1回だけArrowRightイベント**を渡す。
  公開APIの模擬結果から、既知の直前投稿の順序と、
  投稿28の末尾973が一致することを確認。
- API由来は**新規972の1媒体だけ**で、残り28はネイティブのまま。
  Workerに29件が保存され、次文書で29/29表示と返信欄を復元。
  左矢印で前投稿28へ戻り、29件索引が保持されるまで確認。
- `nativeFirstClick29Verified=true`、
  `crossDocumentNavigation=true`、追加API回数1、合格。

## B：4枚投稿の4枚目から29番目へ

- `npm run test:mv3:fourphoto` は、最終投稿に
  `photo/1`から`photo/4`まで4つの独立媒体URLを設定。
  ネイティブ媒体31件・投稿28件の状態から開始する。
- 製品の**本物のphotoCount、onKeyDown、navigate**を使い、
  `/photo/4`の右キー1回で、照合済み29番目の投稿へ移動。
  Workerはネイティブ31媒体+API由来1媒体の**計32媒体**を保持。
- 次文書の投稿番号29/29、前ボタン、元の返信欄を検査。
  前ボタン1回で、直前の投稿に戻る動作と28/29を確認。
- `fourPhotoBoundaryVerified=true`、外部API模擬呼出1回。
## C：ユーザーの同意拒否

- `npm run test:mv3:deny`。
  WorkerのFxEmbed同意が未保存の状態で投稿28の境界に移動。
  模擬確認ダイアログで拒否した場合、**API通信0回、
  経路変更なし、Workerセッションなし、元の返信欄保持**を確認。
- `consentDeclineVerified=true`。

## D：提供元とXの投稿が一致しない

- `npm run test:mv3:unverified`。
  初回API結果に、Xの現在の投稿973が存在せず、
  前後の別投稿974/972だけ含まれる場合を再現。
  投稿間順序を推測せず、API1回で失敗扱いにし、
  インデックス28件・Workerセッション空・元の返信欄を保持。
- `unverifiedCursorRejected=true`。

## 検証の前提と未完了

- テストは**実Chrome・実MV3 Worker/Content Script**
  だが、HTTPサイトはlocalhost、データは模擬X/FxEmbed。
  Xのログイン、実X DOM、実ネットワーク、
  APIが実際に投稿29を返すことの証拠ではない。
- 4枚のとき、同一ウィンドウ内の前投稿へ戻ると
  直前投稿の**最後の写真**を開く。B2の跨ページ逆戻りは
  不変チェックポイントの仕様上、その投稿の**最初の写真**を
  開く。この表示選択の差は実機受入で評価する事項として保留。
- すべての一時ChromeプロセスとHTTPサーバは終了処理を備え、
  Chromeの保存済みユーザープロファイルを利用しない。
- 実Xでの28→29、動画/GIF/混合、返信欄、
  写真のPaintと速度、450超の本番検証、
  最終公開は**未完了**。安全拒否の別ブラウザ迂回をしない。
- 次回再開点：v2.4.22 QA候補の実X手動ロード・受入。
  実ブラウザを自動操作してXへログインしない。
