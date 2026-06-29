# Viewer Specifications

このファイルは `contents/viewer.html` およびビューワー生成処理の詳細仕様を記述します。

---

## generate-viewer.js

`scripts/utils/generate-viewer.js` は以下の4つのデータファイルを自動生成する。

### 生成ファイル

| 生成ファイル | ソース | 説明 |
|---|---|---|
| `contents/viewer-data.js` | `data/dmm-library.json` + `data/vrack-library.json` + `data/mgstage-library.json` + `data/caribbean-library.json` | 全作品データ |
| `contents/presets-data.js` | `contents/presets.json` | プリセット検索定義 |
| `contents/tag-definitions-data.js` | `contents/tag-definitions.json` | タグ定義（名前＋色） |
| `contents/tags-data.js` | `contents/tags.json` | タグ割り当て（productCode → タグ名配列） |
| `contents/favorites-data.js` | `contents/favorites.json` | お気に入りリスト（productCode 配列） |

**これらのファイルは直接編集しない。**

### viewer-data.js の生成ロジック

- 4ソースのデータをマージ: DMM → Hey動画 → MGStage → カリビアン の順で結合
- 各アイテムに `source` フィールドを付与: `'dmm'` / `'heydouga'` / `'mgstage'` / `'caribbean'`
- Hey動画の `playerUrl`（単数）を `playerUrls`（配列）に正規化
- ソースファイルが存在しない場合は空配列にフォールバック

### 実行

```bash
npm run generate-viewer  # データファイルのみ生成
npm run serve-start      # 生成 + HTTPサーバーをバックグラウンド起動（http://localhost:8000）
npm run viewer           # 生成 + viewer.html を直接開く
```

---

## viewer.html

ブラウザベースのライブラリビューワー。

### アクセス方法

- **サーバーモード**: `npm run serve-start` → `http://localhost:8000`（タグ・お気に入り編集可能）
- **ファイルモード**: `npm run viewer` → `file://...`（タグ・お気に入りは読み取り専用 / localStorage フォールバック）

`npm run serve-start` 使用中は `file://` で直接開かないこと。

### 主要機能

- タイトルクリック → `itemURL` を別ウィンドウで開く
- `▶ 1`, `▶ 2`... ボタン → `playerUrls` の各パートを別ウィンドウで開く（20件以上も flex-wrap で対応）
- サムネイルクリック → 拡大モーダル
- 女優名クリック → その女優で検索絞り込み

### フィルター

- **ソースフィルター**: DMM / MGStage / Hey動画 / カリビアン で絞り込み
- **女優情報なし**: 女優情報未取得のアイテムのみ表示
- **タグフィルター**: ドロップダウンパネルで複数タグをAND条件で絞り込み（タグなし選択も可）
- **お気に入りのみ**: ♥ お気に入り登録済みのアイテムのみ表示

### URL パラメータ

ページ読み込み時に以下のクエリパラメータを解釈する（`applyUrlParams()` で処理）：

| パラメータ | 値 | 動作 |
|---|---|---|
| `q` | 検索文字列 | 検索ボックスに入力して即時絞り込み |
| `deep` | `1` または `true` | Deep Search を有効にして `q` を展開 |

**例**: `http://localhost:8000/?q=藍色なぎ&deep=1` → Deep Search 有効で「藍色なぎ」を検索

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

### 女優名検索（別名取り込み）

女優名から別名一覧を取得し、確認・編集したうえで検索ボックスへ取り込むモーダル機能。検索ボックスの入力を自動展開する Deep Search と違い、別名を一覧表示してから手動で検索へ反映する。

**操作:**
1. ヘッダーの「女優名検索」ボタンでモーダルを開く
2. 女優名を入力すると（350ms デバウンス）別名を自動検索し、「別名（編集可・カンマ区切り）」欄にメイン名＋全別名を表示
3. 必要に応じて別名欄を手動編集
4. 「入力」ボタンで別名群を検索ボックスへスペース区切りで取り込み、即時フィルタ適用（ページ先頭へスクロール）。「キャンセル」または背景クリックで閉じる

**動作:**
1. 入力値から `/search?alias=<入力値>` でメイン名を解決
2. `/details?name=<メイン名>` でメイン名＋全別名を取得
3. デバウンスとリクエストID管理により、古いリクエストの結果は破棄
4. サーバー未接続時は「サーバーに接続できません」と表示（API は serve-start 時のみ有効）

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

## Favorites System

### データ構造

- **お気に入りリスト** (`contents/favorites.json`): `["productCode1", "productCode2", ...]`（UIで管理）

### UI 操作

- カード表示のサムネイル右下に ♡ アイコンが常時表示される
- クリックで ♥（赤）に切り替わり、お気に入り登録される
- 再クリックで ♡ に戻り、登録解除される
- フィルターバーの「♥ お気に入りのみ」チェックボックスで絞り込み可能

### 永続化

- サーバーモード（`npm run serve-start`）: `POST /api/favorites` でディスクに即時保存
- ファイルモード（`file://`）: ブラウザの `localStorage`（`viewer_favorites`）にフォールバック

### テーブルビューとの関係

テーブル表示にはハートアイコンを表示しない。フィルタリングは `applyFilters()` 経由で共通動作する。

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

`npm run serve-start` でバックグラウンド起動するHTTPサーバー（port 8000）。

### 静的ファイル配信

- `contents/` 配下の静的ファイルを配信

### API エンドポイント

**タグ管理 API**
- `POST /api/tag-definitions`: `tag-definitions.json` と `tag-definitions-data.js` を更新
- `POST /api/tags/bulk`: `tags.json` と `tags-data.js` を更新

**お気に入り API**
- `POST /api/favorites`: Body = `string[]`（productCode 配列）。`favorites.json` と `favorites-data.js` を更新

**サーバー管理 API**（localhost からのみ）
- `GET /api/status`: サーバー状態・起動時刻・PID・アップタイム・データ更新日時を返す
- `POST /api/stop`: グレースフルシャットダウン（`npm run serve-stop` から呼び出し）
- `POST /api/reload`: `generate-viewer.js` を再実行してデータファイルを更新（`npm run serve-reload` から呼び出し）

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
- タグ編集ができない場合: `npm run serve-start` で起動しているか確認（`file://` では編集不可）

<!-- last-documented-commit: 17e54e5 -->
