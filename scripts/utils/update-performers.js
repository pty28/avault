#!/usr/bin/env node

/**
 * update-actresses.js
 *
 * productCode と女優名（カンマまたはスラッシュで区切り）を指定して、指定したライブラリファイルの actresses フィールドを更新します
 *
 * 使用方法:
 *   npm run update-performers -- VERO00129 "女優名1,女優名2"                              (DMM)
 *   npm run update-performers-mgstage -- SIRO05588 "女優名"                               (MGStage)
 *   npm run update-performers-heydouga -- heydouga_123456 "女優名"                        (Hey動画)
 *   npm run update-performers-caribbean -- caribbean_001_001 "女優名1,女優名2"             (Caribbean)
 *   node scripts/utils/update-performers.js --file data/mgstage-library.json SIRO05588 "女優名"
 *
 * オプション:
 *   --file <path>  ライブラリファイルを指定（デフォルト: data/dmm-library.json）
 */

const fs = require('fs');
const path = require('path');

// コマンドライン引数をチェック
const args = process.argv.slice(2);

// --file オプション処理
const fileArgIndex = args.indexOf('--file');
const libraryFile = fileArgIndex !== -1 && args[fileArgIndex + 1]
  ? path.resolve(args[fileArgIndex + 1])
  : path.join(__dirname, '..', '..', 'data', 'dmm-library.json');

// --file と値を除いた残りの引数
const remainingArgs = args.filter((_, i) => i !== fileArgIndex && i !== fileArgIndex + 1);

if (remainingArgs.length < 2) {
  console.error('\n❌ 使用方法:');
  console.error('   npm run update-performers -- <productCode> "<actress1>,<actress2>,..."\n');
  console.error('オプション:');
  console.error('   --file <path>  ライブラリファイルを指定（デフォルト: dmm-library.json）\n');
  console.error('例:');
  console.error('   npm run update-performers -- VERO00129 "女優名1,女優名2"');
  console.error('   npm run update-performers-mgstage -- SIRO05588 "女優名"');
  console.error('   npm run update-performers-heydouga -- heydouga_123456 "女優名"\n');
  process.exit(1);
}

const productCode = remainingArgs[0];
const actressesInput = remainingArgs[1];

// 女優名をパース（カンマまたはスラッシュ（半角・全角）で分割）
const actresses = actressesInput
  .split(/[,/／]/)
  .map(name => name.trim())
  .filter(name => name.length > 0);

if (actresses.length === 0) {
  console.error('\n❌ エラー: 有効な女優名が指定されていません\n');
  process.exit(1);
}

try {
  // ライブラリファイルを読み込む
  const data = JSON.parse(fs.readFileSync(libraryFile, 'utf-8'));

  // productCode に一致するアイテムを探す
  const itemIndex = data.findIndex(item => item.productCode === productCode);

  if (itemIndex === -1) {
    console.error(`\n❌ エラー: productCode "${productCode}" が見つかりません\n`);
    process.exit(1);
  }

  const item = data[itemIndex];

  // 更新前の情報を表示
  console.log('\n' + '═'.repeat(70));
  console.log('📝 actresses 更新');
  console.log('═'.repeat(70) + '\n');

  console.log(`📌 Product Code: ${item.productCode}`);
  console.log(`📚 Title: ${(item.title || '(なし)').substring(0, 60)}`);
  console.log('');

  // 更新前の actresses を表示
  console.log('【更新前】');
  if (item.actresses && item.actresses.length > 0) {
    console.log(`  ${item.actresses.length}件: ${item.actresses.join(', ')}`);
  } else {
    console.log('  (未設定)');
  }
  console.log('');

  // actresses を更新
  const oldPerformers = item.actresses || [];
  item.actresses = actresses;

  // 更新後の actresses を表示
  console.log('【更新後】');
  console.log(`  ${actresses.length}件: ${actresses.join(', ')}`);
  console.log('');

  // ファイルに保存
  fs.writeFileSync(libraryFile, JSON.stringify(data, null, 2), 'utf-8');

  console.log('═'.repeat(70));
  console.log('✅ 更新完了しました\n');

  // 統計情報を表示
  if (oldPerformers.length > 0 && oldPerformers.length !== actresses.length) {
    console.log(`📊 女優数の変更: ${oldPerformers.length}件 → ${actresses.length}件\n`);
  }
} catch (error) {
  console.error('\n❌ エラーが発生しました:', error.message);
  process.exit(1);
}
