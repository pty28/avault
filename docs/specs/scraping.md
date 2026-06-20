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
3. `npm run scrape-vrack` — VRACK（Hey動画・一本道）scraping
4. `npm run scrape-caribbean` — カリビアン scraping

```bash
npm run run-all
```

### run-all-dmm.js — DMM 全スクリプト実行

DMM の2スクリプトを順次実行する：

1. `npm run scrape-dmm` — DMM library scraping（作品情報＋女優・メーカー・レーベル・メーカー品番・playerUrls を内部 GraphQL API で一括取得）
2. `npm run search-actress` — GraphQL で女優が取得できなかった作品（素人系など）を Web から補完

```bash
npm run run-all-dmm
npm run run-all-dmm -- --force
```

> **2026-06 リニューアル後**: scrape-dmm が内部 GraphQL API でメタ情報まで取得するため、旧 `fetch-info` / `scrape-manufacturer-codes` / `fetch-player-urls` / `fetch-actresses` は統合・廃止された。

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

> **2026-06 リニューアル対応**: DMM のマイライブラリが React/Tailwind 製 SPA に移行し旧 DOM セレクタ（`mySearchList_*`）が消滅したため、内部 GraphQL API（`https://api.video.dmm.co.jp/graphql`）を直接叩く方式に全面刷新した。作品情報・女優・メーカー・レーベル・メーカー品番・playerUrls を**この1スクリプトで一括取得**する（旧 `fetch-info` / `scrape-manufacturer-codes` / `fetch-player-urls` を統合・廃止）。

### 処理フロー

1. `https://video.dmm.co.jp/mylibrary/` を開き、保存済みクッキー（`.puppeteer-profiles/dmm-cookies.json`）を復元
2. `Mylibrary` クエリを1回叩いてログイン判定。未ログインなら手動ログイン → ターミナルで Enter を押すとクッキーを保存
3. **`Mylibrary` クエリ**で購入済み一覧を全件ページング取得（`limit=120`、取得日時の新しい順）
   - 取得フィールド: `id`（=品番）, `title`, `packageImage.mediumUrl`, `contentType`, `floor`, `latestViewingRightsAcquiredAt`
4. 既存データ（`data/dmm-library.json`）とマージし新規分のみ抽出（初期フィールド: `productCode`, `title`, `actresses: []`, `thumbnail`, `itemURL`, `isFetched: false`, `isShirouto: false`, `registeredAt`, 空のメタフィールド）
   - 重複判定は `normalizeDmmProductCode` / `paddedEquivalent` / `extractProductCodeFromThumbnail` を併用した安全網（例: `49FN00008` ⇄ `49FN08` ⇄ サムネ形）
5. **`ContentMeta` クエリ**でメタ情報を付与（対象: 新規＋`isFetched:false`、`--force` 時は全件）。連続呼び出しは `metaDelay`（250ms）でスロットル
   - `makerContentId` → `manufacturerCode`、`maker` → `makerName`/`makerId`、`label` → `labelName`/`labelId`
   - `actresses[].name` を `cleanActressName`（Alice表記・括弧内別名を整形）して `actresses` に格納
   - `products` から playerUrls を再構成（後述）
   - 取得成功で `isFetched: true`
6. `data/dmm-library.json` に保存（メタ付与の前後で2回書き込み・インクリメンタル更新）

> **注**: API 方式ではページングで常に全件を取得するため、旧来の `--full`（1ページ目のみ↔全ページ）の区別はなくなった。フラグは `--force` のみ。

### playerUrls の再構成 (`buildPlayerUrls`)

`ContentMeta` の `products`（所有商品＝`utilizationStatus !== NONE`）から配信用 pid を**実データ由来**で特定し、プレイヤーURLを組み立てる：

- 素人系（`〜st` サフィックスの product）があればそれを pid に使用（例: `show019` → `show019st`）
- それ以外は `dl` サフィックスを持たない「素」の product を pid に使用（エイリアス品番対応。例: `cid=61mdb093` でも素 product `61rmd00723` を pid に）
- いずれも無ければ cid にフォールバック
- 所有 product ごとに `parent_product_id` を埋めた URL を生成（複数パート対応）
- VR 作品（`contentType === 'VR'` または `【VR】` タイトル）はプレイヤーURL形式が異なるためスキップ

> 既存データ3791件で上記ルールにより 100% pid を導出できることを確認済み。

### データ構造（`data/dmm-library.json`）

```json
{
  "productCode": "VERO00129",
  "title": "作品タイトル",
  "actresses": ["女優名1", "女優名2"],
  "thumbnail": "https://pics.dmm.co.jp/...",
  "itemURL": "https://video.dmm.co.jp/av/content/?id=vero00129",
  "playerUrls": ["https://www.dmm.co.jp/digital/-/player/=/player=html5/act=playlist/pid=vero00129/view_flag=1/parent_product_id=.../part=1/"],
  "manufacturerCode": "VERO-129",
  "makerName": "メーカー名",
  "makerId": "maker_id_123",
  "labelName": "レーベル名",
  "labelId": "label_id_456",
  "isFetched": true,
  "isShirouto": false,
  "registeredAt": "2026-04-12T..."
}
```

> **注**: `isShirouto` は API 方式では自動分類されず常に `false`（レガシーフィールド）。`isFetched` は新規作成時 `false`、`ContentMeta` 取得成功で `true` に更新される。

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

## VRACK Scraper (`scrape-vrack.js`)

VRACK（Hey動画・一本道・HEYZO）の購入済み動画をスクレイピングする。事前ログインが必要。

- 出力: `data/vrack-library.json`
- playerUrlは単数形（`playerUrl`）で保存。`generate-viewer.js` が配列化する。
- `generate-viewer.js` でのソースフィールドは `'heydouga'`。

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
| `<productCode>` | 商品ID（位置引数）を指定するとそのアイテムのみ単体検索する（makerName チェックなし）。例: `npm run search-actress -- SONE-258` / MGS は `--file` 付きコマンドと併用（`npm run search-actress-mgstage -- SIRO-5588`） |
| `--force` | `isSearched` フラグを無視して再処理 |
| `--jewel` | 特定メーカー（Jewel: 46165, 豊彦: 45339, メガハーツ: 46654）のみ処理 |
| `--file <path>` | 対象ライブラリファイルを指定（デフォルト: `data/dmm-library.json`） |

`--file` 指定時はメーカー名不一致チェック（suspicious.log）をスキップ。位置引数の判定では `--file` の値は productCode と見なされない。

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

### search-products-by-actress

```bash
npm run search-products-by-actress -- "女優名"
npm run search-products-by-actress -- "女優名1,女優名2"        # OR条件
npm run search-products-by-actress -- "女優名1,女優名2" --all  # AND条件
```

部分一致で検索。OR条件がデフォルト。AND条件は `--all` フラグ。

### update-performers

```bash
npm run update-performers -- VERO00129 "女優名1,女優名2"            # DMM
npm run update-performers-mgstage -- SIRO05588 "女優名"            # MGStage
npm run update-performers-vrack -- heydouga_123456 "女優名"        # VRACK
npm run update-performers-caribbean -- caribbean_001_001 "女優名"  # カリビアン
```

特定アイテムの女優情報を手動で更新。コンマ区切りで複数指定可能。対象ライブラリは `--file` 付きの派生コマンドで切り替える。

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

<!-- last-documented-commit: 4c85442 -->
