# 2026-10-26 調査：Chrome拡張の固定フォルダ運用とXギャラリー互換性

## 確認できた事実

1. Chrome公式の開発者ガイドでは、`chrome://extensions` のDeveloper Modeから展開済みフォルダを読み込む方式が示されている。
   https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world
2. Chromeの拡張機能アップデート機構はWeb Store配信の更新を確認する。PC上の任意フォルダをGitHubから取得する機能ではない。
   https://developer.chrome.com/docs/extensions/develop/concepts/extensions-update-lifecycle
3. X公式ヘルプでは、プロフィールのメディアタイムラインに写真・動画・GIFが表示されることを説明している。
   https://help.x.com/ja/using-x/view-all-x-pictures
4. 写真・動画の切り替えに `?filter=photo` が使われるWeb UI版の参考実装：
   https://github.com/stland6338/x-profile-tab-defaults （非公式・変更の可能性あり）。

## このリポジトリでの具体的な検査結果（SOURCE VERIFIED）

- 従来の`parseGalleryCounter`は「3枚中2枚目」を現在3／総数2と誤認し、検証で弾く。日本語の総数と現在位置を逆順にしていた。
- `NATIVE_NEXT` と `NATIVE_PREVIOUS` は「次の画像へ」「前の写真へ」などのラベルを判別できず、Xの標準ナビゲーションが有効でも検知できない場合がある。
- 無限スクロールでは `window.scrollTo` だけではネストされたスクロールコンテナへ届かない。表示中の最後のメディアタイルで `scrollIntoView` を優先すれば、ネストされたスクロール領域にも対応できる。
- Gitに記録された原本のSHA-256テストがLinux(LF)とWindows(CRLF)のチェックアウトで不一致。ハッシュ計算前にLFに正規化すれば同一の意味内容を両環境で検証できる。

## v2.2.3で行う修正

- 明示的なギャラリーカウンターの日本語表現と全角数字を正しく解析。範囲はX公式上限の4枚まで。
- 日本語・英語のネイティブ矢印ボタンの代表的な表記揺れに対応し、標準操作が可能なら拡張は横取りしない。
- 遅延読み込み時、ページ内で最後に見えるタイルの `scrollIntoView` を優先。見つからない場合のみ従来のWindowスクロールへフォールバックする。
- Node単体・モックDOMの回帰テストを追加し、Windowsでも原本整合性検査を通す。
- 15分間隔のPC自動同期は廃止。固定のChrome用フォルダに検証済みビルドだけを開発時に反映する。

## 未実施・制約

- Xにログイン済みの実ChromeでDOM・枚数表記・動画・URL・速度の実測：NOT RUN。
- `scrollIntoView` による実サイト無限スクロール成功率の検証：NOT RUN。
- 先読み`name=large`とXの実表示URLのキャッシュ一致検証：NOT RUN。
- 内部GraphQLや非公開認証情報の抽出・再送信は採用しない。
- Chromium模擬X検査やNodeのテストは本番Xでの動作保証ではない。
