# X Media Navigator — B2 タブ保存競合とE2E往復検証

- 作業ID：`XMN-B2-TAB-SESSION-RACE-20261030`
- 基準：`77d24e487a546a156a678a82df419c70839c6df6`
- 専用ブランチ：`task/xmn-b2-hardening-20261030`
- 作業場所：`%USERPROFILE%\Documents\x-media-navigator-b2-hardening-20261030`
- 既存R1〜R5、B0〜B3、450参照超のアーカイブ実装を再作成せず、
  未完了のWorker所有権競合を独立テストで再現して修正。
- 公開main、安定Draft PR #17、通常Chrome v2.4.18、
  旧QA v2.4.20、ユーザーのChromeプロファイルは変更しない。

## 独立でRED→GREENを確認した不具合

1. タブが閉じる途中で`consent.set`のストレージ書込が待機すると、
   タブ終了時の削除よりも書込完了が遅れ、
   **再利用されたタブIDへ旧プロフィールの同意が残る**競合。
   同意書込をタブ所有のキューに入れ、タブ削除がその完了を待つ。
2. 期限切れセッションの`session.get`が非同期で削除中、
   保存済みページが`manifest.activate`を終えても、
   古い読込の削除が新しく復元されたセッションを消してしまう。
   読取・書込・ページアクティブ化のタブ所有ロックを統一。
3. 同じXタブ内でプロフィールを切り替えた場合、古いプロフィールの
   保存結果の削除が、別プロフィールの新セッションを消す。
   Workerの全セッション処理を**タブ単位**で直列化し、
   正常な他プロフィールのセッションは読み取らず保持する。
4. 古いプロフィールの遅延`session.clear`が、新プロフィールの
   正常なセッションまで削除する。削除対象の所有者を確認し、
   そのプロフィールの保存物だけを対象とする。
5. 有効な別プロフィールの`session.get`に対し、
   関係ないプロフィールからの取得が`null`になるだけでなく、
   **元の有効データまで削除**する問題を修正。

### 保存設計

- 元のWorkerの`manifestKey(tab, profile)`は名前空間として維持。
  非同期処理ロックだけ`tabLockKey(tab)`に一本化。
- Worker権限は`storage`だけ。タブ全件アクセス権限・外部API権限を
  追加しない。サインイン情報、Cookie、閲覧URLは保存しない。
- X側ページ所有の旧`sessionStorage`を信用する経路は追加しない。
- 64ページ上限のWorker実物検証で、連続するページ境界の検査、
  64ページ目までの読出しと65ページ目の拒否を確認。
## 新しい実Chrome往復検証

- `tools/mv3-archive-roundtrip-smoke.mjs`と
  `npm run test:mv3:roundtrip`を追加。
- Chrome for Testingの一時プロファイルに実製品MV3 Workerと
  TypeScriptコンパイル済みContent Scriptを読み込む。
  **440件の既知参照と20件の外部API模擬応答**をWorkerに保存し、
  manifestの検証後、実際のフルドキュメント遷移で新ページ560へ移動。
- 新文書の本物の拡張操作パネル、既存の返信DOM、
  20件の保存済みページ、戻る矢印を検証。
  戻る矢印から旧ページ561へ戻り、manifest.activePage=0、
  440件・同じカーソル・返信欄・表示番号を再検証。
- テストのWorker origin制限変更は**使い捨てlocalhostコピーだけ**。
  もとのX/Twitter許可オリジンは変更していない。
- `crossDocumentNavigation:true`、
  `checkpointRolloverVerified:true`、`mv3Test:passed`を記録。
  Xの実サイトを閲覧したこと、完全SPAを達成したことは意味しない。
## 総合検証

- `npm test`：**321 tests / 312 PASS / 0 FAIL /
  3 SKIP / 実際のXに関するTODO 6**。
- `npm run typecheck`：Content Script/Service WorkerともPASS。
- `npm run test:browser`：独立Edge Chromium合成4 PASS。
- `npm run test:mv3`：Chrome for Testing・既存の保存ページ往復PASS。
- `npm run test:mv3:archive`：Chrome for Testing・440+20保存PASS。
- `npm run test:mv3:roundtrip`：Chrome for Testing・新しい自動保存から
  実文書往復／返信欄／状態復元までPASS。
- `npm run test:mv3:reject`：Edge実Workerの未許可送信元拒否PASS。
- テスト条件は合成URL・使い捨てプロファイル。実XのSPA、
  画像品質、CPU/RAM、HTTP転送サイズ、28→29の操作は未受入。

## 残りの作業と運用

- FxEmbedの外部API順序とXメディアタブの同一性は保証できない。
  不確かな混合メディア／写真枚数は推測せず停止する。
- B4の本番実測（描画フレーム、画像解像、転送、体感）、
  B5の認証済みXでの実機受入と公開判断は保留。
- 64ページ制限は安全側の上限で、超過時の保存・退避戦略は未実装。
- GitHub ActionsのNode/型検査/必須Chromium/生成JS一致を確認し、
  主開発正本へFF-onlyで統合する。元担当の未コミットworktreeは保護する。

## GitHub Actionsの初回FAIL・修復（必須Chromiumを維持）

- 初回コードコミット：`26ea869fee013ebe63cab8217267aaed59c235ad`。
  GitHub Actions run `41004745029`：**FAIL**。
  Node 321件とTypeScript検査は成功したが、Ubuntuの
  `tests/browser.test.mjs`長尺40シナリオで
  **`data-xmn-results`の結果マーカーが取得できなかった**。
  実行時間約2.4秒でDOM途中のダンプが返った。試験自体を緩和しない。
- 対応：`--virtual-time-budget=65000 --dump-dom`による一度きりの
  DOM取得を、この長尺テストだけ**実時間CDPの結果マーカー監視**に変更。
  Chrome専用の一時プロファイル・CDPポートを使い、
  同じ40条件すべてが完了するまで一定間隔で状態を確認。
  失敗、例外、結果不在は引き続き明確なFAIL。
- 別テストのCanvas・セッション復元の検証方法は変更しない。
  Chrome/Chromium必須CI品質ゲートを外さず、スキップもしない。
- Windows Chrome for Testing 156で、変更後の4ブラウザケースが
  **4 PASS／0 FAIL**。長尺ケースは実時間約33秒。
  Linux CIでの再検証は修復コミットpush後の結果を正本にする。
