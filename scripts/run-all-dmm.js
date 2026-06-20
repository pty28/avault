#!/usr/bin/env node

/**
 * run-all-dmm.js
 *
 * 以下のスクリプトを順番に実行します：
 * 1. npm run scrape-dmm - DMM マイライブラリ API から作品情報＋メタ（女優・メーカー・
 *    レーベル・メーカー品番・プレイヤーURL）を取得
 * 2. npm run search-actress - 女優未登録作品（素人系など）を Web から補完
 *
 * 2026-06 のDMMリニューアル後、scrape-dmm が GraphQL API でメタ情報まで取得するため、
 * 旧来の fetch-info / scrape-manufacturer-codes / fetch-player-urls / fetch-actresses は
 * 不要となり削除した。
 *
 * 使用方法: npm run run-all-dmm
 * または: npm run run-all-dmm -- --force (各ステップを --force フラグで実行)
 */

const { spawn } = require('child_process');

const forceFlag = process.argv.includes('--force');

const scripts = [
  {
    name: 'Scrape DMM Library',
    command: 'npm',
    args: forceFlag ? ['run', 'scrape-dmm', '--', '--force'] : ['run', 'scrape-dmm'],
    description: `DMM マイライブラリ API から作品情報・女優・メーカー/レーベル・品番・プレイヤーURLを取得中${forceFlag ? ' (--force モード)' : ''}...`,
  },
  {
    name: 'Search Actress Web',
    command: 'npm',
    args: forceFlag ? ['run', 'search-actress', '--', '--force'] : ['run', 'search-actress'],
    description: `女優未登録作品の情報を Web から補完中${forceFlag ? ' (--force モード)' : ''}...`,
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
