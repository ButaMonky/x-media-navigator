# X Media Navigator: v2.4.26 公開前の原作者・ライセンス確認

確認日：2026-10-31 JST。これは根拠整理であって法律上の最終判断ではない。

## 確認した資料
- Firefox公式AMO: https://addons.mozilla.org/ja/firefox/addon/mediabutton/
  - タイトル：X(Twitter)のメディアページに「前のメディアへ」or「次のメディアへ」ボタンを追加
  - 表示上の作者：KT／バージョン1.3／最終更新2024-12-13／ライセンス**MIT**の記載あり。
  - バージョン履歴: https://addons.mozilla.org/ja/firefox/addon/mediabutton/versions/ ではv1.2／v1.3をMITとして表示。
- Chrome公式ストア識別子: `fkljpdamgibhefcblfeabdhkfenmbnik`。確認用URL: https://chromewebstore.google.com/detail/fkljpdamgibhefcblfeabdhkfenmbnik
  - 補助的な公表データ（Chrome Web Store由来）: https://extpose.com/ext/fkljpdamgibhefcblfeabdhkfenmbnik
  - 表示上の公開者は同じ**KT**、バージョン1.3、最終更新2024-12-13。名称／機能の説明がFirefox版と一致。
- 非公開研究元: `upstream/chrome-v1.3/`。Chrome実機の旧版を保存したスナップショット。
  - フォルダには `content_script.js`、`style.css`、アイコン、manifestなどがあり、**LICENSEファイルは含まれていない**。
  - この状況は「Chrome版のソースコードがMITに従って公開されている」という直接証拠ではない。

## 公開の判断
- **確認できたこと**：Firefox版のMIT表示とChrome版の同一作者・同一題名・同一バージョン。
- **未確認**：両ブラウザ配布物のソースの完全一致、Chrome版の正式な再配布ライセンス通知、原版由来コード・アイコン・その他同梱アセットの個別出所。
- よって「Firefox側にMIT記載がある」ことだけを根拠にChrome版も包括的にMITだと断定しない。
- 個人の非公開QA試験は継続可能。一般公開／再配布に進む前に、Firefox 1.3ソースとChrome保存原本の実バイト・構造比較、クレジット／MIT著作権表示の同梱可否、必要なら公開者への確認を行う。
- `upstream/chrome-v1.3` の元コードを削除・置換しない。出所と帰属表示を保護する。
- 既存Web Store拡張への自動上書き、Chrome拡張IDのなりすまし、公開`main`への無断統合は行わない。

関連する実機受入: `docs/qa/2026-10-31-v2426-user-live-acceptance.md`。
