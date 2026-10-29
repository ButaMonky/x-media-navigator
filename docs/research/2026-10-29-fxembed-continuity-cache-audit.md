# X Media Navigator｜公開メディア取得・ページ連続性・画像キャッシュ研究

- 研究ID：`XMN-RESEARCH-FXCURSOR-CACHE-20261029`
- 日付：2026-10-29 JST
- 対象：非公開 `ButaMonky/x-media-navigator`、`handoff/fxembed-media-continuation-20261029`
- 状態：**実際の公開API + Chromium独立実験 + コード監査 + 回帰テスト**。ログイン済みXでの実操作・高速化率は**未検証**。
- 変更対象：引継ぎ専用ブランチのみ。安定ブランチ、Draft PR #17、main、通常インストール版、既存Chromeプロフィールは変更しない。

## 1. 公開FxEmbedの3ページ実測

対象：公開の`pignic_cafe`メディア。Cookie、OAuth、Xログイン、秘密情報なし。読み取りのみ。

| ページ | 返却投稿 | 受理投稿 | 写真メディア参照 | 除外内容 |
| --- | ---: | ---: | ---: | --- |
| 1 | 66 | 63 | 57 | 写真＋動画混合3 |
| 2 | 76 | 71 | 50 | 混合1、メディア情報欠落4 |
| 3 | 68 | 66 | 53 | 混合1、メディア情報欠落1 |
| **計** | **210** | **200** | **160** | **混合5、欠落5** |

- リクエストは`count=100`だが、実返却は66～76件/ページだった。したがって`count=100`を「100件返る」の保証として扱わない。
- 3ページともHTTP 200、次カーソルあり。実測カーソル長46文字。受理候補のCDN URL形式はすべて正規化に成功。
- この試行では各ページ内の投稿IDは降順、ページ境界でも降順、ページ間の投稿ID重複0件。
- 別試行は69＋68＋82＝219投稿、受理209投稿だった。返却数は時間・上流状態で変動し、恒久的な件数保証はない。
- 受理されない「混合メディア」はXが公式に認める正常な投稿形式。添付番号を推測して`/photo/N`に変換してはならない。
- 受理できない「メディア情報欠落」についても、投稿本文や引用先から写真番号を憶測で作らない。

再現コマンド：`node tools/fxembed-public-research.mjs`（公開APIへの最大3回の読み取り。結果は集計のみ表示し、生データ/URL/カーソルは保存しない）。

## 2. 再現・修正した投稿順逆転（重要）

旧実装では`publicApiAnchorFound=true`の後続ページに対し、**ページ内が新→古の順であるかだけを検査**していた。カーソルが古いページへ戻り、現在の索引末尾より新しい投稿を返した場合、**古い投稿の後ろに新しい投稿を追加**してしまう。

- REDテスト：既知の投稿400→300→200に対し、外部カーソルが250→150を返す。旧実装は索引末尾へ250・150を追加してしまった。
- 修正：初回アンカー照合後のページでは、外部APIの先頭投稿が索引末尾より**新しい**場合は`fxembed.continuation_abort: cursor_newer_than_tail`で中止し、DOM由来の索引・カーソル・セッション保存を変更しない。
- 正常なページ境界重複：先頭に末尾200が再登場し、その後150が続くなら、200の重複をスキップし150を追加する。回帰テスト合格。
- この修正は**誤順序を防ぐ**もので、Xメディアタブと外部APIのフィルター完全一致や過去に欠落した投稿の自動復元は証明しない。

## 3. 画像サイズ・HTTPキャッシュの独立実験

ローカルHTTPサーバーで**同じGIFバイト列**を、キャッシュ可能な`/image.gif?name=large`と`/image.gif?name=orig`の2 URLで配信。独立したChromiumを起動し`large → orig → large`の順で3回表示要求を実施。

- 結果：`large`がネットワーク1回、`orig`がネットワーク1回。後続の同一`large`は追加通信0件。
- 結論：**この独立環境ではサイズ名違いのURLが別々のHTTPキャッシュエントリー**だった。同じ画像IDでも`large`の事前取得だけでは`orig`のネットワーク取得を省略できなかった。
- **XのCDNそのものを検証した結果ではない。** Xのリダイレクト、実際の表示サイズ、ブラウザキャッシュ、HTTP応答ヘッダーは別途要観測。
- `PerformanceResourceTiming.transferSize=0`は、`Timing-Allow-Origin`がない外部CDNではキャッシュヒットの証明にならない。
- ユーザー視点での価値は「追加通信なしの低画質Canvas」や「先読み済みデコード画像の表示引継ぎ」にもあり得るが、X本来の`orig`が別途転送されるなら通信量の最適化効果は限定的。

再現コマンド：`node tools/cache-variant-lab.mjs`。使い捨てのChromiumプロファイルとlocalhostのみ使用。実験終了時にChromeを閉じて一時ファイルを削除。

## 4. FxEmbedを利用する際の構造的制約

- Chrome MV3のContent Scriptは通常のCORS制約を受ける。第三者APIが適切な`Access-Control-Allow-Origin`を返す場合は、追加のhost権限やbackground workerを要求せず読み取り可能。隔離MV3のlocalhost実験は既存研究で成功しているが、サインイン済み`x.com`の同じオリジンで成功した証拠ではない。
- APIに投稿URLがあっても、Xの現在のReactモーダルがそれを受け取るAPIは確定していない。現行の`window.location.assign()`はXの通常文書遷移であり、返信欄の再生成・空白・低画質Canvas引継ぎが途切れる可能性がある。未確認の`history.pushState()`やX非公開GraphQL呼出しに置き換えない。
- Xのメディアタブは、アップロードされた画像・動画・GIFを時系列で並べる仕様。外部APIが一致した順序を保証するわけではない。
- 現行索引上限は**450投稿ではなく450メディア参照**。1投稿に写真が複数あるため、上限へ早期到達し得る。件数を単に上げるより、検証済みの「前後ウィンドウ」をページごとに保持する設計が必要。
- `publicApiWarmCursor`は先行取得を同一カーソルで一度だけ試す。タブ非表示・Xの画面移動などでタイマーが中止されると再先行取得しない場合がある。意図的な過剰通信回避と、操作時の待ち時間を比較して実機で調整する。
- `prefetch.finished.cached:true`は拡張側のデコード済み短期キャッシュであり、XのブラウザHTTPキャッシュ命中率ではない。
- 低画質Canvasは実際のXのサムネイルDOMリンクを識別できる場合に限り準備される。APIだけで発見した投稿の通常文書移動では、旧ページのCanvasを移動先へ持ち越せない。

## 5. 次に取るべき検証と優先順位

1. **最優先／実X**：ログイン済みの通常の認可Chromeで、同じ公開プロフィールの28→29件目、通常文書移動時の画面、左右キー、動画、返信欄、矢印位置を観測する。ユーザーのCookie、認証ヘッダー、HARや閲覧履歴を送信・保存しない。テスト終了時は起動したブラウザのみ閉じる。
2. **先読み実測**：DevToolsのNetwork/Performanceで`large`と`orig`の両方が取得されるか、低画質が`preview.visible quality=low`まで到達するかを匿名化した集計のみで確認。ログの`preview.low_thumbnail_decoded`だけで表示成功と断定しない。
3. **混合メディア5件／欠落データ5件**：X標準で生成されるメディアリンク・枚数の正確な仕様を実機で調査し、妥当な証拠なしにAPIからリンクを創作しない。
4. **450参照の上限**：常時全件を積む方式から、前後を限定して入れ替えるページウィンドウを設計する。復元と左右移動の単調性を先に形式化し、途中でカーソルを飛ばさない回帰テストを用意する。
5. **プライバシーとUX**：FxEmbedはX公式ではない第三者サービス。初回同意、送信元IP等の通信情報、タイムアウト/失敗時の画面保持を維持する。公開版への適用は実X QA後の明示的判断に限定。

## 6. 根拠

- FxEmbed API：`https://docs.fxembed.com/api/introduction/` と `https://docs.fxembed.com/api/twitter/operations/2profilehandlemedia/`
- Xメディア一覧：`https://help.x.com/en/using-x/view-all-x-pictures`
- X混合メディア：`https://blog.x.com/ja/product/introducing_mixed_media_videos_images_gifs_together_one_tweet`
- ChromeのContent ScriptとCORS：`https://www.chromium.org/Home/chromium-security/extension-content-script-fetches/`
- Resource Timingの制限：`https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming/transferSize`

## 7. テスト結果・障害記録

- 再現テスト：旧コードでは「古いカーソルが新しい投稿を返す」ケースは**失敗（falseを期待したのにtrue）**。修正後は正常に中止。正常なページ重複テストは修正前後とも成功。
- `npm run typecheck`：PASS。
- `npm test`：**193件（184 PASS、0 FAIL、3 SKIP、6 本番X TODO）**。
- Edge Chromium `npm run test:browser`：**4 PASS、0 FAIL**。
- 独立画像キャッシュ実験：`name=large` 1件、`name=orig` 1件、同一`name=large`再要求はキャッシュヒットで追加通信なし。
- 公開FxEmbed実測は最小限のGETのみ。結果に生の投稿URL、ID、本文、画像、認証情報は保存していない。
- ツール失敗：PowerShell`Replace([char]13+[char]10,[char]10)`のオーバーロード不一致で編集処理を中止し、元のソースを変更していないことを確認。文字列を正規化して安全に再実行した。
- 本番Xのログイン画面・403による未検証範囲は`docs/qa/2026-10-29-real-chrome-fxembed.md`を参照。これは拡張コードの合否と混同しない。
- **公開main／安定版／Draft PR #17／Chrome通常インストール先は変更しない。** 新コードは非公開の引継ぎブランチのみで保持する。

## 8. 今回の研究パッチの扱い

- 誤順序防止ガードを含むソースのバージョンを**非公開QA v2.4.20**とした（TypeScript・コンパイルJS・manifest・npm package/lock整合）。
- この変更は安全側に停止する検証であり、「29件目以降を全件取りこぼしなく高速表示できる」保証や、本番Xでの受け入れ合格ではない。
- QA固定フォルダは`tools/update-chrome-qa.ps1`経由でテスト成功後にのみ更新する。通常版`X-Media-Navigator-Current`はv2.4.18を維持。

## 9. 非公開QA v2.4.20への導入検証（修正コミット後）

- **実装修正・研究スクリプトのコミット：`71b0fd101d1a7e3b4be83f3d5917f6bf5ebc205d`**。非公開引継ぎブランチへpush済み。
- コミット後に`tools/update-chrome-qa.ps1 -NoOpen`を実行。型検査、通常Node全テスト、Chromium全テストが成功した場合のみフォルダを入れ替える一括処理が正常終了。
- QA設置先：`%USERPROFILE%\Downloads\X-Media-Navigator-FxEmbed-QA-20261029`、manifest版`2.4.20`を確認。JS/CSS/3アイコンのSHA-256はソースと**5/5完全一致**、QA_READMEにソース`71b0fd1`と未コミット変更なしが記載された。
- 通常固定フォルダ：`%USERPROFILE%\Downloads\X-Media-Navigator-Current`は`2.4.18`のまま。更新スクリプトによる通常版6ファイルの非変更検証も成功。
- Git作業ツリーはclean、mainと安定`fix/prefetch-startup-v241`は以前のSHAから変更なし。Draft PR #17もopen/Draft/未マージ。
- ブラウザは自動再起動・通常プロファイル操作をしていない。QAをChromeで試すには、旧版を無効化し、QA拡張カードを再読み込み後、Xタブを再読み込みする必要がある。
- GitHubのこのコミットに対するstatus APIは空配列で、**クラウドCIの成功を裏付ける情報なし**。Windowsローカルテスト成功と明確に区別する。

---

## 10. 第2回・修正なし横断監査（2026-10-29 / Research-only）

- 監査ID：`XMN-AUDIT-R2-20261029`。開始時ソースHEAD：`6b06c4ab3c72c8b1d6eca3e0ac3ea36f40de8b98`、引継ぎブランチclean・GitHub HEAD一致。
- **実装・生成JS・manifest・テスト・QA配布フォルダは変更しない。** 本節のみ既存研究台帳に追記。検証スクリプトはWindows一時フォルダに生成・実行後に削除。
- 分類：CONFIRMED = 現行JSを用いた独立VM・合成環境で再現、CODE = 明示的なコード経路確認、HYPOTHESIS = 本番Xに発生するか未確認。各所に実Xの動作証明ではないことを明記する。
- 検証環境：Windows Node v24.19.0・コミット済み `extension/content_script.js`。Xへサインインせず、Cookie・認証ヘッダー・HAR・生の投稿URLを取得・保存しない。

### 新規監査項目（重複カウントを避けるためR2番号で管理）

| ID | 優先 | 状態 | 根拠・現在の影響 |
| --- | --- | --- | --- |
| R2-001 | P1 | CONFIRMED | `window.sessionStorage`に由来する復元データを信頼しすぎる。異常順序・重複・誤フィルター・任意カーソルが復元された。 |
| R2-002 | P1 | CONFIRMED | FxEmbedが8件以上の候補と**前回と同一cursor**を返す場合、取得成功のままカーソルを更新せず、次回も同一ページを要求し得る。 |
| R2-003 | P2 | CONFIRMED | APIが最終ページで既知の末尾投稿だけを返し`cursor=null`の場合、追加なしでrollbackし`exhausted=false`を保持。次回も同一問い合わせを再試行する。 |
| R2-004 | P2 | CONFIRMED | API-only投稿への文書遷移前に矢印を2回操作すると、遷移中フラグなしで`location.assign()`が2回呼ばれる。 |
| R2-005 | P2 | CONFIRMED | 事前取得タイマー待ち中にタブが隠れると通信せず中止するが、カーソルを試行済みとして記録するため復帰後に同じ事前取得を再予約できない。 |
| R2-006 | P2 | CONFIRMED | `preview.visible`ログは`classList.add('xmn-handoff-visible')`より前に出力。DOM操作が失敗しても「表示」と記録される。可視ピクセルの証明ではない。 |
| R2-007 | P2 | CODE / BENCH | `findLiveLink()`は移動先を探す度に現在のX DOMタイルを全探索する。3,000タイル×200検索の合成環境で60万タイル検査、約5秒。 |
| R2-008 | P2 | CODE | `response.text()`で全文を確保した後に4MB上限を検証する。Content-Length欠落・不正確な大容量応答に対して受信途中の中断上限ではない。 |
| R2-009 | P2 | CODE | CIのChromium統合試験は実行環境にChrome/Chromiumがなければ検証を行わず成功終了し得る。実X向けTODO6件も通常PASSの範囲外。 |
| R2-010 | P2 | HYPOTHESIS | API待機中に既存DOM索引が成長すると、取得開始時の末尾を基準に追加した結果、順序逆転する合成例を確認。通常Xビューア中のDOM監視は停止するため実利用の発生条件は未証明。 |

### 検証用の人工データと観測結果（再実施可能な条件）

- **R2-001**：同じプロフィールの`/status/100/photo/1`を開いた想定で、保存した参照を`[100,120,90]`へ並べ替えると復元成功（投稿順逆転）。`[100,90,90]`でも復元成功（`refs.length=3`、`indexes.size=2`）。`timeline='bob|video'`も復元成功。`cursor='bogus-cursor-without-evidence'`も復元成功。一方`expires`を過去にすると正常に拒否。これらはサイト側と同じオリジンのWeb Storageを利用するため、隔離JS変数の保護とは分けて考える。
- **R2-002**：既知400→300、`publicApiAnchorFound=true`、保存cursor`CURSOR-SAME`。APIは290～220の8投稿・同じ`CURSOR-SAME`を返す。結果は`success=true`、8参照追加、`publicApiCursor`不変、`exhausted=false`。4ページループ内の`candidates>=8`判定がcursor同一判定より先にある。
- **R2-003**：既知200→100、cursor`CURSOR-AT-END`。APIは既知100のみ・`cursor=null`。2回連続呼出しで2回API処理を起動、毎回`success=false`、`publicApiExhausted=false`、カーソル不変。これ自体は既存写真を壊さないが、不必要な繰り返しとUI上の末尾判定の曖昧さが残る。
- **R2-004**：既知100→API由来90、XのDOMリンクは未存在。短時間の右操作2回を模したVMで`location.assign('/alice/status/90/photo/1')`を2回呼出し。通常ブラウザが最初の呼出しで即座に遷移を確定させる場合、ユーザー可視の重複発生は未証明。
- **R2-005**：事前取得タイマーが予約された後に`document.hidden=true`とし、タイマーを実行。実際のAPI呼出し0件、`publicApiWarmCursor='NEXT'`、復帰後に再予約なし。再試行条件を`予約`と`取得完了`で分離すべき。
- **R2-006**：`classList.add()`が例外を投げる合成DOMでも`preview.visible quality=low`は既に記録されていた。なお正常にクラスが付与されてもブラウザのPaint・Compositor完了は未証明。
- **R2-007**：これは実Xの性能測定ではなく、DOM長に比例する探索回数を示す合成ベンチマーク。古い索引・切断されたReactノードを信頼しないという現行の安全条件は維持すべき。
- **R2-010**：アンカー確認済み既知400→300のAPI待機中、想定X DOMが200を追加し、その後APIが250→150を返す。結果`success=true`、並び`400,300,200,250,150`。通常のモーダル表示時には`stopListObserver()`が働くため、直接の本番不具合と主張しない。

### 公式仕様の確認

- Web Storageはオリジン・タブ単位（`sessionStorage`）。Chromeの隔離WorldはJS変数を分離する一方、サイトと共有するDOM/ストレージを拡張専用の認証済みデータとみなすことはできない。MDN：`https://developer.mozilla.org/en-US/docs/Web/API/Web_Storage_API`、Chrome：`https://developer.chrome.com/docs/extensions/reference/api/storage`。
- `chrome.storage.session`は拡張側の一時保存の候補だが、既定ではContent Scriptから利用できず、アクセスレベル変更・`storage`権限・設計移行を伴う。**無条件で新権限を増やす提案ではない。**
- FxEmbed公式は`cursor.bottom`で続き取得、`count`最大100、公開APIのリクエスト上限を案内。外部APIの継続性・同じデータの永続性までは保証しない。参照：`https://docs.fxembed.com/api/introduction/`。
- PerformanceResourceTimingの`transferSize=0`はCORS/Timing-Allow-Originに制約される。ブラウザキャッシュと拡張内部の`prefetched`キャッシュを区別する。参照：`https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming/transferSize`。


### R2-011：第三者への送信同意もWeb Storageに依存（重要）

- **優先 P1 / CONFIRMED（合成）**。同一オリジンの`sessionStorage`に`xmn-fxembed-consent-alice='yes'`が保存済みの状態を作ると、最初の右キー操作で確認ダイアログの呼出し0回・FxEmbed続き取得1回となった。
- サイト側JavaScriptが実際にこのキーを変更した証拠や、X自体が悪意ある動作をしているという主張ではない。**同意状態をユーザー専用・拡張専用の信頼領域で管理できていないという設計上の境界問題**である。
- 現行`credentials:'omit'`はXのCookieを送らないため、直ちにCookie流出を意味しない。ただし第三者には公開プロフィール名・接続元IP等が伝わり得るため、初回同意の確実性は保持すべき。

## 11. 後日まとめて直す場合の依存関係と検証ゲート（実装は今回行わない）

| 改修単位 | 対象ID | 必須の合格条件 |
| --- | --- | --- |
| A. 信頼境界と復元スキーマ | R2-001 / R2-011 | 異常順序・重複・他プロフィール/フィルター・偽同意・偽カーソルを拒否。権限追加と実装サイズを比較して方式決定。 |
| B. カーソル状態機械 | R2-002 / R2-003 / R2-005 | `idle/requesting/ready/exhausted/retryable_error`とカーソル履歴。カーソル同一・ループ・空ページ・429/5xxで投稿が重複・消失しない。 |
| C. 画面操作の排他・非同期整合 | R2-004 / R2-010 と既存右キー待ち課題 | 連打で文書遷移1回。更新中にルート・一覧・フィルターが変われば結果を破棄。取得待ち中の「次へ」を1回の有効操作として処理し、古い操作は再開しない。 |
| D. DOM探索とデータ保持 | R2-007 / 既存450参照上限 | 切断されたReact DOM要素は不採用、既知の生きたリンク索引を利用。3,000タイル・高速連続キー・仮想化・追加/除去で投稿順が不変。 |
| E. 画像先読み・本当の体感 | R2-006 と既存`large/orig`差 | `preview.visible`はDOM可視化成立後に報告し、画面塗り/表示時間は別指標。誤った画像の表示0、追加通信・転送量をNetworkで実測して方式選定。 |
| F. APIの防御的ストリーミング/テストゲート | R2-008 / R2-009 | 4MB超の応答を受信中に中止。CIではブラウザ検証未実行を明確にFAILまたは別の必須ゲートへ分離。TODOを合格と誤認しない。 |

- **順序**：A（信頼境界）→ B/C（ページ継続・入力の一貫性）→ D（長い一覧）→ E（表示高速化）→ Fの総合受入。Fの入力上限・テスト整備はAから並行して準備してよい。
- **研究のみ段階**：次回以降の研究ではこのR2番号を使い、`CONFIRMED/CODE/HYPOTHESIS/VERIFIED_FIXED`の状態を更新する。別ファイルに同じ課題を重複登録しない。
- **実機未達**：ログイン済みXでの28→29件目、左右キー、返信パネル、写真/動画混合、実ネットワーク転送、可視低画質フレーム、画面応答時間は独立合成テストで代替できない。

## 監査番号の整理・独立検証の追記（研究のみ）

研究中の`R2-001～011`と`R2-18～21`は詳細証拠の局所ID。重複課題は別件として数えない。
**正本は`XMN_RESEARCH_LEDGER.md`の`R-001～R-031`**とし、対応は次のとおり。

| 詳細報告の局所ID | 累積研究台帳の正本ID |
| --- | --- |
| R2-001 / R2-011 | R-001（復元）／R-002（同意） |
| R2-002 / R2-18 | R-026（カーソル同値） |
| R2-003 / R2-19 | R-028（既知投稿だけの終端） |
| R2-004 / R2-20 | R-025（文書遷移の連打） |
| R2-005 | R-008（中断したWarmup） |
| R2-006 | R-010（preview.visibleの意味） |
| R2-007 | R-012（DOMリンク全探索） |
| R2-008 / R2-21 | R-031（遅い本文サイズ検査） |
| R2-009 | R-021（CIブラウザ検証の扱い） |
| R2-010 | R-009（非同期索引競合） |

以下の局所IDで残した追加再現は、いずれも上記の正本IDへ紐づけ済み。

- **R2-18 / P1 / 合成再現：同一カーソル継続。** 既知400→300、APIが8件の新規投稿と**現在と同じcursor**を返すと`success=true`・8件追加・cursor不変・exhausted=false。次の境界で同じカーソルを再取得し得る。回数ではなく「新しいcursorへ進んだか」で完了を判断する。
- **R2-19 / P2 / 合成再現：末端の既知投稿のみ。** `cursor=null`かつ追加0件の返答でもrollbackで`exhausted=false`に戻り、同じ問い合わせが繰り返される。終端確認と再試行可能な失敗を明確に区別する。
- **R2-20 / P2 / 合成再現：API-only遷移の連打。** `location.assign()`呼出し前後で`navigationBusy`を立てないため、同じ次投稿へ続けて2回の文書遷移を要求可能。実ブラウザの画面移動が確実に2回発生するとの主張ではない。
- **R2-21 / P2 / 静的確認：容量上限の適用が遅い。** APIレスポンスを`await response.text()`で全文確保してから`body.length > 4_000_000`を見る。サイズ異常のストリームは受信途中で止める設計の方が安全。
- **R2-01/02の実Chromiumによる補強：** 通常のページスクリプトが`sessionStorage['xmn-fxembed-consent-alice']='yes'`を設定し、その後別の隔離MV3 Content Scriptが同じ値を読むことに成功。**同時にページ側の通常JS変数は隔離Content Scriptから見えなかった**。localhost・使い捨てブラウザ・認証なし・ブラウザ終了とプロファイル削除確認。これはVMだけの推測ではなく、実ChromiumのWeb Storage共有境界の証拠。
