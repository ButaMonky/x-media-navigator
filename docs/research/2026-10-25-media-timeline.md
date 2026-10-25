# Xメディアタブ・ギャラリー・先読み調査（2026-10-25）

## 結論（研究根拠を区別する）

1. XのWeb UIには、メディアタブの写真を `/{user}/media?filter=photo` で選択する版が存在する (外部のオープンソース拡張で確認)。これは仕様保証ではない。出典: https://github.com/stland6338/x-profile-tab-defaults と https://chromewebstore.google.com/detail/photos-first-for-x/enkgkhmajfdojmdgfkmjnnegkhhigpli
2. Xのメディアタイムラインは写真・動画・GIFを表示する。X公式: https://help.x.com/en/using-x/view-all-x-pictures
3. 投稿に添付できるメディアの最大数は4。表示上の一部だけから「2/2」と推測することはできない。X公式: https://help.x.com/en/using-x/how-to-post
4. Chrome拡張Content ScriptはISOLATED WORLDで実行でき、ページ変数や独自APIに侵入せずDOMだけで作業可能。Chrome公式: https://developer.chrome.com/docs/extensions/mv3/content_scripts/
5. `HTMLImageElement.decode()`は画像の事前デコードに使えるが、Xの表示URLと先読みURLが一致するか、ブラウザが再利用するかは別途実測が必要。MDN: https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode
6. `fetchPriority="low"`は優先度ヒントであり通信量/タイミングを保証しない。MDN: https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/fetchPriority
7. 参考実装としてX.com Enhanced Galleryの機能分離・TypeScript使用を確認。直接ソースは流用していない。https://github.com/PiesP/xcom-enhanced-gallery

## ソース監査で発見したv2.1の具体的な問題（SOURCE VERIFIED）

- AUD-010: 画面が `/alice/media` → `/alice/media?filter=photo` に変わっても `pathname` が同じため一覧が混在し得る。さらにSPAはURLが先に切り替わりDOM更新が遅延する。
- AUD-011: 元 `photoCount()` は記事中の `photo/1` だけを見た場合でも `1`、`photo/1..2` を見た場合でも `2` と確定し、実際は4枚の投稿でも「最後」と誤認し得る。
- AUD-012: 先読み対象は最大2件だが、`imageSources` はタイムラインの走査に応じて無制限に保持する。

## v2.2で採用した修正（CODE IMPLEMENTED）

- `mediaTimelineKey`: 大文字小文字・トラッキングパラメータを正規化し、`filter`値が変わったらセッションを分離。
- DOMの旧画像リストと新リストを区別する保留状態を持ち、タイルノードまたはリンクの内容に差が現れるまで以前の一覧を流用しない。新旧タブで全く同じDOMを再利用する場合は自動移動を保留して安全側に倒す。
- 確認された写真総数の条件を強める。画像4枚（X上限）全部のURLが分かる場合、または現在位置と一致する明示カウンター（例: `Image 2 of 2`）からのみ判断。1〜3枚が可視というだけでは総数は確定しない。
- Thumbnail URL Mapの容量を128件に制限。先読み実画像は同時最大2枚。`decode`の失敗を例外未処理にしない。

## 未解決・実機で調べること（NOT VERIFIED LIVE X）

- 実際の2026年版Webの写真・動画フィルターの値、同一DOM再利用の有無、`aria-label`の画像総数表示位置。
- X独自の画像切り替えコントロールがラベルを持たない場合、今回の安全側判定では投稿間移動できないケースが残る。
- 先読みの`name=large`がX表示時URLと一致するか、ブラウザCache hit率とメモリ量。ネットワーク記録が必要。
- 画像4枚以外で明示的なカウンターが取得できない場合、投稿境界を確定する別の方法を検討する。
- インストール済みChrome v1.3は変更しない。TypeScript版は別の非公開ブランチでテストする。

## 安全・権限上の原則

内部GraphQLのエンドポイント・queryIdは非公開で変化する。ログインCookie、CSRFトークン、Authorizationを収集・送信しない。メディアデータの外部保存を行わず、拡張機能の権限増加を要求しない。
