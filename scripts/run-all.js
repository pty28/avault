#!/usr/bin/env node

/**
 * run-all.js
 *
 * 以下の4つのスクリプトを順番に実行します：
 * 1. npm run run-all-dmm  - DMM ライブラリのスクレイピング〜女優情報取得
 * 2. npm run run-all-mgs  - MGStage ライブラリのスクレイピング〜女優情報取得
 * 3. npm run scrape-vrack - VRACK ライブラリのスクレイピング
 * 4. npm run scrape-caribbean - カリビアン購入済み動画のスクレイピング
 *
 * 使用方法: npm run run-all
 * または: npm run run-all -- --full   (全ページ取得)
 * または: npm run run-all -- --force  (既存データも上書き)
 * または: npm run run-all -- --full --force
 */

const { spawn } = require('child_process');

// フラグ解析
const forceFlag = process.argv.includes('--force');
const fullFlag = process.argv.includes('--full');

// DMM API ID チェック
const API_ID = process.env.DMM_API_ID;
const AFFILIATE_ID = process.env.DMM_AFFILIATES_ID;
const hasApiCredentials = API_ID && AFFILIATE_ID;

// サイト有効フラグ（デフォルト true、.env で false に上書き可能）
const useDMM    = process.env.USE_DMM    !== 'false';
const useMGS    = process.env.USE_MGSTAGE !== 'false';
const useD2PASS = process.env.USE_D2PASS  !== 'false';

// 各スクリプトの引数を構築
const dmmArgs = ['run', 'run-all-dmm'];
if (fullFlag) dmmArgs.push('--', '--full');
if (forceFlag) dmmArgs.push(...(fullFlag ? ['--force'] : ['--', '--force']));

const mgsArgs = ['run', 'run-all-mgs'];
if (fullFlag) mgsArgs.push('--', '--full');
if (forceFlag) mgsArgs.push(...(fullFlag ? ['--force'] : ['--', '--force']));

const vrackArgs = forceFlag ? ['run', 'scrape-vrack', '--', '--force'] : ['run', 'scrape-vrack'];
const caribbeanArgs = forceFlag ? ['run', 'scrape-caribbean', '--', '--force'] : ['run', 'scrape-caribbean'];

const scripts = [
  ...(useDMM ? [{
    name: 'Run All DMM',
    command: 'npm',
    args: dmmArgs,
    description: `DMM ライブラリのスクレイピング〜女優情報取得${fullFlag ? ' (全ページ)' : ''}${forceFlag ? ' (--force)' : ''}...`,
  }] : []),
  ...(useMGS ? [{
    name: 'Run All MGStage',
    command: 'npm',
    args: mgsArgs,
    description: `MGStage ライブラリのスクレイピング〜女優情報取得${fullFlag ? ' (全ページ)' : ''}${forceFlag ? ' (--force)' : ''}...`,
  }] : []),
  ...(useD2PASS ? [{
    name: 'Scrape VRACK',
    command: 'npm',
    args: vrackArgs,
    description: `VRACK ライブラリのスクレイピング${forceFlag ? ' (--force)' : ''}...`,
  }] : []),
  ...(useD2PASS ? [{
    name: 'Scrape Caribbean',
    command: 'npm',
    args: caribbeanArgs,
    description: `カリビアン購入済み動画のスクレイピング${forceFlag ? ' (--force)' : ''}...`,
  }] : []),
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
  console.log('║' + ' '.repeat(16) + '🔄 全ライブラリ 全スクリプト順次実行ツール' + ' '.repeat(10) + '║');
  console.log('╚' + '═'.repeat(68) + '╝');

  // API ID チェック - メッセージ表示
  if (!hasApiCredentials) {
    console.log('\n⚠️  警告: DMM_API_ID / DMM_AFFILIATES_ID が設定されていません');
    console.log('   → DMM の女優・メーカー情報取得（Fetch Info）をスキップします');
    console.log('   → 女優情報は `npm run search-actress` で Web から取得してください\n');
  }

  if (!useDMM)    console.log('⏭️  USE_DMM=false: DMM をスキップ');
  if (!useMGS)    console.log('⏭️  USE_MGSTAGE=false: MGStage をスキップ');
  if (!useD2PASS) console.log('⏭️  USE_D2PASS=false: VRACK・カリビアン をスキップ');

  if (scripts.length === 0) {
    console.log('\n⚠️  実行対象のサイトがありません。.env の USE_* 設定を確認してください。');
    process.exit(0);
  }

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
