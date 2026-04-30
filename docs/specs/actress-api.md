# 女優別名検索 API 仕様

## 概要

`serve-viewer.js` が提供するローカル API。女優の別名（旧芸名）からメイン名を検索、またはメイン名から全別名を取得できます。

## API エンドポイント

### 1. 別名で検索 `GET /search`

別名からメイン名（正式名）を検索します。

**リクエスト**
```
GET /search?alias=<別名>
```

**パラメータ**

| パラメータ | 必須 | 説明 |
|---|---|---|
| `alias` | ✓ | 検索する別名（日本語可） |

**レスポンス: 200 OK（見つかった場合）**

```json
{
  "alias": "AIKA",
  "count": 2,
  "results": [
    {
      "id": 6182,
      "main_name": "芹沢ゆい",
      "page_url": "https://seesaawiki.jp/w/sougouwiki/d/..."
    },
    {
      "id": 10404,
      "main_name": "なつき",
      "page_url": "https://seesaawiki.jp/w/sougouwiki/d/..."
    }
  ]
}
```

**レスポンス: 404 Not Found（見つからない場合）**

```json
{
  "message": "No actresses found with this alias",
  "alias": "存在しない名前",
  "results": []
}
```

**レスポンス: 400 Bad Request（パラメータ不足）**

```json
{
  "error": "Bad Request",
  "message": "Query parameter \"alias\" is required"
}
```

---

### 2. 女優詳細取得 `GET /details`

メイン名（正式名）から詳細情報（全別名リスト）を取得します。

**リクエスト**
```
GET /details?name=<メイン名>
```

**パラメータ**

| パラメータ | 必須 | 説明 |
|---|---|---|
| `name` | ✓ | メイン名（正式名、日本語可） |

**レスポンス: 200 OK（見つかった場合）**

```json
{
  "id": 28,
  "main_name": "AIKA",
  "page_url": "https://seesaawiki.jp/w/sougouwiki/d/AIKA",
  "aliases": [
    "MARI",
    "あずき",
    "ゆか",
    "佐藤聖羅",
    "優木あいか",
    "平岡歩",
    "本田愛華",
    "桜井愛香",
    "西野あおい",
    "香川さくら"
  ],
  "alias_count": 10
}
```

**レスポンス: 404 Not Found（見つからない場合）**

```json
{
  "message": "Actress not found",
  "name": "存在しない名前"
}
```

**レスポンス: 400 Bad Request（パラメータ不足）**

```json
{
  "error": "Bad Request",
  "message": "Query parameter \"name\" is required"
}
```

---

### 3. 全女優リスト `GET /list`

データベースに登録されている全女優のメイン名一覧を取得します。

**リクエスト**
```
GET /list
```

**パラメータ**: なし

**レスポンス: 200 OK**

```json
{
  "count": 16152,
  "actresses": [
    {
      "id": 1,
      "main_name": "あいうえお",
      "page_url": "https://seesaawiki.jp/w/sougouwiki/d/..."
    },
    ...
  ]
}
```

---

## エラーレスポンス

### 503 Service Unavailable

データベース（`actresses.db`）が見つからない場合。

```json
{
  "error": "Service Unavailable",
  "message": "Database not found"
}
```

### 500 Internal Server Error

データベースクエリ中にエラーが発生した場合。

```json
{
  "error": "Internal Server Error",
  "message": "<詳細メッセージ>"
}
```

---

## 使用例

### JavaScript/React（Deep Search 機能）

```javascript
// 別名をメイン名に変換
const searchRes = await fetch('/search?alias=AIKA');
const { results } = await searchRes.json();
const mainName = results[0].main_name;

// メイン名から全別名を取得
const detailsRes = await fetch(`/details?name=${mainName}`);
const { aliases } = await detailsRes.json();
```

### cURL

```bash
# 別名で検索
curl "http://localhost:8000/search?alias=AIKA"

# メイン名から詳細取得
curl "http://localhost:8000/details?name=AIKA"

# 全女優リストを取得
curl "http://localhost:8000/list"
```

---

## データベーススキーマ

### actresses テーブル

| カラム名 | 型 | 説明 |
|---------|-----|------|
| id | INTEGER | 主キー |
| main_name | TEXT | メイン名（本名） |
| page_url | TEXT | 女優ページのURL |
| created_at | TIMESTAMP | 作成日時 |
| updated_at | TIMESTAMP | 更新日時 |

### aliases テーブル

| カラム名 | 型 | 説明 |
|---------|-----|------|
| id | INTEGER | 主キー |
| actress_id | INTEGER | 女優ID（外部キー） |
| alias_name | TEXT | 別名 |
| created_at | TIMESTAMP | 作成日時 |

---

## データベース更新

スクレイピングで DB を再生成する場合：

```bash
cd scripts/actress-db
uv sync
uv run python -m scraper.scraper
# 完了後
cp actresses.db ../../data/
```

詳細は [`README.md`](../../README.md) の「女優DB更新」セクションを参照。

---

## 注釈

- `main_name` はページの h2 ヘッディングから取得した正式名です
- 1人の女優が複数の別名を持つことがあります
- `/search` は別名の完全一致検索のみ（部分一致・あいまい検索は非対応）
- ビューワーの Deep Search 機能を有効にすると、自動的にこれらの API を呼び出し、別名を本名に変換・展開します
