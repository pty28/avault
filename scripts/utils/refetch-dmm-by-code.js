#!/usr/bin/env node

/**
 * refetch-dmm-by-code.js
 *
 * 指定した productCode のエントリだけ、DMM の ContentMeta API から全メタ
 * （playerUrls / maker / label / actresses / manufacturerCode / itemURL）を
 * 取り直して上書きします。productCode 自体は変更しません。
 *
 * isFetched 済みで scrape-dmm の再取得対象から外れている旧スキーマ由来のエントリ
 * （maker/女優/品番/playerUrls が空・不正）の復旧用。
 * ContentMeta の id はマイライブラリ一覧の id（= productCode 小文字）で解決する。
 *
 * 使用方法:
 *   npm run refetch-dmm -- 53RDV043 53KS8488 15ALD64
 *   npm run refetch-dmm -- 53RDV043,53KS8488     （カンマ区切りも可）
 *   npm run refetch-dmm -- --file data/dmm-library.json SIRO05588
 *   npm run refetch-dmm -- --cid 53ks08352 53RDV043   （idを手動指定。対象1件のとき）
 *
 * オプション:
 *   --file <path>  ライブラリファイルを指定（デフォルト: data/dmm-library.json）
 *   --cid <id>     ContentMeta に使う id を手動指定（productCode で解決しない場合）
 */

const fs = require('fs');
const path = require('path');
const {
  setupSession,
  enrichItem,
  CONFIG,
} = require('../scrape-dmm-library');

function takeOption(args, name) {
  const idx = args.indexOf(name);
  if (idx === -1 || !args[idx + 1]) return { value: null, rest: args };
  const value = args[idx + 1];
  const rest = args.filter((_, i) => i !== idx && i !== idx + 1);
  return { value, rest };
}

async function main() {
  let args = process.argv.slice(2);

  const fileOpt = takeOption(args, '--file');
  const libraryFile = fileOpt.value
    ? path.resolve(fileOpt.value)
    : path.join(__dirname, '..', '..', 'data', 'dmm-library.json');
  args = fileOpt.rest;

  const cidOpt = takeOption(args, '--cid');
  const cidManual = cidOpt.value;
  args = cidOpt.rest;

  // 残りの引数を productCode のリストに（スペース/カンマ区切り対応）
  const codes = args
    .flatMap(a => a.split(','))
    .map(c => c.trim())
    .filter(Boolean);

  if (codes.length === 0) {
    console.error('\n❌ 使用方法: npm run refetch-dmm -- <productCode> [<productCode> ...]');
    console.error('   オプション: --file <path> / --cid <id>\n');
    process.exit(1);
  }

  if (cidManual && codes.length !== 1) {
    console.error('\n❌ --cid は対象が1件のときのみ指定できます\n');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(libraryFile, 'utf-8'));

  // 対象 item を特定
  const targets = [];
  for (const code of codes) {
    const item = data.find(it => it.productCode && it.productCode.toLowerCase() === code.toLowerCase());
    if (!item) {
      console.warn(`⚠️  productCode "${code}" が見つかりません（スキップ）`);
      continue;
    }
    targets.push(item);
  }

  if (targets.length === 0) {
    console.error('\n❌ 対象が1件もありません\n');
    process.exit(1);
  }

  console.log(`\n🎯 再取得対象: ${targets.length}件\n`);

  const { browser, page } = await setupSession();

  let okCount = 0, failCount = 0;
  try {
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      const progress = `[${i + 1}/${targets.length}]`;

      // ContentMeta の id はマイライブラリ一覧の id（= productCode 小文字）。
      // 旧スキーマ品番でもこの id で解決する。サムネのゼロ埋め cid では解決しない。
      const cid = (cidManual || item.productCode).toLowerCase();

      // 手動キュレーション済みの女優名を保護（既存が非空なら enrich 後に復元）
      const prevActresses = Array.isArray(item.actresses) ? [...item.actresses] : [];

      try {
        const r = await enrichItem(page, item, cidManual || undefined);
        if (r.ok) {
          if (prevActresses.length > 0) item.actresses = prevActresses;
          item.itemURL = `https://video.dmm.co.jp/av/content/?id=${cid}`;
          okCount++;
          console.log(`   ${progress} ✅ ${item.productCode} (cid:${cid})  品番:${item.manufacturerCode || '-'}  女優:${(item.actresses || []).join(',') || '-'}  player:${(item.playerUrls || []).length}`);
        } else {
          failCount++;
          console.log(`   ${progress} ⚠️  ${item.productCode} (cid:${cid})  メタ取得失敗: ${r.error}`);
        }
      } catch (error) {
        failCount++;
        console.log(`   ${progress} ❌ ${item.productCode} (cid:${cid})  ${error.message}`);
      }
      await new Promise(r => setTimeout(r, CONFIG.metaDelay));
    }

    fs.writeFileSync(libraryFile, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`\n💾 保存完了: ${libraryFile}`);
    console.log(`   成功 ${okCount} / 失敗 ${failCount}\n`);
  } finally {
    console.log('🔚 ブラウザを閉じています...');
    await browser.close();
  }
}

main().catch(err => { console.error(err); process.exit(1); });
