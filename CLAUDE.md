# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this repository.

## External References

詳細仕様・ルールは以下のファイルを参照すること：

- **ルール**: [`.claude/rules.md`](.claude/rules.md) — 実装時の必須ルール（スクレイプ前DOM調査など）
- **スクレイピング仕様**: [`docs/specs/scraping.md`](docs/specs/scraping.md) — 各スクレイパー・ユーティリティの詳細
- **ビューワー仕様**: [`docs/specs/viewer.md`](docs/specs/viewer.md) — viewer.html・タグ・プリセットの詳細

## DOM操作・スクレイピング実装チェックリスト

**⚠️ 重要：スクレイピング処理やDOM操作を実装する場合、推測で進めてはいけません**

実装前に以下を必ず確認してください：

- [ ] **デバッグスクリプト作成済み？** `scripts/debug/debug-{sitename}-dom.js` を作成しましたか？
- [ ] **実際のDOM構造を調査済み？** スクリプト実行後、生成された `.json` ファイルで要素を確認しましたか？
- [ ] **iframe 対応？** iframe が関わる場合、iframe **内部** の構造も調査しましたか？
- [ ] **セレクタは推測ではなく調査結果？** クラス名やIDは分析結果に基づいていますか？
- [ ] **実装後にテスト実行済み？** スクリプト修正後、実際に動作確認しましたか？

**違反パターン（やってはいけないこと）**
- ❌ DOM 調査なしに実装コード修正を開始
- ❌ iframe のセレクタを推測で書く
- ❌ ボタンやリンクのクラス名を推測でターゲット
- ❌ スクロール動作パラメータを推測で変更
- ❌ 実装後、動作確認なしに完了とする

## Debug Script Management

**⚠️ デバッグスクリプトは一時的なファイルです。調査完了後は必ず削除してください。**

### ルール

- ✅ `scripts/debug/debug-*.js` ファイルは自由に作成可能
- ✅ JSON分析ファイル（`.json`）も一時ファイルとして削除可
- ❌ `package.json` に debug スクリプトの npm コマンドを登録しない
- ❌ 調査完了後、デバッグスクリプトを git にコミットしない

### 理由

- デバッグスクリプトは **一時的な調査用** であり、本番コードではない
- package.json を汚すため、スクリプト一覧が不明瞭になる
- 不要なエントリが残ると、他のデベロッパーの混乱を招く

### 正しいワークフロー

```
1. 新しい DOM 構造を調査する必要が発生
2. scripts/debug/debug-{sitename}-dom.js を作成
3. スクリプト実行、分析結果を確認
4. 実装コードを修正
5. 調査完了後、デバッグスクリプトを削除
   → rm scripts/debug/debug-*.js
   → rm scripts/debug/*-analysis.json
6. package.json から debug エントリを削除
7. コミット（実装変更のみ、デバッグスクリプトは含めない）
```

## Project Overview

AV作品情報（女優名・メーカー・品番等）をDMM/FANZA・MGStage・VRACK（Hey動画・一本道・HEYZO）から自動収集・集約するツール群。Claude Code スラッシュコマンドと Node.js スクリプトで構成される。

## Project Structure

```
collection_list/
├── scripts/
│   ├── scrape-dmm-library.js       # DMM ライブラリのスクレイピング + playerURL取得
│   ├── scrape-mgstage.js           # MGStage 購入済みストリーミング動画のスクレイピング
│   ├── scrape-vrack.js             # VRACK 購入済み動画のスクレイピング
│   ├── scrape-caribbean.js         # カリビアン 購入済み動画のスクレイピング
│   ├── fetch-info.js               # DMM API から女優・メーカー・レーベル情報取得
│   ├── fetch-player-urls.js        # playerURL 取得（単体実行用）
│   ├── search-actress.js           # Web から女優情報取得（DMM・MGStage 共用）
│   ├── fetch-actresses.js          # 女優情報取得（レガシー）
│   ├── scrape-manufacturer-codes.js # メーカー品番取得
│   ├── run-all.js                  # 全ソース順次実行（DMM + MGStage + Hey動画 + カリビアン）
│   ├── run-all-dmm.js              # DMM 全スクリプト順次実行
│   ├── run-all-mgs.js              # MGStage 全スクリプト順次実行
│   ├── serve-viewer.js             # ビューワー用 HTTP サーバー
│   ├── scrape-mylist-tags.js       # マイリストタグのスクレイピング
│   │
│   ├── utils/
│   │   ├── generate-viewer.js      # viewer-data.js 等を自動生成
│   │   ├── list-no-actresses.js    # 女優情報未取得アイテムの一覧
│   │   ├── list-all-actresses.js   # 全ユニーク女優一覧
│   │   ├── search-products-by-actress.js
│   │   ├── list-no-itemurl.js
│   │   ├── list-makers.js
│   │   ├── list-labels.js
│   │   ├── list-genres.js
│   │   ├── list-many-player-urls.js
│   │   ├── check-duplicate-player-urls.js
│   │   ├── update-performers.js
│   │   └── ...
│   │
│   └── debug/                      # 調査用スクリプト（実装完了後は削除する）
│
├── .puppeteer-profiles/            # Puppeteer ブラウザプロファイル（セッション保持）
│   ├── dmm/                        # DMM ログインセッション
│   ├── mgstage/                    # MGStage ログインセッション
│   └── d2pass/                     # D2Pass統一認証プロファイル（Hey動画・カリビアン共用）
│
├── contents/
│   ├── viewer.html                 # ビューワー本体
│   ├── presets.json                # プリセット定義（手動編集可）
│   ├── tag-definitions.json        # タグ定義（手動編集可）
│   ├── tags.json                   # タグ割り当て
│   ├── viewer-data.js              # 自動生成（generate-viewer）
│   ├── presets-data.js             # 自動生成（generate-viewer）
│   ├── tag-definitions-data.js     # 自動生成（generate-viewer）
│   └── tags-data.js                # 自動生成（generate-viewer）
│
├── docs/
│   ├── rules.md                    # 実装ルール
│   └── specs/
│       ├── scraping.md             # スクレイピング仕様
│       └── viewer.md               # ビューワー仕様
│
├── data/
│   ├── dmm-library.json                # DMM 作品データ（自動生成）
│   ├── vrack-library.json              # VRACK 作品データ（自動生成）
│   ├── mgstage-library.json            # MGStage 作品データ（自動生成）
│   └── caribbean-library.json          # カリビアン 作品データ（自動生成）
├── suspicious.log                  # 品質確認用エラーログ
├── package.json
└── .env                            # 環境変数（要作成）
```

## Environment Variables

```
DMM_API_ID=your_api_id_here       # DMM Affiliate API ID（必須）
DMM_AFFILIATES_ID=xxxxx-990       # DMM Affiliate ID（必須）
```

## ブラウザセッション保持（プロファイル機能）

各スクレイパーは Puppeteer 専用プロファイルを使用してセッションを保持します。

**初回実行**: スクリプト実行時に手動でログイン
```bash
npm run scrape-dmm           # ユーザーが手動でログイン
npm run scrape-mgstage       # ユーザーが手動でログイン
npm run scrape-vrack         # ユーザーが手動でログイン
npm run scrape-caribbean     # ユーザーが手動でログイン
```

**以降実行**: プロファイルに保存されたセッションから自動復元（ログイン不要）
```bash
npm run scrape-dmm           # ログイン不要（セッション自動復元）
npm run scrape-mgstage       # ログイン不要（セッション自動復元）
npm run scrape-vrack         # ログイン不要（セッション自動復元）
npm run scrape-caribbean     # ログイン不要（セッション自動復元）
```

**ログイン状態のリセット**: プロファイルディレクトリを削除
```bash
rm -rf .puppeteer-profiles/dmm        # DMM のセッションをリセット
rm -rf .puppeteer-profiles/mgstage    # MGStage のセッションをリセット
rm -rf .puppeteer-profiles/d2pass     # VRACK・カリビアン（D2Pass統一認証）のセッションをリセット
```

> 📌 注: Hey動画とカリビアンは D2Pass サービス経由で認証されるため、同じプロファイル（`.puppeteer-profiles/d2pass/`）を共用します。

> ⚠️ 注意: `.puppeteer-profiles/` ディレクトリは `.gitignore` で除外されており、バージョン管理されません（ユーザー個人のセッション情報のため）。

## Commands

### /search-actress

製品コードや作品名から女優名を検索する（Claude Code スラッシュコマンド）。

```
/search-actress "SIRO-5588"
/search-actress "作品名"
```

データソース: av-wiki.net / seesaawiki.jp（EUC-JP エンコード必須）/ adult-wiki.net

### Automation Scripts

```bash
npm run run-all               # 全ソース: DMM + MGStage + Hey動画 + カリビアン
npm run run-all-dmm           # DMM: scrape → fetch-info → manufacturer-codes → search-actress
npm run run-all-dmm -- --force
npm run run-all-mgs           # MGStage: scrape → search-actress
npm run run-all-mgs -- --full --force
```

### DMM Core

```bash
npm run scrape-dmm                  # DMM スクレイプ + playerURL（1ページ目）
npm run scrape-dmm -- --full --force
npm run fetch-player-urls           # playerURL のみ取得（単体）
npm run fetch-player-urls-full
npm run fetch-player-urls-force
npm run fetch-info                  # 女優・メーカー・レーベル情報（DMM API）
npm run fetch-info -- --force
npm run scrape-manufacturer-codes   # メーカー品番
```

### MGStage / VRACK / Caribbean

```bash
npm run scrape-mgstage              # MGStage スクレイプ（1ページ目）
npm run scrape-mgstage-full         # 全ページ
npm run search-actress-mgstage      # MGStage 向け女優検索
npm run scrape-vrack                # VRACK スクレイプ
npm run search-actress-vrack        # VRACK 向け女優検索
npm run search-actress-1pondo       # 一本道向け女優検索
npm run scrape-caribbean            # カリビアンスクレイプ
npm run search-actress-caribbean     # カリビアン向け女優検索
```

### Viewer

```bash
npm run serve                       # 生成 + HTTP サーバー起動（http://localhost:8000）
npm run viewer                      # 生成 + viewer.html を直接開く
npm run generate-viewer             # データファイルのみ生成
```

### Utility / Debug

```bash
npm run search-actress              # Web から女優情報取得（DMM）
npm run search-actress -- --force
npm run search-actress -- --jewel
npm run search-actress -- --file data/mgstage-library.json  # または mgstage-library.json（CWDから）
npm run search-actress-mgstage      # MGStage向け女優検索
npm run search-actress-vrack        # VRACK向け女優検索
npm run search-actress-1pondo       # 一本道向け女優検索
npm run search-actress-caribbean    # カリビアン向け女優検索
npm run list-no-actresses           # 女優情報未取得アイテムの一覧
npm run list-no-actresses -- --csv
npm run list-all-actresses          # 全ユニーク女優一覧
npm run list-all-actresses -- --csv
npm run search-products-by-actress -- "女優名"
npm run search-products-by-actress -- "女優名1,女優名2" --all
npm run update-performers -- VERO00129 "女優名1,女優名2"           # DMM
npm run update-performers-mgstage -- SIRO05588 "女優名"            # MGStage
npm run update-performers-vrack -- heydouga_123456 "女優名"        # VRACK
npm run update-performers-1pondo -- 1pondo_123456 "女優名"         # 一本道
npm run update-performers-caribbean -- caribbean_001_001 "女優名"  # カリビアン
npm run list-makers
npm run list-labels
npm run list-genres
npm run list-many-player-urls
npm run check-duplicate-player-urls
npm run test-api
```
