#!/usr/bin/env node

/**
 * search-products-by-actress.js
 *
 * 指定した女優が出演している作品をすべて表示します
 * カンマ区切りで複数の女優名を指定できます
 * デフォルト: OR条件（いずれかが出演）
 * --all: AND条件（全員が出演）
 *
 * 使用方法:
 *   npm run search-products-by-actress -- "女優名"
 *   npm run search-products-by-actress -- "女優名1,女優名2" （OR条件 - いずれかが出演）
 *   npm run search-products-by-actress -- "女優名1,女優名2" --all （AND条件 - 全員が出演）
 *   node scripts/utils/search-products-by-actress.js "女優名"
 *   node scripts/utils/search-products-by-actress.js -- "AIKA" --all
 */

const fs = require('fs').promises;
const path = require('path');

async function searchProductsByActress() {
  try {
    // 引数から女優名とフラグを取得
    const allArgs = process.argv.slice(2).filter(arg => arg !== '--');
    const useAndCondition = process.argv.includes('--all');

    if (allArgs.length === 0) {
      console.error('❌ エラー: 女優名を指定してください');
      console.log('\n使用方法:');
      console.log('  npm run search-products-by-actress -- "女優名"');
      console.log('  npm run search-products-by-actress -- "女優名1,女優名2" （複数指定 - OR条件）');
      console.log('  npm run search-products-by-actress -- "女優名1,女優名2" --all （複数指定 - AND条件）');
      console.log('  node scripts/utils/search-products-by-actress.js "女優名"');
      console.log('\n例:');
      console.log('  npm run search-products-by-actress -- "AIKA"');
      console.log('  npm run search-products-by-actress -- "麻美ゆま"');
      console.log('  npm run search-products-by-actress -- "AIKA,麻美ゆま" （どちらかが出演 - 73件）');
      console.log('  npm run search-products-by-actress -- "AIKA,麻美ゆま" --all （両方が出演 - 0件）');
      console.log('  npm run search-products-by-actress -- "AIKA,波多野結衣,深田えいみ" （誰かが出演 - 89件）');
      console.log('  npm run search-products-by-actress -- "AIKA,波多野結衣,深田えいみ" --all （全員が出演）');
      process.exit(1);
    }

    // カンマで分割して複数の女優名を取得
    const searchActresses = allArgs[0]
      .split(',')
      .map(name => name.trim())
      .filter(name => name.length > 0);

    // dmm-library.json を読み込む
    const data = JSON.parse(
      await fs.readFile(path.join(__dirname, '..', '..', 'data', 'dmm-library.json'), 'utf-8')
    );

    // 指定された女優が出演している作品を抽出
    const matchedProducts = [];

    for (const item of data) {
      if (item.actresses && Array.isArray(item.actresses)) {
        let isMatch = false;

        if (useAndCondition) {
          // AND条件: 指定した女優すべてが出演している作品を見つける
          isMatch = searchActresses.every(searchActress =>
            item.actresses.some(actress =>
              actress === searchActress ||
              actress.includes(searchActress)
            )
          );
        } else {
          // OR条件: 指定した女優のいずれかが出演している作品を見つける
          isMatch = searchActresses.some(searchActress =>
            item.actresses.some(actress =>
              actress === searchActress ||
              actress.includes(searchActress)
            )
          );
        }

        if (isMatch) {
          matchedProducts.push({
            productCode: item.productCode || 'N/A',
            title: item.title || 'タイトルなし',
            actresses: item.actresses || [],
          });
        }
      }
    }

    // 結果を表示
    console.log('\n' + '═'.repeat(80));

    // タイトルの作成
    let queryTitle;
    let queryText;

    if (searchActresses.length === 1) {
      queryTitle = `「${searchActresses[0]}」の出演作品`;
      queryText = `「${searchActresses[0]}」の出演作品`;
    } else if (useAndCondition) {
      // AND条件: 「×」で結合、「かつ」で接続
      queryTitle = `「${searchActresses.join('」×「')}」の全出演作品`;
      queryText = `「${searchActresses.join('」かつ「')}」の全出演作品`;
    } else {
      // OR条件: 「/」で結合、「または」で接続
      queryTitle = `「${searchActresses.join('」/「')}」の出演作品`;
      queryText = `「${searchActresses.join('」または「')}」の出演作品`;
    }

    console.log(`🎬 ${queryTitle}`);
    console.log('═'.repeat(80) + '\n');

    if (matchedProducts.length === 0) {
      console.log(`❌ ${queryText}は見つかりませんでした\n`);
      process.exit(0);
    }

    console.log(`✅ 該当作品数: ${matchedProducts.length}件\n`);

    for (let i = 0; i < matchedProducts.length; i++) {
      const product = matchedProducts[i];
      console.log(`${i + 1}. [${product.productCode}]`);
      console.log(`   ${product.title}`);
      console.log(`   出演女優: ${product.actresses.join(', ')}`);
      console.log('');
    }

    console.log('═'.repeat(80) + '\n');
  } catch (error) {
    console.error('❌ エラーが発生しました:', error.message);
    process.exit(1);
  }
}

searchProductsByActress();
