# X Media Navigator — B5 履歴復元・非公開QA v2.4.24

- 作業ID：`XMN-B5-HISTORY-ATOMIC-QA-20261030`
- 独立作業ブランチ：`task/xmn-b5-history-hardening-20261030`
- 開始基準：`3e2a6ab018f4b25d2a8b2d77f89808c749021727`
- 過去のB0〜B5、B2最大64ページ、B4のネットワーク予算、
  B5の28→29とCI必須化を保護した上で実装。
- 新しい候補：Chrome MV3 `2.4.24`、
  `X Media Navigator (History QA 2.4.24)`。
- 公開main、旧通常v2.4.18、旧QA v2.4.20 / 2.4.21 /
  2.4.22 / 2.4.23、Draft PR #17は変更しない。

## 修正した履歴バグ

- 保存済み不変ページが3枚以上ある場合、ブラウザ履歴で
  ページ2からページ0へ戻ったとき、従来の
  `checkpoint.find`は読み取り専用のスナップショットだけ返し、
  Workerの`manifest.activePage`と`session`が古いページのまま残る。
  この状態では、その後の左右矢印が保存済みページと一致しない。
- `checkpoint.restore`はブラウザがすでに到着している
  **トップフレームの正確なX媒体URL**のみを照合し、
  プロフィール、同意、Manifest全ページの不変性、
  チェックポイント帰属と一意性をWorker内部で検証。
- 合致する場合だけ、`manifest.activePage`と現在の
  `session`を**同一ストレージ書込**で更新。
  ストレージ失敗・URL不一致・他タブ・サブフレーム・
  Manifest欠落では変更しない。
- `SessionStore.restoreCheckpointForRoute()`を追加。
  これまでの読み取り専用`findCheckpointForRoute()`は保持。
  Content Scriptは通常の戻る経路でWorker側に
  正確な媒体URLでのチェックアウトを要求する。
- `pageshow.persisted`で復帰したBFCacheの既存Controllerも、
  現在の正確なX URLとWorkerの選択ページを照合する。
  すでに一致する既存画像・X返信欄・操作UIは破棄せず再利用。
  異なる場合のみWorkerが選択を完了した後に旧インデックスを破棄し、
  有効なセッションを復元する。
- 非同期確認中にURLやnavGenerationが変化したら
  古い返信や別媒体へ移動しない。Cookie/認証トークンや
  History APIの不正書換・非公式SPAの捏造は行わない。

## 実行された独立試験

- Worker：3ページ間の非隣接チェックアウト・双方向、
  未保存URL／別プロフィール／別タブ／サブフレームの拒否、
  同一書込のストレージ失敗で旧状態保持。
- Content Script：BFCacheの一致画廊を破棄しない、
  Manifest欠落時はネイティブXの画面を保持、
  非同期チェック途中の経路変更で旧状態を使わない。
- Node **356件、347 PASS、0 FAIL、3 SKIP、実X TODO6**。
- Chrome for Testing実MV3の使い捨てlocalhostサイト：
  `test:mv3:history`で3ページ間0→2→0→1、
  `test:mv3:bfcache`でブラウザの戻る・進むによる
  選択ページ復帰にPASS。
- Linux CIでも必要な一時Chrome起動・CDP・プロセス終了を
  2つの独立試験で対応。初期のContent Script未装着だけを
  使い捨てページ上で1回復帰、開始済みテストのリロードはしない。
- GitHub Actionsの必須Chrome for Testing MV3ゲートに、
  上記2試験を追加。4ケースの既存B5 28→29・写真4枚・
  同意拒否・不正APIアンカーに加え、Workerの未認可origin拒否を
  削除せず、合計7ケースを必須化。
- 全試験は実Chrome Service Workerを含むが、
  対象は**模擬localhostサイト**で実Xのログイン画面ではない。
  Browser UIの最終承認とは区別する。

## v2.4.24 非公開QA成果の保存先と安全条件

- 新規候補先：
  `%USERPROFILE%\Downloads\X-Media-Navigator-v2.4.24-HISTORY-QA-20261030`。
  既存ディレクトリがあれば上書き禁止。
- `tools/stage-b5-private-qa.ps1`はリポジトリがcleanかつ
  同一SHAが非公開GitHubの正本に存在し、
  GitHub Actions同一SHAの必須CIがSUCCESSであり、
  Node、TypeScript、実Chrome履歴・28→29・未承認origin拒否の
  すべてに成功した場合のみ出力。
- 本体アセットのハッシュ、Readmeと任意実行の
  個人情報を含まない集計用スニペットを保存。
  通常のChrome拡張は**自動ロード・更新しない**。

## 正式受入に残る事項

- 実際にログイン済みのXのMedia一覧で28→29、
  写真1〜4枚・GIF・動画・混合とX返信欄、Native SPA、
  450件以上のページ、CPU/RAM・Paint・HTTP転送を検証。
- ログイン済みブラウザをこのチャットから操作できない場合、
  無断でCookie/ユーザープロファイルを読み取らない。
  安全ポリシーの拒否を別ブラウザで迂回しない。
- これらの受入と公開判断が終わるまで
  **100％完了、正式公開済みと記録しない**。

## 独立Chromeセキュリティ試験のOSハンドル解放

- Windowsで完了した実Worker拒否テスト後に一時プロファイルが
  EPERMで短時間ロックされる場合があった。ログで保存対象を判定し、
  削除対象を一時ディレクトリ直下のxmn-worker-cdp-*に限定。
- プロセスツリーの終了をWindows / Linuxで分岐し、
  一時ロックの解除を最大30回・0.5秒間隔で待ってから削除。
  消去を諦めた場合は従来どおりテスト失敗とし、
  未認可オリジンの厳格な拒否条件を緩和しない。
- 修正後の本物のWorker MV3拒否テストでPASS。
