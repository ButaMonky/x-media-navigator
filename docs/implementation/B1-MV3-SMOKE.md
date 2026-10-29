# B1 実Chromium MV3 Service Workerの独立検証

- 目的：B1の`chrome.storage.session`保存、第三者APIの同意、ページ遷移後の復元を**本物のChromium MV3拡張実行環境**で検証する。
- 検証ベース：`047186c47d041ca74646255d09c5e88663c3eb53`（B1完了コミット）
- コマンド：プロジェクト直下で`node tools/mv3-worker-smoke.mjs`
- Node.js：内蔵WebSocketが利用できるNode 22以上を推奨。
- 推奨ブラウザ：**Chrome for Testing**。通常のGoogle Chrome 137以降やMicrosoft Edgeの`--load-extension`フラグは無効化されている。
- 環境変数：`XMN_CHROME_FOR_TESTING`でブラウザのexeを指定可能。Windowsでは`%LOCALAPPDATA%\XMediaNavigator\QA-Browser\chrome`にある最新バージョンも自動検索。
- 取得方法：`npx --yes @puppeteer/browsers install chrome@stable --path "$env:LOCALAPPDATA\XMediaNavigator\QA-Browser"`（Windows PowerShell）。
- 2026-10-29にChrome for Testing 156.0.8078.73で検証成功。通常Chrome/EdgeのCLIで最初の試行が失敗したため、対応ブラウザで再試験した。

## 安全なテスト方式

- localhostの公開範囲`http://127.0.0.1`だけで動作。実XへのアクセスやCookie/トークン/HAR取得を行わない。
- コンパイル済みService Workerを一時ディレクトリへコピーし、**コピー上の送信元チェックだけ**をテスト用localhostへ差し替える。製品のWorker・Manifest・Chromeインストール先を変更しない。
- 使い捨てChromeプロフィール、動的DevToolsポート、独立したMV3拡張、独立したページで実行し、終了時に**起動したChromiumプロセスのみ**を終了、テスト拡張と一時プロフィールを削除する。
- ページ側の`sessionStorage`に偽の同意値`yes`を用意しても、Worker側の`consent.get`は未同意を返す。Workerへ本人同意を保存して初めて同意済みになる。
- 正しい2投稿の一時セッションを保存し、時系列を反転した不正なセッションは拒否する。その後**別のHTTP文書へ移動**し、タブ内の短期セッションと同意状態が復元されることを確認する。

## 限界と完了条件

- このテストは「Workerの実起動・Chromeメッセージ・短期ストレージ・複数文書間の維持」を証明する。XのReact DOM、写真・動画メディアの実表示、Chromeへ普段入れている拡張の更新成功までは証明しない。
- Chrome本番UIでのロードと実際の28→29件目、GIF・写真位置、返信欄を含む受入テストは`NOT RUN`。
- 既存main、Draft PR #17、通常インストールv2.4.18、非公開QA固定フォルダv2.4.20には適用しない。成果は検証専用ブランチにのみ保存。
