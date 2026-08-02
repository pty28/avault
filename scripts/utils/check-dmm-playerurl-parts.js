#!/usr/bin/env node
/**
 * DMM playerUrls の part 不足を検出・自動修正する監査ツール（既存データの一括点検用）。
 *
 * 新規スクレイプ分は `scrape-dmm-library.js` のPass 2で自動的に検証されるため、
 * 本ツールは「過去にPass 2が無かった時代のデータ」や「想定外のドリフト」を
 * 定期的に洗い出すためのバックフィル/監査ツールという位置づけ。
 *
 * 判定ロジックの詳細（React Fiberからcontent.idを直接取得する方式、
 * モーダルの開閉、part数カウント等）は `scripts/utils/dmm-part-checker.js` を参照。
 *
 * 使用方法:
 *   node scripts/utils/check-dmm-playerurl-parts.js --limit 10
 *   node scripts/utils/check-dmm-playerurl-parts.js --all
 */
const fs = require('fs');
const path = require('path');
const { setupSession } = require('../scrape-dmm-library.js');
const { verifyAndFixPartCounts } = require('./dmm-part-checker.js');

const LIBRARY_PATH = path.join(__dirname, '../../data/dmm-library.json');
const PROGRESS_PATH = path.join(__dirname, '../debug/dmm-playerurl-parts-check-progress.json');

const args = process.argv.slice(2);
const allMode = args.includes('--all');
const limitArg = args.find(a => a.startsWith('--limit'));
const limit = allMode ? Infinity : (limitArg ? parseInt(args[args.indexOf(limitArg) + 1] || limitArg.split('=')[1], 10) : 20);

function loadProgress() {
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function saveProgress(progress) {
  fs.mkdirSync(path.dirname(PROGRESS_PATH), { recursive: true });
  fs.writeFileSync(PROGRESS_PATH, JSON.stringify(progress, null, 2), 'utf-8');
}

async function main() {
  const library = JSON.parse(fs.readFileSync(LIBRARY_PATH, 'utf-8'));
  const progress = loadProgress();

  const targets = library.filter(item =>
    item.productCode &&
    !(item.title && item.title.includes('VR')) &&
    item.isFetched === true &&
    Array.isArray(item.playerUrls) &&
    item.playerUrls.length >= 1 &&
    !progress[item.productCode]
  );

  console.log(`🔍 チェック対象: ${targets.length}件（既チェック済みはスキップ、上限${limit === Infinity ? '無し' : limit}件）\n`);
  if (targets.length === 0) {
    console.log('対象なし。終了します。');
    return;
  }

  const { browser, page } = await setupSession();
  let processedCount = 0;
  let itemUrlFixedCount = 0;
  const mismatches = [];

  try {
    await verifyAndFixPartCounts(page, targets, {
      shouldStop: () => processedCount >= limit,
      onItemResult: (result) => {
        processedCount++;
        if (result.itemUrlFixed) itemUrlFixedCount++;
        const urlNote = result.itemUrlFixed ? '  [itemURL修正]' : '';
        if (!result.ok) {
          console.log(`  ⚠️  ${result.productCode}  ${result.reason}${urlNote}`);
          progress[result.productCode] = { ok: false, reason: result.reason, checkedAt: new Date().toISOString() };
        } else if (result.match) {
          console.log(`  ✅ ${result.productCode}  現在:${result.currentCount}  実際:${result.actualCount}${urlNote}`);
          progress[result.productCode] = { ok: true, match: true, currentCount: result.currentCount, actualCount: result.actualCount, checkedAt: new Date().toISOString() };
        } else {
          const tag = result.fixed ? '🔧' : '❗';
          const note = result.fixed ? '修正しました' : '(要確認・自動修正なし)';
          console.log(`  ${tag} ${result.productCode}  現在:${result.currentCount} → 実際:${result.actualCount}  ${note}${urlNote}`);
          mismatches.push({ productCode: result.productCode, currentCount: result.currentCount, actualCount: result.actualCount, fixed: !!result.fixed });
          progress[result.productCode] = { ok: true, match: false, fixed: !!result.fixed, currentCount: result.currentCount, actualCount: result.actualCount, checkedAt: new Date().toISOString() };
        }
        if (result.fixed || result.itemUrlFixed) {
          // 対象itemオブジェクトはverifyAndFixPartCounts内で直接playerUrls/itemURLを
          // 書き換え済み（library配列の要素はitem参照そのもの）。都度保存する。
          fs.writeFileSync(LIBRARY_PATH, JSON.stringify(library, null, 2), 'utf-8');
        }
        saveProgress(progress);
      },
    });
  } finally {
    await browser.close();
  }

  const fixedCount = mismatches.filter(m => m.fixed).length;
  const unfixedCount = mismatches.filter(m => !m.fixed).length;

  console.log('\n' + '='.repeat(60));
  console.log(`📊 チェック完了: ${processedCount}件`);
  console.log(`🔧 自動修正件数: ${fixedCount}件（実際 > 現在、data/dmm-library.jsonに反映済み）`);
  console.log(`❗ 要確認（自動修正なし）: ${unfixedCount}件（現在 > 実際、信頼性が低いため未修正）`);
  console.log(`🔗 itemURL自動修正件数: ${itemUrlFixedCount}件`);
  if (mismatches.length > 0) {
    console.log('\n詳細:');
    console.log(JSON.stringify(mismatches, null, 2));
  }
  console.log(`\n進捗ファイル: ${PROGRESS_PATH}`);
}

main().catch(err => { console.error(err); process.exit(1); });
