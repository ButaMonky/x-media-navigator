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

## 2026-10-30 初回GitHub CI失敗と修正

- 初回コミット `ce35705476b010fb95459fea41f0a902e03ed48b`、
  GitHub Actions run **41020382568: FAIL**。Node 333件、
  型検査、必須合成ChromiumはPASS。
- 新しいB5 MV3品質ゲートの最初のケースは
  `mv3Test=waiting`、CDP対象は`background_page`で
  **MV3 Service Workerがロードされなかった**。
- 原因：CIで使用した`google-chrome`は、Chrome 137以降の
  **Chrome brandedビルドでは`--load-extension`が無効化**されている。
  製品側のバグではなくQAブラウザ選択の誤り。
  出典: https://groups.google.com/a/chromium.org/g/chromium-extensions/c/1-g8EFx2BBY/m/my-groups
- 修正：`browser-actions/setup-chrome@v2`で**Chrome for Testing**を
  導入し、返された`chrome-path`を必須MV3検査へ明示的に渡す。
  バイナリがなければFAIL。Windowsの既存CFTも維持。
  Chromium/CfT以外のbranded Chromeへのフォールバックは禁止。
- 本番Chromeへのパラメータ改変やブラウザ安全仕様の迂回ではない。
  公式が拡張機能検査をサポートする非ブランドテストビルドを使用。
- 再開位置：修正コミットでGitHub Actionsを再実行し、
  MV3の4ケースと生成JS一致がすべてSUCCESSしたときだけ
  FF-only主開発統合を許可。失敗結果を無かったことにしない。

## 2026-10-30 二度目のLinux CIと初期ページの取りこぼし

- GitHub run `41021191064`: **FAIL**。
  公式Chrome for Testingビルドの導入は成功。
  初回28→29／4枚投稿／同意拒否は**3/4 PASS**、
  4件目の不正アンカー拒否は`mv3Test=waiting`。
  プローブ結果マーカーが未生成のままで、製品内の
  28→29ロジック不一致と断定はできない。
- 対応：4つの一時Chrome smokeで、起動後にまだ
  `sessionStorage`のB5内部phaseが**未設定**かつ
  失敗マーカー未生成の場合に限り、CDPから**一回だけ**
  同じlocalhost初期文書をReloadして起動競合を回復。
  既に`starting`等に進んだ文書は再読み込みしない。
  これは本番Xの移動・安全拒否を迂回せず、
  実MV3 Workerの同意/保存/拒否を再実行して検査する。
- 成功・失敗JSONに`startupReloaded`を追加して再現性を記録。
  待機上限、4つのPASSアサーション、未許可送信元の拒否は維持。
- Windowsの単独native実Worker smokeを再実行し
  `startupReloaded=false`でPASS。
  Linux再受入は次のGitHub SHA/runを確認するまで未確定。
