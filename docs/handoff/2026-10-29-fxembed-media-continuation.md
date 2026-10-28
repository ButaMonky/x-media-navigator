# X Media Navigator — FxEmbed APIで28件以降へ進む機能・引継ぎ

記録日：2026-10-29 JST
状態：**WIP / 実Xで未検証 / 公開不可 / 現在の安定版と分離済み**

## 1. 次のチャットが最初に読む情報

- 非公開GitHub：`ButaMonky/x-media-navigator`
- **未完成の引継ぎブランチ：`handoff/fxembed-media-continuation-20261029`**
- 安定した既存開発ブランチ：`fix/prefetch-startup-v241`、Draft PR #17は**維持し、勝手に変更・マージしない**。
- 公開 `main` は `47b23d56257ee272f4adc1dea21900340e673c98`、変更しない。
- PCのリポジトリ：`C:\Users\Saito\Documents\X-Media-Navigator`
- 実際のインストール用フォルダ：`C:\Users\Saito\Downloads\X-Media-Navigator-Current` **v2.4.18**（現行コードとは異なり、FxEmbed試作はまだ入っていない）。
- v2.4.18の旧版バックアップ：`C:\Users\Saito\Downloads\X-Media-Navigator-Backups\pre-v2418-20261028_170301`。
- 2026-10-28の安定開発版HEAD：`1799493a42786a634ff3d2e7772bf9c148cf4679`。WIPブランチはこのコミットを親にした。
- このブランチにある試作は**途中段階**。テスト・CI・Chrome実機検証・インストール用6ファイルの入替は未完了。

## 2. 何を求められたか、なぜこの機能が必要か

ユーザーはXのプロフィールメディアタブで、右矢印キーで投稿を連続閲覧するChrome MV3 TypeScript拡張を開発中。以前は次の投稿が未取得の場合、現在の画像モーダルを一旦閉じ、背後のXメディア一覧を自動スクロールして投稿を読み込み、再度開く方式だった。これが遅く、画面位置を乱した。

v2.4.18ではこの自動スクロールを廃止した代わりに、ユーザーが確認した `pignic_cafe` の投稿では「投稿 28/28」で進めなくなった。ユーザーの最新の明示的要望は、**APIから28件目以降の投稿URLを自動取得し、可能な限り連続閲覧を続けられるようにすること**。従来の自然なSPA、右側の返信欄、画像内の枚数送り、▶◀ボタン位置、誤スキップ防止を維持する。

## 3. APIの研究・実際に得られた証拠

X公式API `GET /2/users/{id}/tweets` は投稿情報の一括取得が可能（最大100件/リクエスト、カーソルあり）だが、開発者認証と従量課金が必要で、Webのメディアタブと同じ順序・対象の保証はない。**APIキー・Cookie・ログイン情報を使わない**方針。

FxEmbed/FxTwitterの第三者公開API
`GET https://api.fxtwitter.com/2/profile/pignic_cafe/media?count=100&cursor=...`
を、認証・Cookieなしで調査。2026-10-28 JSTにHTTP 200、`Access-Control-Allow-Origin: *` を確認。2ページで約109～134件の投稿（時間・応答によって変化）、一例では126件の有効なメディア投稿グループ、99個の画像URL候補を解析できた。投稿IDが `21114...` で始まる投稿も4件確認できた。APIが返す順番はその応答では新しい→古い順で重複なしだったが、恒久的保証ではない。

第三者APIの実写真URLは `https://pbs.twimg.com/media/ID.jpg?name=orig` のような形式で、従来のX DOM向けURLパーサーと異なっていたため、専用の正規化を追加した。独立したEdge Chromium MV3隔離環境から、公開ハンドルだけでFxEmbed CORSリクエスト可能（実測 `corsFromIsolatedMV3:true`）。

重要：**APIで候補URLが分かることと、Xの現行React画像モーダル内で次の投稿へシームレスに遷移することは別問題**。Xが実際にDOMへ生成したリンクなら既存のX所有SPAクリック経路を用いる。一覧にないAPI由来のURLでは、試作は`window.location.assign()`による通常のXページ遷移を使う。**ページ全体が再読み込みされ、返信欄付きモーダルの状態が変わる可能性が高く、ユーザー希望の完全SPAではない**。この制限を隠さない。

第三者サービスへの公開ハンドル送信は、試作では初回に`window.confirm()`で説明・承認を取る。 `fetch` は `credentials:'omit'`、`referrerPolicy:'no-referrer'`、CORS、9.5秒Abort、読取限定・最大4ページ、`content-length`/本文4MB制限、短時間のレート配慮を設定。API資格情報は扱わない。短期`sessionStorage`へ最大450件/有効30分の公開メディア情報・次カーソルを保存し、通常ページ移動時にも復元する試作。

## 4. 試作コードとテスト（WIPブランチで保存）

- `src/core.ts`：`normalizePublicPhotoUrl()`、`parsePublicMediaPage()`。写真/動画種別、投稿ID、投稿者ハンドル、Xの正規投稿URL、画像CDN originを検証。異なるアカウント、未知の画像URL、混合・不正な添付を拒否。
- `src/content.ts`：FxEmbedページの読取、ページごとのカーソル、現在のXメディア一覧最後の実投稿IDへのアンカー照合、順序逆転防止、索引上限・不完全アルバムの拒否、API由来のRefs・画像URLsの保持、デコード済みキャッシュとセッションの復元、処理中のユーザー画面移動・保存失敗時の安全中止、確認ダイアログとAPI-only URLへの正規ページ移動。
- `extension/content_script.js`：上記TypeScriptの生成物。**TypeScriptのみをソース正本として修正すること**。
- `tests/core.test.mjs`：写真URL正規化と第三者APIの異常入力・実URL形式の回帰テスト。
- `tests/controller.test.mjs`：カーソル継続、アンカー一致、間違った一覧順の拒否、セッション保存/復元、外部通信にCookieが含まれないこと、450件上限、遅延応答と画面移動の競合、写真枚数証拠等のテスト。**全テスト最終パスはまだ得られていない**。
- `tools/fxembed-isolated-cors-probe.mjs`：使い捨てMV3＋127.0.0.1テスト用ページで、公開プロフィールへ1回だけread-only CORS GETする独立プローブ。通常のユーザーChromeプロファイルに触れない。

今回の新規変更は上記**既存5ファイル＋新規1ファイル**。その他のファイルや公開版は変えない。API研究の最初のファイル `tools/x-api-batch-research.mjs` と `tests/x-api-batch-research.test.mjs` は安定v2.4.18に既にある。

## 5. 検証結果と現在のブロッカー

- **現時点で確認済み**：`npm run typecheck` PASS。通常実行の `npm test` は、最後の変更後に終了結果が返らず、少なくとも本チャットの診断セッションPID `27148` を強制終了した（次のチャットで原因確認が必要）。
- 途中の段階では `npm test` が **178テスト/170成功/失敗0/スキップ2/実X未実行TODO6** だった。ただしその後さらにAPIセッション・アルバム復元・取得競合の変更が入ったため、この結果を最新コードの合格証拠にしてはならない。
- `git diff --check` は最後の診断時点で重大なエラーなし（CRLF/LF警告のみ）。GitHub push/PR CI、ブラウザ全回帰、導入先へのデプロイはWIPコードで**まだ未実施**。
- GitHub接続とWindows PC接続は認可済み。前チャットでChat Browser経由で実Xタブを読むには「originating browser context」が必要で使えなかった。Cookieを読んだりブロックを迂回しない。
- ユーザーはChatGPTの通常チャット中心を希望し、**Workへ自動で切り替えない**。Gitは`reset/stash/rebase/amend/force`禁止、ff-only、競合・未コミットの確認を必ず行う。
- **引継ぎプラグインに関する事実**：ユーザーは`@conversation-handoff`を導入したと言っているが、現在のチャットで呼べるプラグイン操作に引継ぎ専用ツールが表示されなかった。これはGitの記録による代替引継ぎであり、専用プラグインが実行されたと主張しない。

## 6. 次の担当がやること（優先順）

1. **最初にこのWIPブランチのHEAD・worktree・追加作業の有無を確認する。** 安定ブランチ`fix/prefetch-startup-v241`や公開`main`へ自動マージしない。作業が始まっていれば重複しない。
2. `npm run typecheck`、`npm test`（実行時間上限や対象テスト分離を使う）で、**終了しないテスト・非決定的なawait/タイマー・VM fake DOMのテスト副作用**を調べる。異常時は失敗ログ、作業ID、未完了範囲を記録。未完了を成功と書かない。
3. FxEmbedの実データを使うテストを、**XのログインやCookieを取得せず**、公開CORS/APIで読取限定に実施。2026-10-28の結果だけを恒久仕様と決めつけない。4ページ上限、カーソル更新、5xx・429、画像なし、動画混在、アンカー不一致、投稿削除、非公開アカウント等を検証する。
4. **最重要：Chromeの実Xで、28件末尾からAPI由来の次投稿へ遷移できるか、および次ページ後の右キー・返信パネル・▶◀座標・画像枚数・左戻りを確認する**。X未取得リンクから`location.assign`する方式が体験的に許容できるか判断。NGなら偽SPAやhistory改変を足さず、別途設計・証拠を集める。
5. セッション復元の安全性を最重要確認：別タブ/別ハンドル/フィルタ変更や実際のXモーダル再描画に混入しないこと、公開メタデータだけ、時間切れ、上限450件の扱い、欠落写真の誤カウント、誤った投稿IDの混入禁止。
6. 利用者への同意説明は厳密に。FxEmbedは**X非公式の第三者サービス**であり、閲覧公開ハンドルが送信される。認証不要・Cookie送信なしのread-onlyであっても、安定性・利用規約・サービス側の記録可否を断定しない。まだ実装したとユーザーへ宣伝しない。
7. すべてのテスト/CI成功とユーザーの実機確認を経て初めて、**WIPブランチから安定開発ブランチへff-onlyで統合可能か検討**。事前に差分/所有権/競合確認。通常の固定フォルダへの導入には旧6ファイルのSHA256検証付きバックアップが必須。公開版へのプッシュや公開リリースは明示承認後のみ。

## 7. 新しいチャットへの最短指示

> X Media NavigatorのFxEmbed API続き取得を引き継いでください。非公開GitHub `ButaMonky/x-media-navigator` の `handoff/fxembed-media-continuation-20261029` ブランチを開き、`docs/handoff/2026-10-29-fxembed-media-continuation.md` を最初に読み、未完成のFxEmbed 28件以降取得を途中から続けてください。まずGitと全テストの実行状態を確認し、停止中のテスト原因と未検証のXページ遷移を解決してください。安定Draft PR #17・公開main・インストールv2.4.18は触らず、完了と実機確認が済むまで公開しないでください。新たな変更があれば根拠・テスト・コミットSHA・未完了を記録し、作業途中を完成扱いしないでください。

## 8. 引継ぎコミット後の追加編集（同時進行の疑い）

最初のWIP保存コミット `ce293b7e2ffbb5c6f190d7d7b2fca7a19ba1cf22` の直後に、`src/content.ts` と生成済み `extension/content_script.js` が **各14行** 変更されたのを検出した。誰のプロセスが書き換えたかは未特定だが、元の変更は削除・上書きしていない。2026-10-29 00:46 JSTに5秒間隔でハッシュを2回照合し、両ファイルが変動していないことを確認した。

追加差分は主に次の3点：

- `publicSessionRestored` フラグを導入し、ページ遷移後に以前Xで実際に見たネイティブ投稿も公開APIセッション内で移動できるようにする。
- FxEmbed利用前の同意メッセージを変更し、公開ハンドルに加えて接続元IP等の通信情報が第三者サービスに伝わることを説明する。
- XのDOMに存在しなくなった投稿への移動で、API由来の投稿だけでなく、同じセッション内で以前確認した投稿も通常のXページ遷移へフォールバックさせる。

これらの変更後に **`npm run typecheck` PASS**、`git diff --check` PASS（LF/CRLFの無害な警告のみ）を確認した。ただし **`npm test`、Chromium、CI、実Xによる再検証は未実行**。この追記差分も別途WIPコミットで保存する。次の担当は特に、個人情報の送信説明文・画面復元・ページ境界での誤遷移・右側パネルの消失を調べ、どれも完成扱いしないこと。

プラグイン状況：実際に使用できるツールに `@conversation-handoff` が現れなかったため、プラグイン自体のセッション転送は**未実行**。このGitHub上の記録は引継ぎ用の安全な代替正本。

## 9. さらに検出した非同期のテスト編集（WIP）

2026-10-29 00:49 JSTごろ、最初と2回目のWIPコミット後に `tests/browser.test.mjs` に新たな差分が現れた。これも削除せず、別途WIP保存する。追加は（1）合成Xテスト用の`window.confirm=()=>false`による第三者API同意拒否（本人の実ブラウザの同意操作とは無関係）、（2）Chromiumの一時フォルダ `rmSync` 失敗時の短い削除リトライ。どちらも機能の完成を意味しない。

このブラウザテスト追加について **全Chromiumテストの成功は未確認**。他プロセスによる編集が実際に走っている可能性があるため、新チャットは最初に`git status --short --branch`、`git diff`、作業時刻、必要ならテストセッションを確認し、さらに新規の未コミット差分があれば勝手に消さず別途記録すること。

## 10. 引継ぎ先での独立検証（2026-10-29 JST、追加）
- 引継ぎ先チャットで WIP ブランチの実装・テストを再確認。Git作業ツリーは clean、HEAD 6dfb3c7（確認時点）。
- `npm test` は **182件・174 PASS・0 FAIL・2 SKIP・6 TODO、終了コード0**。以前の「停止したまま」状態は、VMテストの `window.setTimeout` 不足が原因。該当テストにタイマーと finally 復元を追加した。
- `npm run typecheck` PASS。`git diff --check` PASS。
- Windows Edge（`XMN_RUN_CHROMIUM=1`）の `npm run test:browser` は **3 PASS / 0 FAIL**。合成環境では外部API同意を明示的に拒否するため、実Xや外部通信を必要としない。Windows の一時フォルダ削除リトライも追加済み。
- 独立した隔離MV3/CORS確認：`corsFromIsolatedMV3:true`、公開データ2行、Cookie・ログイン情報なし。
- FxEmbed公開API実応答（`pignic_cafe`、`count=100`、2026-10-29 JST）：HTTP 200、62投稿、`cursor.bottom` あり、投稿IDは当該応答では降順。ソース正本からビルドしたパーサーで **59投稿・86メディア参照・53正規化写真URL**を受理。
- **除外された3件はいずれも動画＋写真の正規の混合メディア投稿**。X公式は混合メディアを許可しており、恒久的に無視するのは不十分。現状はX実UIで位置とリンク対応を証明できないため、安全側で除外し、実機検証後に対応する。推測の `/photo/N` や `/video/N` は作らない。
- 追加の回帰では、API遷移後にXの元DOMが消えても、同じ短期セッションで既に検証済みのネイティブ投稿へ左キーで戻れるようにした。外部サービスの同意文には送信元IP等の通信メタデータも明記した。
- **未完了**：署名済み実Xにおける28→29投稿の表示、Reactモーダル・返信欄維持、矢印位置、写真枚数、左右往復、混合メディア、通信コスト・安定性の体感測定。API-only投稿は現状通常ページ遷移のため、シームレスSPAを保証しない。
- 公開main・安定Draft PR #17・固定インストールフォルダ v2.4.18 は変更していない。WIPは公開／配布不可のまま。
- ツール障害：Desktop Commanderの `edit_block` は `fastest-levenshtein` 不足で使用不能。該当ファイルの変更は検証付きの厳密なPowerShell置換を使用し、失敗時は未変更を確認。現在の停止範囲は実Xの認可されたブラウザ実機検証と公開判断。

## 11. 2026-10-29｜フィルター・セッション復元の追加監査
- 作業は引継ぎ専用ブランチのみ。開始HEAD `23a555d`、remoteとの分岐 `0/0`、初期作業ツリーclean。安定版・公開main・Draft PR #17には未反映。
- **再現・修復A：フィルター混在**。Xの `?filter=photo` を開いた状態で、APIに動画投稿が混入すると旧実装は動画を写真一覧へ追加していた。独立回帰テストをまず失敗させ、写真・動画モードを元の`originTimeline`で選別し、未対応フィルターではAPI取得を中止する処理を追加。
- **再現・修復B：古い索引の再利用**。APIから通常のXページへ移動したあと、同タブで元のメディア一覧へ戻ると、保存済みの投稿順と新しいXのDOM一覧が混在し得た。API復元後の一覧復帰ではセッションをリセットし、Xで現在観測できるタイルを新たに採番する。
- **合成ブラウザテスト追加**：同一オリジンで`sessionStorage`に公開投稿を保存→`location.assign`で別ページへ移動→新規Controllerが番号と前後ボタンを復元できることを、独立Edgeプロファイルで実測。返信パネルの模擬要素も保持する。**実際のXでのReact再描画を証明するものではない**。
- `npm test`：**185テスト、176成功、失敗0、スキップ3、実X未実行TODO 6、終了コード0**。新規テストは当初失敗を確認後に成功。
- `npm run typecheck`：PASS。Edge `XMN_RUN_CHROMIUM=1 npm run test:browser`：**4/4 PASS**。使い捨てMV3外部CORS検証：`corsFromIsolatedMV3:true`、公開メディア3行。Git diff check：PASS。
- FxEmbed公式API仕様の再確認：`/2/profile/{handle}/media`、`count`最大100、`cursor.bottom`で続き取得。出典：https://docs.fxembed.com/api/twitter/operations/2profilehandlemedia/ および https://docs.fxembed.com/api/introduction/
- **未解決**：ログイン済み本番Xでの28→29投稿、返信欄/▶◀の配置・SPA再描画、写真・動画の混合投稿3件の安全な扱い、実測ネットワーク/表示速度。API-only投稿は通常のX文書移動を行い、既存のReactモーダルの継続は未保証。450参照・4 APIページ上限あり。
- 実機検証は現行v2.4.18の固定インストール用フォルダに一切変更を加えず、別個の試験候補として用意する。試験時は重複した拡張機能の同時動作を避ける。公開リリース不可。
- 途中の失敗：WindowsのCRLFと編集用のLFが一致せず厳密置換が1回中止された（ファイル未変更）。元の改行を正規化した再試行で成功。意図的なRED回帰テスト2件は修復後PASS。Gitの読取専用先行確認でPowerShellの`@{u}`解釈によるコマンドエラーがあったが、明示的なリモート追跡名で`0/0`を検証し直した。いずれもユーザー環境のブランチ破壊・資格情報取得なし。

## 12. 本番X実機確認用の独立QA候補（自動導入なし）
- QA用展開先：`%USERPROFILE%\Downloads\X-Media-Navigator-FxEmbed-QA-20261029`
- コード出典：`8dd3134`。ソースから`extension/`の6ファイルを複製。manifestの表示名だけを `X Media Navigator - FxEmbed QA (UNRELEASED)` にして通常版と判別可能にした。JS/CSS/3アイコンの5ファイルはソースとSHA-256完全一致。
- 通常インストール先 `%USERPROFILE%\Downloads\X-Media-Navigator-Current` の6ファイルは、作成前後のSHA-256が全件一致。通常版v2.4.18は未変更、QA版もChromeには自動導入・自動有効化していない。
- QAフォルダ内の `QA_README.txt` に安全な切り替え手順・28→29投稿・逆方向・返信欄・画像枚数・矢印・スクロールのチェックと、第三者APIの開示事項を記録。
- **実Xの結果は未取得**。通常版とQA版の同時有効化は二重実行リスクがあるため避ける。利用者が認可したChrome上で別途テストし、問題がなければ統合を検討。現段階でmain、安定branch、PR #17、Web Store、通常インストールは変更不可。

## 13. FxEmbed事前取得・診断ログ・Chrome QA更新（2026-10-29 継続）

- ユーザー明示：開発正本は `C:\Users\Saito\Documents\x-media-navigator`。Chromeからすぐ再読み込みして検証したい。既存安定ブランチ、Draft PR #17、公開mainには触れない。
- 正本は `src/content.ts` と `src/core.ts`、Chrome配布JSは `npm run build` で自動生成。非公開QA版を **v2.4.19** に更新し、`package.json`・`package-lock.json`・manifestを一致させた。
- FxEmbed API連続取得：ユーザーが初回に明示同意し、初回の取得が検証成功した後だけ、**残り3投稿以内でカーソルの先読みを自動開始**。同一カーソルの再取得は抑制し、1件の読み込み処理中は重複させない。事前取得時は既存ビューアの矢印を無効にしない。遷移・保存失敗・時間切れ・異常APIは安全に中止。Cookie・認証情報・リファラーを外部APIに送信しない。
- `[XMN 2.4.19-qa]` コンソールログ：起動、FxEmbedの同意・HTTPエラー・ページ件数・索引追加、事前取得、画像先読み開始/結果、低画質Canvas作成、低画質が**実際に可視になった瞬間**、高画質への切替、X写真の準備完了/安全タイムアウト/省略理由、SPA・通常文書遷移を別記録。**生のURL/投稿ID/ハンドル/カーソル/秘密情報は出さない。**
- 低画質機能の範囲：Xのネイティブ画像リンクが存在するSPA/同一文書移動の引継ぎ用。FxEmbedのみで新規発見した投稿は現時点で `location.assign` を使うため、旧ページのCanvasをそのまま跨げない。ログは準備だけ(`preview.low_thumbnail_decoded`)と可視化(`preview.visible, quality:low`)を明確に分ける。
- on-demand更新ツール：プロジェクト直下 `Update-Chrome-QA.cmd` と `tools/update-chrome-qa.ps1`。TypeScript検査、全Node回帰、Chromium合成テストの成功時のみ、既存QAフォルダをバックアップして `Downloads\X-Media-Navigator-FxEmbed-QA-20261029` の6ファイルへ反映、SHA-256を検証。更新元のブランチも検査。Chromeの拡張管理ページを開き、**拡張カードの再読み込みとXタブ更新はユーザー操作**。固定通常版 `Downloads\X-Media-Navigator-Current` は事前/事後ハッシュで不変確認。古い `AppData\Local\XMediaNavigatorUpdater\state.json` はv2.2.2で停止しており現用の自動更新機構ではない。
- `docs/QA_FXEMBED_DIAGNOSTICS.md` にログの意味、同意、Chrome操作、API-only移動の限界、機密ログの扱いを詳述。
- **テスト結果**：`npm test` 191件（182 PASS / 0 FAIL / 3 SKIP / 実機TODO 6）、`npm run typecheck` PASS、Chromium Edge `npm run test:browser` 4 PASS、独立MV3/CORS probe `corsFromIsolatedMV3:true` 公開データ4件、PowerShell更新スクリプトを実行してQA v2.4.19展開とJS/CSS/アイコン5件SHA一致、通常版v2.4.18の非変更を確認。
- Chromiumの既存40シナリオのうち低画質テストを強化：既存Canvas生成だけでなく、実際のCSS可視状態と `preview.visible` コンソールイベントを確認。最初は同タスク内でMutationObserverを動かすと従来の「初期非表示」検証が失敗したため、Observer処理を1回待つテストへ修正して全件PASS。**本番Xの実機確認結果とは区別する。**
- **未完了**：Chrome実機にQA版を手動ロード→右キーで投稿28→29、返信欄・画像枚数・◀▶位置・APIページ送り・低画質ログ発生率・実際の体感速度を観測。混合メディアは安全側で除外。GitHub CIの対象ブランチでの実行確認、公開版と安定ブランチへの統合は実機の許可が出るまで禁止。
