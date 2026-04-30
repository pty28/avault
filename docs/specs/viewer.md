# Viewer Specifications

このファイルは `contents/viewer.html` およびビューワー生成処理の詳細仕様を記述します。

---

## generate-viewer.js

`scripts/utils/generate-viewer.js` は以下の4つのデータファイルを自動生成する。

### 生成ファイル

| 生成ファイル | ソース | 説明 |
|---|---|---|
| `contents/viewer-data.js` | `data/dmm-library.json` + `data/heydouga-library.json` + `data/mgstage-library.json` + `data/caribbean-library.json` | 全作品データ |
| `contents/presets-data.js` | `contents/presets.json` | プリセット検索定義 |
| `contents/tag-definitions-data.js` | `contents/tag-definitions.json` | タグ定義（名前＋色） |
| `contents/tags-data.js` | `contents/tags.json` | タグ割り当て（productCode → タグ名配列） |

**これらのファイルは直接編集しない。**

### viewer-data.js の生成ロジック

- 4ソースのデータをマージ: DMM → Hey動画 → MGStage → カリビアン の順で結合
- 各アイテムに `source` フィールドを付与: `'dmm'` / `'heydouga'` / `'mgstage'` / `'caribbean'`
- Hey動画の `playerUrl`（単数）を `playerUrls`（配列）に正規化
- ソースファイルが存在しない場合は空配列にフォールバック

### 実行

```bash
npm run generate-viewer  # データファイルのみ生成
npm run serve            # 生成 + HTTPサーバー起動（http://localhost:8000）
npm run viewer           # 生成 + viewer.html を直接開く
```

---

## viewer.html

ブラウザベースのライブラリビューワー。

### アクセス方法

- **サーバーモード**: `npm run serve` → `http://localhost:8000`（タグ編集可能）
- **ファイルモード**: `npm run viewer` → `file://...`（タグは読み取り専用）

`npm run serve` 使用中は `file://` で直接開かないこと。

### 主要機能

- タイトルクリック → `itemURL` を別ウィンドウで開く
- `▶ 1`, `▶ 2`... ボタン → `playerUrls` の各パートを別ウィンドウで開く（20件以上も flex-wrap で対応）
- サムネイルクリック → 拡大モーダル
- 女優名クリック → その女優で検索絞り込み

### フィルター

- **ソースフィルター**: DMM / MGStage / Hey動画 / カリビアン で絞り込み
- **女優情報なし**: 女優情報未取得のアイテムのみ表示
- **タグフィルター**: すべて / タグなし / 各タグ名で絞り込み

### ソースバッジ

- DMMアイテム: バッジなし
- MGStageアイテム: 製品コード横にオレンジの **MGS** バッジ
- Hey動画アイテム: 製品コード横に紫の **HEY** バッジ
- カリビアンアイテム: 製品コード横に緑の **CBN** バッジ

### ソート

- 登録順（デフォルト、同一タイムスタンプ時は `_idx` でタイブレーク）
- 製品コード
- タイトル（日本語あいうえお順）

### 表示モード

- カード表示（デフォルト、48件/ページ）
- テーブル表示（50件/ページ）

### Deep Search 機能

女優の別名（旧芸名）から本名（正式名）を自動検索し、本名の別名リスト全体を展開する高度な検索機能。

**有効化方法:**
1. 検索ボックス上の「Deep Search」チェックボックスを有効に
2. 女優名（別名または本名）を入力

**動作:**
1. 入力した別名から本名を自動検索（`/search?alias=<入力値>`）
2. 本名の詳細情報を取得（`/details?name=<本名>`）
3. 本名と全別名の両方で検索実行

**例:**
- 入力: 「藍色なぎ」（別名）
- 自動検索: 本名「茉宮なぎ」 + 全別名「茉宮なぎ」「藍色なぎ」「藤森朱音」「峯岸はるか」で展開
- 結果: これらの名前を含むすべての作品が表示される

**API:**
内部的に以下のエンドポイントを利用（詳細は [actress-api.md](actress-api.md) 参照）
- `GET /search?alias=<別名>` - 別名からメイン名を検索
- `GET /details?name=<メイン名>` - メイン名から全別名を取得

---

## Tag System

### データ構造

- **タグ定義** (`contents/tag-definitions.json`): `[{ "name": "タグ名", "color": "#hex" }]`（ユーザー編集可）
- **タグ割り当て** (`contents/tags.json`): `{ "productCode": ["タグ名1", "タグ名2"] }`（UIで管理）

### Server API（`npm run serve` 時のみ有効）

```
POST /api/tag-definitions
Body: [{ "name": "タグ名", "color": "#hex" }]

POST /api/tags/bulk
Body: { "productCodes": [], "addTags": [], "removeTags": [] }
```

### 選択モード

1. 「選択モード」ボタンをON
2. カード/行をクリックして複数選択
3. 画面下部のフローティングバーから「タグを割り当て」

### タグ管理モーダル

- タグの追加・名前編集・色変更・削除が可能
- 「保存」で `tag-definitions.json` に永続化（サーバーモード必須）

---

## Preset System

- ユーザー編集ファイル: `contents/presets.json`
- `presets.json` 変更後は `npm run generate-viewer` で `presets-data.js` を再生成

```json
[
  { "label": "[選択なし]", "query": "" },
  { "label": "放尿系", "query": "尿 聖水 お漏らし" }
]
```

- `presets-data.js` は `<script>` タグで読み込む（`fetch()` ではない）ため、`file://` でも動作する
- viewer.html 内では `(typeof PRESETS !== 'undefined') ? PRESETS : []` で参照する（`window.PRESETS` は不可。`const` はwindowに付かない）

---

## serve-viewer.js

`npm run serve` で起動するHTTPサーバー（port 8000）。

### 静的ファイル配信

- `contents/` 配下の静的ファイルを配信

### API エンドポイント

**タグ管理 API**
- `POST /api/tag-definitions`: `tag-definitions.json` と `tag-definitions-data.js` を更新
- `POST /api/tags/bulk`: `tags.json` と `tags-data.js` を更新

**女優別名検索 API**（Deep Search で使用）
- `GET /search?alias=<別名>`: 別名からメイン名を検索
- `GET /details?name=<メイン名>`: メイン名から全別名を取得
- `GET /list`: 全女優リストを取得

詳細は [actress-api.md](actress-api.md) を参照。

### データベース

SQLite ファイル（`data/actresses.db`）を使用して女優データを管理。
- Database ファイルが存在しない場合、`/search`, `/details`, `/list` は 503 エラーを返す

---

## Debugging

- presets/tags が動作しない場合: ブラウザコンソールを確認 → `npm run generate-viewer` で再生成 → `http://localhost:8000` でアクセスしているか確認
- タグ編集ができない場合: `npm run serve` で起動しているか確認（`file://` では編集不可）
