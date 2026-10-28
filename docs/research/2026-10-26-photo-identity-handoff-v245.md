# X Media Navigator v2.4.5 — SPA引継ぎの正しい写真の識別と描画待機

調査日：2026-10-26 / 基点：v2.4.4、commit f848834 / 非公開開発ブランチ fix/photo-identity-handoff-v245

## 静的監査で確定した問題

v2.4.4の `finishVisualHandoff(viewer)` は、Xの新しいモーダルから `querySelector('img[src]')` で最初の画像を選び、その画像の `complete && naturalWidth > 0` により視覚的な引継ぎレイヤーを解除していた。

これは、新しいモーダルが先にプロフィール画像・引用画像・別の写真を持つ場合に誤判定する可能性がある。また、Xが画像要素の `src` を先に更新しても `currentSrc` がまだ旧画像を表示する間があり、`src` の一致だけでは新写真の準備完了を意味しない。さらに `complete` はデコード完了の保証ではない。

これらは**静的コード上の可能な不具合**であり、ユーザーの「シームレス表示成功が半分程度」という体感報告の原因を実サイトで確定したものではない。

## AUD-038：X CDNメディアIDによる一致（CODE IMPLEMENTED）

- `src/core.ts` に副作用のない `photoCdnIdentity(url)` を追加。`https://pbs.twimg.com/media/<ID>` 形式のクエリサイズ（small/large/orig）・既知の拡張子形式の間で同一メディアIDを抽出する。プロフィール画像・外国ホスト・HTTP・認証情報付きURLは除外。
- 先読みを開始する既存の検証 `preloadImageUrl` は**緩めない**。メディアIDの取得は、Xの新しいビューアが既に表示している画像と先読み画像の一致を検査する用途に限る。
- 引継ぎ対象のメディアIDを保持し、Xのビューア内から**同じメディアIDの写真**だけを検索。別の画像が読み込み済みでも引継ぎ表示を早期解除しない。
- `img.currentSrc` が存在する場合は実表示候補として優先する。`src` に新写真のURLが設定されたが、`currentSrc` がまだ旧写真の場合は、準備完了として扱わない。 `currentSrc` が空の場合のみ `src` を検証する。

## AUD-039：デコード完了の確認（CODE IMPLEMENTED）

- Xの新しい写真がロード済み（`complete && naturalWidth > 0`）の場合でも、`HTMLImageElement.decode()` が利用できれば成功・失敗の解決まで待つ。成功時はその写真とソースURLを記録して、短い表示引継ぎ終了タイマーを実行する。
- 重複して呼ばれるMutationObserverでは同じ画像の `decode()` を二重に呼ばない。`src` や `currentSrc` が変更されたときの古いPromise完了も、新しい写真の完了と誤認しない。
- `decode()` が拒否されても、画像そのものが読み込めている場合はX標準の描画に戻す。従来どおり最大1.8秒でレイヤーを解除する安全タイムアウトを維持する。
- SPAの操作・Xの投稿欄・History・認証・内部GraphQLは書き換えない。新たな通信や権限は発生しない。

## 検証と残る重要な制約

- Node/FakeDOMで、先読みした写真とX側の別画像・アバターの区別、実表示`currentSrc`の旧→新切替、非同期デコードの重複防止、Promiseが旧画像のものである場合の保護を検証。
- 独立Chrome合成Xでは、次のモーダル内に**別の画像が先に存在する状況**を再現し、実際の写真メディアIDに一致した段階で引継ぎが終了することを検査。
- GitHub ActionsとPCのTypeScript型検査・Node・Chrome模擬検査は別々に確認する。**実サイトXのDOM構造・体感速度・成功率は依然未測定**。
- XがCSS背景や想定外の画像構造を使う場合、写真を識別できず、最長1.8秒のフェイルセーフで解除する可能性がある。X本番の画像選択子を確認後に調整する。
- 右の投稿・返信欄が再展開するアニメーションは、現在の「閉じる→次投稿を開く」方式に由来し、今回の変更では根本解消しない。

参考：
https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode
https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/currentSrc
https://github.com/PiesP/xcom-enhanced-gallery/blob/master/docs/media-sources.md

## AUD-040：同一DOM画像のsrc/srcset切替を即検出（CODE IMPLEMENTED）

既存のビューア監視は`childList:true`中心で、XのReactが同じ`img`を再利用し`src`だけ更新しても`finishVisualHandoff`が即座に呼ばれなかった。

`src/srcset`属性も監視し、画像URLの変更なら写真引継ぎ判定のみ再実行。画像や動画ノードの追加/削除の場合だけボタンの整合確認も実行し、拡張自身のボタン・ステータス表示更新では無駄な再構築を行わない。既存の安全タイムアウトは継続。

## AUD-041：描画待ち90msに別写真が現れる競合（CODE IMPLEMENTED）

デコード完了後、短い90msタイマーで引継ぎ画像を解除する間に、Xがさらに写真`currentSrc`を変更した場合、旧タイマーによって別写真が見える可能性があった。

タイマー実行時に、**ビューアと画像がまだ接続中・読み込み済みで、デコード時と同じURL/メディアIDを表示していること**を再検証。一致しない場合は解除せず次の写真を再評価し、1.8秒のフェイルセーフで最終解除する。

## AUD-042：キャンセル済みSPAのloadイベント待ちが残る（CODE IMPLEMENTED）

画像のロード待ちで`addEventListener('load', ..., {once:true})`を登録しても、loadが発生しないまま閉じれば、イベント監視が不要になっても残る恐れがあった。

対象画像にロード監視を最大1件だけ維持し、対象が変わった場合は古い監視を解除。モーダル引継ぎの終了時にはオブザーバーとロード監視を外す。`decode()`が後から解決しても`handoff`の一致を確認し、古い表示を再出現させない。

## テストの不具合と修復記録

- 初回の新規モックテストでは`handoff.generation`が不足し、期待したdecodeが始まらなかった（FIXED：必要な世代番号を追加）。
- load監視の削除処理を導入後、一部の模擬画像に`removeEventListener`実装がなくテスト失敗（FIXED：モックへ追加し、監視解除そのものの検証を追加）。
- SPA src再利用、別写真へ差替中の非同期完了、90msの描画競合、モーダル終了後のイベント解除、終了後の古いdecode無効化を回帰テストに追加。
- 終了判定：Node/FakeDOM **75 PASS / 0 FAIL / 1 SKIP / 6 TODO**、TypeScript型検査PASS。Chrome模擬試験とGitHub CIは別途チェック。X実機でのちらつき改善は**未確認**。

## AUD-043：視覚引継ぎオブザーバー初期化失敗の後片付け

`beginVisualHandoff`はDOMへのレイヤー追加と`handoff`状態の設定後、短命な`MutationObserver.observe()`を開始する。何らかの理由でobserveに失敗すると、従来のcatchではDOMのレイヤーだけ除去し、`handoff`参照とタイマーが約1.8秒残る可能性があった。

修正では、既に状態が設定済みなら`clearVisualHandoff()`を利用して**レイヤー・イベント監視・タイマー・参照を一括破棄**する。Observerが例外を投げる合成テストで、失敗後のhandoff=null、DOM要素なし、時間制限タイマー解除を確認した。

最新のローカル検査：Node/FakeDOM **76 PASS / 0 FAIL / 1 SKIP / 6 TODO**、型検査PASS。Chrome合成X試験・GitHub Actionsは最終コミットの検査結果を別途記録する。

ユーザーのX実サイトでは未検証。実際のXの画像URL形式、表示空白、右側投稿欄アニメーションの解消可否は引き続き保留。
