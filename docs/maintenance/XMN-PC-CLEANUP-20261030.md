# X Media Navigator — PC整理とGitHub復元台帳（2026-10-30）

作業ID: `XMN-PC-CLEANUP-20261030`。非公開リポジトリ `ButaMonky/x-media-navigator`。公開 `main`、Draft PR #17、既存Chromeプロファイルは変更しない。

## PCに残したもの
- 開発正本: `%USERPROFILE%\Documents\x-media-navigator`。ブランチ `task/xmn-b0-b3-20261029`（整理開始基準SHA `33d7669038f939c5a65f23e9059f133915b16a17`）。
- Chrome用の唯一の固定フォルダ: `%USERPROFILE%\Downloads\X-Media-Navigator-Current`。Manifest V3、v2.4.26、10ファイル。別名QAディレクトリは置かない。
- ChromeのLoad unpacked／拡張カードの再読み込みは未操作。登録済みChrome拡張が最新ファイルを使っているかはユーザー側受入が必要。
- Git worktree 38→1、`Documents`直下のXMN関連フォルダ1、`Downloads`直下のXMN関連フォルダ1。重複した`node_modules`約807 MiBを解消し、ローカル開発フォルダは約33 MiB。
- TEMPのXMN関連446項目（約68.26 MiB）、旧アップデーター約0.70 MiB、独立Chrome for Testing約439.67 MiB、旧QA保管庫約4.51 MiBを削除。計測したCドライブの空き容量は整理前約552.4 GiB、整理後約553.728 GiB（約1.3 GiB増）。通常Chrome本体・ログイン済みプロファイルは未変更。
- Chrome for Testingは公開配布物を再取得すれば復元可能。GitHubに再配布用バイナリは保存していない。

## GitHubだけに残した復元用の非公開バックアップ
1. `archive/xmn-legacy-qa-packages-20261030`、コミット `6484640dc006750d048da9f45a06c22bedffae89`。パス `archive/xmn-legacy-qa-packages-20261030.zip`。旧版のQA／ZIP／チェックサム等206ファイル。ZIP SHA-256 `E9160924E46D3946F62FDBD15BD22891B33141B59FE3FF9ECA8E766C87F17132`。Gitの保存blobから復元し、元206ファイルと個別SHA-256一致を確認してからPC側を削除。
2. `archive/xmn-local-extra-recovery-20261030`、コミット `38e86e6519751e27625dba15382e138ffb975259`。パス `archive/xmn-local-extra-recovery-20261030.zip`。復旧パッチ／研究メモ8件、旧アップデーターバックアップ54件＋MANIFEST。ZIP SHA-256 `AB80918A4DFE646385BFD0D7187CF91EDA702C3453ACBE606E0A047742405BB9`。Git保存blobから復元し、元62ファイルとの個別SHA-256一致を確認。Cookie、トークン、HAR、ブラウザプロファイル、生ログ、旧updaterの状態ファイルはGitHubにアップロードしない。
3. ローカル未コミット実装を保存した、**公開しない・自動統合しない**アーカイブブランチ（全てremote SHA検証済み）:
   - `archive/xmn-b2-adjacent-wip-20261030` → `33f9a9d5435f8f7d41fd9d36ab6a8291b775d0d2`
   - `archive/xmn-b2-capacity-wip-20261030` → `c94cbc36a41962fd2a85e7a133e6fc0aec0a2344`
   - `archive/xmn-b2-page-wip-20261030` → `7b55abedd58fea4aad2d3084f9e23070c35ed41d`
   - `archive/xmn-b2-preflight-wip-20261030` → `d411ba0d47e8c47b452c824eff1e84bb5a1d57a7`
   - `archive/xmn-b2-transition-wip-20261030` → `ed8cc1fa648ddfac6dc5739654b9caf29086f2fc`
   - `archive/xmn-b5-history-restore-wip-20261030` → `02df23695dbbc2e31ee10844ce68faf11f2befdc`
   - 独立未統合クリーン成果: `archive/xmn-b3-stream-safety-20261030` → `59844402c6b28ff84de91233957c1aac918d9ed9`。
4. ほかのクリーン作業領域は正本の祖先コミットまたはGitHub remoteの完全一致を確認。残る2領域の見かけの差分はJavaScript改行コードだけで、インデックス更新後は変更0件。Gitの`reset`、`stash`、`rebase`、`amend`、force更新を使わず、クリーンなworktreeのみを通常の`git worktree remove`で整理した。

## 作業後の品質と残課題
- 正本のTypeScript型検査PASS。`npm test`は**368件、359 PASS、0 FAIL、3 SKIP、実X TODO 6**。生成JSの改行差は正規化してGit cleanを確認。新規コードを公開したわけではない。
- GitHubの公開main／通常配布版は変更していない。**実ログインXでの画像28→29、1〜4画像、GIF/動画、返信欄、SPA、450件超、Paint/通信量計測は未受入**。正式100%ではない。
- `Update-Chrome-QA.cmd`／`tools/update-chrome-qa.ps1`は旧FxEmbed別フォルダ向けの**レガシー更新手順**。今後実行しない。次の更新スクリプトを作る場合は`X-Media-Navigator-Current`だけを対象とし、GitHub保存／テスト完了を確認した上で既存ファイルを検証しながら置き換える。
- 復旧時はGitHubのarchiveブランチのZIPをダウンロードし、SHA-256を照合する。ローカルのブラウザCookie／認証情報／個人データは復元対象に含めない。
