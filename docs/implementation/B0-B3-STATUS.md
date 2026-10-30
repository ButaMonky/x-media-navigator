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
| B2 | VALIDATED PREFETCH WINDOW CONNECTED / CHECKPOINT PAGING PENDING | 投稿群の索引、APIカーソル、長い一覧 |
| B3 | CODE+SYNTHETIC TEST COMPLETE / LIVE-X PENDING | 左右キーの単一状態管理・キャンセル |
| B4 | PARTIAL / LIVE-X PERFORMANCE PENDING | キャッシュ・探索・デコード前の安全条件を改善。実Xでの画質・速度計測は未完了 |
| B5 | DEFERRED | 実Xの受入試験と正式公開 |

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

### GitHub Actionsでの最終受入

- コミット`d949137e49a0aca6b98f271b697c411fb6b60bce`、GitHub Actions run **40826087029**：`TypeScript check`が**success**で完了（`gh run watch --exit-status`の終了コード0を確認）。
- 旧失敗run **40825339338** の再発防止を目的に、`--virtual-time-budget=65000`と20秒以上の待機余裕チェックを導入した。今回のLinux CIは合格したが、CI環境ごとのゆらぎを永続的にゼロと保証するものではない。
- この実行によって**必須ブラウザ検証をスキップせずCI成功**したことを確認。Chrome for TestingによるMV3実通信、許可外送信元拒否、全NodeテストはWindowsローカルの独立合格として別に保持する。
- 最終ソース保存後の再開位置：B2ウィンドウ担当の独立成果を確認してから、ギャラリーへ統合する安全条件と本番X受入のゲートを設計する。公開main・安定ブランチ・既存Chromeの更新は依然保留。

---

## B2・B4 追加改善｜画像URLキャッシュ・XのDOM探索（2026-10-29）

- 対応元：累積研究台帳`R-012`（毎回のDOM全探索）、`R-014`（FxEmbed経由のURLだけ上限なし）、B2の非同期セッション競合・保存失敗時の不変条件。
- **R-014：同一の上限管理**：X DOMサムネイル、FxEmbed、復元セッションのいずれも`rememberImageSource()`へ統一。最大128件・更新時リビジョン・重複URL非更新・古いURLの退避を同じ規則とする。公開写真URLを別ホストへ変更しない。175件の外部API画像投入を合成すると128件で維持（以前は175件）。
- **R-014：トランザクションの完全性**：API続きを追加後、拡張専用保存が失敗して巻き戻す際は、以前に存在した画像URLキャッシュ128件とリビジョンを復元する。新しい大量画像が古い画像を追い出しても、失敗したページ追加でキャッシュを失わない。
- **B2：保存中の画面切替**：非同期`persistPublicMediaSession()`完了時に世代・プロフィール・ルートが変わっていたら、**現在の別セッションを巻き戻さず終了**する。新旧プロフィールの索引・カーソルが交差しないことを独立合成テストで検証。
- **R-012：検証済みDOMリンク索引**：`scanTiles()`でX由来の有効なリンクを最大1024件だけ一時保持。閲覧時にキャッシュ済みリンクが接続中・現グリッド内・同じメディアキーの所有者であれば、全タイル走査を省略する。Reactが要素やhrefを変更した場合はキャッシュを破棄し、既存のX DOM全探索にフォールバックする。
- DOMの一時キャッシュは永続化しない。`resetSession()`で破棄し、Xのプロフィールやフィルターをまたいで古いDOMノードを再利用しない。
- `tests/b4-image-source-cache.test.mjs`：175枚投入・128件保持、同値URL、拒否された外部画像、保存失敗時の復元、別プロフィールへの非同期切替。 `tests/b4-live-link-cache.test.mjs`：2,500タイルの合成DOMで200回の探索が全走査0回、削除・別領域移動・href変更・1024件上限、実際の`scanTiles()`からのキャッシュ登録。
- **注意**：合成DOMでの走査回数改善は、実XのReact処理・CPU・通信速度を測定したものではない。現実のスライドと返信欄の動作を検証するまで、体感高速化率は報告しない。
- B2の`planMediaWindow()`自体は純粋関数の受入済みだが、**全投稿のメモリウィンドウ退避・カーソル再開までを製品に統合したわけではない**。別作業ツリー`task/xmn-b2-window-model-20261029`にある独立モデルは未コミットのため、所有権を尊重して今回変更・上書きしない。

### B2・B4キャッシュ改善の受入（同日）

- `npm test`：**234件、225 PASS、0 FAIL、3 SKIP、6 LIVE-X TODO**。
- `npm run typecheck`：Content Script＋MV3 WorkerともPASS。
- `npm run test:browser`：独立Edge Chromiumで4 PASS、0 FAIL。
- `npm run test:mv3`：Chrome for Testingでセッション・同意・別文書復元・返信欄保持の合成確認PASS。
- `npm run test:mv3:reject`：独立Edge Chromiumで、製品Workerの拒否対象を実際に拒否できることを確認しPASS。
- 退行防止：`tests/b4-image-source-cache.test.mjs`と`tests/b4-live-link-cache.test.mjs`の合計9件で、キャッシュ境界・URL更新・失効DOM・保存失敗時の巻き戻し・非同期セッション切替を確認。
- **残る課題**：実Xでの体感速度は未測定。単一巨大画像のデコード開始前にメモリ上限を保証する問題（R-040）は未修正。B2の保持範囲モデルを本体の長い索引へ接続する問題（R-006）も別担当の未コミット成果との競合を避け、今回保留した。

### 生成物一致CIの失敗と復旧（2026-10-29）

- 追加改善コミット`e5bdff4d2cb31bd1ee1f51da3385447457bd77f1`、GitHub Actions run **40841499514** は**FAIL**。Nodeテスト・型検査・必須Chromium合成テストはPASSしたが、最後の`git diff --exit-code -- extension/content_script.js extension/background.js`で失敗。
- GitHubの実ログを精査したところ、差分は`Controller`の説明コメント**1行のみ**。TypeScriptの説明は新しい内容なのに、生成済み`extension/content_script.js`に古いコメントが残っていた。Windows/Linux固有の改行差ではなく、正本とコンパイル済み生成物の同期漏れ。
- `npm run build`を再実行し、生成JSへの差分が**コメント1行のみ**であること、`git diff --check`に問題がないことを確認。**既存テストを緩和せず**生成JSを正本と一致させ、再push後にGitHub CIを確認する。
- 再開位置：今回の生成物同期コミットと最新CIが完了後、B2ウィンドウ別担当の独立成果・未コミット状態を再確認する。公開版／通常QAへの反映は引き続き保留。

---

## B4追加｜巨大画像の明示的デコード前のサイズ検査（R-040）

- 改修前：`drainPrefetchQueue()`が`image.src`を設定した直後に`image.decode()`を開始し、完了後に`naturalWidth × naturalHeight × 4`と80MiB上限を比較していた。画像サイズが著しく大きい場合に、明示的デコードを開始する前の制限が存在しなかった。
- 改修後：画像の幅・高さが判明していれば`decode()`実行前に推定デコード容量を検査し、上限超過なら`prefetchTooLarge`として除外し、`img`の`src`属性を取り除いてリソース解放を要求する。幅・高さが未確定の場合は`load`イベントの後に判定し、許可された画像だけに`decode()`を明示的に呼び出す。
- 大きすぎて除外した画像は`record.ready=false`となり、既存のCanvas引継ぎ／高画質画像への昇格へ誤使用しない。正常サイズの画像は既存の2並列・5先読み・80MiBの予算を維持。
- テスト`tests/b4-prefetch-budget.test.mjs`：10,000×10,000画素（概算400MB）の合成画像は明示的デコード呼出し**0回**、除外・src解放・転送スロット解放を確認。遅れて寸法が確定する1,200×900画素の合成画像は`onload`後にデコードを開始し成功。
- 既存テストの軽量モック1件は`naturalWidth`のみで高さが欠落していたため、現実の正常に読み込まれた画像と同様に`naturalHeight=600`を追加。製品側の安全条件を緩める修正はしていない。
- **限界**：ブラウザは画像ロード中に内部でデコードすることがあるため、`img.onload`前の実RAM使用ピークを80MiB以下に保証するわけではない。今回は**拡張が行う明示的な巨大画像デコードを防ぐ修正**であり、実X/実RAMの測定は未実施。
- テスト：`npm test` 236件中**227 PASS、0 FAIL、3 SKIP、6 LIVE-X TODO**。`npm run typecheck`PASS、Edge Chromium合成4件PASS・0 FAIL。公開版とインストール済み拡張は変更していない。

### R-040 最終保存・CI結果（2026-10-29）

- 実装コミット`681335d0f99800326555cac382e5f3abe058942e`は非公開`task/xmn-b0-b3-20261029`へpush済み。
- GitHub Actions run **40842718630** は`success`。Nodeテスト、TypeScript型検査、必須Chromium試験、生成済みJSの正本一致がすべて合格。
- 現時点の開発候補：`v2.4.21`。公開main、安定開発版、既存Draft PR #17、通常インストールv2.4.18、固定QA v2.4.20には未反映。実Xの画面描画・体感速度・大きな画像の自動デコードRAM実測は未検証。
- 独立B2ウィンドウ作業ツリーは未コミットのため、そのファイルに触れず、次回は別担当が保存・テストを完了した証拠を照合してからController接続を検討する。
- 補助ツールの失敗記録（作業ID`XMN-B4-20261029-DOC-CHECK`）：文書の重複行整理を試みた際、Desktop Commanderの`edit_block`がローカル依存パッケージ`fastest-levenshtein`欠落でエラーとなり、当該操作は未実行。その後、読み取り専用PowerShellで該当B0行が1件であることを確認。製品コードや研究資料への影響はなく、再実行が必要な作業もなし。

---

## R-024修正・B2独立モデルの保全（2026-10-29）

- 別作業ツリー`task/xmn-b2-window-model-20261029`で6,000投稿・150件の先頭追加・2500回のウィンドウ選択等の独立テスト10件とTypeScript型検査がPASS。既存の未コミット4ファイルだけを厳密に指定し、**B2独立モデルの正本をコミット`083f3b9b2c40597e1f97f04df2db0abc058cfaf7`として非公開GitHubへ保存**。未コミット成果は消失せず、元ブランチ/作業ツリーは独立したまま。
- R-024：同じURLのReact画像スライドが`opacity:0`で残ると、`activeViewerForRoute()`のキャッシュが透明な旧スライドを返す経路を修正。CSSのdisplay/visibility/opacityを共通の`viewerStyleVisible()`で検査し、非表示のときは通常の`findActiveViewer()`で再選択。
- 最初の合成Chromium検証では、テストがControllerメソッドを型なしのオブジェクトへ直接呼び出すため新しい`this.viewerStyleVisible()`の参照に失敗。これは実Xの不具合ではなく、既存合成テストの契約上の相違。CSS判定を独立関数へ移して解決し、**Chromium合成4件PASS**とR-024専用テストPASSを確認。
- R-024の修正は、実XのReactで同じ透明スライド状態が発生したことを意味しない。操作時のDOM所有権の安全側対処として記録する。
- B2モデルについては、FF-only統合規則を維持し、別ブランチを非FFのGit mergeで取り込まない。**新たな前進専用ブランチを現在の開発正本から作り、モデルの採用を独立テストで検証する**。旧版のインストール・公開は許可していない。

---

## B2 Window runtime integration｜2026-10-29

- Starting point: `task/xmn-b0-b3-20261029` commit `9ece4e873c4abc90df14623c2bdc5083cce5ec47`; integration-only branch `task/xmn-b2-window-integration-20261029`, separate worktree. Source model from `task/xmn-b2-window-model-20261029` commit `083f3b9b2c40597e1f97f04df2db0abc058cfaf7`. Four files copied only after exact Git blob comparison (source module, stand-alone model TypeScript config, model tests, model report). No reset/stash/rebase/amend/force and no non-FF merge.
- TypeScript production content bundle now includes `src/media-window.ts` in `tsconfig.json`. The model explicitly stores source/provenance and completeness of groups; it never calls FxEmbed or invents media URLs.
- `Controller.verifiedPostWindow()` keeps a cache of validated whole-post groups around the currently viewed post. If `refs.length > 450`, `preloadAdjacentImages()` allows prefetch only for URLs belonging to this validated 450-reference neighbourhood. For 450 or fewer references, preserve the previous prefetch path without constructing a second model.
- On first use, compute `planMediaWindow()` of up to 450 references from the full timeline, and validate only that selected neighbourhood with `ValidatedMediaWindowIndex`; this avoids validating/double-copying all 15,000 references at every initial prefetch. Reuse the validated neighbourhood for nearby arrows and rebuild after leaving its range or changing profile, length, head/tail or underlying array.
- If the timeline contains noncontiguous duplicate posts or the selected neighbourhood is inconsistent, abstain from speculative CDN prefetch. Preserve the actual X viewer and native navigation; do not silently reorder or discard earlier posts.
- **Limit**: this first integration is safe *windowed prefetch*, not full eviction/restore of the browsing timeline. `Controller.refs` still holds all previously indexed references in memory; the FxEmbed 450-reference accumulation/storage limit is unchanged. Full forward/backward checkpoint paging requires page store, cursor ownership, versioned restore and verified real X navigation.
- Synthetic Node model: 6,000 posts (15,000 media refs), 150 new-head posts, 2,500 selection iterations. Production connection tests: cache reuse, crossing window boundary, native head insertion, bad/noncontiguous groups, prefetch isolation and short timeline compatibility.
- Integration tests: `npm test` **254 cases: 245 PASS, 0 FAIL, 3 SKIP, 6 real-X TODO**; Edge Chromium synthetic 4 PASS, 0 FAIL; `npm run typecheck` PASS; Chrome for Testing MV3 consent/session/response PASS; Edge MV3 real-worker denied origin PASS. These are private/isolated tests, not X production acceptance.
- Incidental repair: on the Windows integration worktree, `.github/workflows/check.yml` carries CRLF line endings. The existing CI contract erroneously expected only LF. Make `tests/ci-required-browser.test.mjs` accept both CRLF and LF for the same required `exit 1` statement. The browser gate itself was not loosened.
- Pending: actual checkpoint-backed 450+ API paging; real X media modal, photo/video/GIF mixture and image delivery timings; public release and installed Chrome updates. Do not merge into stable/public branches without actual user acceptance.

---

## B2 integration GitHub CI failure and fixture correction | 2026-10-29

- Work ID XMN-B2-WINDOW-CI-40863134069. Branch task/xmn-b2-window-integration-20261029 at commit 0b74a4d2e48f8eac75b699999dff7753b1d21a33 was saved; base 9ece4e8 and independent model 083f3b9 are preserved.
- GitHub Actions run 40863134069 FAILED: npm test and TypeScript checks passed; Linux synthetic Chromium had 39 native-gallery scenarios pass and 1 fail: "same handoff upgrades from thumbnail to full image without refetch". Actual X was not visited.
- Test harness assumed an already decoded prefetch photo but awaited its decode after the 1.8s overlay timer started; it also compared ALL unrelated X background prefetch requests. This could produce a CI timing race without showing a product regression.
- Test-only repair: decode synthetic high image before the handoff timer and count duplicate transfer only for the exact target CDN URL. Keep all other browser scenario assertions, including the mandatory Chromium CI gate, unchanged.
- After local repair: npm test 254 tests (245 PASS, 0 FAIL, 3 SKIP, 6 real-X TODO); Edge/Chrome for Testing each 4/4 synthetic browser cases PASS. Linux CI remains a required acceptance gate before ff-only promotion.
- Scope: bounded verified local PREFETCH window. Full 450+ API cursor page eviction, storage and backward restoration remain pending; stable/public Chrome installations and Draft PR #17 are unchanged.

---

## B2 R-030: ambiguous bare post URL safety | 2026-10-29

- Work ID: XMN-B2-ROUTE-OWNER-20261029. Isolated task branch task/xmn-b2-route-guard-20261029 based on integrated development candidate ff0b2a36a6834d1af784f81674d925897005776f; no public, stable or installed QA changes.
- Problem: Controller.activeIndex() accepted the first indexed photo when findCurrentIndex() had already rejected a bare /status/id URL with multiple indexed media. This could treat an unverified photo as the active gallery item.
- Repair: if the URL represents a bare post and ownership is ambiguous, return null and leave native X arrow handling untouched. A single uniquely indexed media status and exact /photo/1 or /photo/2 URLs retain existing navigation. Explicit photo route with a partial single tile remains subject to separate X evidence.
- Tests: tests/b2-route-owner.test.mjs verifies 2-media ambiguity, explicit photo ownership, a unique bare status, cross-profile rejection, and no intercepted ArrowRight. npm test 256 total / 247 PASS / 0 FAIL / 3 SKIP / 6 LIVE-X TODO; TypeScript PASS; Edge Chromium synthetic 4/4 PASS. Actual X gallery not checked.
- Review before integration: require GitHub Actions to verify Node, TypeScript, Chromium and generated JS; only fast-forward task/xmn-b0-b3-20261029 when the main development branch and remote both still match baseline. Remain separate from stable/main and Draft PR #17.

---

## B2 FF-only 統合とR-030の最終受入 | 2026-10-29 JST

- B2ウィンドウの独立正本：`task/xmn-b2-window-model-20261029` / `083f3b9b2c40597e1f97f04df2db0abc058cfaf7`。導入先の統合ブランチ：`task/xmn-b2-window-integration-20261029` / `ff0b2a36a6834d1af784f81674d925897005776f`。いずれも非公開GitHubに保存済み。
- 統合ブランチのCI run **40863134069** はChromium合成のプレビュー昇格1条件のみFAIL（Node/TSはPASS）。原因候補としてテスト用の「既にdecode済み」の画像をプレビュー開始後にdecodeしていた時間競合と、対象外の先読み件数まで固定比較していたことを確認。テスト対象画像を開始前にデコードし、同じURLに対する再要求の有無だけを検査するように修正。Linux CI **40864148663** でPASS。
- 主開発正本`task/xmn-b0-b3-20261029`は`9ece4e8`から`ff0b2a3`へ**ff-only**で統合し、Node 254件中245 PASS・0 FAIL・3 SKIP・X実機TODO 6、TypeScript PASS、Edge合成4 PASS、Chrome for Testing実MV3正当経路・Edge実MV3拒否経路PASS。主正本CI run **40864506732** はPASS。
- R-030：Xのbare `/status/id`から画像が複数索引済みであり、実際にどの写真を表示しているか決められない場合の先頭写真推測を廃止。`findCurrentIndex()`が唯一と確定した投稿や、明示的な写真URLは以前どおり。単体テスト2件を追加し、専用修正コミット`b8472d89ca40151274cbc631511f5a75d783d817`を非公開開発正本へff-only統合。主正本CI run **40865471931** がNode・型検査・必須Chromium・生成JS一致の全てPASS。
- B2新機能の正確な範囲は**450画像参照以内の近傍をアルバム単位で検証する先読み制限**。全履歴をディスク/クラウドへ退避して350件目より古いページを前後に自由に読み戻す本格的なチェックポイント・ページ移動はまだ実装していない。外部FxEmbed/APIの全順序を証明できたという意味でもない。
- 継続優先：B2の双方向チェックポイントページングと再開前後のセッション所有権、B4の実X画面描画/通信/CPU・メモリ測定、B5の28件目以降・写真1〜4枚・GIF/動画・返信欄・権限/同意の本番受入。実Xにサインインしたユーザー環境での試験が済むまで、公開main・安定ブランチ・Draft PR #17・通常Chromeインストールv2.4.18・固定QA版v2.4.20は変更禁止。
- 実装再開位置：この台帳、研究R-001〜R-044、開発正本`task/xmn-b0-b3-20261029`の最新SHAとGit cleanを照合。別作業ツリーの未保存成果を推測で上書きしない。通常チャットで続行し、本人指示がない限りWorkを利用しない。

---

## B2 checkpoint storage foundation / R-041 | 2026-10-29

- Task `XMN-B2-CHECKPOINT-20261029`: use `docs/implementation/B2-CHECKPOINT-STORE.md` for implementation details and reentry steps.
- From private development base `6b9a7a5bccc83538e077aef496c83b11302102b4`, add immutable, consent-gated, tab/profile-scoped checkpoint pages 0–63 under `chrome.storage.session`; strict schema, expiry, canonical replay, ordering, collision rejection, tab-close and explicit-clear cleanup. No extra Chrome permissions.
- Add independent `SessionStore` checkpoint CRUD wrappers. Extend actual Chrome for Testing MV3 test to verify checkpoint persistence across document navigation and no alteration of prior permission/consent safeguards.
- R-041: label unfinished continuation `投稿 X / Y+`; terminal page remains `投稿 X / Y`. This is loaded count rather than proof of a complete X history.
- **NOT DONE**: automatically evict/reload 450+ API pages or claim unlimited media movement. Add a committed manifest, ordered adjoining page checkpoints, storage-quota and abort safety before connecting checkpoint pages to `Controller`.
- Full report and tests are committed to the task branch only after Node, TypeScript, synthetic Chromium, real MV3 and GitHub Actions succeed. Preserve existing stable/main, Draft PR #17 and Chrome installations.

---

## QA updater reproducibility / R-018 | 2026-10-29

- Task `XMN-QA-REPRODUCIBILITY-20261029`: see `docs/implementation/QA-REPRODUCIBILITY.md`.
- The previously permitted dirty Git worktree and same-version/different-content overwrite are now rejected. Source HEAD and private GitHub branch must match, before and after required tests; no new permissions or automatic browser installation.
- The QA README records a verified source SHA and distinguishes DOM overlay reveal from actual image Paint. Static tests guard against reintroducing unsafe behavior; PowerShell parser reports zero errors.
- Source default remains the previously authorized research branch, so the new v2.4.21 candidate is **not** automatically deployed. The installed normal v2.4.18, QA v2.4.20, stable/main and Draft PR #17 remain untouched.

---

## B2 versioned checkpoint manifest | 2026-10-29

- Task ID `XMN-B2-MANIFEST-20261029`: see `docs/implementation/B2-PAGE-MANIFEST.md` for typed schema, validation, tests, failure log and next safe integration conditions.
- The new `src/checkpoint-manifest.ts` and Worker `manifest.put/get/clear` store **only independently verified immutable 1–64 page references and their cursor/ordering metadata**; the active page is mutable but prior page descriptors cannot be rewritten. No new Chrome permissions or page access.
- Worker verifies all referenced pages exist, are valid, have the expected owner/filter/first/last key/count/outgoing cursor, are still within the unexpired 30-minute window, and form a descending, cursor-linked series. A manifest with a missing/corrupt page is removed rather than used for navigation.
- Serialized manifest writes prevent a conflicting update or simultaneous clear. Saving a page does not make it visible as a committed history until the manifest write succeeds.
- Tests and a real MV3 Chrome-for-Testing fixture verify cursor continuity, immutable history, tab/profile isolation, missing page behavior, expired metadata, session/tab clear, storage write failure, and survival across a document change.
- **Not yet working 450+ page navigation**: The product Controller does not yet activate these manifest pages, evict/load a page window or implement reversible full-history movement. Keep original 450-ref limit, cursor provenance and native X gallery safeguards until actual X acceptance.

---

## B2 historical immutable-page restore | 2026-10-29

- Task `XMN-B2-CHECKPOINT-RESTORE-20261029`: detailed rationale, safety constraints and tests: `docs/implementation/B2-CHECKPOINT-RESTORE.md`.
- MV3 Worker `checkpoint.find` verifies same top-frame X document pathname, user consent, tab/profile, entire committed manifest and each immutable stored page before returning only the exact matching media snapshot; uncommitted/expired/corrupt/mismatched pages are rejected.
- When the current short-lived tab session lacks the document URL, the Content Script can now restore that exact historical page through `SessionStore.findCheckpointForRoute()`. A new route, changed session generation, bare status or unverified URL is ignored, without revisiting FxEmbed or replacing X's replies panel.
- Tests: 282 total, 273 PASS, 0 FAIL, 3 SKIP, 6 actual-X TODO; TypeScript PASS; synthetic Edge Chromium 4/4 PASS; actual Chrome for Testing MV3 cross-document historical restore PASS; unauthorized localhost sender rejected in actual Edge MV3.
- **Still pending**: automatically moving across immutable pages with keyboard/buttons; eviction and checkpoint creation when a 450-ref FxEmbed window fills; real signed-in X acceptance, Paint/CPU/memory measurements, and any release/deployment.

---

## 2026-10-30｜B3非同期保存競合のFF-only統合（再開点更新）

- 主開発正本 `task/xmn-b0-b3-20261029` は、`e93c323` から検証済み独立ブランチ `task/xmn-b5-qa-synthetic-20261030` の `e2b264d` へ **FF-only** 前進。
- 過去のR1〜R5研究やB0〜B3を作り直したものではない。今回初めて独立再現したB3非同期保存競合について、修正 `9fe6a0e` とCI証拠 `e2b264d` を主正本へ取り込んだ。
- 非同期Worker保存中にタブ非表示・セッション失効が起こった時、未確定のFxEmbed追加参照／カーソル／終端が表示側に残る問題を安全に巻き戻す。新世代のセッションには触れない。
- 追加RED→GREEN試験3件。Node **285件＝276 PASS・0 FAIL・3 SKIP・実X TODO 6**、TypeScript型検査PASS、Edge合成Chromium **4 PASS**。
- Chrome for Testing MV3正当経路PASS。別途Edge MV3拒否経路は最初の連続起動時に`contentScriptLoaded=false`で **FAIL**、単独再実行で `foreignOriginRejected=true` **PASS**。一時プロファイル試験の起動タイミング不安定候補で、初回失敗を隠さず残す。実Xでは未検証。
- 元の独立タスクブランチのCI run `40915164292` と `40915646723` は SUCCESS。主正本ブランチのpush後CIは別途確認し、成功を先取りしない。
- B2の隣接ページ／ページ境界遷移担当worktreeには、`src/content.ts`等への **未コミット編集が残る**。これらを消去・上書きせず、担当成果が保存されたら最新の差分を照合して移植・FF-only統合する。
- **未完了**：B2の450参照超を扱う安全なページ作成・廃棄・往復とカーソル再開、B4の実X描画・通信測定、B5の認証済みXでの受入（28→29／写真・動画・GIF／返信欄）。通常インストール・公開版・Draft PR #17は据置き。

---

## 2026-10-30｜B2保存済みページの双方向移動（独立リカバリ受入）

- 再開元 `2ad3007`。別担当の未コミット差分を**参照のみ**で取得し、独立の`task/xmn-b2-adjacent-rescue-20261030`に適用。元worktreeのファイルはそのまま保持。
- MV3 Workerが同じタブ・URL・プロフィール・同意・完全なmanifestを検証した後、保存済み隣接ページの正規メディアURLだけを返す。左右キーの二重遷移・不正ルートは停止。
- 主正本のB3非同期保存競合の巻戻し修正も統合済み。Node 292件中283 PASS・0 FAIL、3 SKIP、6 LIVE-X TODO。合成Chromium4/4、Chrome for Testing実Worker往復、Edge拒否テスト合格。
- **この段階で自動450参照超ページングはまだ未実装**。B2の次作業は「カーソルで取得した新ページを完全投稿群としてWorkerへコミットし、履歴を失わずウィンドウ切替」。
- 実Xの28→29、GIF/動画、返信欄・低画質の実画面/速度は引き続き未受入。公開・通常版・安定版には手を触れない。

## 主開発正本への採用確定｜2026-10-30

- 保存済みページ双方向移動を、独立`task/xmn-b2-adjacent-rescue-20261030`の`70a33fdd34e2a6260fecec8aa0bd93ce13c10dfa`から`task/xmn-b0-b3-20261029`へ **FF-only** 統合・GitHub push済み。
- 独立ブランチ GitHub Actions **run `40986049304` SUCCESS**、主開発正本の同一SHAに対する **run `40986198510` SUCCESS**（Node・TypeScript・必須Chromium・生成JS整合）。
- 元の`x-media-navigator-b2-adjacent`作業ツリーには既存未コミット差分が残るが、上書き・破棄・コミット代行はしていない。採用した差分は新たな独立作業ツリーで検査したもの。
- 次の再開点はB2 **自動ページ確定／450参照超の保存／cursor継続と逆方向復元**。別作業ツリー`x-media-navigator-b2-transition`の未コミット変更と、採用済み隣接ページAPIの衝突をまず照合する。未検証のまま直接統合しない。
- 安定ブランチ／公開main／通常版v2.4.18／QAインストールv2.4.20／既存Draft PR #17は変更なし。本番Xでの動作確認・公開は保留。

---

## 2026-10-30｜B2 自動ページ保存の統合候補（実サイト受入待ち）

- 基準：`5ff5251`。別担当の同時編集中 `task/xmn-b2-page-20261030` の
  未コミット成果を、元を変更せず独立`task/xmn-b2-page-audit-20261030`
  に保全して続行。正本は採用前にリモート差分を再照合する。
- 450メディア参照超の取得時、現在の検証済み投稿ウィンドウを
  Workerの不変チェックポイントへ保存し、次の投稿群を別ページに確定する。
  Xの実ビューアを不必要に閉じたり、投稿IDを創作したりしない。
- Workerは同じタブの保存済み隣接ページを厳密に検証し、
  新URL到着後にだけ`manifest.activePage`と短期sessionを原子的に更新。
  以前のページの非同期保存が新アクティブページを上書きしない。
- 追加修正：再取得の0新規件を誤った終端にしない。サムネイル/解像等
  キャッシュだけの変化は確認済みメディア同一性を保持して
  `session.set`の無害な成功応答にする（不変ページは上書きしない）。
- 対象コード/テスト/拒否と再開位置：
  `docs/implementation/B2-PAGE-ARCHIVE-AUDIT-20261030.md`。
- 現時点検証：Node315件・309PASS・失敗0・本番X TODO6、
  Chromium合成4PASS、Chrome for Testing実MV3復元とEdge拒否PASS。
  **本番Xの描画・滑らかさ・450→451の受入は未実施**。
- 安定/公開/Chromeインストール変更は禁止。GitHub CI成功後のみ
  FF-onlyの主開発正本統合とする。

### 2026-10-30 B2実Worker・自動ページ保存結合確認

- `npm run test:mv3:archive`：Chrome for Testing上で
  440既知参照＋20新規参照のチェックポイント保存、
  manifest2ページ、前後URLのWorker照合がPASS。
- 独立追試と記録：`docs/implementation/B2-PAGE-ARCHIVE-AUDIT-20261030.md`。
  通常インストール・公開main・安定Draft PR・元担当の未保存成果は不変更。

---

## 2026-10-30｜B2タブ所有権・保存競合修正と自動保存からの全往復E2E

- 非公開 `task/xmn-b2-hardening-20261030` は、主開発正本
  `77d24e4` から独立してWorkerの競合を修正。
- **タブ終了中の同意書込／期限切れセッション取得／
  プロフィール切替／旧プロフィール削除**の各競合をRED→GREENで再現。
- Workerは従来のプロフィール別保存キーを維持しつつ、
  読取・書込・manifestアクティブ化・終了・同意保存の
  タブ所有ロックを統一。新プロフィールの状態の誤削除を防止。
- **新しい実Chrome E2E**：440件の旧セッション＋20件API模擬結果を
  Workerで不変アーカイブ→次ページへ文書遷移→
  返信欄と矢印を保って旧ページへ戻るまで、実製品コードでPASS。
- 64ページ上限と65ページ目拒否も既存Worker上で確認。
- 全Node321件（312 PASS・0 FAIL・3 SKIP・実X TODO 6）、
  型検査・Chromium合成4件・MV3 4系統（archive/roundtrip/
  正規往復/不正元拒否）PASS。実Xは依然未受入。
- 細部：`docs/implementation/B2-TAB-SESSION-RACE-AND-ROUNDTRIP-20261030.md`。
- 公開main・安定Draft PR #17・通常/QAインストールは変更せず、
  CIを確認してからFF-onlyで開発正本に統合。

### 継続監査｜Linux必須Chromium結果マーカーの競合

- `26ea869` GitHub CI run `41004745029` は、Node/TS成功、
  必須Chromium合成の結果マーカー不在によるFAIL。
- 長尺40シナリオを実時間CDP待機へ置換（全40条件維持）。
  一時Chromeプロファイル・独立CDPを用いるため、
  Xサイトやユーザーブラウザ・履歴は操作しない。
- Windows Chrome for Testing 156の合成4ケースPASS。
  修復後のGitHub CIを確認するまで統合しない。

---

## 2026-10-30｜B2タブ隔離・旧文書競合とChrome E2Eの主正本採用

- 開発正本`task/xmn-b0-b3-20261029`は非公開の
  `task/xmn-b2-hardening-20261030`を**FF-only**統合。
- 修正`26ea869`：タブ終了中の同意書込、期限切れ読込の後発削除、
  プロフィール切替、古いプロフィールのセッション削除を
  実際のWorker状態機械でRED→GREEN。全操作をタブ所有で直列化し
  相手プロフィールの有効な公開セッションを保護。
- 追加`tools/mv3-archive-roundtrip-smoke.mjs`：
  Chrome for Testingで440既知＋20追加の不変保存
  →新ページ→旧ページへ戻るまで実製品Content Script/Workerを確認。
  既存MV3正規往復・保存・外部元拒否も合格。
- Node **321件（312PASS・0FAIL・3SKIP・実X TODO6）**、
  TypeScript、合成Chromium4件、MV3試験4系統PASS。
  64ページ上限の65ページ目拒否も維持。
- CI初回run `41004745029` はUbuntuの長尺合成テストで
  マーカー未取得のFAILを記録。修正`6d9ffe6`では
  **同じ40シナリオの必須判定を維持して実時間CDP監視**へ切替。
- 非公開専用ブランチ run `41005235139` **SUCCESS**、
  主正本 run `41005392051` **SUCCESS**。
- 根拠・失敗・再開点：
  `docs/implementation/B2-TAB-SESSION-RACE-AND-ROUNDTRIP-20261030.md`。
- 公開main、安定Draft PR #17、通常Chrome v2.4.18、
  既存QA v2.4.20、ユーザープロフィールは変更なし。
- **未完了**：B4実サイト描画/通信計測、B5の認証済みX 28→29・
  写真/動画/GIF/混合・返信欄・UI受入と公開判断、上限64ページ満杯時の運用。
  CIやlocalhost検証を実X受入と混同しない。

---

## 2026-10-30｜B4 中間フィルター変更と先頭仮想化の再検証

- 独立ブランチ`task/xmn-b4-grid-perf-20261030`にR-042/R-043の
  条件付き実装不具合を**RED→GREEN**で修正。
- R-043：先頭8＋末尾8が変わらなくても、中間タイルのDOM/媒体キー
  変更を検出する一時全件フィンガープリントを追加。
- R-042：Xが元先頭を仮想化で外した場合も、時系列と既知DOMアンカーで
  証明した新着投稿を先頭へ追加。証明できない未知先頭は末尾に誤追加しない。
- Chrome for Testingの独立localhost測定で1200／3000タイルの
  初期表示バッジ数、中間差分検出、照合処理時間を検証。
  実サイトの速度向上や完全受入を宣言していない。
- Node328件（319PASS・0FAIL・3SKIP・実X TODO6）、
  型検査、合成Chromium4、MV3実Worker4系統PASS。
- 証拠・失敗・残作業：
  `docs/implementation/B4-GRID-VALIDATION-20261030.md`。
- GitHub CIを通してからFF-onlyで開発正本へ統合。
  公開main/通常版/旧QA/安定Draft PRは不変更。

---

## 2026-10-30｜B5非公開v2.4.21候補・安全な独立配布準備

- B4で解消したR-042／R-043とChrome合成・MV3検証を元に
  `task/xmn-b5-private-qa-20261030`で独立QA候補を準備。
- manifest識別子は`Private QA 2.4.21`に限定。
  Chromeの既存v2.4.18／FxEmbed QA v2.4.20には触れない。
- 再現可能な`tools/stage-b5-private-qa.ps1`は
  GitHub正本・clean・型検査・Node検査・ファイルハッシュを確認し、
  **新しいフォルダだけを作成**する。既存の拡張の更新・起動は行わない。
- 未コミット状態ではステージングを実行せずに拒否する
  ネガティブ試験を実施。実行拒否時に生成ディレクトリなし。
- 受入チェックリストと未完了内容は
  `docs/implementation/B5-PRIVATE-QA-20261030.md`。
- 実ログインXでの28→29・GIF/混合・返信欄・Paint計測・公開判断は未完了。

---

## 2026-10-30｜B4完成証拠とB5独立QAファイル配置の確定

- B4のR-042（Xの新着先頭が仮想化で消える際の誤った末尾追加）・
  R-043（先頭/末尾8件不変で中間のみ変わるフィルター切替）修正は
  `9a116fa2aee2cc2502d0ad010f20a6fe0de1d2b0` として開発正本へ
  FF-only統合済み。GitHub Actions run `41008348918` はSUCCESS。
- 合成Chrome for Testingでバッジ1,200件・3,000件、
  中間DOM/媒体リンク置換の検知PASS。
  詳細:`docs/implementation/B4-GRID-VALIDATION-20261030.md`。
- 非公開B5候補 `999a96b0664e3aadababe5a2c5144c0c47468c28` を
  `task/xmn-b5-private-qa-20261030` でNode/TS/必須ChromiumまでCI確認。
  run `41009199167` SUCCESS。旧Linux CI FAIL `41008882577` は、
  必須CDPの起動待機時間を拡大した上で修復（40条件は維持）。
- 新しい独立フォルダ
  `%USERPROFILE%\Downloads\X-Media-Navigator-v2.4.21-B4-QA-20261030` に
  **v2.4.21 Chrome MV3非公開QA候補をステージング済み**。
  7アセットのSHA-256がソースと一致し、
  `SHA256SUMS.txt`と`QA_README.txt`も配置済み。
  既存の通常v2.4.18と旧QA v2.4.20は不変更。
  Chromeへの実インストール・有効化は行っていない。
- 本開発正本もB5 SHA `999a96b0664e3aadababe5a2c5144c0c47468c28`
  へFF-only統合され、GitHubの同SHA run `41009448025` SUCCESS。
  GitHubとローカルのHEAD一致・ワークツリーcleanを確認。
- 本番Xの認証済み28→29、1～4枚・GIF/動画/混合、
  実返信欄の継続表示、画像Paint・CPU/RAM・HTTP転送計測、
  レビュー・公開判断は**未完了**。合成MV3やフォルダ作成を本番受入と
  誤認しない。ユーザーのChromeログイン情報・通常プロフィールは触れない。
- 次の再開点は既存の独立候補を、旧XMNを無効化したChromeに
  ユーザーが手動Load unpackedして実機受入を行うこと。
  完成・公開の判断はその受入証拠取得後のみ。
