#!/usr/bin/env node

/**
 * run-all-mgs.js
 *
 * 以下の2つのスクリプトを順番に実行します：
 * 1. npm run scrape-mgstage - MGStage 購入済みストリーミング動画をスクレイピング
 * 2. npm run search-actress-mgstage - Web サイトから女優情報を取得
 *
 * 使用方法: npm run run-all-mgs
 * または: npm run run-all-mgs -- --full   (全ページ取得)
 * または: npm run run-all-mgs -- --force  (既存データも上書き)
 * または: npm run run-all-mgs -- --full --force
 */

const { spawn } = require('child_process');

const forceFlag = process.argv.includes('--force');
const fullFlag = process.argv.includes('--full');

const scrapeArgs = ['run', 'scrape-mgstage'];
if (fullFlag) scrapeArgs.push('--', '--full');
if (forceFlag) scrapeArgs.push(...(fullFlag ? ['--force'] : ['--', '--force']));

const searchArgs = forceFlag
  ? ['run', 'search-actress-mgstage', '--', '--force']
  : ['run', 'search-actress-mgstage'];

const scripts = [
  {
    name: 'Scrape MGStage',
    command: 'npm',
    args: scrapeArgs,
    description: `MGStage 購入済みストリーミング動画をスクレイピング中${fullFlag ? ' (全ページ)' : ' (1ページ目のみ)'}${forceFlag ? ' (--force)' : ''}...`,
  },
  {
    name: 'Search Actress (MGStage)',
    command: 'npm',
    args: searchArgs,
    description: `Web サイトから女優情報を取得中${forceFlag ? ' (--force)' : ''}...`,
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
  console.log('║' + ' '.repeat(18) + '🔄 MGStage 全スクリプト順次実行ツール' + ' '.repeat(12) + '║');
  console.log('╚' + '═'.repeat(68) + '╝');
  console.log(`\n📋 実行予定: ${scripts.map(s => s.name).join(' → ')}`);
  console.log(`⏱️  開始時刻: ${new Date().toLocaleString('ja-JP')}`);
  if (fullFlag) console.log('🚩 --full フラグが指定されました（全ページ取得）');
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
