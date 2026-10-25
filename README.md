# X Media Navigator — TypeScript rebuild (private beta)

X (Twitter) プロフィールのメディアタブから開いた画像・動画を、一覧順に移動する非公式Chrome拡張機能の開発版です。

**状態:** TypeScriptリファクタリングの検証ブランチ。**X実サイトでの動作確認が済むまでリリース不可**。既存のChromeウェブストア版は書き換えません。

## 操作

| 操作 | 挙動 |
| --- | --- |
| `←` / `→` | **X本来の動作を優先**。投稿内の画像切替・動画操作を乗っ取らない |
| `Shift + ←` / `Shift + →` | 前後の**メディア一覧タイル**に移動 |
| 画面上の `◀` / `▶` | 前後の一覧タイルに移動 |

`/ユーザー名/media` の一覧から開いたビューアでのみ動きます。別プロフィールの投稿や通常の投稿ビューアでは勝手に動きません。

## ディレクトリ構成

- `src/core.ts` — URL・メディア識別子・ショートカットの純粋ロジック
- `src/content.ts` — 状態管理、DOM監視、ナビゲーションの実装
- `extension/` — Chromeが直接読み込む配布用ディレクトリ。JavaScriptは**自動生成**。
- `upstream/chrome-v1.3/` — Chrome v1.3の参照用スナップショット。**編集禁止**。
- `tests/` — 単体・模擬DOM・任意のChromiumテスト
- `docs/analysis/` — 初期コード監査・呼び出し関係
- `docs/MIGRATION_V2.md` — 変更点・リスク・検証の段階
- `docs/IDEAS.md` — 利便性改善の優先順位

## 開発・テスト

Node.js 20以上が必要です。

```sh
npm install
npm run build
npm test
npm run check
```

Chromeの拡張機能として読み込むのは **`extension/`** です。TypeScriptファイルを直接読み込むことはできません。
開発版をテストするときはChromeの「デベロッパーモード」から「パッケージ化されていない拡張機能を読み込む」を選択してください。**元のストア版は一時的に無効化**してください。

`XMN_RUN_CHROMIUM=1 npm run test:browser` は、Chromiumが利用できる環境でのみ動く任意の擬似X統合テストです。Xの実サイト検証とは異なります。

## 維持すべき原則

1. TypeScriptを単一の開発正本とし、`extension/content_script.js` は毎回ビルドで更新する。
2. Chrome配布済み原本・既存インストール・ユーザープロファイルには一切書き込まない。
3. 動作していない機能を「修正済み」とせず、静的証拠・自動テスト・X実機確認を分ける。
4. 追加権限、閲覧履歴の保存、外部サーバーへの送信を機能の前提にしない。
5. Firefox側のMIT表記とChrome配布物の権利関係を確認するまで第三者公開しない。

初期解析: `docs/analysis/baseline-v1.3.md`。今後の機能案は `docs/IDEAS.md`。
