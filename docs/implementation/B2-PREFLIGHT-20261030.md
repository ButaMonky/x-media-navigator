# X Media Navigator — B2 アーカイブ境界の連続キー競合修正と最終QA

- 作業ID：`XMN-B2-PREFLIGHT-GENERATION-20261030`
- 非公開独立ブランチ：`task/xmn-b2-preflight-20261030`
- 基準主開発：`b951b94d888ff9cfb7d39e025d3c22699f1cd2c6`
- 新版：`2.4.25-dev.1`、Chrome MV3 `2.4.25`（Private Preflight QA）。
- 既存v2.4.24（履歴・BFCache）、Provider Integrity（4MB）、
  B4省データ・オフライン、B5の同意・28→29をすべて維持。
- 通常v2.4.18と旧QA v2.4.20〜2.4.24、公開main、
  安定Draft PR #17、ログイン済みChromeを変更しない。

## 発見・修正した競合

1. 既存の`loadPublicMediaContinuation()`は、不変Manifestを非同期で
   Workerに照会する間に`publicApiLoading`がfalseのまま。
   ユーザーがすばやく2回右矢印を押すと、**Manifest取得が重複**し、
   継続可能な場合にFxEmbedへの通信も重複しうる。
2. `publicApiPreflightGeneration`を導入し、Worker照合前に
   `navGeneration`単位で所有権を確保。同じ経路の第2要求は
   実通信する前に停止。既存の`publicApiLoading`とは別段階のロック。
3. `finally`で解除するのは**自分の世代番号の要求だけ**。
   古いURLからの遅延応答が新しいURLの照合ロックを消さない。
   Workerの一時失敗ではロックを確実に開放し、再試行できる。
4. 事前の公開APIウォームアップと右矢印もpreflightを尊重。
   再接続や端末バックグラウンドから連続通信を再開しない。
   保存済み次ページ・最大64ページ到達は既存Workerの信頼済み
   Manifestを確認し、過剰な第三者APIアクセスを行わない。
5. 64ページの上限到達時は「続きを取得できる」という旧表示の
   **プラス記号を消して**、正しい上限案内とXでの手動継続方法を
   ステータスのツールチップに表示。結果キャッシュも更新する。
   X純正が表示する画像や返信欄には介入しない。

## RED→GREEN試験

- 同時に右矢印2回→同じWorker Manifestを1回だけ照合。
- 実際に拡張可能な最後の保存済みページで、
  同時2要求から第三者公開APIの問い合わせを1回に制限。
- Worker保存エラーのあと再試行可能で、外部APIは使わない。
- URLを切り替えてから古い非同期照合が終了しても、
  **新しい世代の所有権を消さない**。
- 64ページ上限の表示が1回だけ更新され、
  無変更ポーリングでは長大索引を再走査しない。
- QA配布は`v2.4.25`専用フォルダ・SHA同一・
  旧通常版およびv2.4.20〜v2.4.24保護・GitHub CI必須。
- Node **364件：355 PASS、0 FAIL、3 SKIP、
  実Xでしか確認できないTODO6**。TypeScript型検査PASS。
- 実ChromeでのB2・B5・BFCache・origin拒否試験の結果と
  GitHub Actions実行IDはCI検証後に追加記録する。

## 正式公開前のBLOCKED

- 2026-10-30、公開X Mediaページを読み取り専用の独立ブラウザで
  確認したところ、**ログイン画面へ転送**され、
  実際の画像グリッド・写真モーダル・矢印は閲覧できなかった。
  ログイン情報の取得・入力・安全制限の迂回はしていない。
- iOS ChatGPTからWindows接続ブラウザを直接利用しようとした
  操作も、`originating browser context`が必要として拒否された。
- 実Xにログイン済みの媒体一覧で28→29、写真1〜4、
  GIF/動画/混合、返信DOM、native SPA・450件超・
  Paint/CPU/RAM/転送を検証できるまでは**100％または公開完了と記録しない**。
- ChromeでChatGPTを開いて接続ブラウザのコンテキストを有効にするか、
  ユーザーが独立QAを手動でLoad unpackedして受入を実施する。
  未受入のまま公開mainや通常版を上書きしない。

## 追加：右矢印連打で同意確認が二重に出る問題

- 元コードでは外部サービスへの同意状態をWorkerから非同期で
  確認中、同じ投稿からの次の右矢印も`hasConsent`を呼んでいた。
  拒否時は**同じ確認ダイアログが2回表示される**ことをREDで確認。
- `publicConsentPendingGeneration`で同一経路の同意処理を1件に限定。
  ダイアログ中やWorker確認中の重複キーは中止し、
  次の投稿位置やネイティブ画像・返信欄は変更しない。
- `finally`でロックを解放する際にも世代番号を照合。
  新しいページの処理を古いページの応答が妨害しない。
- ユーザーが拒否すれば引き続き第三者API通信は**0件**。
  二重同意0件のRED→GREEN試験を追加し、全Node364件でPASS。
