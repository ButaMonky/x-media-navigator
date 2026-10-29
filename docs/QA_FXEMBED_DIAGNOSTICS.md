# X Media Navigator v2.4.20（非公開QA）：通信と画像表示の診断

対象ソース：`C:\Users\Saito\Documents\x-media-navigator`

## Chromeへの更新方法
1. 最初の1回だけ、`chrome://extensions` で既存のX Media Navigatorを無効化し、`Downloads\X-Media-Navigator-FxEmbed-QA-20261029` を「パッケージ化されていない拡張機能」として読み込む。
2. 次回からはプロジェクト直下の `Update-Chrome-QA.cmd` をダブルクリックする。TypeScript検査・Node/Chromiumテストに成功した場合だけ、QAフォルダをバックアップ後に置き換える。
3. コマンド完了後、開いた `chrome://extensions` で **FxEmbed QA (UNRELEASED)** のカードの「再読み込み（⟳）」を押す。Xのタブも再読み込みする。Chrome上部の「更新」ボタンは非公開GitHubからソースを取得しない。
4. 直接ソースを試す場合は`extension`フォルダをChromeに登録する方法もあるが、通常版と同時に有効にしない。推奨は固定QAフォルダ経由。

通常版固定フォルダ `Downloads\X-Media-Navigator-Current` と公開main、Draft PR #17は変更しない。これは自動常駐監視ではなく、**ダブルクリックしたときにのみ動く安全な更新操作**。

## コンソールの見方
- Xのプロフィールメディア一覧で `F12` →「Console」。
- フィルター欄に `[XMN` を入力する。
- `startup` により、正しい拡張スクリプトがXページ上で起動していることを確認する。
- 全ログは投稿ID・プロフィール名・写真URL・Cursor・Cookie・認証情報を含めず、状態・件数・経過時間・固定された理由ラベルのみを出力する。

## ログの判定

| ログ | 実際に証明していること |
| --- | --- |
| `fxembed.consent_granted` | このタブの公開プロフィール取得に同意した |
| `fxembed.request`, `fxembed.page` | 非公式APIへリクエストし、候補データを受理した。複数ページは `continuation: true` |
| `fxembed.continuation_ready` | 前回までの順番を検証し、新しいメディア参照を索引に追加・保存した |
| `fxembed.warmup` | 一度同意した後、末尾3投稿以内で次ページ取得を事前開始した |
| `fxembed.continuation_abort` | アンカー不一致、API失敗、画面移動、保存失敗、450件上限などで安全に中止した |
| `navigation.document_handoff` | Xの本物のDOMリンクがないため、通常のページ遷移へ切り替えた。**SPAではない** |
| `prefetch.started`, `prefetch.finished` | 先読み開始・読み込み/デコード結果。 `cached:true` は拡張内の短期キャッシュであり、HTTPキャッシュヒット証明ではない |
| `preview.low_thumbnail_decoded` | 既存サムネイルを256px以下のCanvasへ描画した。**まだ画面に表示されたとは限らない** |
| `preview.prepared` | 引継ぎ画像を非表示の状態で準備した。 `quality:'low'` は低画質を選択 |
| `preview.visible` | Xの旧ビューアの移行に合わせて仮画像を画面へ出した。 `quality:'low'` のとき低画質先行表示が実際に行われた |
| `preview.promoted_to_high` | 先読み済み高画質画像へ差し替えた |
| `preview.finished` | 仮画像の解除理由（`native_photo_ready`, `timeout`, `cleanup`）と可視時間 |
| `preview.skipped` | 不足する元サムネイル、未デコード、危険な配置、Reduced Motionなどで安全に省略した |

**重要：低画質先行表示は「X自身の写真一覧内のネイティブリンクを使ったSPA遷移」に対してのみ準備できます。**
APIだけで発見した新投稿へ `location.assign` で移動する場合、旧文書のCanvasは次ページへ引き継げません。この場合 `navigation.document_handoff` が出るのが正しい挙動です。

## 28件以降の確認
1. `pignic_cafe` など公開プロフィールのメディア一覧から写真を開く。
2. 最後の既知投稿で `▶` または右キーを押すと、最初の一度だけFxEmbed（Xとは別サービス）の確認が出る。公開ハンドルと接続元IP等の通信情報がサービスに渡ることを理解した場合のみ許可する。
3. `fxembed.page` と `fxembed.continuation_ready`、次の `navigation.document_handoff` の有無を確認する。
4. 続きを閲覧した後、末尾3投稿以内で `fxembed.warmup` が出れば次ページの事前取得が動いた。明示的同意前には絶対に開始しない。
5. 写真枚数・左へ戻る操作・返信欄・背景スクロール・▶◀位置を確認する。ログだけで正常と断定しない。

## 未解決・制限
- 本番XのReactビューア継続（ページ再読み込みなし）は未実装。第三者APIで取得したURLだけではXのReact SPA内部状態を更新できない。
- 写真と動画の混合メディア投稿は、Xでのリンク番号対応を検証するまで安全側で除外する。
- 第三者APIは応答内容や稼働率を保証できない。1回の連続取得は最大4ページ、索引は最大450項目、認証Cookieは送信しない。
- 今回のログはブラウザ通信キャッシュヒット、速度改善率、画面の滑らかさを直接測定するものではない。Network/Performanceの別検証が必要。
- `AppData\Local\XMediaNavigatorUpdater\state.json` の古いv2.2.2記録は、現在のQA更新の正本ではない。新しい更新手順はプロジェクト直下のスクリプトだけを用いる。
