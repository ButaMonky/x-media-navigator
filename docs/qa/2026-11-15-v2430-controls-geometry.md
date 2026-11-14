# v2.4.30 非公開QA — Viewer認識済みでもボタンが消える問題の追加修復

作業ID: XMN-CONTROLS-GEOMETRY-20261115。対象: 非公開リポジトリ、Issue #18。公開mainとWeb Storeは変更しない。

## 利用者の実機ログで確定できたこと
- XMN 2.4.29-dev の startup が存在し、未起動・旧版起動という仮説は否定された。
- MEDIA_INDEX_READY と VIEWER_READY の後、先読み成功が複数記録されている。
- しかし実機では左右ボタンが表示されない。以前の VIEWER_READY はボタンが見えるかの検査ではなかった。
- 多数の ERR_BLOCKED_BY_CLIENT は一部通信がブロックされているものの、先読み自体は成功。content-script-start.js の例外はWindows上のAdGuard AdBlocker由来と一致。これをXMNの直接原因と断定しない。
- 実ユーザーの投稿URL・ハンドル・投稿ID・HAR・Cookie・トークンはGitHubに保存しない。

## 原因候補のコード・実装
- src/content.ts の positionControls() は画像要素の画面内幅150px未満または高さ120px未満のとき controlsHost.style.display='none' にしていた。
- 画像要素は認識できるため、旧コードでは無条件に VIEWER_READY と報告し、ボタンが隠れていても「認識成功」の表示になる。
- 新版ではまず従来の画像領域を優先し、狭い・アニメーション中・画面外クリップで無効なら**同じXダイアログの十分な画面内領域**にアンカーする。ダイアログも検証不能なら安全停止。
- CSSホストを最大z-indexへ変更し、ボタン以外がX操作を妨げない pointer-events:none は維持。
- VIEWER_READY を無条件に出さず、CONTROLS_LAYOUT_OK、CONTROLS_HIDDEN_GEOMETRY、CONTROLS_STYLE_HIDDEN、CONTROLS_NOT_MOUNTED を診断ポップアップに表示する。コード・版・時刻のみ保存する。
- CONTROLS_LAYOUT_OK はCSSと位置検査が通ったことを示すが、別拡張のオーバーレイによる重なりまで保証しない。
- FxEmbed外部API既定OFF、Xネイティブ移動、5～20メディア対応、返信欄、旧UIは維持。

## テストと受入
- tests/controls-visibility.test.mjs で非表示・ボタン不足・正常の診断区別を検証。
- tests/browser.test.mjs に画像領域が幅100px・高さ240pxで、周囲ダイアログが大きい模擬Xを追加。旧版ならホスト display:none、新版は左右ボタン2つを可視な領域へ配置する。
- Node/TypeScript、Edge隔離Chromium、GitHub Actionsの結果はIssue #18に記録する。
- Documents/x-media-navigator/extension と Downloads/X-Media-Navigator-Current のみを更新する。バックアップは非公開GitHubで管理。
- Chromeで拡張機能カードおよびXタブを再読み込みし、Mediaタブから画像を開いて診断コードとボタンを確認する。
- 実Xの受入が済むまでIssueをOpenに保ち、正式公開や100%完成を宣言しない。
