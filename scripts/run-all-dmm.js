#!/usr/bin/env node

/**
 * run-all-dmm.js
 *
 * 以下の4つのスクリプトを順番に実行します：
 * 1. npm run scrape-dmm - DMM ライブラリからデータをスクレイピング
 * 2. npm run fetch-info - 女優名、メーカー、レーベル情報を取得
 * 3. npm run scrape-manufacturer-codes - メーカー品番を取得
 * 4. npm run search-actress - Web サイトから女優情報を取得
 *
 * 使用方法: npm run run-all-dmm
 * または: npm run run-all-dmm -- --force (fetch-info と search-actress を --force フラグで実行)
 */

const { spawn } = require('child_process');

const forceFlag = process.argv.includes('--force');

// DMM API ID チェック
const API_ID = process.env.DMM_API_ID;
const AFFILIATE_ID = process.env.DMM_AFFILIATES_ID;
const hasApiCredentials = API_ID && AFFILIATE_ID;

const scripts = [
  {
    name: 'Scrape DMM Library',
    command: 'npm',
    args: forceFlag ? ['run', 'scrape-dmm', '--', '--force'] : ['run', 'scrape-dmm'],
    description: `DMM マイライブラリから作品コード、タイトル、プレイヤーURLをスクレイピング中${forceFlag ? ' (--force モード)' : ''}...`,
  },
  ...(hasApiCredentials ? [{
    name: 'Fetch Info',
    command: 'npm',
    args: forceFlag ? ['run', 'fetch-info', '--', '--force'] : ['run', 'fetch-info'],
    description: `女優名、作品URL、メーカー/レーベル情報を取得中${forceFlag ? ' (--force モード)' : ''}...`,
  }] : []),
  {
    name: 'Scrape Manufacturer Codes',
    command: 'npm',
    args: ['run', 'scrape-manufacturer-codes'],
    description: 'FANZA ページからメーカー品番をスクレイピング中...',
  },
  {
    name: 'Search Actress Web',
    command: 'npm',
    args: forceFlag ? ['run', 'search-actress', '--', '--force'] : ['run', 'search-actress'],
    description: `Web サイトから女優情報を取得中${forceFlag ? ' (--force モード)' : ''}...`,
  },
];

let currentScriptIndex = 0;
let hasError = false;

function formatTime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}分${seconds % 60}秒`;
  return `${seconds}秒`;
}

function runScript(scriptConfig) {
  return new Promise((resolve) => {
    const startTime = Date.now();

    console.log(`\n${'='.repeat(70)}`);
    console.log(`[${currentScriptIndex + 1}/${scripts.length}] ${scriptConfig.name}`);
    console.log(`${'='.repeat(70)}`);
    console.log(`📌 ${scriptConfig.description}`);
    console.log(`⏱️  開始時刻: ${new Date().toLocaleString('ja-JP')}`);
    console.log('');

    const child = spawn(scriptConfig.command, scriptConfig.args, {
      stdio: 'inherit',
      shell: true,
      cwd: process.cwd(),
      env: process.env,
    });

    child.on('close', (code) => {
      const elapsed = formatTime(Date.now() - startTime);
      console.log('');
      if (code === 0) {
        console.log(`✅ ${scriptConfig.name} が完了しました (${elapsed})`);
      } else {
        console.log(`❌ ${scriptConfig.name} がエラーで終了しました（コード: ${code}、所要時間: ${elapsed}）`);
        hasError = true;
      }
      resolve(code);
    });
  });
}

async function runAll() {
  const overallStartTime = Date.now();

  console.log('\n');
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║' + ' '.repeat(20) + '🔄 DMM 全スクリプト順次実行ツール' + ' '.repeat(14) + '║');
  console.log('╚' + '═'.repeat(68) + '╝');

  // API ID チェック - メッセージ表示
  if (!hasApiCredentials) {
    console.log('\n⚠️  警告: DMM_API_ID / DMM_AFFILIATES_ID が設定されていません');
    console.log('   → Fetch Info（女優・メーカー情報取得）をスキップします');
    console.log('   → 女優情報は `npm run search-actress` で Web から取得してください\n');
  }

  console.log(`\n📋 実行予定: ${scripts.map(s => s.name).join(' → ')}`);
  console.log(`⏱️  開始時刻: ${new Date().toLocaleString('ja-JP')}`);
  if (forceFlag) console.log('🚩 --force フラグが指定されました');

  for (currentScriptIndex = 0; currentScriptIndex < scripts.length; currentScriptIndex++) {
    await runScript(scripts[currentScriptIndex]);
    if (currentScriptIndex < scripts.length - 1) {
      console.log('\n⏳ 次のスクリプトを準備中...\n');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const overallElapsed = formatTime(Date.now() - overallStartTime);

  console.log('\n' + '═'.repeat(70));
  console.log('📊 実行結果サマリー');
  console.log('═'.repeat(70));
  if (hasError) {
    console.log('❌ 実行中にエラーが発生しました');
  } else {
    console.log('✅ 全スクリプトの実行が正常に完了しました');
  }
  console.log(`\n⏱️  終了時刻: ${new Date().toLocaleString('ja-JP')}`);
  console.log(`⏱️  総所要時間: ${overallElapsed}`);
  console.log('');

  process.exit(hasError ? 1 : 0);
}

process.on('SIGINT', () => {
  console.log('\n\n⚠️  実行が中断されました');
  process.exit(1);
});

runAll().catch((error) => {
  console.error('予期しないエラーが発生しました:', error);
  process.exit(1);
});
