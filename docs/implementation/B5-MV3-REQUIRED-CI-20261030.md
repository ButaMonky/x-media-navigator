# X Media Navigator — B5 実MV3ブラウザ検査を必須CI化

- 作業ID: `XMN-B5-CHROME-MV3-CI-20261030`
- 作業ブランチ: `task/xmn-b5-ci-mv3-20261030`
- 基準正本: `2e8587fa9c6b12b84c9a0918d4c2950b70a41b55`
- これまでのB0–B5修正、v2.4.22候補、Chrome QA配布先、
  stable v2.4.18、公開main・Draft PR #17は変更しない。
- 実ログイン済みXへアクセスしない。認証情報・Cookie・HARを保存しない。

## 変更点

- これまではNode＋TypeScript＋合成ChromiumのみがGitHub CIで必須。
  **Chrome MV3 Service Workerの4つのB5シナリオはWindows上の
  独立実行だけ**だったため、将来の回帰を見落とす可能性が残った。
- `.github/workflows/check.yml`の通常品質ゲートの後に、実Chrome MV3
  必須ジョブを追加。Chromiumが存在しない場合は明確にFAIL。
  既存の合成40シナリオと生成JSハッシュ検査は削除・スキップしない。
- Windows/Linux両対応にするため4つのMV3 smokeで
  `XMN_CHROME_FOR_TESTING`または`CHROMIUM_PATH`を検出し、
  Linuxの隔離Chromiumプロセスグループを終了可能にした。
  各試験は新規一時ディレクトリ＋専用プロファイルを維持。
- Linux側のCDPプロセス起動に最大約44秒、対象タブ発見に約25秒、
  WebSocket・CDP各コマンドには個別12秒の期限を設ける。
  **失敗の無視・検証成功の偽装・外部サイトへの迂回はしない。**
## 4本の必須シナリオ

1. `npm run test:mv3:native` — ネイティブの28件目、
   初回ArrowRightによる29件目、1回の公開API取得、
   返信欄保持と戻りを本物のMV3 Workerで検証。
2. `npm run test:mv3:fourphoto` — 28投稿目の4枚目から
   次投稿へ1回で移動。32媒体保持、返信欄と戻りを検証。
3. `npm run test:mv3:deny` — 第三者APIの同意拒否で
   通信回数0、Workerセッション空、元のX相当画面を保持。
4. `npm run test:mv3:unverified` — APIのアンカー不一致で
   架空の次投稿へ移動せず、既知28件を維持。

## 試験と制限

- Windowsの実Chrome for Testingの使い捨てlocalhostで4シナリオ
  **すべてPASS**。B5のネットワーク／認証／UI受入を兼ねない。
- `tests/ci-b5-required.test.mjs`を追加。必須CIの4シナリオ・
  スクリプト呼出・隔離プロファイル・CDP時間制限を
  静的検証。2 PASS。
- Linux GitHub Actionsの実Chromeはこのコミットがpushされた後に
  **RUN SHAと結び付けて検証**し、合格前に主開発へ統合しない。
  初回実行失敗・安全拒否の場合はログ・SHA・再開点を追記。
- 実Xの28→29、動画/GIF/混合、Paint品質、HTTP転送、
  対話UIと公開は引き続き未受入。
