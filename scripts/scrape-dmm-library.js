const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

/**
 * DMMマイライブラリ（新SPA: video.dmm.co.jp）から作品情報を取得するスクリプト
 *
 * 2026-06 のDMMリニューアルで購入済み一覧が React/Tailwind 製 SPA に移行し、
 * 旧 DOM セレクタ（mySearchList_*）が消滅したため、内部 GraphQL API を直接叩く方式へ変更。
 *
 * 取得方法:
 *   1. Mylibrary       : 購入済み一覧（id=品番, タイトル, サムネ, contentType, 取得日時）
 *   2. ContentMeta     : 詳細メタ（メーカー品番, 女優, メーカー, レーベル, products→playerUrls）
 *
 * 使用方法:
 *   npm run scrape-dmm            - 新規分の取得＋メタ付与
 *   npm run scrape-dmm -- --force - 既存分も含めてメタを再取得
 */

const CONFIG = {
  targetUrl: 'https://video.dmm.co.jp/mylibrary/',
  graphqlUrl: 'https://api.video.dmm.co.jp/graphql',
  outputFile: path.join(__dirname, '../data/dmm-library.json'),
  cookieFile: path.join(__dirname, '../.puppeteer-profiles/dmm-cookies.json'),
  profileDir: path.join(__dirname, '../.puppeteer-profiles/dmm'),
  pageSize: 120,         // Mylibrary 1ページあたり件数（API側 limit）
  metaDelay: 250,        // ContentMeta 連続呼び出し間隔（ミリ秒）
};

// 購入済み一覧（取得日時の新しい順）
const MYLIBRARY_QUERY = `query Mylibrary($offset: Int!, $filter: PPVContentViewingRightsItemSummaryListFilterInput!, $sort: PPVContentViewingRightsItemSummaryListSort!) {
  user { ... on Member { ppvLibrary {
    list: contentViewingRightsSummaryList(filter: $filter, offset: $offset, limit: ${CONFIG.pageSize}, sort: $sort) {
      items { id content { title packageImage { mediumUrl } contentType floor } contentItem { latestViewingRightsAcquiredAt } }
      pageInfo { hasNext totalCount }
    } } } }
}`;

// 詳細メタ（女優・メーカー・レーベル・品番・products）
const CONTENT_META_QUERY = `query ContentMeta($id: ID!) {
  ppvContent(id: $id) {
    id title floor contentType
    packageImage { mediumUrl largeUrl }
    makerContentId
    maker { id name }
    label { id name }
    actresses { name }
    products { id utilizationStatus }
  }
}`;

/**
 * 保存済みのクッキーを復元
 */
async function loadCookies(page) {
  try {
    const data = await fs.readFile(CONFIG.cookieFile, 'utf-8');
    const cookies = JSON.parse(data);
    await page.setCookie(...cookies);
    console.log(`✅ クッキーを復元しました (${cookies.length}件)\n`);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('💾 保存済みクッキーがありません（初回実行）\n');
    } else {
      console.log(`⚠️  クッキー復元に失敗しました: ${error.message}\n`);
    }
    return false;
  }
}

/**
 * クッキーを保存
 */
async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    await fs.writeFile(CONFIG.cookieFile, JSON.stringify(cookies, null, 2), 'utf-8');
    console.log(`✅ クッキーを保存しました (${cookies.length}件)\n`);
  } catch (error) {
    console.log(`⚠️  クッキー保存に失敗しました: ${error.message}\n`);
  }
}

/**
 * productCode を DMM CID 形式に正規化する（既存データとの重複判定の安全網）
 * 例: 49FN00008 → 49FN08
 */
function normalizeDmmProductCode(code) {
  if (!code) return code;
  const m = code.match(/^(\d+[A-Za-z]+)(0+)(\d+)$/);
  if (m) {
    const num = parseInt(m[2] + m[3], 10);
    return m[1] + String(num).padStart(2, '0');
  }
  return code;
}

/**
 * 正規化済みコード（例: 49FN08）からサムネイル形式（49FN00008）を生成
 */
function paddedEquivalent(code) {
  const m = code.match(/^(\d+[A-Za-z]+)(\d{2,4})$/);
  if (!m) return null;
  return m[1] + String(parseInt(m[2], 10)).padStart(5, '0');
}

/**
 * thumbnail URLからproductCodeを抽出（既存サムネ形式の重複判定用）
 */
function extractProductCodeFromThumbnail(src) {
  if (!src) return null;
  let m = src.match(/\/([^/]+)\/\1(ps|js)\.(jpg|png|gif)/i);
  if (m) return m[1].toUpperCase();
  m = src.match(/\/([a-z0-9_-]+)\/\1[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)/i);
  if (m) return m[1].toUpperCase();
  m = src.match(/\/([a-z0-9_-]+)[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)/i);
  if (m) return m[1].toUpperCase();
  return null;
}

/**
 * 女優名のクリーニング（Alice表記・括弧内の別名処理）
 */
function cleanActressName(name) {
  if (!name) return name;
  if (name.includes('Alice')) {
    const match = name.match(/Alice（(.+)）?/);
    if (match && match[1]) return match[1];
  }
  if (name.includes('（')) return name.split('（')[0];
  return name;
}

/**
 * ブラウザのページコンテキストから GraphQL を呼ぶ（セッションcookie自動付与）
 */
async function gqlInPage(page, operationName, query, variables) {
  return page.evaluate(async (url, operationName, query, variables) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ operationName, query, variables }),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    return { status: res.status, errors: json && json.errors, data: json && json.data };
  }, CONFIG.graphqlUrl, operationName, query, variables);
}

/**
 * 購入済み一覧をページングで全件取得
 */
async function fetchAllPurchases(page) {
  console.log('📥 購入済み一覧を取得しています...');
  const items = [];
  let offset = 0;
  let totalCount = null;

  while (true) {
    const res = await gqlInPage(page, 'Mylibrary', MYLIBRARY_QUERY, {
      filter: { displayStatus: 'VISIBLE' },
      offset,
      sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC',
    });

    if (res.status !== 200 || res.errors) {
      throw new Error(`Mylibrary API エラー: status=${res.status} errors=${JSON.stringify(res.errors)}`);
    }
    const list = res.data && res.data.user && res.data.user.ppvLibrary && res.data.user.ppvLibrary.list;
    if (!list) throw new Error('Mylibrary レスポンスに list がありません（未ログインの可能性）');

    totalCount = list.pageInfo.totalCount;
    for (const it of list.items) {
      items.push({
        id: it.id,
        title: (it.content && it.content.title) || '',
        thumbnail: (it.content && it.content.packageImage && it.content.packageImage.mediumUrl) || '',
        contentType: (it.content && it.content.contentType) || '',
        floor: (it.content && it.content.floor) || '',
        acquiredAt: (it.contentItem && it.contentItem.latestViewingRightsAcquiredAt) || '',
      });
    }
    console.log(`   ${items.length}/${totalCount} 件`);

    if (!list.pageInfo.hasNext) break;
    offset += CONFIG.pageSize;
  }

  console.log(`✅ 一覧取得完了: ${items.length}件\n`);
  return items;
}

/**
 * products から playerUrls を再構成する
 * - parent_product_id: 所有している product（utilizationStatus !== NONE、例: EST_PURCHASED）の id
 * - pid（配信用コンテンツID）を products から特定する（cid からの推測ではなく実データ由来）:
 *     1. 素人系(floor=AMATEUR)は `〜st` の product が存在 → それを使う（例: show019 → show019st）
 *     2. それ以外は dl サフィックスを持たない「素」の product → エイリアス品番にも対応
 *        （例: cid=61mdb093 でも素product=61rmd00723 を pid に使える）
 *     3. いずれも無ければ cid にフォールバック
 *   （既存データ3791件で 100% このルールで導出可能なことを確認済み）
 * - VR作品はプレイヤーURL形式が異なるためスキップ
 */
function buildPlayerUrls(cid, products, contentType, title) {
  if (contentType === 'VR' || /【VR】/.test(title)) return [];
  if (!Array.isArray(products) || products.length === 0) return [];
  const owned = products.filter(p => p.utilizationStatus && p.utilizationStatus !== 'NONE');
  if (owned.length === 0) return [];

  const stProduct = products.find(p => p.id && /st$/i.test(p.id));
  const bareProduct = products.find(p => p.id && !/dl\d*$/i.test(p.id) && !/st$/i.test(p.id));
  const pid = (stProduct ? stProduct.id : (bareProduct ? bareProduct.id : cid)).toLowerCase();

  return owned.map(p =>
    `https://www.dmm.co.jp/digital/-/player/=/player=html5/act=playlist/pid=${pid}/view_flag=1/parent_product_id=${p.id}/part=1/`
  );
}

/**
 * ContentMeta を取得して item にメタ情報を付与
 */
async function enrichItem(page, item) {
  const cid = item.productCode.toLowerCase();
  const res = await gqlInPage(page, 'ContentMeta', CONTENT_META_QUERY, { id: cid });
  if (res.status !== 200 || res.errors || !res.data || !res.data.ppvContent) {
    return { ok: false, error: res.errors ? JSON.stringify(res.errors) : `status=${res.status}` };
  }
  const c = res.data.ppvContent;

  item.manufacturerCode = c.makerContentId || item.manufacturerCode || '';
  item.makerName = (c.maker && c.maker.name) || item.makerName || '';
  item.makerId = (c.maker && c.maker.id) || item.makerId || '';
  item.labelName = (c.label && c.label.name) || item.labelName || '';
  item.labelId = (c.label && c.label.id) || item.labelId || '';

  const actresses = Array.isArray(c.actresses)
    ? c.actresses.map(a => cleanActressName(a.name)).filter(Boolean)
    : [];
  if (actresses.length > 0) item.actresses = actresses;

  const playerUrls = buildPlayerUrls(c.id, c.products, c.contentType, item.title);
  if (playerUrls.length > 0) item.playerUrls = playerUrls;

  item.isFetched = true;
  return { ok: true, c, actresses, playerUrls };
}

/**
 * メイン処理
 */
async function main() {
  console.log('🚀 DMM Library Scraper (API方式) を起動します\n');

  const forceMode = process.argv.includes('--force');
  if (forceMode) console.log('🚩 --force: 既存分も含めてメタを再取得します\n');

  let browser;
  try {
    console.log('🌐 ブラウザを起動しています...');
    const chromePaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
    const executablePath = chromePaths.find(p => {
      try { require('fs').accessSync(p); return true; } catch { return false; }
    });
    if (executablePath) console.log(`✓ Chrome を検出: ${executablePath}`);

    browser = await puppeteer.launch({
      headless: false,
      executablePath,
      userDataDir: CONFIG.profileDir,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    console.log(`📄 ${CONFIG.targetUrl} にアクセスしています...\n`);
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });

    const cookieRestored = await loadCookies(page);
    if (cookieRestored) {
      console.log('🔄 ページをリロードしています...\n');
      await page.reload({ waitUntil: 'networkidle2' });
    }

    // ログイン判定: Mylibrary API を1回叩いて data が返るか確認
    let loginCheck = await gqlInPage(page, 'Mylibrary', MYLIBRARY_QUERY, {
      filter: { displayStatus: 'VISIBLE' }, offset: 0, sort: 'VIEWING_RIGHTS_ACQUIRED_AT_DESC',
    });
    let isLoggedIn = loginCheck.status === 200 && loginCheck.data &&
                     loginCheck.data.user && loginCheck.data.user.ppvLibrary;

    if (!isLoggedIn) {
      console.log('⏳ ログインしてください...');
      console.log('   ブラウザでDMM/FANZAにログインしてマイライブラリを表示してください。');
      console.log('   完了後、このターミナルで Enterキーを押してください。\n');
      await new Promise(resolve => {
        process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
      });
      await saveCookies(page);
    } else {
      console.log('✅ セッション復元成功！ログインをスキップします。\n');
    }

    // 購入済み一覧を全件取得
    const purchases = await fetchAllPurchases(page);

    // 既存データを読み込み
    console.log('📂 既存データを確認しています...');
    let existingData = [];
    try {
      existingData = JSON.parse(await fs.readFile(CONFIG.outputFile, 'utf-8'));
      console.log(`   ✓ ${existingData.length}件の既存データを読み込みました`);
    } catch (error) {
      if (error.code === 'ENOENT') console.log('   ℹ️  既存ファイルが見つかりません。新規作成します。');
      else throw error;
    }

    // 既存 productCode の集合（正規化・パディング・サムネ形も含めた安全網）
    const existingCodes = new Set(
      existingData
        .filter(item => item.productCode)
        .flatMap(item => {
          const codes = [item.productCode.toLowerCase()];
          const norm = normalizeDmmProductCode(item.productCode);
          if (norm) codes.push(norm.toLowerCase());
          const padded = paddedEquivalent(item.productCode);
          if (padded) codes.push(padded.toLowerCase());
          const thumb = extractProductCodeFromThumbnail(item.thumbnail || '');
          if (thumb) codes.push(thumb.toLowerCase());
          return codes;
        })
    );

    const isExisting = (id) => {
      const variants = [id.toLowerCase()];
      const norm = normalizeDmmProductCode(id);
      if (norm) variants.push(norm.toLowerCase());
      const padded = paddedEquivalent(id);
      if (padded) variants.push(padded.toLowerCase());
      return variants.some(v => existingCodes.has(v));
    };

    // 新規アイテムを生成（スキーマは既存に合わせる）
    const newItems = purchases
      .filter(p => !isExisting(p.id))
      .map(p => ({
        productCode: p.id.toUpperCase(),
        title: p.title,
        actresses: [],
        thumbnail: p.thumbnail,
        itemURL: `https://video.dmm.co.jp/av/content/?id=${p.id.toLowerCase()}`,
        isFetched: false,
        isShirouto: false,
        registeredAt: p.acquiredAt || new Date().toISOString(),
        playerUrls: [],
        makerName: '',
        makerId: '',
        labelName: '',
        labelId: '',
        manufacturerCode: '',
      }));

    console.log(`   📊 一覧: ${purchases.length}件 / ➕ 新規: ${newItems.length}件 / ⏭️ 既存: ${purchases.length - newItems.length}件\n`);

    const mergedData = [...existingData, ...newItems];

    // 一旦保存（メタ付与前）
    await fs.writeFile(CONFIG.outputFile, JSON.stringify(mergedData, null, 2), 'utf-8');

    // メタ情報を付与（新規＋未取得、--forceで全件）
    const newSet = new Set(newItems);
    const targets = mergedData.filter(item =>
      item.productCode && (forceMode || newSet.has(item) || !item.isFetched)
    );
    console.log(`🎬 メタ情報を取得します（対象: ${targets.length}件）...`);

    let okCount = 0, failCount = 0;
    for (let i = 0; i < targets.length; i++) {
      const item = targets[i];
      const progress = `[${i + 1}/${targets.length}]`;
      try {
        const r = await enrichItem(page, item);
        if (r.ok) {
          okCount++;
          console.log(`   ${progress} ✅ ${item.productCode}  品番:${item.manufacturerCode || '-'}  女優:${(item.actresses || []).join(',') || '-'}  player:${(item.playerUrls || []).length}`);
        } else {
          failCount++;
          console.log(`   ${progress} ⚠️  ${item.productCode}  メタ取得失敗: ${r.error}`);
        }
      } catch (error) {
        failCount++;
        console.log(`   ${progress} ❌ ${item.productCode}  ${error.message}`);
      }
      await new Promise(r => setTimeout(r, CONFIG.metaDelay));
    }

    // 最終保存
    await fs.writeFile(CONFIG.outputFile, JSON.stringify(mergedData, null, 2), 'utf-8');
    console.log(`\n💾 保存完了: ${CONFIG.outputFile}`);
    console.log(`   総作品数: ${mergedData.length}件（既存 ${existingData.length} + 新規 ${newItems.length}）`);
    console.log(`   メタ取得: 成功 ${okCount} / 失敗 ${failCount}`);

    const withCode = mergedData.filter(item => item.manufacturerCode).length;
    const withPerformers = mergedData.filter(item => item.actresses && item.actresses.length > 0).length;
    const withPlayer = mergedData.filter(item => item.playerUrls && item.playerUrls.length > 0).length;
    console.log('\n📊 統計:');
    console.log(`   メーカー品番あり: ${withCode}件`);
    console.log(`   女優情報あり: ${withPerformers}件`);
    console.log(`   プレイヤーURLあり: ${withPlayer}件`);

  } catch (error) {
    console.error('❌ エラーが発生しました:', error);
    throw error;
  } finally {
    if (browser) {
      console.log('\n🔚 ブラウザを閉じています...');
      await browser.close();
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
