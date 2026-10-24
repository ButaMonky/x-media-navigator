# v1.3 関数・イベントマップ (静的解析)

対象: `upstream/chrome-v1.3/content_script.js`、502行、IIFE内部に名前付き関数21個。

## ページ監視・状態
- `isMediaPage` (24): `/media` または `/status/` のパス判定
- `onMediaPageLoad` (31): 状態初期化・500msタイル定期走査
- `onExitMediaPage` (54) / `resetAllState` (63): リスナー・Observer・タイマーの一部を解除
- `getCurrentAccountName` (92) / `checkAccountChange` (100): URL先頭パスによるアカウント判定
- `resetTileNumbers` (112): オーバーレイとMapのクリア (カウンター未初期化)
- `monitorURLChange` (451): 100msのpathnameポーリング

## タイル抽出・描画
- `addAbsoluteNumbersToTiles` (125): グローバルな `li[role=listitem]` 抽出とID採番
- `setCurrentTileNumber` (292): statusId→タイル番号
- `navigateToTile` (301): 整数位置で保存済みDOMリンクをクリック
- `displayCurrentTileNumber` (323) / `updateNavigationButtons` (341): 表示とスタイル更新
- `loadMoreTiles` (368), 内部 `onScroll` (378): スクロール後300msで読み込み済み扱い

## メディアビューア・操作
- `checkAndAddButtons` (164), 内部 `tryAddingButtons` (168): ビューアDOM待機
- `observeMediaViewer` (204): `MutationObserver` でUI復旧・キーボード登録
- `addNavigationButtons` (227): ◀/▶クリックの投稿ナビゲーション
- `closeMediaAndThen` (276): 日本語ラベルの閉じるボタンと固定300ms待機
- `handleKeyDown` (398): 左右キーをキャプチャ段階で奪い、同じ投稿の画像位置を見ずに前後のタイルへ

## 全体像
1. URLポーリングでページ・ビューア遷移を検知。
2. `li[role=listitem]` のリンクから `statusId` を集め、タイル番号とDOM要素をキャッシュ。
3. メディアビューアに2個のDOMボタンを注入し、左右キーをcaptureで取得。
4. 移動時はビューアを閉じ、固定時間待機し、保存されたDOM要素のリンクをクリック。

## 静的安全性チェック
- `content_script.js` には `fetch` / `XMLHttpRequest` / `sendBeacon` / `chrome.storage` / `localStorage` / `eval` の呼び出しを発見せず。
- これはコード上の簡易文字列検査であり、拡張全体・ブラウザ環境の安全性を保証しない。
- 現行XのDOMと照合できていないため、各セレクタの寿命は未検証。
