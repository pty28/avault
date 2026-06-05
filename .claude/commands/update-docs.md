---
name: update-docs
description: CLAUDE.md と README.md のドキュメントをアップデートします
args:
  - name: target
    description: 更新対象（scraping, viewer, actress-api, claude, readme, all）
    required: false
---

ドキュメントを `last-documented-commit` からの差分を使って更新します。

## 対象ファイルマッピング

引数 `{{target}}` に応じて対象を決定（未指定 or `all` は全て処理）：

| target | ドキュメントファイル | 主な関連ソース |
|---|---|---|
| `scraping` | `docs/specs/scraping.md` | `scripts/scrape-*.js`, `scripts/fetch-*.js`, `scripts/run-*.js` |
| `viewer` | `docs/specs/viewer.md` | `contents/viewer.html`, `scripts/serve-viewer.js`, `scripts/utils/generate-viewer.js` |
| `actress-api` | `docs/specs/actress-api.md` | `scripts/search-actress*.js` |
| `claude` | `CLAUDE.md` | `scripts/`, `package.json`, `contents/`, `data/` |
| `readme` | `README.md` | 全体 |

## 手順

対象ドキュメントごとに以下を実行：

### 1. コミットマーカーを読み取る

ドキュメントファイルを読み込み、末尾の `<!-- last-documented-commit: XXXXXXX -->` を抽出する。
マーカーがない場合は直近5コミットの差分を使用する。

### 2. 差分を取得する

```bash
git diff <last-documented-commit> HEAD
```

を実行してコード変更全体を取得する。

### 3. 関連変更を抽出してドキュメントに反映する

差分の中からこのドキュメントに関連する変更を洗い出し、以下の観点で更新する：

- 新しい機能・スクリプト・フィールドの追記
- 削除・変更された機能の修正または削除
- 処理フロー・動作の変更点の反映
- コマンド・オプションの変更

差分がない、または関連変更がない場合は「更新不要」と報告してスキップ。

### 4. コミットマーカーを更新する

ドキュメントを編集した後、必ずフッターのマーカーを現在の HEAD に更新する：

```bash
git rev-parse --short HEAD  # 現在のハッシュを取得
```

`<!-- last-documented-commit: <古いハッシュ> -->` を `<!-- last-documented-commit: <新しいハッシュ> -->` に書き換える。

## 注意

- ドキュメントを編集しなかった場合はマーカーを更新しない
- `all` 指定時は各ドキュメントを順番に処理し、最後にまとめてコミットする
- 実装と説明が一致していない箇所は修正する（説明の追加だけでなく誤記訂正も行う）
