# X Media Navigator B0–B3 改修チェックポイント

- 依頼：2026-10-29、R1〜R5の研究を踏まえて順番に可能な限り改修
- 元の研究正本：`docs/research/XMN_RESEARCH_LEDGER.md`（R-001〜R-044）
- 基準コミット：`c73af36aa8dd46b71b8736a7032cab1fa5186e22`
- 専用ブランチ：`task/xmn-b0-b3-20261029`
- 作業ツリー：`C:\Users\Saito\Documents\x-media-navigator-b0-b3`
- 安定main、既存Draft PR #17、`fix/prefetch-startup-v241`、Chromeの固定インストールは不変更。
- Git操作：reset/stash/rebase/amend/force禁止。上流変更時は先に照合。

## 工程

| 工程 | 状態 | 目的 |
| --- | --- | --- |
| B0 | COMPLETE | 現行の回帰基盤と失敗する受入テストの固定 |
| B1 | CODE+SYNTHETIC TEST COMPLETE / LIVE-X PENDING | 同意／セッションを拡張所有の一時状態へ |
| B2 | CORE+REGRESSIONS COMPLETE / WINDOW INTEGRATION PENDING | 投稿群の索引、APIカーソル、長い一覧 |
| B3 | CODE+SYNTHETIC TEST COMPLETE / LIVE-X PENDING | 左右キーの単一状態管理・キャンセル |
| B4–B5 | DEFERRED | 実X未検証の画質/UI最適化、正式公開 |

## B0 証拠

- 独立作業ツリーで `npm ci`、既存 `npm test` 初期状態193件中184成功、失敗0、3スキップ、6実X TODO。
- `tests/b0-contract.test.mjs` にRED受入テスト群を追加。
- `XMN_B0_VERIFY_FIXES=1` であえてREDを確認。既定のCIでは新しい未達受入項目をスキップし、既存の合格テストを誤って失敗扱いにしない。
- 修正を進めた項目からスキップ解除し、実装の検査に移行する。

- B0完了時: npm test 202件・185 PASS・0 FAIL・11 SKIP・6実X TODO、型検査PASS。
pm test 202件・185 PASS/0 FAIL/11 SKIP/6実X TODO、TypeScript型検査成功。
- 受入RED: XMN_B0_VERIFY_FIXES=1 で意図的に失敗。通常CIは未修正項目8件をskipし、後続工程で個別に有効化。

## B1｜拡張所有の同意・セッション（実装済み、実Xは未受入）

- 実装：`src/background.ts`、`src/session.ts`、`tsconfig.background.json`。MV3 Service Workerへ`chrome.runtime.sendMessage`を使用し、`chrome.storage.session`に保存。これはXのページ所有`sessionStorage`から独立。
- 新権限：`storage`のみ。URL・タブ全件を閲覧する`tabs`権限や`host_permissions`は追加しない。既存のX/Twitterマッチだけを維持。Chrome標準`tabs.onRemoved`で当該タブの短期保存を削除。
- Workerが照合：送信元URL/トップフレーム/タブID/プロフィール一致、スキーマ版1、TTL、投稿URLのホスト/所有者/時系列、重複・分断投稿、APIキー・写真CDN形式、最大450参照、保存120,000文字。
- Content Scriptが照合：現在のX投稿URL・世代・プロフィール、復元先の登録済みキー。非同期保存が失敗するとDocument handoffとAPI追加を安全に中止。
- 第三者FxEmbed同意：従来のページ所有ストレージを信頼せず、本人の確認後に当該タブ/公開プロフィール用の許可をWorkerへ保存。保存失敗時はFxEmbedへ接続しない。
- 移行：従来のXページ`xmn-public-media-v1`および当該プロフィールの旧同意フラグを削除するが、その値は新Workerへ取り込まない。**既存ユーザーには再度FxEmbedへの同意を求める。**
- 型検査・Node単体/Chrome互換のEdge合成テスト・Worker拒否/タブ分離の独立テストを実施。実Xの署名済みChromeでの検証は**NOT RUN**。
- B1の公開/Chrome導入は実X受入まで保留。作業ブランチの成果は非公開GitHubに保存する。

- B1チェックポイント：`npm test` 207件（191成功、0失敗、10スキップ、実X TODO 6）、Edge Chromium 4件合格、TypeScript Content/Worker 2ビルドとも型検査合格。
- B0受入テスト`R-001`を有効化して合格。残り7件は未達を明記してRED契約として保持。旧ページストレージの値を信頼するフォールバックは追加していない。
- Chromeの実機でのService Worker起動・セッション継続・追加`storage`権限の受入は**未実行**。既存ブラウザのインストールは変更しない。

## B2｜メディア順序とページングの修正

- R-044: FxEmbed公式`animated_gif`を受理可能な動画系メディアとして正規化（実XのGIFリンクは未検証）。
- R-029: 200応答に`cursor.bottom`が欠落・不正型なら、正常終端と区別して拒否する。
- R-026: 外部APIが前回と同一のカーソルを返すとき、8件以上取得できていても停止。
- R-033: 元の投稿グループを`Set`でまとめる前に、非連続重複や投稿順逆転を検出する。
- R-032: 初回アンカー投稿の未索引写真（photo/2, photo/3など）は、矛盾しない場合に限り同じ投稿の末尾へ補完。
- R-028: 正常終端で新規参照が0件なら`exhausted`へ遷移し、同じAPI終端を繰り返し問い合わせない。
- R-042: Xが最新の投稿を一覧先頭へ追加した場合、既知先頭より新しいと証明できるタイルを先頭へ追加して索引を作り直す。
- R-043: フィルター切替時に先頭8件だけでなく末尾・件数の差も検査する。
- 新しい純粋関数`planMediaWindow()`は最大450メディア参照、写真1〜4枚を分断しない保持範囲を生成。**まだ実際のControllerに組み込まない**。
- B0の受入契約8件はすべて有効化・PASS。全Node 211件中202成功/0失敗/3スキップ/本番X TODO6。実Xの28→29とReactモーダルは未受入。

## B3｜左右キー・通信キャンセル・API負荷の制御

- ユーザーが最終既知投稿で右キーを押したとき、既にバックグラウンドでFxEmbed続きを取得中なら、**1件だけの保留移動意図**を記録する。成功時のみ同じX URL・同じ投稿ID・同じ画像の識別子・同じセッション世代・接続されたビューアを検証して`navigate(1)`を一度だけ実行。
- 左方向のキー・Escape・タブ非表示・セッションリセット・ルート変更で保留を解除する。失敗時は自動移動しない。
- API由来URLへ通常文書遷移を開始したら最大10秒間二重`location.assign()`を抑制。非同期保存のあとで元の画面・ビューア・世代を再検証し、別の操作を踏んだ場合は移動しない。
- タブが非表示になった時・別の画面へ移動した時・セッション破棄時に、取得中のFxEmbed HTTPリクエストを`AbortController`で中止。画像プリフェッチの既存中断と同じ基本原則。
- HTTP 429・5xxでは指数的なクールダウン（上限、`Retry-After`を利用できれば尊重）。CORS・通信エラーにも短いバックオフ。正常取得時は回数をリセット。
- 温めておくためのFxEmbed先行取得では、タイマー予約だけでカーソルを試行済みにせず、実際に起動した際に記録。実行中止・失敗時は同じカーソルを再試行可能にするが、通信クールダウン中は再接続しない。
- JSON応答サイズは従来の`await response.text()`後の判定に加え、ReadableStreamが使えるブラウザでは受信チャンクの累積4,000,000バイト上限を適用し、越えた時点で`reader.cancel()`。stream未対応のテスト/旧ブラウザは従来互換の受信後サイズ検査。
- 受入テストは`tests/b3-navigation.test.mjs`、`tests/b3-network.test.mjs`。保留移動の二重起動防止、ルート変更、逆キーによるキャンセル、429、タブ非表示でのAbort、ストリーム4MB境界とUTF-8分割を検証。
- 開発候補Manifestを`2.4.21 B0-B3 candidate`へ更新。**Chromeに導入済みのQAは2.4.20、通常版は2.4.18のまま**。新候補は`task/xmn-b0-b3-20261029`のみに存在し、インストールや公開はしていない。
- この段階は単体・合成ブラウザでの検証完了のみ。署名済み本番Xでの通信レース、動画/混合/GIFの操作、Chrome拡張Service Workerの起動/再起動、右の返信欄の見た目・体感速度は**未検証**。

## B3最終検証と今回の終了条件

- 独立改修ブランチの候補版：`2.4.21-dev.1`、manifest `2.4.21 B0-B3 candidate`。
- 最終`npm test`：**219件、210 PASS、0 FAIL、3 SKIP、6 LIVE-X TODO**。B0のRED受入8項目はすべて有効化してPASS。
- 最終Chromium合成試験：**4 PASS、0 FAIL**。独立Network/ナビゲーション6件も含め全Nodeテストで検証。
- `npm run typecheck`：Content ScriptとService WorkerともPASS。`node --check`：配布JS2本ともPASS。`git diff --check`：PASS。
- 本番Xの認証済みギャラリー、実DOMの返答パネル、先読み画像のCPU/メモリ・HTTPキャッシュ、Chromeでの実際のService Worker再起動は未検証。これらの未検証箇所をPASSと扱わない。
- **後続の実装候補**：B2の450メディア参照`planMediaWindow`を`Controller`へ統合するには、Xの仮想化、ページ戻り、別タブ/複数プロフィール、APIカーソルのページ間復元を同時に保証する必要がある。研究済みの純粋関数までを保存し、現行ギャラリーの索引を破棄する変更は未実行。
- **改修は非公開GitHubの`task/xmn-b0-b3-20261029`だけに保存**。通常版2.4.18・QA固定インストール版2.4.20・公開main・安定開発ブランチ・Draft PR #17は変更しない。
- 今後のChrome実機受入では、通常版と候補版を同時に有効化せず、正当なユーザーがサインインしたX画面で28→29件目、左右・写真1〜4枚、動画/GIF、返信欄、API権限と同意動作、非表示・キャンセル・画像プリフェッチを確認する。

## 続行チェックポイント｜MV3ブラウザ検証・B3追加保護・B4計測正確性

- **実Chromium・B1正当な通信**：別の検証ブランチ`58bb9b2`で確立した`tools/mv3-worker-smoke.mjs`を、内容ハッシュを確認してこの候補へ取り込んだ。Chrome for Testing 156による再試験では、製品Content Scriptと実MV3 Workerの通信、ページ所有`sessionStorage`の偽同意無視、拡張専用同意、正しいセッション保存、不正順序の拒否、別HTTP文書への移動後の復元、元の返信欄の維持、投稿コントロールをすべて確認。
- **実Chromium・B1送信元拒否**：`tools/b1-worker-cdp-probe.mjs`では**実際の製品Workerを無改変で読み込み**、独立Edge Chromiumのlocalhost拡張からメッセージ送信。Workerは外部元を`{ok:false}`として拒否。実MV3 Worker対象の起動とContent Script送信をCDPの実時間で確認。
- いずれも使い捨ての拡張・プロファイル・localhostのみ。**X本番・認証情報・Cookie・HAR・通常Chromeのプロファイルには接触していない**。テスト後は起動したブラウザだけを終了。
- 最初の`--virtual-time-budget --dump-dom`によるネガティブ試行は`waiting`で終了し判定不能だったため、CDPでWorkerの非同期応答を実時間観測する試験へ切り替えた。**最初の判定不能を製品の失敗と数えない**。
- B3追加：不正な公開API JSON・4MB超応答・前進しないカーソル・非連続投稿群・アンカー不一致・フィルター不一致についても短い指数バックオフを適用。先行取得は再試行禁止時刻より前にスケジュールしない。正常応答時に失敗回数を解消。
- B3の新規回帰テスト：`tests/b3-network.test.mjs`に不正JSONと同値カーソルの再通信防止を追加。既存429と異常受信のテストは維持。
- B4で安全に修正可能な**計測の順序のみ**修正：`preview.visible`のログは`classList.add('xmn-handoff-visible')`が成功してから発行。失敗時は`preview.skipped reveal_failed`を出してオーバーレイを破棄する。`tests/b4-reveal-diagnostics.test.mjs`で成功/失敗を検証。
- `preview.visible`は**DOMクラス付与の成功**であって、GPU画面描画の確証ではない。B4の本番Xの画質・速度改善・UI変更は依然保留。
- 再現コマンド：`npm run test:mv3`（Chrome for Testing）／`npm run test:mv3:reject`（Edge ChromiumまたはCHROMIUM_PATH指定）。試験は製品コードの公開や既存Chromeインストールを一切必要としない。

## 続行検証｜2026-10-29、B1/B3強化およびB4診断の修正

- 再開元：`ffa54907a34d153717a271e68933b63540dfc4fe`、独立タスクブランチ`task/xmn-b0-b3-20261029`。
- B1の実MV3起動・正当な通信について、他の検証ブランチの**既に検査済みのスクリプト**（出典`58bb9b2`）をハッシュ照合して採用。Chrome for TestingにてContent Scriptの起動、同意・セッションの拡張所有保存、別文書後の復元、旧ページ偽同意の無視、返信欄と戻る矢印維持を確認。
- 追加の`tools/b1-worker-cdp-probe.mjs`は**無改変の製品Worker**をlocalhostへロードし、許可外送信元を拒否する結果を実MV3＋CDPで確認。`--dump-dom`の仮想時刻でWorker応答を観測できなかった初回試行は**INCONCLUSIVE**であり、後から実時間CDP試験に切り替えて成功。
- 成功した2種類の独立ブラウザテストは`npm run test:mv3`、`npm run test:mv3:reject`から再実施可能。ブラウザは各自の一時プロフィールだけを起動し、終了時に対象プロセス・一時ディレクトリを削除。X本番にはアクセスしていない。
- B3追加修正：HTTP 429/5xx以外にも**不正なJSONスキーマ、サイズ超過、同値カーソル、非連続投稿、アンカー/タイムライン不一致**を短時間のクールダウン対象にする。不要なVolunteer APIリクエストを抑えるが、正当な応答まで無期限停止させない。新規回帰テスト2件で確認。
- B4の安全な計測修正：`showVisualHandoff()`が`preview.visible`を**DOM表示クラス適用成功後**に記録。DOM追加の例外時には誤った可視ログを出さず、オーバーレイを破棄する。回帰テスト2件追加。**実画面のPaint成功や高速化率はこのログでは証明できない**。

### このチェックポイントの試験結果

- `npm test`：**223件、214 PASS、0 FAIL、3 SKIP、実X TODO 6**。
- `npm run typecheck`：Content Script/Service WorkerともにPASS。
- `XMN_RUN_CHROMIUM=1 npm run test:browser`：**4 PASS、0 FAIL**。
- `npm run test:mv3`：Chrome for Testing 156／WorkerとContent Scriptの正当な通信・移動後の復元／**PASS**。
- `npm run test:mv3:reject`：独立Edge Chromium／実Workerの無許可送信元拒否／**PASS**。
- `git diff --check`・ビルド生成JSの整合性・配布版Manifestの検査を再確認してからコミットする。
- 一時の調査コマンドでPowerShell`Select -Object`の入力ミスが発生したが、研究対象のファイル変更なしで修正し再実行済み。旧`--dump-dom` Worker検証の未確定結果も本節へ記録した。

### 継続・判断待ち

- **B2残：450参照の実閲覧ウィンドウ適用**。`planMediaWindow()`は独立テスト済みだが、現在閲覧している投稿群を破棄せず、カーソル/戻る/フィルター切替を守る実接続はまだ未実装。別の作業ツリー`task/xmn-b2-window-model-20261029`では独立モジュールを研究中のため、同じファイルを競合編集しない。
- **B4残：実描画・実HTTP通信の測定**。Canvas描画の1フレーム、画像デコード、CPUメモリ、Xの`large/orig`転送などを実Xで測る必要がある。今回の診断修正を「画面が高速になった」と言い換えない。
- **B5残：本番Xの受入・公開判断**。認証済みXの28→29件目、写真1〜4枚、動画・GIF・混合、返信欄、Chromeの権限ダイアログ、先読みUIを人が確認するまでは公開main・安定版・Chrome固定QAの更新禁止。
- 開発候補は`2.4.21-dev.1`。通常版v2.4.18、インストール済みQA v2.4.20は変更しない。
- 次の再開位置：このファイル・研究台帳・専用タスクブランチの最新Git SHAを照合してから、B2ウィンドウ担当の成果を受入条件に照らしてレビュー。実Xでまだ確認不能なUI改造は保留する。

### 継続して改善した品質ゲート（R-021）

- GitHub Actionsの旧設定では、Chrome/Chromiumが見つからなくても`echo`だけでCIを成功終了できた。今回`check.yml`を更新し、**Chromium合成ブラウザ試験を必須**に変更。ランナーでブラウザが見つからなければ`::error::`と`exit 1`で明示的にFAILとする。
- GitHubのUbuntu 24.04ランナーイメージにはGoogle Chrome/Chromiumが通常含まれるが、イメージが変わった場合は**無検証成功よりも明示的失敗**を優先する。根拠：https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md
- `tests/ci-required-browser.test.mjs`で無検証スキップを再導入できないように契約を固定。CIが実際にGitHub上で成功したかはpush後に確認し、ローカル成功と区別する。
- Chrome for TestingによるWorker+Content Scriptの実起動テストはローカル独立受入。現時点ではGitHub CIの必須ジョブには追加しない（通常Google ChromeのCLIによるMV3拡張読み込みには版依存があり、Chrome for Testingの専用インストール方法をさらに設計する必要がある）。

- CI品質ゲート追加後のローカル全体検査：`npm test` 224件中**215 PASS・0 FAIL・3 SKIP・実X TODO 6**、Content/Worker型検査PASS。Chromium合成4件・Chrome for Testing MV3正当経路・Edge MV3拒否経路は同じ候補版で別途PASS済み。

### CI必須ブラウザ試験の初回障害と改善

- 2026-10-29のGitHub Actionsコミット`8d6c8ec`、run `40825339338`：**CI失敗**。Nodeテストと型検査は成功したが、必須合成ブラウザの最長シナリオで`data-xmn-results`の完了マーカーが現れず失敗。これは`browser test skipped`ではなく、実行したChromiumがシナリオを最後まで完了できなかった記録。
- 試験ソースの明示的`await wait(...)`は合計約28,070ms。以前の`--virtual-time-budget=33000`ではGitHub Linuxランナー上のタイマー/描画タスクに十分な余裕がない可能性がある。**根本原因の確定ではなく仮説**として扱う。
- 対応：`tests/browser.test.mjs`の仮想時間予算を65,000msへ増やし、`tests/ci-required-browser.test.mjs`で明示的待機時間に20秒以上の余裕があることを契約化。CIの必須ブラウザゲートや検証項目は削除しない。
- Windows Chrome for Testing 156とEdge Chromiumの両方で、変更後の4ブラウザケースは**それぞれ4/4 PASS**。ローカルNode全テストは**225件・216 PASS・0 FAIL・3 SKIP・実X TODO 6**。これらはLinux CI上の成功の代替ではなく、push後に改めてCIを検証する。
- 障害記録はこのファイルを正本に保持。再発時はGitHub run `40825339338`と比較し、`--dump-dom`の固定仮想時間方式からCDPによる実際の完了マーカー待ちへ移行する方針。
