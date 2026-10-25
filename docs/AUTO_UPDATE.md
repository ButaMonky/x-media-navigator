# X Media Navigator — Windows 固定フォルダ・自動ベータ同期

## これは何を自動化するか

- 常に同じ場所をChromeに登録します：
  C:\Users\Saito\Downloads\X-Media-Navigator-Current
- GitHubの非公開betaブランチで、テスト成功済みのpush実行が作ったベータZIPのみ取得。
- Windowsタスクスケジューラが15分ごとに新バージョンを調べ、更新があれば固定フォルダを安全に交換。
- 変更前のフォルダはバックアップ。失敗時には以前の版を維持・復元。
- Cookie、アクセストークン、ブラウザ設定を変更・外部保存しません。GitHub CLIの既存ログインを利用します。

**Chromeの制約**：chrome://extensions 上部の「更新」ボタンは、非公開GitHubから展開済み拡張をダウンロードする機能ではありません。固定フォルダに新しいファイルが同期されたあと、**対象拡張カードの「再読み込み」（丸い矢印）**を押して反映します。ページの再読み込みが必要な場合もあります。

## セットアップ

1. Windows PCでGitHub CLI (gh) に、非公開リポジトリ ButaMonky/x-media-navigator にアクセスできるアカウントでログインしていることを確認。
2. GitHubのbetaブランチから tools/update-private-beta.ps1 をPCの固定位置へ配置。
   管理用の例：C:\Users\Saito\Documents\XMN-PrivateBetaUpdater\update-private-beta.ps1
3. PowerShell から次を一度実行：

    powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File "C:\Users\Saito\Documents\XMN-PrivateBetaUpdater\update-private-beta.ps1"

4. インストールフォルダの manifest.json が存在することを確認。
5. chrome://extensions でデベロッパーモードをオンにし「パッケージ化されていない拡張機能を読み込む」から、固定フォルダ X-Media-Navigator-Current を **一回だけ** 選択。
6. 以前のv2.2.1/v2.2.2 betaを同じプロフィールで二重有効化しない。旧ベータは無効にする。
7. Windowsタスクスケジューラを15分ごとに登録する。同一スクリプトを繰り返し起動します。Windowsがスリープ中は動作しません。

## 自動更新の確認とトラブルシューティング

- 現在のバージョン：固定フォルダの manifest.json にある version。
- 同期状態：%LOCALAPPDATA%\XMediaNavigatorUpdater\state.json
- チェック履歴：%LOCALAPPDATA%\XMediaNavigatorUpdater\updater.log
- 過去版のバックアップ：%LOCALAPPDATA%\XMediaNavigatorUpdater\backups
- 今すぐ新しい版をチェックするには上のPowerShellコマンドを再実行。その後Chrome拡張カードの再読み込み。
- GitHubの認証失効・オフライン・失敗したCI・消失したArtifactの場合は既存版を維持します。
- 新しいコミットでも manifest.json の version を増やしていなければ、Chromeの表示番号は変わりません。

## GitHub側の更新チャンネル

1. 普段の開発はTypeScriptの研究ブランチで実施。自動テストに成功するまでbetaへ載せない。
2. ユーザーに試してほしいコミットのみbetaへ昇格させる。betaのGitHub Actionsが再検証。
3. 全テスト成功時だけ、manifest版番号を使った X-Media-Navigator-v[version]-beta というArtifactsが作成される。
4. PCの定期同期はbetaブランチの成功したpush実行だけを対象にし、PRや失敗したビルドには追従しません。
5. mainは本番安定版として引き続き分離する。実サイトXで未検証のベータをmainへ自動マージしない。

## セキュリティと限界

これは署名済みCRXやChromeウェブストアでの自動配布ではなく、利用者PCによるローカル同期です。管理者権限、拡張のupdate_urlやCookieの抽出を必要としません。GitHubの非公開コードとCIを信頼する設定であるため、更新により意図しない挙動が発生した場合は同期タスクを無効化し、backupsの旧版へ戻してください。

Chromiumの模擬テストは本番Xでの挙動を保証しません。betaとChrome Web Storeの元拡張を同時に有効化しないでください。
