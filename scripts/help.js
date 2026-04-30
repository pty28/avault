#!/usr/bin/env node

const commands = [
  { type: 'header', text: '🎬 AV Collection List - コマンドヘルプ' },
  { type: 'blank' },

  { type: 'section', text: '📥 スクレイピング' },
  { cmd: 'npm run scrape-dmm', desc: 'DMMライブラリをスクレイプ（1ページ目）' },
  { cmd: '  --full', desc: '全ページをスクレイプ' },
  { cmd: '  --force', desc: '既存データも上書き' },
  { cmd: 'npm run scrape-mgstage', desc: 'MGStageストリーミング（1ページ目）' },
  { cmd: '  --full', desc: '全ページをスクレイプ' },
  { cmd: '  --force', desc: '既存データも上書き' },
  { cmd: 'npm run scrape-vrack', desc: 'VRACK購入済みをスクレイプ' },
  { cmd: 'npm run scrape-caribbean', desc: 'カリビアン購入済みをスクレイプ' },
  { cmd: 'npm run scrape-mylist', desc: 'マイリストタグをスクレイプ' },
  { type: 'blank' },

  { type: 'section', text: '📊 データ取得' },
  { cmd: 'npm run fetch-info', desc: 'DMM APIで女優・メーカー・レーベル情報取得' },
  { cmd: '  --force', desc: 'すべてを再取得' },
  { cmd: 'npm run fetch-player-urls', desc: 'playerURLを取得（1ページ目）' },
  { cmd: 'npm run fetch-player-urls-full', desc: '全ページから取得' },
  { cmd: 'npm run fetch-player-urls-force', desc: 'すべてを再取得' },
  { cmd: 'npm run search-actress', desc: 'Web検索で女優情報取得（DMM向け）' },
  { cmd: '  --file <file>', desc: '指定ファイルを処理' },
  { cmd: '  --force', desc: 'すべてを再検索' },
  { type: 'blank' },

  { type: 'section', text: '🎨 ビューワー' },
  { cmd: 'npm run generate-viewer', desc: 'ビューワーデータを生成' },
  { cmd: 'npm run viewer', desc: '生成 + viewer.html を開く' },
  { cmd: 'npm run serve', desc: '生成 + HTTPサーバー起動（http://localhost:8000）' },
  { type: 'blank' },

  { type: 'section', text: '🔄 一括実行' },
  { cmd: 'npm run run-all', desc: 'DMM + MGStage + VRACK + カリビアン' },
  { cmd: 'npm run run-all-dmm', desc: 'DMM全処理（scrape → fetch-info → codes → actress）' },
  { cmd: 'npm run run-all-mgs', desc: 'MGStage全処理' },
  { type: 'blank' },

  { type: 'section', text: '🔍 検索・フィルタリング' },
  { cmd: 'npm run search-products-by-actress "女優名"', desc: '女優名から作品を検索' },
  { cmd: 'npm run list-no-actresses', desc: '女優情報未取得の作品一覧' },
  { cmd: '  --csv', desc: 'CSV形式で出力' },
  { cmd: 'npm run list-all-actresses', desc: 'すべてのユニーク女優一覧' },
  { cmd: '  --csv', desc: 'CSV形式で出力' },
  { cmd: 'npm run list-no-itemurl', desc: 'itemURL未設定の作品一覧' },
  { cmd: 'npm run list-makers', desc: 'すべてのメーカー一覧' },
  { cmd: 'npm run list-labels', desc: 'すべてのレーベル一覧' },
  { cmd: 'npm run list-genres', desc: 'すべてのジャンル一覧' },
  { type: 'blank' },

  { type: 'section', text: '📋 品質チェック' },
  { cmd: 'npm run list-many-player-urls', desc: 'playerURL数が多い作品一覧' },
  { cmd: 'npm run check-duplicate-player-urls', desc: '重複するplayerURLをチェック' },
  { cmd: 'npm run test-api', desc: 'DMM API接続をテスト' },
  { type: 'blank' },

  { type: 'section', text: '⚙️ データ更新' },
  { cmd: 'npm run update-performers <productCode> "女優1,女優2"', desc: '女優情報を直接更新' },
  { type: 'blank' },

  { type: 'footer', text: '詳細はREADME.md / CLAUDE.md / .claude/rules.md を参照' },
];

commands.forEach(item => {
  if (item.type === 'header') {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(item.text);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } else if (item.type === 'section') {
    console.log(`\n${item.text}\n`);
  } else if (item.type === 'blank') {
    console.log('');
  } else if (item.type === 'footer') {
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📚 ${item.text}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  } else if (item.cmd) {
    console.log(`  ${item.cmd.padEnd(50)} ${item.desc}`);
  }
});
