# X Media Navigator — B3非同期保存競合の独立修正（2026-10-30）

- 作業ID: `XMN-B3-PERSISTENCE-ABORT-RACE-20261030`
- 独立作業ブランチ: `task/xmn-b5-qa-synthetic-20261030`
- 開始元: `e93c3234e87029a438c8d14904d6311869b93be9`（B0–B3開発候補）
- 状態: **ローカル修正・合成検証済み／実際のXは未検証**
- 対象: `src/content.ts`、生成`extension/content_script.js`、新規回帰テストのみ。
- 公開`main`、安定`fix/prefetch-startup-v241`、Draft PR #17、
  Chromeの通常版v2.4.18／QA版v2.4.20、他担当の作業ツリーは変更しない。

## 再現した不具合

`loadPublicMediaContinuation()`は、取得した候補を`refs/indexes`と
`publicApiCursor`へ先に反映し、その後にMV3 Workerへ非同期保存していた。
保存待ちでタブが非表示となると`stillSameSession()`がfalseになり
戻り値は失敗なのに、**追加されたAPI参照・カーソル・末尾判定が残留**した。
ゼロ件の正当な終端レスポンスでも、同じ競合で
`exhausted=true`が未確定のまま残った。
## 修正内容

- 変更前の参照・カーソル・終端・写真状態を保持し、
  保存完了後にタブ非表示／ルート変更等で失効したドラフトを巻き戻す。
- Worker保存が失敗した通常経路も同じ巻戻し関数を使用する。
- セッション世代・プロフィール・タイムライン・参照配列・索引所有者を
  再照合し、新しいセッションの参照を古い非同期処理で破壊しない。
- 想定外のネイティブ索引追加で件数が変わった場合は、
  無関係な参照をまとめて削除しない安全側の判断を維持。
- 新規`tests/b3-storage-commit-race.test.mjs`の3件で
  追加参照の取消し・偽の終端取消し・新セッション非干渉を検証。

## 検証と再現

- 修正前：3件中1 PASS、**2 RED**。API追加が残留、
  ゼロ件終端のカーソルが`null`に化ける状態を再現。
- 修正後：3件PASS／0 FAIL。
- `npm test`：285件、276 PASS／0 FAIL／3 SKIP／6実X TODO。
- `npm run typecheck`：PASS（Content＋Worker）。
- `XMN_RUN_CHROMIUM=1 npm run test:browser`：4 PASS／0 FAIL。
- `npm run test:mv3`：Chrome for Testing・実Worker連携PASS。
- `npm run test:mv3:reject`：隔離Edge・外部元拒否PASS。
- `git diff --check`：PASS。ビルド出力はTypeScriptから再生成。
## 残る制約・次の再開位置

- タブを隠す直前に**Workerが保存を完了済み**の場合、
  今回の処理はローカルの未受入状態を巻き戻すが、
  `chrome.storage.session`に検証済みの新しいスナップショットが
  残る可能性がある。厳密な二相コミット／CAS・世代付き保存は
  B2ページ遷移状態機械の統合時に設計する。
- 同じ保存待機中にネイティブ一覧が新しく追加された場合、
  無関係な索引を破壊しないことを優先し、
  完全な同時更新トランザクションまでは保証しない。
- 既存の450参照制限・B2双方向ページ送り・本番Xの28→29、
  返信欄の画面保持・画像実Paint/速度・公開受入は未完了。
- B2隣接ページ担当の未コミット変更と競合させない。
  統合時は必ずブランチ差分を照合し、新しいコード上でも回帰試験する。

## 失敗・復旧記録

- 新規worktree作成で短縮SHAを誤記（`e93c323aa`）し停止。
  参照先の完全SHAを読み直して**独立worktreeを正常作成**。
- 一時的なローカル変更スクリプトで正規表現の改行解釈による
  Node構文エラーが発生。ソース変更前に停止したため、
  一時スクリプトだけ修正・再実行し、修正スクリプトは削除。
- どちらも公開版・既存作業ツリー・Chrome環境に影響なし。

## GitHub保存・クラウドCI

- 修正コミット: `9fe6a0e3f93d1c85ddbebdb6ed87a10d5d76515d`
  （`task/xmn-b5-qa-synthetic-20261030`へpush済み）。
- GitHub Actions `TypeScript check`: run `40915164292` **SUCCESS**。
  同runは非公開タスクブランチのpushを対象にし、
  実Xでの検証を意味しない。
- 本成果はFF-onlyの主開発候補へは未統合。
  同時進行中のB2ページング実装の未保存変更を保持している。
