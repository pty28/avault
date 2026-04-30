const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

/**
 * MGStage 購入済みストリーミング動画一覧をスクレイプするスクリプト
 *
 * 使用方法:
 *   npm run scrape-mgstage                    # 1ページ目のみ（新規のみ追加）
 *   npm run scrape-mgstage-full               # 全ページ取得
 *   npm run scrape-mgstage -- --force         # 1ページ目のみ・既存データも上書き
 *   npm run scrape-mgstage -- --full --force  # 全ページ・既存データも上書き
 *
 * ページ構造（調査済み）:
 *   URL: https://www.mgstage.com/mypage/mypage_top.php
 *   リスト: ul#PpvVideoList > li.ppv_purchase_item
 *   ページネーション: JavaScript関数 LoadMyPageBodyPPV(n) を呼び出す形式
 *   ストリーミング判定: a.button_mypage_streaming_now が存在するアイテムのみ対象
 */

const CONFIG = {
  mypageUrl: 'https://www.mgstage.com/mypage/mypage_top.php',
  outputFile: path.join(__dirname, '../data/mgstage-library.json'),
  pageLoadDelay: 2000,
};

const forceMode = process.argv.includes('--force');
const fullMode = process.argv.includes('--full');

const BASE_URL = 'https://www.mgstage.com';

function waitForEnter(message) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

/**
 * 購入日文字列 "購入日 YYYY/MM/DD" を registeredAt (ISO 8601) に変換
 * 0:00 JST (UTC+9)
 */
function parsePurchaseDate(dateText) {
  if (!dateText) return new Date().toISOString();
  const match = dateText.match(/(\d{4})\/(\d{2})\/(\d{2})/);
  if (!match) return new Date().toISOString();
  const [, year, month, day] = match;
  return new Date(`${year}-${month}-${day}T00:00:00+09:00`).toISOString();
}

/**
 * 現在表示中の ul#PpvVideoList からストリーミングアイテムを抽出
 */
async function scrapeCurrentPage(page) {
  return await page.evaluate((baseUrl) => {
    const items = [];

    document.querySelectorAll('ul#PpvVideoList > li.ppv_purchase_item').forEach(li => {
      // ストリーミング再生ボタン（button_mypage_streaming_now）が存在するアイテムのみ対象
      const streamingBtn = li.querySelector('a.button_mypage_streaming_now');
      if (!streamingBtn) return;

      // プレイヤーURL（相対URLを絶対URLに変換）
      const rawHref = streamingBtn.getAttribute('href') || '';
      const playerUrl = rawHref.startsWith('http') ? rawHref : baseUrl + rawHref;

      // 商品コード・商品URL: p.package_colum > a
      const detailLink = li.querySelector('p.package_colum > a');
      let productCode = null;
      let itemURL = null;
      if (detailLink) {
        const href = detailLink.getAttribute('href') || '';
        const m = href.match(/\/product\/product_detail\/([^/]+)\//);
        if (m) productCode = m[1];
        itemURL = href.startsWith('http') ? href : baseUrl + href;
      }

      if (!productCode) return;

      // タイトル: h2.title > a
      const titleEl = li.querySelector('h2.title a');
      const title = titleEl ? titleEl.textContent.trim() : '';

      // メーカー名: dl > dt("メーカー名：") の次の dd > a
      let makerName = null;
      const dtEls = li.querySelectorAll('dl > dt');
      for (const dt of dtEls) {
        if (dt.textContent.trim() === 'メーカー名：') {
          const dd = dt.nextElementSibling;
          if (dd) {
            makerName = dd.textContent.trim();
          }
          break;
        }
      }

      // サムネイル: p.package_colum > a > img[src]
      const imgEl = li.querySelector('p.package_colum img');
      const thumbnail = imgEl ? imgEl.getAttribute('src') : null;

      // 購入日: li.date のテキスト（"購入日 YYYY/MM/DD"）
      const dateEl = li.querySelector('li.date');
      const purchaseDateText = dateEl ? dateEl.textContent.trim() : null;

      items.push({
        productCode,
        title,
        makerName,
        thumbnail,
        itemURL,
        playerUrl,
        purchaseDateText,
      });
    });

    return items;
  }, BASE_URL);
}

/**
 * pagerbox から総ページ数を取得
 * 「29タイトル中 1〜20タイトルを表示」のようなテキストと
 * LoadMyPageBodyPPV(n) のonclickから最終ページ番号を取得
 */
async function getTotalPages(page) {
  return await page.evaluate(() => {
    // "最後へ" ボタンの onclick から最終ページ番号を取得
    const lastBtn = Array.from(document.querySelectorAll('.pagerbox a')).find(
      a => a.textContent.trim() === '最後へ'
    );
    if (lastBtn) {
      const onclick = lastBtn.getAttribute('onclick') || '';
      const m = onclick.match(/LoadMyPageBodyPPV\((\d+)\)/);
      if (m) return parseInt(m[1], 10);
    }

    // フォールバック: ページ数のリンクから最大値を取得
    const pageLinks = document.querySelectorAll('.pagerbox .page-list a');
    let maxPage = 1;
    pageLinks.forEach(a => {
      const onclick = a.getAttribute('onclick') || '';
      const m = onclick.match(/LoadMyPageBodyPPV\((\d+)\)/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxPage) maxPage = n;
      }
    });
    return maxPage;
  });
}

/**
 * LoadMyPageBodyPPV(n) を呼び出してページを切り替え、リストが更新されるまで待つ
 */
async function goToPage(page, pageNum) {
  // 切り替え前の最初のアイテムの商品コードを取得（更新検知用）
  const beforeCode = await page.evaluate(() => {
    const first = document.querySelector('ul#PpvVideoList > li.ppv_purchase_item p.package_colum a');
    if (!first) return null;
    const m = (first.getAttribute('href') || '').match(/\/product\/product_detail\/([^/]+)\//);
    return m ? m[1] : null;
  });

  // ページ切り替え
  await page.evaluate((n) => {
    LoadMyPageBodyPPV(n);
  }, pageNum);

  // リストが更新されるまで待機（最大10秒）
  try {
    await page.waitForFunction(
      (prevCode) => {
        const first = document.querySelector('ul#PpvVideoList > li.ppv_purchase_item p.package_colum a');
        if (!first) return false;
        const m = (first.getAttribute('href') || '').match(/\/product\/product_detail\/([^/]+)\//);
        const newCode = m ? m[1] : null;
        return newCode !== prevCode;
      },
      { timeout: 10000 },
      beforeCode
    );
  } catch {
    // タイムアウトしても続行（既にページが変わっている可能性）
  }

  await new Promise(r => setTimeout(r, CONFIG.pageLoadDelay));
}

/**
 * 既存の mgstage-library.json を読み込む
 */
async function loadExistingLibrary() {
  try {
    const data = await fs.readFile(CONFIG.outputFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function main() {
  console.log('🎬 MGStage スクレイパーを起動します');
  console.log(`   モード: ${forceMode ? 'force（全件上書き）' : '通常（新規のみ追加）'}${fullMode ? ' + 全ページ' : ' (1ページ目のみ)'}\n`);

  let browser;
  try {
    const chromePaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
    const executablePath = chromePaths.find(p => {
      try { require('fs').accessSync(p); return true; } catch { return false; }
    });

    browser = await puppeteer.launch({
      headless: false,
      executablePath,
      userDataDir: path.join(__dirname, '../.puppeteer-profiles/mgstage'), // セッション保持用プロファイル
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    // 年齢確認バイパス
    await page.setCookie({
      name: 'adc',
      value: '1',
      domain: 'www.mgstage.com',
      path: '/',
    });

    await page.goto('https://www.mgstage.com/', { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('手順:');
    console.log('  1. ブラウザで mgstage.com にログインしてください');
    console.log('  2. Enter を押してください');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await waitForEnter('ログインが完了したら Enter を押してください...');

    // マイページへ遷移
    console.log('\n📄 マイページへ遷移中...');
    await page.goto(CONFIG.mypageUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // ul#PpvVideoList が表示されるまで待機
    try {
      await page.waitForSelector('ul#PpvVideoList > li.ppv_purchase_item', { timeout: 15000 });
    } catch {
      console.error('❌ 購入済みリストが見つかりません。ログイン状態を確認してください。');
      return;
    }

    await new Promise(r => setTimeout(r, CONFIG.pageLoadDelay));

    // ページ数を取得
    const totalPages = await getTotalPages(page);
    const pagesToScrape = fullMode ? totalPages : 1;
    console.log(`   総ページ数: ${totalPages}ページ（取得: ${pagesToScrape}ページ）\n`);

    // ページをスクレイプ
    const allRawItems = [];

    for (let pageNum = 1; pageNum <= pagesToScrape; pageNum++) {
      if (pageNum > 1) {
        console.log(`   ページ ${pageNum} へ移動中...`);
        await goToPage(page, pageNum);
      }

      const items = await scrapeCurrentPage(page);
      console.log(`   ページ ${pageNum}: ${items.length}件のストリーミングアイテムを取得`);
      allRawItems.push(...items);
    }

    console.log(`✓ スクレイプ完了: ${allRawItems.length}件\n`);

    if (allRawItems.length === 0) {
      console.log('⚠️  ストリーミングアイテムが見つかりませんでした');
      return;
    }

    // 既存データを先に読み込む（重複チェック用）
    const existing = await loadExistingLibrary();
    const existingMap = new Map(existing.map(item => [item.productCode, item]));
    console.log(`📚 既存ライブラリ: ${existing.length}件\n`);

    // 新規アイテムのみをフィルタして整形
    const newItems = [];
    let skippedCount = 0;

    for (const raw of allRawItems) {
      const { productCode } = raw;

      // 既存アイテムはスキップ
      if (existingMap.has(productCode) && !forceMode) {
        skippedCount++;
        // playerUrls のみ更新
        const prev = existingMap.get(productCode);
        existingMap.set(productCode, { ...prev, playerUrls: [raw.playerUrl] });
        continue;
      }

      // 新規アイテムのみ整形
      const { title, makerName, thumbnail, itemURL, playerUrl, purchaseDateText } = raw;
      const item = {
        productCode,
        // MGStageのproductCodeは外部コード形式（例: 336KNB-195）なので
        // generateManufacturerCode による変換不要。そのまま使用する。
        manufacturerCode: productCode,
        title,
        actresses: [],
        makerName: makerName || null,
        thumbnail: thumbnail || null,
        itemURL: itemURL || null,
        playerUrls: [playerUrl],
        isFetched: true,
        isUncensored: false,
        registeredAt: parsePurchaseDate(purchaseDateText),
      };
      newItems.push(item);
    }

    console.log(`📊 新規アイテム: ${newItems.length}件 (スキップ: ${skippedCount}件)\n`);

    let addedCount = 0;

    for (const item of newItems) {
      if (!item.productCode) continue;

      const prev = existingMap.get(item.productCode) || {};
      existingMap.set(item.productCode, {
        ...prev,
        ...item,
        // 既存の registeredAt・actresses を保持
        registeredAt: prev.registeredAt || item.registeredAt,
        actresses: (prev.actresses && prev.actresses.length > 0) ? prev.actresses : item.actresses,
      });
      addedCount++;
    }

    const merged = Array.from(existingMap.values());

    await fs.writeFile(CONFIG.outputFile, JSON.stringify(merged, null, 2), 'utf-8');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ 完了');
    console.log(`   スクレイプ件数: ${newItems.length}件`);
    console.log(`   新規追加:       ${addedCount}件`);
    console.log(`   スキップ:       ${skippedCount}件`);
    console.log(`   合計:           ${merged.length}件`);
    console.log(`   保存先:         mgstage-library.json`);

    if (newItems.length > 0) {
      console.log('\n📋 取得データサンプル（最初の3件）:');
      newItems.slice(0, 3).forEach((item, i) => {
        console.log(`  [${i + 1}] ${item.productCode}`);
        console.log(`       タイトル:   ${item.title.substring(0, 40)}`);
        console.log(`       メーカー:   ${item.makerName}`);
        console.log(`       再生URL:    ${item.playerUrls[0].substring(0, 80)}`);
        console.log(`       登録日:     ${item.registeredAt}`);
      });
    }

  } catch (error) {
    console.error('\n❌ エラー:', error.message);
    console.error(error.stack);
  } finally {
    if (browser) {
      console.log('\n⏸  10秒後にブラウザを閉じます...');
      await new Promise(r => setTimeout(r, 10000));
      await browser.close();
    }
    process.stdin.pause();
  }
}

main().catch(console.error);
