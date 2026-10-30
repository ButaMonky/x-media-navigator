# X Media Navigator — B2 非同期プリフライト競合・64ページ上限

- 作業ID：`XMN-B2-PREFLIGHT-RACE-20261030`
- 専用ブランチ：`task/xmn-b2-preflight-race-20261030`
- 基準主開発SHA：`b951b94d888ff9cfb7d39e025d3c22699f1cd2c6`
- 非公開QA候補：`v2.4.25`（Preflight QA）。
- これまでのB0〜B5、本物のMV3 Worker、B2不変ページ、
  B4先読み、B5履歴とCI必須Chrome 7ケースは保持。
- 公開main、安定Draft PR、通常版v2.4.18と
  旧QA v2.4.20〜v2.4.24は変更しない。

## RED → GREENで確認した新しい問題

1. **同時に右キーを押す場合、FxEmbedの問い合わせが2回走る**。
   元コードは保存済みmanifestの`await loadPageManifest`が終わるまで
   `publicApiLoading`をtrueにしなかった。右矢印や背景ウォームアップが
   同時に待機でき、同じカーソルを二重に取得する。
2. Workerのmanifest読出しが一時失敗した後、
   プリフライトを永久ロックして再試行不能にしてはならない。
3. 64ページ上限をいったん確認した後、別の右キーで
   同じmanifestを再読したり、同意状態の照会・ウォームアップを
   続ける必要はない（新規APIはすでに不許可）。
4. ブラウザの新しい経路が旧世代のWorker照会中に開始した場合、
   旧経路の`finally`が新経路の読み込み予約を消してはならない。
5. 「投稿 2 / 2+」の+は残り取得可能な状態を示すため、
   **保存64ページ到達**を確認後は+を出さず、
   上限到達をツールチップで案内する。X側の投稿が尽きたとは判定しない。
## 実装

- `publicApiPreflightGeneration`をルートの`navGeneration`で管理。
  非同期Worker照会を始める**前**に所有権を確保。
  同一世代の二重取得を拒否し、`finally`では
  自分の世代の予約だけを解除する。
- `resetSession`で旧世代予約を廃棄。
  新しい経路には古いデータ・問い合わせを流用しない。
- 64ページ上限をmanifestから検証した場合、
  `checkpointCapacityReached`を記録し、
  以後のWorker照会、同意確認、ウォームアップ、API取得を停止。
- 画面内に表示されている既存媒体の索引・Xの返信欄、
  確定済み不変ページと`publicApiCursor`は保持。
  `publicApiExhausted`（APIの投稿終端）はtrueにしない。
- UIは「+」を外して上限案内を表示。
  保存済みページへの戻る移動には干渉しない。
- 画像・ログイン情報・Cookie・個人情報の読出しや送信は追加しない。

## テストの根拠と保留

- 独立テスト5件を先に作成。うち同時取得・再読・容量状態など
  **最初の3件はRED**、修正後の5件すべてGREEN。
- 特に2つのリクエストでmanifest読出し2回・API呼出し2回を
  修正前に再現。修正後はそれぞれ1回。
- 同一世代の再入、例外後の再試行、別世代への切替、
  保存64ページの再読抑制、表示投稿番号を検証。
- `npm test`、TypeScript、必須Chromium、
  GitHub Actionsはコミット前／push後に実施し記録する。
- ログイン済み実Xでの画廊・動画/GIF・返信欄・
  通信計測と公開判断は**未完了**。
  実Xに接続できない場合は安全拒否を迂回しない。

## 非公開QAステージング

- 新規フォルダ：
  `%USERPROFILE%\Downloads\X-Media-Navigator-v2.4.25-PREFLIGHT-QA-20261030`
- `tools/stage-b5-private-qa.ps1`は、非公開GitHub同一SHA、
  clean・成功済み必須CI、Node/TypeScript、
  MV3の履歴・保存ページ往復・未認可元拒否の
  すべての検証後のみ、別置きでファイルを出力。
- 既存のQAや公開mainは自動上書きしない。
  `SHA256SUMS`とQA_READMEも生成。

## ローカル総合検証（2026-10-30）

- 追加5テストを含む`npm test`：**361テスト／352 PASS／0 FAIL／3 SKIP／実X TODO6**。
- `npm run typecheck`、生成コードビルド、差分検査PASS。
- Chrome for Testingの合成画廊：**4/4 PASS**。
- 実MV3 Workerを使った隔離Chromeの独立検証：
  通常Worker、440+20件アーカイブ、フル文書の往復、
  履歴ジャンプ、BFCache Back/Forward、API28→29、
  ネイティブ28→29、写真4枚目、同意拒否、
  照合不能なAPIアンカー、未許可オリジン拒否の**11系統PASS**。
- GitHub Actionsでは既存Node、TypeScript、合成Chrome、
  必須Chrome MV3 7ケースと生成JS一致を**省略しない**。
- 上記は一時Chromeプロフィールとlocalhostでの検証であり、
  認証済み実Xでの操作確認を代替しない。
