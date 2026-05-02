const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');

/**
 * FANZAマイリストからタグ情報を取得するスクリプト
 *
 * マイリストのリスト名をタグ定義として取り込み、
 * 各リストの商品をタグ割り当てとして反映する。
 *
 * 使用方法:
 *   npm run scrape-mylist
 */

const CONFIG = {
  targetUrl: 'https://www.dmm.co.jp/digital/-/mylibrary/search/',
  tagDefinitionsFile: path.join(__dirname, '..', 'contents', 'tag-definitions.json'),
  tagsFile: path.join(__dirname, '..', 'contents', 'tags.json'),
  cookieFile: path.join(__dirname, '../.puppeteer-profiles/dmm-cookies.json'),
  waitTimeout: 60000,
  clickDelay: 2000,
  excludeLists: ['購入済み商品一覧', '非表示商品一覧'],
  mergePatterns: [
    { pattern: /^半外半中/, mergedName: '半外半中' },
  ],
};

// ============================================================
// ユーティリティ関数
// ============================================================

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
 * HSL → Hex 変換
 */
function hslToHex(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * タグ数に応じて色を均等生成
 */
function generateColors(count) {
  const colors = [];
  for (let i = 0; i < count; i++) {
    const hue = (i * 360 / count) % 360;
    colors.push(hslToHex(hue, 65, 50));
  }
  return colors;
}

/**
 * thumbnail URLからproductCodeを抽出
 * (scrape-dmm-library.js と同一ロジック)
 */
function extractProductCodeFromThumbnail(src) {
  let productCode = '';

  // パターン1: /CODE/CODE[ps|js].jpg
  let urlMatch = src.match(/\/([^/]+)\/\1(ps|js)\.(jpg|png|gif)$/i);
  if (urlMatch) {
    productCode = urlMatch[1].toUpperCase();
  }

  // パターン2: /CODE/CODE-[サフィックス].jpg
  if (!productCode) {
    urlMatch = src.match(/\/([a-z0-9_-]+)\/\1[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)$/i);
    if (urlMatch) {
      productCode = urlMatch[1].toUpperCase();
    }
  }

  // パターン3: 最後のパスセグメントから抽出
  if (!productCode) {
    urlMatch = src.match(/\/([a-z0-9_-]+)[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)$/i);
    if (urlMatch) {
      productCode = urlMatch[1].toUpperCase();
    }
  }

  // パターン4: pics.dmm.co.jp の URL パスから抽出
  // 例: /digital/amateur/vondp033/vondp033js.jpg → vondp033
  // 例: /digital/video/abc00123/abc00123pl.jpg → abc00123
  if (!productCode) {
    urlMatch = src.match(/pics\.dmm\.co\.jp\/digital\/[^/]+\/([a-z0-9_]+)\//i);
    if (urlMatch) {
      productCode = urlMatch[1].toUpperCase();
    }
  }

  // パターン5: ファイル名から直接抽出（サフィックス除去）
  // 例: vondp033js.jpg → vondp033, abc00123ps.jpg → abc00123
  if (!productCode) {
    urlMatch = src.match(/\/([a-z0-9_]+?)(?:ps|js|pl|pt|pb|jp)\.(jpg|png|gif)$/i);
    if (urlMatch) {
      productCode = urlMatch[1].toUpperCase();
    }
  }

  return productCode || null;
}

/**
 * リスト名にマージパターンを適用
 */
function applyMergePattern(listName) {
  for (const { pattern, mergedName } of CONFIG.mergePatterns) {
    if (pattern.test(listName)) {
      return mergedName;
    }
  }
  return listName;
}

/**
 * 「もっと見る」ボタンを繰り返しクリックしてすべてのデータをロード
 * (scrape-dmm-library.js と同一ロジック)
 */
/**
 * ページ上のアイテム数を取得（複数セレクタ対応）
 */
async function countItems(page) {
  return await page.evaluate(() => {
    // マイリスト詳細ページ: ul#js-list > li
    // メインライブラリページ: .mySearchList_item
    const selectors = [
      '#js-list > li',
      '.mySearchList_item',
    ];
    for (const sel of selectors) {
      const items = document.querySelectorAll(sel);
      if (items.length > 0) return { count: items.length, selector: sel };
    }
    const imgs = document.querySelectorAll('img[src*="pics.dmm.co.jp"]');
    return { count: imgs.length, selector: 'img[src*="pics.dmm.co.jp"]' };
  });
}

async function loadAllItems(page) {
  console.log('📥 すべてのアイテムを読み込んでいます...');

  let clickCount = 0;
  let consecutiveNoChangeCount = 0;
  const maxNoChangeAttempts = 3;

  while (true) {
    try {
      const { count: currentItemCount } = await countItems(page);
      console.log(`   現在のアイテム数: ${currentItemCount}`);

      // 「もっと見る」ボタンを複数セレクタで探す
      const clickResult = await page.evaluate(() => {
        // セレクタ候補
        const buttonSelectors = [
          '.mySearchList_more a',
          '[class*="more"] a',
          'a[class*="more"]',
        ];

        for (const sel of buttonSelectors) {
          const btn = document.querySelector(sel);
          if (btn) {
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return new Promise((resolve) => {
              setTimeout(() => {
                try {
                  btn.click();
                  resolve({ found: true, clicked: true, selector: sel });
                } catch (err) {
                  resolve({ found: true, clicked: false, error: err.message });
                }
              }, 500);
            });
          }
        }

        // テキストで「もっと見る」を探す
        const allLinks = document.querySelectorAll('a');
        for (const link of allLinks) {
          if (link.textContent.trim().includes('もっと見る')) {
            link.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return new Promise((resolve) => {
              setTimeout(() => {
                try {
                  link.click();
                  resolve({ found: true, clicked: true, selector: 'text:もっと見る' });
                } catch (err) {
                  resolve({ found: true, clicked: false, error: err.message });
                }
              }, 500);
            });
          }
        }

        return { found: false, reason: 'no load-more button found' };
      });

      if (!clickResult.found) {
        console.log(`   ℹ 「もっと見る」ボタンが見つかりません: ${clickResult.reason}`);
        break;
      }

      if (!clickResult.clicked) {
        console.log(`   ⚠️  クリックに失敗しました: ${clickResult.error || 'unknown'}`);
        break;
      }

      clickCount++;
      console.log(`   ✓ 「もっと見る」ボタンをクリックしました (${clickCount}回目)`);

      await new Promise(r => setTimeout(r, CONFIG.clickDelay));

      const { count: newItemCount } = await countItems(page);

      if (newItemCount === currentItemCount) {
        consecutiveNoChangeCount++;
        console.log(`   ⚠️  アイテム数が増加していません (${consecutiveNoChangeCount}/${maxNoChangeAttempts})`);

        if (consecutiveNoChangeCount >= maxNoChangeAttempts) {
          console.log('   ℹ 読み込み完了と判断します。');
          break;
        }

        await new Promise(r => setTimeout(r, CONFIG.clickDelay * 2));
      } else {
        console.log(`   ✓ ${newItemCount - currentItemCount}件の新しいアイテムが読み込まれました`);
        consecutiveNoChangeCount = 0;
      }

    } catch (error) {
      console.log('   ⚠️  エラーが発生しました:', error.message);
      break;
    }
  }

  console.log(`✅ 読み込み完了 (合計クリック回数: ${clickCount}回)`);
}

// ============================================================
// マイリスト操作関数
// ============================================================

/**
 * マイリストパネルを開く
 */
async function openMyListPanel(page) {
  const clicked = await page.evaluate(() => {
    // テキストで「マイリスト」を含む要素を探す
    const allElements = document.querySelectorAll('a, button, div, span');
    for (const el of allElements) {
      const text = el.textContent.trim();
      if (text === 'マイリスト' || text === '■ マイリスト' || text === 'マイリスト') {
        if (el.tagName === 'A' || el.tagName === 'BUTTON' || el.onclick || el.style.cursor === 'pointer') {
          el.click();
          return true;
        }
      }
    }
    // フォールバック: テキストにマイリストを含む最初のクリック可能要素
    for (const el of allElements) {
      if (el.textContent.trim().includes('マイリスト') && !el.textContent.trim().includes('マイリストを')) {
        el.click();
        return true;
      }
    }
    return false;
  });

  if (!clicked) {
    throw new Error('「マイリスト」ボタンが見つかりませんでした');
  }

  await new Promise(r => setTimeout(r, 1500));
  console.log('✓ マイリストパネルを開きました');
}

/**
 * マイリストパネル内をスクロールして全リスト名を取得
 */
async function scrapeListNames(page) {
  // パネル内を段階的にスクロール
  for (let scrollAttempt = 0; scrollAttempt < 10; scrollAttempt++) {
    await page.evaluate(() => {
      const panelSelectors = [
        '.mylist-panel',
        '.myList',
        '.myListPanel',
        '[class*="mylist"]',
        '[class*="myList"]',
        '[class*="MyList"]',
      ];
      let panel = null;
      for (const sel of panelSelectors) {
        panel = document.querySelector(sel);
        if (panel) break;
      }
      if (!panel) {
        const allLinks = document.querySelectorAll('a');
        for (const link of allLinks) {
          if (link.textContent.trim() === '購入済み商品一覧') {
            panel = link.closest('div[class]') || link.parentElement;
            break;
          }
        }
      }
      if (panel) {
        panel.scrollTop += 200;
      }
    });
    await new Promise(r => setTimeout(r, 300));
  }

  // リスト名を取得
  const listItems = await page.evaluate(() => {
    const results = [];

    // パネルを特定
    const panelSelectors = [
      '.mylist-panel',
      '.myList',
      '.myListPanel',
      '[class*="mylist"]',
      '[class*="myList"]',
      '[class*="MyList"]',
    ];

    let panelElement = null;
    for (const selector of panelSelectors) {
      panelElement = document.querySelector(selector);
      if (panelElement) break;
    }

    if (!panelElement) {
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        if (link.textContent.trim() === '購入済み商品一覧') {
          panelElement = link.closest('div[class]') || link.parentElement;
          break;
        }
      }
    }

    if (panelElement) {
      const links = panelElement.querySelectorAll('a');
      for (const link of links) {
        const text = link.textContent.trim();
        const href = link.href || '';
        if (text && href) {
          results.push({ name: text, href });
        }
      }
    }

    // パネルが見つからない場合のフォールバック
    if (results.length === 0) {
      const allLinks = document.querySelectorAll('a');
      for (const link of allLinks) {
        const text = link.textContent.trim();
        const href = link.href || '';
        if (href.includes('mylibrary') && href.includes('list') && text) {
          results.push({ name: text, href });
        }
      }
    }

    return results;
  });

  // 重複排除
  const uniqueMap = new Map();
  for (const item of listItems) {
    if (!uniqueMap.has(item.name)) {
      uniqueMap.set(item.name, item);
    }
  }

  return Array.from(uniqueMap.values());
}

/**
 * マイリストパネルを閉じる
 */
async function closeMyListPanel(page) {
  await page.evaluate(() => {
    const closeButtons = document.querySelectorAll('[class*="close"], [class*="Close"], button');
    for (const btn of closeButtons) {
      const text = btn.textContent.trim();
      if (text === '×' || text === '✕' || text === 'X') {
        btn.click();
        return;
      }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  });
  await new Promise(r => setTimeout(r, 500));
}

/**
 * 商品一覧ページからproductCodeを全件抽出
 */
async function scrapeProductCodes(page) {
  // ページ全体をスクロールして遅延読み込みを完了
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  });

  await new Promise(r => setTimeout(r, 1000));

  // DOM構造をデバッグ出力
  const debugInfo = await page.evaluate(() => {
    const info = {};
    // 主要なクラスを持つ要素を調査
    const candidates = [
      '.mySearchList_item',
      '.d-item',
      '.d-boxpicdata',
      '.d-boxlist',
      '[class*="list"]',
      '[class*="item"]',
      'table td',
    ];
    for (const sel of candidates) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) {
        info[sel] = {
          count: els.length,
          firstClass: els[0].className,
          firstTag: els[0].tagName,
        };
      }
    }
    // pics.dmm.co.jp 画像の親要素を調査
    const dmmImgs = document.querySelectorAll('img[src*="pics.dmm.co.jp"]');
    const parentClasses = [];
    dmmImgs.forEach(img => {
      let parent = img.parentElement;
      const chain = [];
      for (let i = 0; i < 4 && parent; i++) {
        chain.push(`${parent.tagName}.${parent.className.toString().substring(0, 50)}`);
        parent = parent.parentElement;
      }
      parentClasses.push(chain.join(' > '));
    });
    info._imgParents = parentClasses.slice(0, 5); // 最初の5件のみ
    info._totalDmmImgs = dmmImgs.length;
    return info;
  });

  console.log('   🔍 DOM構造デバッグ:', JSON.stringify(debugInfo, null, 2));

  // サムネイルURLを収集（優先順位付き）
  const thumbnails = await page.evaluate(() => {
    const srcs = [];

    // 方法1: マイリスト詳細ページ - #js-list li p.tmb img
    document.querySelectorAll('#js-list > li p.tmb img').forEach(img => {
      if (img.src && img.src.includes('pics.dmm.co.jp')) srcs.push(img.src);
    });

    if (srcs.length > 0) return { srcs, method: '#js-list li p.tmb img' };

    // 方法2: メインライブラリのセレクタ
    document.querySelectorAll('.mySearchList_item .mySearchList_item_pict img').forEach(img => {
      if (img.src && img.src.includes('pics.dmm.co.jp')) srcs.push(img.src);
    });

    if (srcs.length > 0) return { srcs, method: 'mySearchList_item' };

    // 方法3: フォールバック - 全 pics.dmm.co.jp 画像
    document.querySelectorAll('img[src*="pics.dmm.co.jp"]').forEach(img => {
      if (img.src) srcs.push(img.src);
    });

    return { srcs, method: 'all-dmm-imgs' };
  });

  console.log(`   🔍 サムネイル取得方法: ${thumbnails.method}, ${thumbnails.srcs.length}件`);

  // デバッグ: サンプルURLを出力
  console.log('   🔍 サムネイルURL サンプル:');
  thumbnails.srcs.slice(0, 5).forEach((src, i) => console.log(`      [${i}] ${src}`));

  const productCodes = [];
  const seen = new Set();
  const failed = [];
  for (const src of thumbnails.srcs) {
    const code = extractProductCodeFromThumbnail(src);
    if (code && !seen.has(code)) {
      seen.add(code);
      productCodes.push(code);
    } else if (!code) {
      failed.push(src);
    }
  }

  if (failed.length > 0) {
    console.log(`   ⚠️  productCode抽出失敗: ${failed.length}件`);
    failed.slice(0, 3).forEach((src, i) => console.log(`      [${i}] ${src}`));
  }

  return productCodes;
}

// ============================================================
// メイン処理
// ============================================================

async function main() {
  console.log('🚀 マイリスト → タグ スクレイパーを起動します\n');

  let browser;

  try {
    // ブラウザ起動
    console.log('🌐 ブラウザを起動しています...');

    const chromePaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];

    let executablePath = chromePaths.find(p => {
      try {
        require('fs').accessSync(p);
        return true;
      } catch {
        return false;
      }
    });

    if (!executablePath) {
      console.log('⚠️  システムにChromeが見つかりませんでした。Puppeteer付属のChromiumを使用します。');
    } else {
      console.log(`✓ Chrome を検出: ${executablePath}`);
    }

    browser = await puppeteer.launch({
      headless: false,
      executablePath: executablePath,
      defaultViewport: { width: 1280, height: 800 },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled', // Puppeteer 検出対策
      ],
    });

    const page = await browser.newPage();

    // Puppeteer 検出対策：navigator.webdriver を上書き
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    // DMMマイライブラリページにアクセス
    console.log(`📄 ${CONFIG.targetUrl} にアクセスしています...\n`);
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2' });

    // 保存済みクッキーの復元を試みる
    const cookieRestored = await loadCookies(page);

    // クッキー復元後、ページをリロード
    if (cookieRestored) {
      console.log('🔄 ページをリロードしています...\n');
      await page.reload({ waitUntil: 'networkidle2' });
    }

    // ログイン状態をチェック
    const isLoggedIn = await page.evaluate(() => {
      return document.querySelector('[class*="mySearch"]') !== null ||
             document.querySelector('[class*="mylibrary"]') !== null;
    });

    if (!isLoggedIn) {
      // ログイン待ち
      console.log('⏳ ログインしてください...');
      console.log('   ブラウザでDMMにログインしてマイライブラリページを表示してください。');
      console.log('   完了後、このターミナルで Enterキーを押してください。\n');

      await new Promise((resolve) => {
        process.stdin.setEncoding('utf8');
        process.stdin.once('data', () => {
          process.stdin.pause();
          resolve();
        });
        setTimeout(resolve, CONFIG.waitTimeout);
      });

      // ログイン後、クッキーを保存
      await saveCookies(page);
    } else {
      console.log('✅ クッキーからのセッション復元成功！ログインをスキップします。\n');
    }

    // ============================================================
    // Phase 1: マイリスト名を取得
    // ============================================================
    console.log('\n📋 Phase 1: マイリスト名を取得しています...\n');

    await openMyListPanel(page);

    const rawListItems = await scrapeListNames(page);
    console.log(`   取得したリスト数: ${rawListItems.length}件`);
    rawListItems.forEach(item => console.log(`   - ${item.name}`));

    // フィルタリング
    const filteredItems = rawListItems.filter(item => {
      return !CONFIG.excludeLists.includes(item.name);
    });

    // マージパターン適用 + 重複排除
    const nameMapping = new Map(); // originalName → mergedName
    const uniqueTagNames = new Set();

    for (const item of filteredItems) {
      const mergedName = applyMergePattern(item.name);
      nameMapping.set(item.name, mergedName);
      uniqueTagNames.add(mergedName);
    }

    const tagNames = Array.from(uniqueTagNames);
    console.log(`\n📌 タグとして登録するリスト (${tagNames.length}件):`);
    tagNames.forEach((name, i) => console.log(`   ${i + 1}. ${name}`));

    // ============================================================
    // Phase 2: 各リストの商品を取得
    // ============================================================
    console.log('\n📦 Phase 2: 各リストの商品を取得しています...\n');

    const listProductMap = new Map();
    for (const name of tagNames) {
      listProductMap.set(name, []);
    }

    await closeMyListPanel(page);

    for (let i = 0; i < filteredItems.length; i++) {
      const listItem = filteredItems[i];
      const mergedName = nameMapping.get(listItem.name);
      console.log(`\n--- [${i + 1}/${filteredItems.length}] リスト: ${listItem.name}${mergedName !== listItem.name ? ` → ${mergedName}` : ''} ---`);

      try {
        // リストページに遷移
        await page.goto(listItem.href, { waitUntil: 'networkidle2' });
        await new Promise(r => setTimeout(r, 1000));

        // 「もっと見る」で全アイテムをロード
        await loadAllItems(page);

        // productCodeを抽出
        const productCodes = await scrapeProductCodes(page);
        console.log(`   ✅ ${productCodes.length}件のproductCodeを取得`);

        // マージ先に追加（重複排除）
        const existing = listProductMap.get(mergedName);
        for (const code of productCodes) {
          if (!existing.includes(code)) {
            existing.push(code);
          }
        }

      } catch (error) {
        console.log(`   ⚠️  エラー: ${error.message}`);
      }
    }

    // ============================================================
    // Phase 3: タグデータを書き出し
    // ============================================================
    console.log('\n\n💾 Phase 3: タグデータを書き出しています...\n');

    // tag-definitions.json
    const colors = generateColors(tagNames.length);
    const tagDefinitions = tagNames.map((name, i) => ({
      name,
      color: colors[i],
    }));

    await fs.writeFile(CONFIG.tagDefinitionsFile, JSON.stringify(tagDefinitions, null, 2) + '\n', 'utf8');
    console.log(`✅ tag-definitions.json に ${tagDefinitions.length}件のタグ定義を書き込みました`);

    // tags.json (クリアして上書き)
    const tags = {};
    for (const [tagName, productCodes] of listProductMap) {
      for (const code of productCodes) {
        if (!tags[code]) {
          tags[code] = [];
        }
        if (!tags[code].includes(tagName)) {
          tags[code].push(tagName);
        }
      }
    }

    await fs.writeFile(CONFIG.tagsFile, JSON.stringify(tags, null, 2) + '\n', 'utf8');
    const taggedCount = Object.keys(tags).length;
    console.log(`✅ tags.json に ${taggedCount}件の商品のタグ割り当てを書き込みました`);

    // 統計表示
    console.log('\n📊 統計:');
    for (const [tagName, productCodes] of listProductMap) {
      console.log(`   ${tagName}: ${productCodes.length}件`);
    }

    // generate-viewer を実行
    console.log('\n🔄 viewer データを再生成しています...');
    execSync('node scripts/utils/generate-viewer.js', {
      cwd: path.join(__dirname, '..'),
      stdio: 'inherit',
    });
    console.log('✅ viewer データの再生成が完了しました');

    console.log('\n🎉 完了!');

  } catch (error) {
    console.error('\n❌ エラーが発生しました:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
    process.stdin.pause();
  }
}

main();
