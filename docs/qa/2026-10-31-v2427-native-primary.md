# X Media Navigator v2.4.27 — Xネイティブ優先・非公開QA受入記録

- 作業ID：XMN-NATIVE-PRIMARY-V2427-20261031
- 対象：非公開リポジトリ ButaMonky/x-media-navigator
- 開発ブランチ：feature/xmn-native-primary-v2427-20261031
- 安定版main、Draft PR #17、既存Chromeの認証情報・プロファイルを変更しない。
- 本資料は技術受入の記録。公開リリースや実Xでの100%完成を宣言しない。

## 方針と実装内容

- Xのメディア一覧で実際に確認できたネイティブ投稿リンクを移動の唯一の標準情報源とする。
- 右キー・左キーは投稿内の写真カルーセルを優先し、境界でのみ既知の前後投稿へ移動。Xが受け取るクリック・SPA・返信欄を維持する。
- 未知の次投稿では外部FxEmbedへの同意確認／公開APIの自動呼出し／先行取得を行わない。
- 旧FxEmbedの保存済みページ／Workerの履歴は通常起動・BFCacheで自動復元しない。第三者処理のコードは後方互換と回帰テスト用に残すが、非公開v2.4.27のユーザーUIから有効化できない。
- 未知の末尾では元のビューアとスクロール位置を変えず、Xメディア一覧でユーザー自身が続きを読み込むように案内する。旧来の背景自動スクロールは復活しない。
- 既知写真のCDN低並列先読み・短い低画質→高画質引継ぎ・省データ／オフライン制御・GIF/動画でXの純正操作優先は維持。
- 投稿位置は読み込み済みインデックス内の相対表示であり、アカウントの全投稿数ではない。外部APIの過去のカーソルでは「続きあり（+）」を表示しない。

## テスト・検証

- TypeScript build・JS syntax・typecheckはWindowsローカルで成功。
- ネイティブ用の3新規テストはPASS（標準起動で外部セッション復元しない／末尾で外部通信やモーダル変更なし／旧カーソルが表示を汚染しない）。
- 追加の固定フォルダ更新・バージョン・旧QAの安全性関連テストを含む対象20件PASS。
- 既存の合成XのEdgeブラウザ試験は4/4 PASS（左右、複数写真、SPAと返信欄、明示的スクロール後の再開、クロスオリジンCanvas表示、旧APIセッションの不使用）。
- 後方互換の外部API／保存ページの単体試験は新しい通常モードとは分離して、明示的なテストフラグで評価する。製品の自動API許可を意味しない。
- Windowsの全件テスト実行はテストプロセスが終了しなかったため、正式な終了コードを得られていない。CIによる同一コミットの全件・MV3検査を公開前に必須とする。未完了をPASSにしない。
- Chrome for TestingをPCへ再インストールせず、既存Microsoft Edgeを一時隔離プロフィールで使用した。通常のX・Cookie・ログイン済みブラウザをテストで操作しない。

## 更新配布と容量

- 新版のバージョンはmanifest v2.4.27、npm package/lock v2.4.27-dev.1。
- 今後は単一の固定フォルダ Downloads\X-Media-Navigator-Current のみ更新する。
- 新 Update-Chrome-Current.cmd は private GitHubの同一HEAD・CI成功、ローカルGit clean、TypeScript型・JS構文、7アセットのSHA256を検査する。
- 更新は一時ディレクトリへのコピー、Currentとの置換、SHA再検証で行う。成功後に一時ロールバックを削除。失敗時は旧Currentへ復元し、失敗成果は安全検査のため保存できる。
- 旧 Update-Chrome-QA.cmd は誤って別のFxEmbed QAフォルダを作らないように無効化。
- 非公開GitHubへ保管済みの旧版は再度ローカルに大量複製しない。公開mainへの統合やWeb Storeへのアップロードは自動で行わない。

## 未完了の公開ゲート

1. Windowsの実Xでv2.4.27を手動導入し、通常の写真1〜4、投稿境界、ネイティブSPA、右側返信、動画・GIF、末尾の読み込み案内を確認。
2. 外部APIの同意ダイアログも通信も発生しないこと、読み込み済みの次投稿では右キー1回で移動できることを確認。
3. Chrome版とFirefox版の元コード・アイコン等のライセンスと再配布条件を確認。Firefox版にMIT表記がある事実だけではChrome版のライセンスは断定しない。
4. 実Xで長大一覧、メモリ・通信量・描画の最終確認。全投稿の無制限取得・非公開投稿の発見は仕様として保証しない。

次の再開位置：GitHub CI成功→固定Currentを更新→Chrome拡張カード再読み込み→実X最終受入。重大な不合格時は新ブランチで記録し、公開mainを変更しない。

## CI修正記録・MV3移行（2026-10-31追記）

- Feature branch initially at bffe315aaf5d881c795f9d08fe31735c09013a85: GitHub Actions run 41094532945 failed in npm test because historical FxEmbed tests expected opt-in behavior without explicitly enabling it. Fix commit a169eca4bf2be0e55a9567d25ab22da1ac175038, keeping historical tests available only under explicit test flags.
- Run 41106715906 passed Node suite and isolated synthetic browser checks but failed at \`test:mv3:native\`: the original MV3 fixture was actually a **consented FxEmbed request and full-document restore**, incompatible with new native-only default. This was a stale acceptance assumption, not evidence of a real-X navigation failure.
- New required native MV3 fixture tests: at 28 known posts, right arrow keeps existing X-like viewer and replies while refusing external API and consent; after a user-simulated X media-grid append of the exact 29th native link, one right arrow activates the X-owned SPA link and retains the modal. No fabricated ID, hidden scroll, or third-party request. Isolated localhost, no logged-in X or browser credentials.
- Other three MV3 historical provider fixtures retain original consent/invalidation assertions but now set \`experimentalThirdPartyApiEnabled=true\` explicitly in their isolated test Controller.
- MV3 history and BFCache historical fixtures create a second explicitly opted-in isolated test Controller on restored pages. The normal production startup continues with the parameterless constructor, native-only by default. The opt-in constructor requires a private extension-side option and does not expose a user-facing switch or remove FxEmbed consent checks.
- Windows local \`npm run check\` and \`node --test --test-force-exit --test-concurrency=4 tests/*.test.mjs\`: **372 total / 363 PASS / 0 FAIL / 3 SKIP / 6 TODO**, exit 0. Chrome-for-Testing MV3 fixture changes must still pass GitHub CI before promotion.
## CI MV3第2パス（研究・修正）

- Run 41108218149: **新しいnative-only MV3 28→29試験PASS**。最初の境界ではAPI要求0・同意0・現ビューア維持、ユーザー追加の正規タイルを取得後、2回目の右キーでXネイティブSPAを1度だけ利用し29件目へ移動（実Xではなくlocalhost隔離Chrome for Testing）。
- 同じrunは次の歴史的4写真→次投稿のFxEmbed補助試験でFAIL: Worker内の32メディア参照は保存成功したが、v2.4.27既定モードが外部セッションを復元しないため、旧期待のカウンターと矢印は表示されなかった。これは標準ネイティブ動作の失敗ではなく、**レガシーテストの復元指定不足**。
- 4写真の後方互換試験に対し、クロスドキュメント遷移後だけ明示的な隔離QA用オプトインControllerを作成する修正を適用した。
- BFCache歴史試験は最初のページへ戻ったときにもページ側にオプトインControllerが必要なので、fixtureの起動時点から隔離QA用Controllerを作る（通常製品では既定OFFのまま）。品質検査を削除/skipしていない。
- この2修正は次のGitHub ActionsのMV3実拡張検査による受入が必要。最新の結果を確認するまで非公開開発正本やCurrentへの統合・更新は保留。