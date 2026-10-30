# X Media Navigator — B5 履歴移動・BFCache再開・安全な正本照合

- **作業ID**：`XMN-B5-HISTORY-RESTORE-20261030`
- **独立ブランチ**：`task/xmn-b5-history-restore-20261030`
- **開始時の正本SHA**：`2e8587fa9c6b12b84c9a0918d4c2950b70a41b55`
- **新しい非公開QA版**：Chrome MV3 `2.4.23`、
  npm `2.4.23-dev.1`、名前`X Media Navigator (History QA 2.4.23)`。
- B0〜B4、B5のネイティブ28→29／4枚写真／安全拒否テストの既存成果を
  引き継いでいる。旧作業を再実施していない。
- 公開`main`、安定Draft PR #17、通常版v2.4.18と
  旧QA v2.4.20／v2.4.21／v2.4.22、ログイン済みChromeプロファイルは
  この作業では変更・上書き・自動ロードしない。

## 不具合の機械的再現

### 1. 離れたチェックポイントへのブラウザ履歴移動でWorkerが取り残される

- 保存済みページ0/1/2のうち、
  Xの既知URLへHistoryや直接文書移動で2→0のように飛ぶと、
  以前の`checkpoint.find`は該当ページを読み取れるが、
  **Workerの`manifest.activePage`と`xmn:session:<tab>`は
  最後のページ2のまま残っていた**。
- UIがページ0の媒体を表示してもWorker側の前後ページ照合はページ2を
  基準にするため、後続の左右ボタンが停止・不一致になる。
- `tests/session-worker.test.mjs`で3ページの2→0、
  未登録URL／別タブ・別フレームの拒否、保存失敗時の非変更を
  追加して、修正前の**RED**を記録。

### 2. ChromeのBack/Forward Cacheでは古いControllerが再利用される

- 単なるフル文書移動なら新しいContent Scriptのconstructorが
  `restorePublicMediaSession`を呼ぶ。
  しかしChromeのBFCacheで旧文書を復元すると、
  **constructorは再実行されない**ため、旧Controllerの
  `restoredCheckpointPage`とWorkerのactivePageがずれる。
- 新規の実Chrome `mv3-history-back-forward-smoke.mjs`で
  0→2→**実際の`history.back()`**を試すと、
  修正前に`Actual browser history.back left the Worker on page2`
  と明示的に**FAIL**。スキップや結果の偽装はしていない。
## 実装

- Workerの`checkpoint.restore`を追加。タブID・X/Twitterの
  トップフレーム・対象プロフィール・**今すでに到着済みの正確なURL**を
  確認したうえで、既存manifestの全ページを不変スナップショットと照合。
- 正確なURLが保存済みのただ1ページに属するときだけ、Workerの
  `manifest.activePage`と`session`を**1回の
  `chrome.storage.session.set`で同時に更新**する。
  未知・別プロフィール・不正・重複した参照は絶対に生成しない。
- 旧`checkpoint.find`は読み取り専用APIとして残し、
  `SessionStore.restoreCheckpointForRoute()`を新設。
  Content Scriptの非隣接ページ履歴復元でのみ新APIを採用。
  セキュアなWorkerが未対応なら失敗側に倒し、
  読み取り専用結果を採用して不整合を作らない。
- 実Chromeの`pageshow.persisted`が真の時だけ、
  キャッシュされたControllerがWorkerの現在ページを再照合。
  既存媒体の完全一致ならXの画像・返信欄DOMとキャッシュを維持。
  対象が異なる場合だけ、**Workerによる正当なページ復元成功後**に
  拡張の索引・ボタンを再構築。通常のXネイティブ閲覧には干渉しない。
- `pageshow`の間にXのURLやナビゲーション世代が変わった場合は
  旧要求を破棄する。Xの`history.pushState`偽装や
  ログインCookie・HARの読取りは行わない。
## 回帰・E2E検証

- Node **337件／328 PASS／0 FAIL／3 SKIP／実X TODO 6**。
- TypeScript型検査および拡張生成JavaScriptビルドはPASS。
- Node試験3件で、非隣接0→2→0と次ページの再取得、
  不正URLと別タブ・別フレームの拒否、
  失敗した保存時のセッション非変更を確認。
- Controller試験3件で、再利用できる媒体参照を破棄しないこと、
  manifestがないX画面を変更しないこと、
  非同期応答前にURLが変わったとき古い要求を採用しないことを確認。
- `npm run test:mv3:history`：
  **実Chrome for Testing＋本物のMV3 Worker/Content Script**で、
  3チェックポイントの0→2→0→1をフル文書URL移動で通過。
  `atomicHistoricalCheckoutVerified=true`。
- `npm run test:mv3:bfcache`：
  実Chromeで0→2→本物の`history.back()`→
  `history.forward()`の往復を検査。
  修正前FAIL→修正後PASS、
  `nativeBackForwardVerified=true`。
- 試験のURL・投稿・X画面・FxEmbedレスポンスは
  **localhostの模擬データ**。Chromeの隔離プロファイルだけを使い、
  製品Workerの許可オリジンは変えずテスト用コピーのみ変更。
  実際のXでこの画面が同じ仕様であることを示さない。
## 安全なQA・残作業

- `tools/stage-b5-private-qa.ps1`は新しい出力先
  `%USERPROFILE%\Downloads\X-Media-Navigator-v2.4.23-History-QA-20261030`
  のみを生成。元のv2.4.22とは実コードが変わるため版番号を変更。
- ソースのGit clean・private GitHub HEAD完全一致、
  **同一コミットのActions成功**、Node/TS、
  既存のB5 28→29・未許可origin拒否、
  新規のHistory/BFCache実Chrome検査が全てPASSの時だけ
  本体7点とSHA256SUMS、README、任意の個人情報なし診断JSを配置。
- 既存v2.4.18/2.4.20/2.4.21/2.4.22の各アセットについて
  SHA-256を前後比較する。自動Load unpacked・Chrome操作・
  既存ディレクトリ上書き・同じバージョンで内容差替はしない。
- **残る正式受入**：ログイン済み実Xの28→29、画像1〜4、
  GIF/動画/混在、Reactの返信欄、画面PaintとHTTP取得の計測、
  450件超・複数ページの本番再現、公開の可否。
- GitHubのCI結果はpush後に追記する。実Xなしで
  進捗率100％や公開済みとはしない。
- 失敗時は`XMN-B5-HISTORY-RESTORE-20261030`を再開キーとし、
  途中のSHAとGitHub Actions run番号を照合して再実行しない。
