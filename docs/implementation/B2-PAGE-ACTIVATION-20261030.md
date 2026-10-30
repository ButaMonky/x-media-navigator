# B2 保存済みページの認証済みアクティブ化

- 作業ID: `XMN-B2-TRANSITION-20261030`
- ブランチ: `task/xmn-b2-page-20261030`
- 基準: 主開発正本 `3bd229d`（既存R1〜R5/B0〜B3再実行なし）
- 元の `x-media-navigator-b2-transition` 未コミット成果を**閲覧だけ**して、
  作業成果と仕様の互換性を検証した。元作業ツリーは一切編集しない。
- 既存非公開v2.4.21開発コードのみ。公開main、通常Chrome
  v2.4.18、非公開QA v2.4.20、安定Draft PR #17は変更しない。

## 変更内容

- `manifest.activate` は、以前に確定した連続ページの直後/直前だけ、
  現在のタブ/プロフィール/先頭フレーム/同意/正確なX URLを照合する。
- メディア数・カーソル・時系列・64ページ上限・不変な保存済みデータを
  Workerで再検証し、manifest.activePageと短期sessionを1回のstorage.setで保存。
- `manifest.put` によるアクティブページの飛び越し変更を拒否。
  `checkpoint.adjacent` は実際のactivePageからのみ移動を許可。
- 戻り先投稿に複数写真がある場合は、**最後の写真ではなく最後の投稿の最初の写真**を
  対象にする。プラン作成時のURLは仮候補であり、Workerが完全な保存済み
  メディア配列に照合した場合にのみページ変更を許可する。
- `restorePublicMediaSession()` は新文書に到着した後でのみページをアクティブ化し、
  旧URLや別タブの情報から実際のX画面を書き換えない。
- 旧Workerからの明示的な拒否や不正カーソルでは移動しない。
  視覚的にシームレスなSPA遷移は実装していない。

## 検証記録

- 変更前のNode Workerテスト2件が、強化したactivePage契約によってRED。
  Worker経由の認証済みページ切替へ契約を更新後、成功。
- 追加：`tests/b2-boundary-transition.test.mjs`（独立プラン検査）、
  `tests/session-worker.test.mjs`の厳密な不正遷移・再試行・別タブ拒否試験。
- `npm test`: 296件、287 PASS、0 FAIL、3 SKIP、6件は実X TODO。
- `npm run typecheck`: PASS。Edge合成Chromium 4 PASS。
- `npm run test:mv3`: 実Chrome for Testingの一時MV3で
  2ページの往復・認証済みWorker・同意・返信欄保持を検証してPASS。
- `npm run test:mv3:reject`: 実EdgeのMV3で未認可元の拒否PASS。
- 認証済みXサイトでのDOM/React遷移、実通信・描画・速度は未受入。
## 制約・次工程

- まだ作成済みの保存ページへの移動だけであり、
  **450参照超で新しいページを自動アーカイブ/確定する機能は未完成**。
- 次工程は完全投稿グループを保持したカーソルページの保存、
  期限と衝突の再検証、上限時の切替で、完了前の公開は禁止。
- MV3 storageの`session.set`単独書込との競合がないことを確認する。
  アクティブページが確定済みなら外部から異なるセッションを上書きしない。
- 安全拒否・失敗が起これば、作業IDと再開位置をこの資料へ追記する。
