# Scraping Specifications

このファイルはスクレイピング処理の詳細仕様を記述します。

> **重要**: 新しいスクレイパーを実装する前に必ず [CLAUDE.md](../../CLAUDE.md) の「DOM操作・スクレイピング実装チェックリスト」を参照してください。

---

## Browser Session Management (プロファイル機能)

すべてのスクレイパーは Puppeteer 専用プロファイルを使用してログインセッションを保持します。

### プロファイル構造

```
.puppeteer-profiles/
├── dmm/                    # DMM ログインセッション
├── mgstage/                # MGStage ログインセッション
└── d2pass/                 # D2Pass統一認証プロファイル（Hey動画・カリビアン共用）
```

**D2Pass について**: Hey動画（heydouga.com）とカリビアン（caribbeancompr.com）は同じ D2Pass サービスを経由して認証されるため、1つのプロファイルで両方のサイトにアクセス可能です。

### 動作フロー

1. **初回実行** (`npm run scrape-*`)
   - ブラウザを表示モードで起動
   - プロファイルディレクトリは新規作成
   - ユーザーが手動でログイン
   - ログイン状態（クッキー・セッション）がプロファイルに保存される

2. **以降実行** (`npm run scrape-*`)
   - ブラウザを表示モードで起動
   - プロファイルディレクトリから自動復元
   - ログイン状態が自動的に復元される
   - ユーザーのログイン操作は不要

### セッションのリセット

特定サイトのログイン状態をリセットする場合：

```bash
rm -rf .puppeteer-profiles/dmm        # DMM
rm -rf .puppeteer-profiles/mgstage    # MGStage
rm -rf .puppeteer-profiles/d2pass     # Hey動画・カリビアン（D2Pass統一認証）
```

### .gitignore

プロファイルディレクトリはバージョン管理から除外されます：

```
.puppeteer-profiles/
```

---

## Run-All Scripts

### run-all.js — 全ソース実行

全ソースのパイプラインを順次実行する：

1. `npm run run-all-dmm` — DMM full pipeline
2. `npm run run-all-mgs` — MGStage full pipeline
3. `npm run scrape-heydouga` — Hey動画 scraping
4. `npm run scrape-caribbean` — カリビアン scraping

```bash
npm run run-all
```

### run-all-dmm.js — DMM 全スクリプト実行

DMM の4スクリプトを順次実行する：

1. `npm run scrape-dmm` — DMM library scraping + playerUrls fetching
2. `npm run fetch-info` — 女優・メーカー・レーベル情報取得
3. `npm run scrape-manufacturer-codes` — メーカー品番取得
4. `npm run search-actress` — Web から女優情報取得

```bash
npm run run-all-dmm
npm run run-all-dmm -- --force
```

### run-all-mgs.js — MGStage 全スクリプト実行

MGStage の2スクリプトを順次実行する：

1. `npm run scrape-mgstage` — MGStage scraping（デフォルト: 1ページ目のみ）
2. `npm run search-actress-mgstage` — Web から女優情報取得

```bash
npm run run-all-mgs                    # 1ページ目のみ
npm run run-all-mgs -- --full          # 全ページ
npm run run-all-mgs -- --force         # 既存データも上書き
npm run run-all-mgs -- --full --force
```

**共通技術仕様:**
- `child_process.spawn()` でサブプロセス管理
- stdout/stderr を親プロセスに直接パイプ（リアルタイム出力）
- Ctrl+C でグレースフル中断
- 各ステップの開始・終了時刻・所要時間を表示

---

## DMM Library Scraper (`scrape-dmm-library.js`)

Puppeteer を使用して DMM マイライブラリをスクレイピングする。

### 処理フロー

1. ブラウザを起動してDMMライブラリにアクセス
2. fullMode時は「もっと見る」ボタンを全クリック
3. サムネイルURLから製品コード・タイトルを抽出（`ps.jpg` / `js.jpg` 両対応）
4. `data/dmm-library.json` に保存（初期フィールド: `productCode`, `title`, `actresses[]`, `thumbnail`, `itemURL`, `isFetched: false`, `isShirouto: false`, `registeredAt`）
5. 既存データとマージして重複を避ける（インクリメンタル更新）
6. **同一ブラウザセッション内**でplayerURLを取得：
   - サムネイルをクリック → `waitForModalWithPid()` で正しいモーダルを待機 → `a[onclick*="window.open"]` URLを抽出 → Escapeを押下
   - `playerUrls` 配列として保存（複数パート対応）
   - `【VR】` タイトルはスキップ
   - `playerUrls` が既存の場合はスキップ（`--force` 時を除く）

### Player URL Modal Handling (`waitForModalWithPid`)

- `waitForModalWithPid(page, expectedProductCode, timeoutMs)` でモーダル出現を待機
- DOM をポーリングして `a[onclick*="window.open"]` リンクを確認し、onclick URL内のpidが期待するproductCodeと一致するかを検証
- 前の作品のモーダルが残留することによるレースコンディションを防止
- `extractPlayerUrlFromDetailPage()` でも pid 検証を二重チェック
- URL取得後は Escape + 500ms 待機（次の `waitForModalWithPid` が遷移を担保）

---

## Player URL Fetcher (`fetch-player-urls.js`)

scrape-dmm-library.js からplayerURL取得を独立させた単体スクリプト。

- `waitForModalWithPid` のロジックは scrape-dmm-library.js と共通
- `data/dmm-library.json` から既存 `playerUrls` を読み込みスキップ判定
- `--full`: 「もっと見る」で全ページ読み込み後に処理
- `--force`: 既存 playerUrls を上書き
- スキップ条件: `【VR】` タイトル、`playerUrls` 既存（`--force` なし時）
- Enter キー押下後に `process.stdin.pause()` を呼び出してプロセスを正常終了

---

## DMM API Integration (`fetch-info.js`)

DMM Affiliate API を使用して女優名・メーカー・レーベル情報を取得する。

### 処理フロー

1. `data/dmm-library.json` を読み込む
2. 対象フィルタリング:
   - **通常モード**: `actresses` が空 AND `isFetched: false` のアイテムのみ
   - **`--force` モード**: productCode があるすべてのアイテム
3. 各アイテムに対して以下の順で検索:
   - `floor=videoa`（一般作品）→ 成功時 `isShirouto: false`
   - 結果なし → `floor=videoc`（素人系）→ 成功時 `isShirouto: true`
   - 結果なし + productCodeに"00"含む → "00"を1つ除去して `floor=videoa` 再試行（例: `H_152SIL00012` → `h_152sil12`）
4. 女優名・itemURL・makerName・makerId・labelName・labelId を抽出
5. `data/dmm-library.json` に書き戻し（`isFetched: true` に更新）

### データ構造

```json
{
  "productCode": "VERO00129",
  "title": "作品タイトル",
  "actresses": ["女優名1", "女優名2"],
  "thumbnail": "https://pics.dmm.co.jp/...",
  "itemURL": "https://www.dmm.co.jp/digital/videoa/-/detail/=/cid=vero00129/",
  "playerUrls": ["https://www.dmm.co.jp/digital/-/player/.../part=1/"],
  "manufacturerCode": "VERO-129",
  "makerName": "メーカー名",
  "makerId": "maker_id_123",
  "labelName": "レーベル名",
  "labelId": "label_id_456",
  "isFetched": true,
  "isShirouto": false
}
```

---

## Manufacturer Code Scraper (`scrape-manufacturer-codes.js`)

FANZA 作品ページからメーカー品番を取得する。

- Puppeteer で `video.dmm.co.jp/av/content/` にアクセス
- 年齢確認ポップアップを自動バイパス
- ネットワークアイドル後にページをスクレイプ
- `data/dmm-library.json` の `manufacturerCode` フィールドを更新
- 既存の `manufacturerCode` があるアイテムはスキップ（安全に再実行可能）
- 各種フォーマット対応（VERO00129, H_172HMNF00004 等）

---

## MGStage Scraper (`scrape-mgstage.js`)

> **注意**: このスクレイパーは実装前に `scripts/debug/debug-mgstage-dom.js` でDOMを調査した後に実装した。新たに修正する場合も同様の調査を行うこと。

MGStage マイページから購入済みストリーミング動画をスクレイピングする。

### ページ構造

- URL: `https://www.mgstage.com/mypage/mypage_top.php`
- アイテム: `ul#PpvVideoList > li.ppv_purchase_item`
- ストリーミングフィルタ: `a.button_mypage_streaming_now` が存在するアイテムのみ
- productCode: `p.package_colum > a[href]` の `/product/product_detail/CODE/` パターンから抽出
- title: `h2.title a`
- makerName: `dl > dt("メーカー名：") + dd` のテキスト
- thumbnail: `p.package_colum img[src]`（`data-src` ではない）
- playerUrl: `a.button_mypage_streaming_now[href]`（相対URL → `https://www.mgstage.com` で絶対URL化）
- 購入日: `li.date` の "購入日 YYYY/MM/DD" → JST 0:00 の ISO 文字列

### ページネーション

JavaScript関数 `LoadMyPageBodyPPV(n)` を `page.evaluate()` で呼び出す。  
次ページ読み込み完了の検知: 最初のアイテムのproductCodeが変わるまで `waitForFunction` で待機。

### データ構造

```json
{
  "productCode": "336KNB-195",
  "manufacturerCode": "336KNB-195",
  "title": "作品タイトル",
  "actresses": [],
  "makerName": "KANBi",
  "thumbnail": "https://image.mgstage.com/...",
  "itemURL": "https://www.mgstage.com/product/product_detail/336KNB-195/",
  "playerUrls": ["https://www.mgstage.com/mgsplayer/?..."],
  "isFetched": true,
  "isUncensored": false,
  "registeredAt": "2023-05-13T15:00:00.000Z"
}
```

**重要**: `manufacturerCode = productCode`（MGStageのproductCodeは外部コード形式のため、DMM内部コード変換は不要）

---

## Hey動画 Scraper (`scrape-heydouga.js`)

Hey動画の購入済み動画をスクレイピングする。事前ログインが必要。

- 出力: `data/heydouga-library.json`
- playerUrlは単数形（`playerUrl`）で保存。`generate-viewer.js` が配列化する。

---

## Performer Web Fetcher (`search-actress.js`)

複数のWebサイトから出演者情報を取得する。DMM・MGStage 共用。

### 検索優先順位

1. `https://avwikidb.com/work/{manufacturerCode}/` — 「出演女優」フィールドをメーカー名検証付きで抽出
2. `https://av-wiki.net/{manufacturerCode}/` — 「AV女優名」セクションから抽出（「＊」は除外）
3. **av-wiki.net フォールバック** — manufacturerCode で失敗時にproductCode（小文字）で再試行
4. `https://adult-wiki.net/search/?keyword={productCode}` — 検索結果が1件のみの場合に詳細ページへアクセス
5. `https://shiroutowiki.work/fanza-video/{productCode_lowercase}/` — 直接アクセスしてregexで抽出
6. `https://www.jav321.com/video/{productCode}/` — 直接アクセス（メーカー名検証付き）

### manufacturerCode 生成ロジック（DMM専用）

`productCode` から `manufacturerCode` を生成する（MGStageはスクレイプ時に設定済みのためスキップ）：

1. `^[hH]_[0-9]+` プレフィックスを除去
2. `^[0-9]+` プレフィックスを除去
3. 先頭ゼロをインテリジェントにトリム：
   - 数字部分が4桁以上の場合、最後の3桁を除いた「ヘッド部分」を確認
   - ヘッドに非ゼロ数字があれば最初の非ゼロ桁から保持
   - ヘッドが全ゼロなら最後の3桁のみ保持
4. `TOP100`・`BEST[0-9]+` はプレースホルダーとして再生成

例:
- `C02290` → `c-2290`
- `E00123` → `e-123`
- `H_1241SIRO05588` → `siro-5588`

### フラグ・オプション

| フラグ | 動作 |
|--------|------|
| `--force` | `isSearched` フラグを無視して再処理 |
| `--jewel` | 特定メーカー（Jewel: 46165, 豊彦: 45339, メガハーツ: 46654）のみ処理 |
| `--file <path>` | 対象ライブラリファイルを指定（デフォルト: `data/dmm-library.json`） |

`--file` 指定時はメーカー名不一致チェック（suspicious.log）をスキップ。

### 除外タイトルパターン

`福袋` / `お中元セット` / `夏ギフトセット` / `お歳暮セット` / `冬ギフトセット`

### 技術ノート

- **jav321.com**: TextNode抽出 → innerTextフォールバック → CSSセレクタフォールバック の3段階抽出
- **adult-wiki.net**: 検索結果が1件のみの場合だけ詳細ページへアクセス（無駄なページロードを回避）
- エラー時はログ出力して次のアイテムに継続
- `isSearched: true` で処理済みマーク（`--force` 時はスキップ判定に使用しない）
- アイテム間に1000ms のレート制限

---

## Utility Scripts

### list-no-actresses

```bash
npm run list-no-actresses
npm run list-no-actresses -- --csv  # → list-no-actresses.csv
```

女優情報が未取得のアイテムを一覧表示。manufacturerCode を自動生成して表示（TOP100/BEST[0-9]+も生成）。

### list-all-actresses

```bash
npm run list-all-actresses
npm run list-all-actresses -- --csv  # → list-all-actresses.csv
```

全ユニーク女優名を出現回数付きであいうえお順に表示。

### search-products-by-actress

```bash
npm run search-products-by-actress -- "女優名"
npm run search-products-by-actress -- "女優名1,女優名2"        # OR条件
npm run search-products-by-actress -- "女優名1,女優名2" --all  # AND条件
```

部分一致で検索。OR条件がデフォルト。AND条件は `--all` フラグ。

### list-makers / list-labels

```bash
npm run list-makers  # → makers-list.csv
npm run list-labels  # → labels-list.csv
```

makerId / labelId でデデュープし、アイテム数付きで一覧表示。

### list-genres

```bash
npm run list-genres              # videoa + videoc 両方
npm run list-genres -- 43        # videoa (floor ID: 43) のみ
npm run list-genres -- 44        # videoc (floor ID: 44) のみ
npm run list-genres -- --csv     # → list-genres-videoa.csv / list-genres-videoc.csv
```

DMM API の GenreSearch エンドポイントを使用。`DMM_API_ID` / `DMM_AFFILIATES_ID` が必要。

### list-many-player-urls

```bash
npm run list-many-player-urls
npm run list-many-player-urls -- --csv  # → list-many-player-urls.csv
```

playerUrls が8件以上のアイテムを件数降順で表示。

### check-duplicate-player-urls

```bash
npm run check-duplicate-player-urls
```

playerUrl が複数のアイテムに重複している場合を検出して報告。

### update-performers

```bash
npm run update-actresses -- VERO00129 "女優名1,女優名2"
```

特定アイテムの女優情報を手動で更新。コンマ区切りで複数指定可能。

---

## Caribbean Scraper (`scrape-caribbean.js`)

カリビアンプレミアム（caribbeancompr.com）の購入済み動画を一覧取得する。

### 処理フロー

1. ブラウザを起動してカリビアンにアクセス
2. ユーザーが手動でログイン
3. 購入履歴ページ (`/member/app/history`) をスクレイプ：
   - `div.cart-item` から各商品を抽出
   - `a.meta-title` でタイトルと商品ページURL取得
   - `div.meta-data` で女優名を抽出
   - サムネイル: `a.cart-media-image > img[src]`
4. 各商品ページからスタジオ情報を取得：
   - `li.movie-spec` で「スタジオ」を検索
   - `span.spec-content > a` からスタジオ名を抽出
5. playerUrl は商品ページのURL自体を使用（直接再生可能）
6. `data/caribbean-library.json` に保存

### データ構造

```json
{
  "productCode": "caribbean_122719_405",
  "title": "おんなのこのしくみ ~けっこうスケベーなカラダしてるんですヨ~",
  "actresses": ["宮本るみ"],
  "makerName": "天然むすめ",
  "thumbnail": "https://www.caribbeancompr.com/moviepages/122719_405/images/s.jpg",
  "itemURL": "https://www.caribbeancompr.com/moviepages/122719_405/index.html",
  "playerUrls": ["https://www.caribbeancompr.com/moviepages/122719_405/index.html"],
  "isFetched": true,
  "source": "caribbean",
  "registeredAt": "2026-04-12T..."
}
```

### 商品コード規則

URLの形式: `/moviepages/{productId}/index.html`
→ 商品コード: `caribbean_{productId}`

例: `/moviepages/122719_405/` → `caribbean_122719_405`

### 使用方法

```bash
# 基本的な実行（ログイン手動）
npm run scrape-caribbean

# 既存データも上書き
npm run scrape-caribbean -- --force
```

### 技術ノート

- Puppeteer のヘッドレスモード使用（ユーザーが手動でログイン）
- 各商品ページは個別タブで取得（インクリメンタル更新対応）
- アイテム間に1000ms のレート制限
- スクレイプ時に `isFetched: true` を設定（APIはないため）
