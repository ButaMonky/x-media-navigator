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
