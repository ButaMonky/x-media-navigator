# XメディアのSPA遷移・先読み・DOM保全：追加調査（2026-10-25）

## 一次ソースと観測範囲

- X公式のメディアタイムライン説明: https://help.x.com/ja/using-x/view-all-x-pictures 。写真・動画・GIFの時系列一覧が対象。タブURLのクエリ値は公式の安定したAPI契約とはみなさない。
- MDN Resource Timing: https://developer.mozilla.org/ja/docs/Web/API/Performance_API/Resource_timing 。画像の転送時間、キャッシュ指標の測定方法。CDNとのオリジンが異なる場合、Timing-Allow-Originがなければ一部の詳細がゼロになる。
- MDN fetchPriority: https://developer.mozilla.org/ja/docs/Web/API/HTMLImageElement/fetchPriority 。低優先度指定はヒントであり転送速度やキャッシュヒットを保証しない。
- X.com Enhanced Gallery: https://github.com/PiesP/xcom-enhanced-gallery 。MITの独立実装。 `docs/media-sources.md` では「表示に使うURL」と「保存時の高画質URL」を明確に分離し、DOMフォールバックの画像は実際に観測したURLを採用する。実装は参照のみでコード転載なし。

## 具体的なコード監査結果（v2.2基準）

### AUD-014 / 確定：DOM仮想化でモーダル喪失の可能性
`Controller.navigate` は以前観測した `refs` に移動先があると、ビューアを先に閉じてから現在のDOMからリンクを探していた。Xが一覧項目を仮想化・再生成してリンクがない場合、移動失敗と再オープン失敗が同時に起こり得る。
**v2.2.1実装**：すでに存在が判明している移動先は、閉じる前にライブDOM上のリンクを再検証。なければビューアを維持して終了。未知の次ページへの遅延読み込みは従来の安全な待機処理を維持。

### AUD-015 / 確定：フィルターの非同期変更が移動中に起こり得る
`navigate` はビューアを閉じた後、プロフィール名だけを比較し、メディア一覧の `?filter=...` 差分を検査していなかった。URL更新とDOM再描画の競合時に古い一覧をクリックするリスク。
**v2.2.1実装**：終了時点の `mediaTimelineKey` が移動開始前の一覧キーと一致する場合だけクリック。異なると通知して中止。

## 先読みの実測計画（NOT RUN ON LIVE X）

1. 検証用Chromeプロフィールで、ストア版と開発版を同時に有効化しない。
2. DevTools NetworkのDisable cacheを**オフ**にし、利用者の操作（画像→次の画像、最終画像→次投稿）でどの `pbs.twimg.com/media/` URLを取得するか記録。
3. `name=small` から `name=large` に書き換えた先読みURLが、実際の表示URLと完全一致しているか比較。別サイズならHTTPキャッシュ共有による高速化は未保証。
4. 前後の各2枚以下の画像と遅延時間を比較する。同じ画像のリクエスト数や転送量も記録。
5. PerformanceResourceTimingのtransferSize等がCDN跨ぎで制限される場合、転送量が0という値のみでキャッシュヒットとは判定しない。NetworkパネルのTransfer Sizeで照合する。
6. 本番Xで動画・GIF、2〜3枚写真、仮想スクロール、写真/動画の切替を検証。必要な証拠だけ記録し、Cookie・Authorizationヘッダー・個人情報は保存しない。

## アーキテクチャ判断

- 内部GraphQLは調査資料として参照可能だが、本拡張はAPIリクエストの再実行、X内部認証の抽出、ページスクリプトのフックを**実装しない**。
- DOM／閲覧セッションのキャッシュを唯一のナビゲーション根拠にする場合、DOMが仮想化されて消えたときは「推測で開く」より「現在の画像を維持」を選ぶ。
- プレフェッチの枚数拡大や独自ビューア化は、キャッシュURL一致と描画待ち時間の実測を経て判断する。
- 今回のコード所見はSOURCE VERIFIED、変更はCODE IMPLEMENTED。Node/Chromiumのテスト結果はCIの実行を確認するまで別扱い。X実機の結果は未取得。
