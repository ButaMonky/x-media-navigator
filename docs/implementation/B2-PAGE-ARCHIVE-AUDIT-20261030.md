# X Media Navigator｜B2 450参照超ページング受入・非公開

- 作業ID：`XMN-B2-PAGE-ARCHIVE-AUDIT-20261030`
- 独立ブランチ：`task/xmn-b2-page-audit-20261030`
- 親コミット：`5ff5251417052cd4aa40b89e54a226317d531969`
- 同時編集中の`x-media-navigator-b2-page-20261030`を上書きせず、
  既存の未コミットTypeScript・テスト・生成JSをSHA照合して
  別worktreeに差分移植。元作業ツリーは変更していない。
- 安定main、Draft PR #17、公開版、通常Chrome v2.4.18、
  既存QA v2.4.20、Chromeプロフィールの変更は禁止・未実施。

## B2の進捗（非公開実装・合成試験）

- 450参照付近で、現在の完結した投稿群と公開APIの続きを
  同じ索引配列に強引に押し込まず、**投稿単位で独立スナップショット**
  としてWorkerに保存し、manifestを最後に公開する。
- ソースの正当なカーソル、投稿順、添付番号、画像CDNを検査。
  元の表示・返信欄を保持し、保存完了まで旧ウィンドウを退避しない。
- 現在のコミット済みページから次・前のページへ進むときも
  Xの実URLへの通常文書移動を使用。Historyの偽装や非公開GraphQL
  の直接呼び出しはしない。
- 合成450件→次10件、440件→次20件、2ページ→3ページ、
  カーソル逆転・未完成アルバム・保存失敗を回帰試験で確認。
## 今回新たに修正した競合と状態誤認

- **R-B2-REPEAT**：保存済みの次ページを再取得しても、新規項目が0件で
  カーソル終端だからと**現在のページまで`exhausted`扱いにしない**。
  既に次ページを持つmanifestのactivePageを確認して判断する。
  RED（falseを期待してtrue）→修正後GREEN。
- **R-B2-SESSION-METADATA**：manifest確定後にブラウザの画像解像や
  サムネイルURL・PhotoTotalが更新されると、Workerの完全一致が
  `session.set`を拒否して通常のページ内移動が止まる可能性があった。
  URL・投稿順・所有者・カーソル等の不変な**メディア同一性**だけが
  一致すれば、新しいTTL/画像キャッシュの保存は行わず成功を返す。
  既存の不変なcheckpointも実際の保存セッションも書き換えない。
  不正な参照・別ページ・別プロフィール・保存期限切れは従来どおり拒否。
  画像キャッシュを実際に変更したRED試験→修正後GREEN。
- 450参照の回帰テストは外部API`count=100`の現実的な単一応答範囲に
  合わせ、10投稿の正常cursor前進で検証。誤った2投稿cursor再利用
  モックによる初回REDは試験データの問題として修正した。

## 検査結果

- `npm test`：**315件／309 PASS／0 FAIL／0 SKIP／6 本番X TODO**
- `npm run typecheck`：Content Script・MV3 WorkerともPASS
- `npm run test:browser`：独立Edge Chromiumの合成X 4/4 PASS
- `npm run test:mv3`：Chrome for Testingの実MV3 Workerで
  ページ往復・返信欄DOM・拡張同意・正当な復元を検査しPASS
- `npm run test:mv3:reject`：独立Edge実MV3で不正送信元拒否PASS
- 型検査・ビルド・構造検査は実サイトの画面描画速度を証明しない。
## 未完了・次回再開位置

- まだ認証済みX実機での28→29、450→451、写真1〜4枚、
  GIF/動画混在、右返信欄、低画質仮表示から高画質への遷移を
  観測していない。完全SPA・実PaintとHTTPキャッシュの受入不可。
- 非公開FxEmbedのカーソル情報はX本体の媒体順序を保証せず、
  混合メディアや欠落データを推測で補わない。
- APIに十分な確証がなく`preparePublicContinuationPage`が拒否
  した場合は現在のX表示と履歴を保ち、投稿を飛ばさない。
- manifest保存の直後にタブを隠したときのクライアント再照合、
  保存領域のquota、満杯64ページ時の退避方針、
  期限切れからの安全な再同意を継続検証する。
- 本成果を保存後、GitHub ActionsのNode/TypeScript/必須Chromium
  ・生成JS完全一致まで確認し、**FF-onlyで主開発正本へ統合**する。
  他の担当の未コミット成果は消去しない。
