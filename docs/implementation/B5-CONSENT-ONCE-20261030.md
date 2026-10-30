# X Media Navigator — B5 FxEmbed同意確認の重複防止と安全な拒否

- 作業ID: `XMN-B5-CONSENT-ONCE-20261030`
- 専用ブランチ: `task/xmn-b5-consent-once-20261030`
- ベース: `2746b80f7af13fe0010b2f0f0e51577d9e648845`
- 版: `2.4.26-dev.1` / Chrome MV3 `2.4.26`、
  `X Media Navigator (Consent QA 2.4.26)`。
- B2容量・同時API通信対策、B3検証済みProvider Integrity、
  B4 Data Saver、B5 28→29・History/BFCacheは保護した。
- 旧通常v2.4.18、旧QA v2.4.20〜2.4.25、公開main、
  Stable Draft PR #17、ユーザーのログイン済みChromeは変更しない。

## 重複同意確認をRED→GREENで修正

- 初回投稿一覧の末尾で右キーを短時間に2回押すと、
  MV3 Workerの`hasConsent()`がまだ完了していない間、
  同じ外部サービスFxEmbedへの同意確認が**二重に開く**問題を
  同一URL・同一ControllerのRED試験で再現。
- `publicConsentPendingGeneration`を追加し、
  **プロフィール/URLを持つnavGeneration単位で1つの同意処理だけ**を許可。
  2回目のキーは他の同意確認や外部API取得を発生させない。
- 同意された場合も継続要求を**1件だけ**起動し、次段の既存
  `publicApiPreflightGeneration`/ `publicApiLoading`と連携する。
- 別ページ・別世代に切り替わった後、旧非同期処理の完了が
  新ページの同意確認ロックを解放することはない。
  ロックは例外・拒否・正常承認を問わず`finally`で解除する。
- Workerの同意照合そのものが拒否・通信例外で失敗した場合は
  **外部APIへ接続せず**、利用者へ1回だけ案内して状態を解放。
  Cookie/アクセストークン/履歴の読出しを追加しない。
## 試験証拠と保存

- 4つの同意処理の実動作試験と、2つの非公開QA出力安全性試験：
  同時キー入力と同意拒否、同意済みの重複API抑止、
  別経路への移動中の世代競合、
  MV3同意照合エラー時のfail-closed。
- 同意関係4テストはRED再現または以前の修正条件の
  GREEN検証を伴い、修正後は全件PASS。出力安全性2テストもPASS。
- `npm test`：**368件（359 PASS、0 FAIL、3 SKIP、実X TODO6）**。
  TypeScript型検査PASS。実Chrome for Testingの
  X模擬DOMと実Worker各試験、Linux GitHub Actionsを
  非公開ブランチの同一コミットで実施する。
- QA候補は旧版と分離した
  `%USERPROFILE%\Downloads\X-Media-Navigator-v2.4.26-CONSENT-QA-20261030`
  へ**SHA/CI/Node/TS/Chromium検証完了後だけ配置**。
  `SHA256SUMS.txt`/ `QA_README.txt`/
  個人情報を集めない手動集計用JavaScriptを同梱。
- 出力先が既存なら絶対に上書きせず、GitHub SHA一致・
  clean/CI成功・従来版の前後ハッシュ照合を必須とする。

## 実Xの最終受入はBLOCKED

- 2026-10-30、公開X Mediaページの読み取り専用確認は
  ログイン画面へリダイレクトされたため、
  実際のメディア一覧・画像モーダル・左右ボタンを観察できなかった。
- iOSからのローカルブラウザ接続も
  `originating browser context`が必要とされて利用不可。
  認証情報、Cookie、HARを読み取らず、安全拒否を迂回しない。
- **ログイン済み実Xの28→29、写真1〜4枚、GIF・動画・混合、
  返信欄とReact SPA、450件超のページ移動、Paint・HTTP転送**
  の受入は未実施。受入証拠と公開判断が得られるまでは、
  **進捗100%・公開完了は宣言しない**。
- 最新の作業再開位置：
  `docs/implementation/B5-RELEASE-GATE-HANDOFF-20261030.md`と本ファイル。

## 2026-10-30 22時台｜全局所ゲート確認

- Node：**368件、359 PASS、0 FAIL、3 SKIP、実X TODO6**。
- `npm run typecheck`：TS Content Script／MV3 WorkerともPASS。
- `npm run test:browser`：Chrome for Testingによる合成Xの4/4 PASS。
- 実Chrome for Testingの一時プロフィール／本物のMV3 Worker：
  `test:mv3`、`archive`、`roundtrip`、`history`、
  `bfcache`、`b5`、`native`、`fourphoto`、
  `deny`、`unverified`、`reject` の**全11系統PASS**。
- すべてlocalhostだけの分離試験。実Xで確認したとは主張しない。
- GitHub Actionsの同一SHA成功を確定してから
  `v2.4.26` QAフォルダへ非上書きステージングする。
