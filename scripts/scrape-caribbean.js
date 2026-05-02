const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

/**
 * カリビアン購入済み動画一覧をスクレイプするスクリプト
 *
 * 使用方法:
 *   npm run scrape-caribbean
 *   npm run scrape-caribbean -- --force   # 既存データも上書き
 */

const CONFIG = {
  loginPageUrl: 'https://www.caribbeancompr.com/index2.html',
  historyPageUrl: 'https://www.caribbeancompr.com/member/app/history',
  outputFile: path.join(__dirname, '../data/caribbean-library.json'),
  pageLoadDelay: 1000,
};

const forceMode = process.argv.includes('--force');
const BASE_URL = 'https://www.caribbeancompr.com';

function waitForEnter(message) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

/**
 * 商品URLから商品コードを抽出
 * 例: /moviepages/122719_405/index.html → caribbean_122719_405
 */
function extractProductCode(moviePageUrl) {
  const match = moviePageUrl.match(/\/moviepages\/([^/]+)\//);
  if (match) {
    return `caribbean_${match[1]}`;
  }
  return null;
}

/**
 * 購入履歴ページから商品一覧を抽出
 */
async function scrapeHistoryPage(page) {
  return await page.evaluate((baseUrl) => {
    const items = [];

    // div.cart-item から各商品を抽出
    document.querySelectorAll('div.cart-item').forEach(cartItem => {
      // タイトル: a.meta-title
      const titleEl = cartItem.querySelector('a.meta-title');
      if (!titleEl) return;

      const title = titleEl.textContent.trim();
      const moviePageHref = titleEl.getAttribute('href') || '';

      // 商品ページURL
      const itemURL = moviePageHref.startsWith('http')
        ? moviePageHref
        : baseUrl + moviePageHref;

      // サムネイル: a.cart-media-image > img[src]
      const imgEl = cartItem.querySelector('a.cart-media-image img');
      let thumbnail = imgEl ? imgEl.getAttribute('src') : null;
      // 相対URLを絶対URLに変換
      if (thumbnail && !thumbnail.startsWith('http')) {
        thumbnail = baseUrl + thumbnail;
      }

      // 女優名: div.meta-data（meta-titleの直後）
      const metaDataEls = cartItem.querySelectorAll('div.meta-data');
      let actresses = [];
      // 最初のmeta-dataが女優名（その後は配信方式など）
      if (metaDataEls.length > 0) {
        const firstMetaData = metaDataEls[0].textContent.trim();
        // 複数の女優は、以下のいずれかで区切られている可能性
        actresses = firstMetaData
          .split(/[、,]/)
          .map(s => s.trim())
          .filter(s => s.length > 0 && !s.includes('配信方式'));
      }

      items.push({
        title,
        itemURL,
        thumbnail,
        actresses,
      });
    });

    return items;
  }, BASE_URL);
}

/**
 * 商品ページからスタジオ情報と再生URLを取得
 */
async function fetchProductDetails(browser, productPageUrl) {
  const page = await browser.newPage();

  try {
    await page.goto(productPageUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    const details = await page.evaluate(() => {
      // スタジオ情報を抽出
      let studioName = null;
      const movieSpecEls = document.querySelectorAll('li.movie-spec');
      for (const li of movieSpecEls) {
        const titleSpan = li.querySelector('span.spec-title');
        if (titleSpan && titleSpan.textContent.includes('スタジオ')) {
          const contentSpan = li.querySelector('span.spec-content');
          if (contentSpan) {
            const studioLink = contentSpan.querySelector('a');
            studioName = studioLink ? studioLink.textContent.trim() : contentSpan.textContent.trim();
            break;
          }
        }
      }

      // playerUrl: 商品ページのURL自体を使用
      const playerUrl = window.location.href;

      return {
        studioName,
        playerUrl,
      };
    });

    return details;
  } catch (error) {
    console.error(`   ⚠️  スタジオ情報取得エラー (${productPageUrl}): ${error.message}`);
    return { studioName: null, playerUrl: productPageUrl };
  } finally {
    await page.close();
  }
}

/**
 * 既存のcaribbean-library.jsonを読み込む
 */
async function loadExistingLibrary() {
  try {
    const data = await fs.readFile(CONFIG.outputFile, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

/**
 * 商品をマージする（重複排除）
 */
function mergeLibrary(existingItems, newItems) {
  const map = new Map();

  // 既存アイテムを登録
  for (const item of existingItems) {
    map.set(item.productCode, item);
  }

  // 新規アイテムを追加・更新
  for (const item of newItems) {
    const key = item.productCode;

    if (map.has(key)) {
      // 既存アイテムを更新（女優情報は追加のみ）
      const existing = map.get(key);
      if (item.actresses && item.actresses.length > 0 && (!existing.actresses || existing.actresses.length === 0)) {
        existing.actresses = item.actresses;
      }
      if (item.makerName && !existing.makerName) {
        existing.makerName = item.makerName;
      }
      existing.updatedAt = new Date().toISOString();
    } else {
      // 新規アイテムを追加
      map.set(key, item);
    }
  }

  return Array.from(map.values());
}

async function main() {
  console.log('🎬 カリビアン スクレイパーを起動します');
  console.log(`   モード: ${forceMode ? 'force（全件上書き）' : '通常（新規のみ追加）'}\n`);

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
      userDataDir: path.join(__dirname, '../.puppeteer-profiles/d2pass'), // D2Pass統一認証プロファイル（Hey動画・カリビアン共用）
      defaultViewport: { width: 1280, height: 900 },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.goto(CONFIG.loginPageUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('手順:');
    console.log('  1. ブラウザでカリビアンにログインしてください');
    console.log('  2. ログイン後、Enter を押してください');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await waitForEnter('ログインが完了したら Enter を押してください...');

    // 購入履歴ページへのリンクを自動でクリック
    console.log('\n🔄 購入履歴ページを自動で開いています...');
    try {
      const historyLinkClicked = await page.evaluate(() => {
        // a[href="/member/app/history"] をクリック
        const historyLink = document.querySelector('a[href="/member/app/history"]');
        if (historyLink) {
          historyLink.click();
          return true;
        }
        return false;
      });

      if (historyLinkClicked) {
        console.log('   ✓ 購入履歴リンクをクリックしました');
        await new Promise(r => setTimeout(r, 3000)); // ページ遷移待ち
      } else {
        console.log('   ⚠️  購入履歴リンクが見つかりません');
      }
    } catch (e) {
      console.log(`   ⚠️  購入履歴ページの自動表示に失敗: ${e.message}`);
    }

    console.log('\n📥 購入履歴ページをスクレイプしています...');
    const rawItems = await scrapeHistoryPage(page);
    console.log(`✓ ${rawItems.length}件の商品を検出しました\n`);

    // 既存ライブラリを先に読み込む（重複チェック用）
    let existingLibrary = [];
    const existingCodes = new Set();
    if (!forceMode) {
      existingLibrary = await loadExistingLibrary();
      existingLibrary.forEach(item => existingCodes.add(item.productCode));
      console.log(`📚 既存ライブラリ: ${existingLibrary.length}件\n`);
    }

    // 商品ページからスタジオ情報を取得（新規アイテムのみ）
    console.log('📄 商品ページから詳細情報を取得しています...');
    const newItems = [];
    let skippedCount = 0;

    for (let i = 0; i < rawItems.length; i++) {
      const raw = rawItems[i];
      const productCode = extractProductCode(raw.itemURL);

      if (!productCode) {
        console.log(`   ⚠️  [${i + 1}/${rawItems.length}] 商品コード抽出失敗: ${raw.itemURL}`);
        continue;
      }

      // 既存アイテムはスキップ
      if (existingCodes.has(productCode)) {
        skippedCount++;
        continue;
      }

      // 新規アイテムのみ詳細情報を取得
      const details = await fetchProductDetails(browser, raw.itemURL);
      await new Promise(r => setTimeout(r, CONFIG.pageLoadDelay)); // Rate limiting

      const item = {
        productCode,
        title: raw.title,
        actresses: raw.actresses,
        makerName: details.studioName,
        thumbnail: raw.thumbnail,
        itemURL: raw.itemURL,
        playerUrls: [details.playerUrl],
        isFetched: true, // Caribbean はAPIなし（スクレイプで全情報取得）
        isUncensored: true, // Caribbean は無修正サイト
        source: 'caribbean',
        registeredAt: new Date().toISOString(),
      };

      newItems.push(item);
      console.log(`   ✓ [${newItems.length}件取得] ${item.productCode}: ${item.title}`);
    }

    console.log(`\n✓ 詳細情報取得完了: ${newItems.length}件 (スキップ: ${skippedCount}件)\n`);

    // 既存ライブラリとマージ
    let library = forceMode ? [] : existingLibrary;

    const mergedLibrary = mergeLibrary(library, newItems);
    console.log(`📚 マージ後: ${mergedLibrary.length}件\n`);

    // ファイルに保存
    await fs.writeFile(CONFIG.outputFile, JSON.stringify(mergedLibrary, null, 2), 'utf-8');
    console.log(`✅ 保存完了: ${CONFIG.outputFile}`);

  } catch (error) {
    console.error('❌ エラー:', error.message);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

main();
