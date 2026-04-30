#!/usr/bin/env node

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

/**
 * DMMマイライブラリから全購入済み商品のプレイヤーURLを自動取得し、dmm-library.jsonに保存
 *
 * フロー：
 * 1. 購入済み商品一覧ページで「もっと見る」をクリックして全商品ロード
 * 2. ロードされた各商品をクリック → 購入済み商品詳細ページに遷移
 * 3. onclick属性から再生URLを抽出
 * 4. 一覧ページに戻る
 * 5. 次の商品を処理
 */

const CONFIG = {
  targetUrl: 'https://www.dmm.co.jp/digital/-/mylibrary/',
  cookieFile: path.join(__dirname, '../.puppeteer-profiles/dmm-cookies.json'),
  clickDelay: 1000,
  waitTimeout: 3000,
};

const fullMode = process.argv.includes('--full');
const forceMode = process.argv.includes('--force');

// 保存済みのクッキーを復元
async function loadCookies(page) {
  try {
    if (!fs.existsSync(CONFIG.cookieFile)) {
      console.log('💾 保存済みクッキーがありません（初回実行）\n');
      return false;
    }

    const cookies = JSON.parse(fs.readFileSync(CONFIG.cookieFile, 'utf-8'));
    await page.setCookie(...cookies);
    console.log(`✅ クッキーを復元しました (${cookies.length}件)\n`);
    return true;
  } catch (error) {
    console.log(`⚠️  クッキー復元に失敗しました: ${error.message}\n`);
    return false;
  }
}

// クッキーを保存
async function saveCookies(page) {
  try {
    const cookies = await page.cookies();
    fs.writeFileSync(CONFIG.cookieFile, JSON.stringify(cookies, null, 2), 'utf-8');
    console.log(`✅ クッキーを保存しました (${cookies.length}件)\n`);
  } catch (error) {
    console.log(`⚠️  クッキー保存に失敗しました: ${error.message}\n`);
  }
}

// dmm-library.jsonを読み込んでplayerUrlsがある商品のセットを返す
function loadExistingPlayerUrls() {
  const libraryPath = path.join(__dirname, '../data/dmm-library.json');
  try {
    const data = JSON.parse(fs.readFileSync(libraryPath, 'utf-8'));
    const existingSet = new Set(
      data
        .filter(item => item.playerUrls && item.playerUrls.length > 0)
        .map(item => item.productCode)
    );
    return existingSet;
  } catch {
    return new Set();
  }
}

// システムのChromeパスを検出
function getChromeExecutablePath() {
  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];

  return chromePaths.find(p => {
    try {
      fs.accessSync(p);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * 購入済み商品一覧ページで「もっと見る」ボタンをクリックして全商品をロード
 * fullMode=false の場合は最初のページのみ
 */
async function loadAllItems(page) {
  if (!fullMode) {
    const itemCount = await page.evaluate(() => {
      return document.querySelectorAll('.mySearchList_item').length;
    });
    console.log(`📥 最初のページのみ処理します (${itemCount}件)\n`);
    return itemCount;
  }

  console.log('📥 購入済み商品一覧ページで全商品をロード中...');

  let clickCount = 0;
  let consecutiveNoChangeCount = 0;
  const maxNoChangeAttempts = 3;

  while (true) {
    try {
      // 現在のアイテム数を取得
      const currentItemCount = await page.evaluate(() => {
        const items = document.querySelectorAll('.mySearchList_item');
        return items.length;
      });

      console.log(`   現在のアイテム数: ${currentItemCount}`);

      // 「もっと見る」ボタンをページ内で探してクリック（scrape-dmm-library.js と同じロジック）
      const clickResult = await page.evaluate(() => {
        const moreButtonDiv = document.querySelector('.mySearchList_more');
        if (!moreButtonDiv) {
          return { found: false, reason: 'mySearchList_more div not found' };
        }

        const moreButtonLink = moreButtonDiv.querySelector('a');
        if (!moreButtonLink) {
          return { found: false, reason: 'anchor link not found' };
        }

        // ボタンが表示されているか確認
        const rect = moreButtonLink.getBoundingClientRect();
        const isVisible = rect.top >= 0 && rect.left >= 0 &&
                         rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                         rect.right <= (window.innerWidth || document.documentElement.clientWidth);

        // スクロールしてボタンを表示領域に入れる
        moreButtonLink.scrollIntoView({ behavior: 'smooth', block: 'center' });

        // 少し待ってからクリック
        return new Promise((resolve) => {
          setTimeout(() => {
            try {
              moreButtonLink.click();
              resolve({ found: true, clicked: true });
            } catch (err) {
              resolve({ found: true, clicked: false, error: err.message });
            }
          }, 500);
        });
      });

      if (!clickResult.found) {
        console.log(`   ℹ 「もっと見る」ボタンが見つかりません: ${clickResult.reason}`);
        console.log('   全データの読み込みが完了しました。');
        break;
      }

      if (!clickResult.clicked) {
        console.log(`   ⚠️  クリックに失敗しました: ${clickResult.error || 'unknown'}`);
        break;
      }

      clickCount++;
      console.log(`   ✓ 「もっと見る」ボタンをクリックしました (${clickCount}回目)`);

      // 長めに待機（ネットワーク遅延を考慮）
      console.log(`   ⏳ データ読み込み待機中...`);

      // 最初の5秒は確実に待つ
      await page.waitForTimeout(5000);

      // その後、アイテム数が変わるまで最大10秒待機
      let newItemCount = currentItemCount;
      for (let i = 0; i < 20; i++) {
        newItemCount = await page.evaluate(() => {
          const items = document.querySelectorAll('.mySearchList_item');
          return items.length;
        });

        if (newItemCount > currentItemCount) {
          break;
        }
        await page.waitForTimeout(500);
      }

      // アイテム数が増えているか確認
      if (newItemCount === currentItemCount) {
        consecutiveNoChangeCount++;
        console.log(`   ⚠️  アイテム数が増加していません (${consecutiveNoChangeCount}/${maxNoChangeAttempts}) - ${currentItemCount}件`);

        if (consecutiveNoChangeCount >= maxNoChangeAttempts) {
          console.log('   ℹ 読み込み完了と判定します。');
          break;
        }

        // さらに長く待機してリトライ
        console.log(`   ⏳ 再度待機中...`);
        await page.waitForTimeout(8000);
      } else {
        console.log(`   ✓ ${newItemCount - currentItemCount}件の新しいアイテムが読み込まれました (${currentItemCount} → ${newItemCount})`);
        consecutiveNoChangeCount = 0;
      }

    } catch (error) {
      console.log('   ⚠️  エラーが発生しました:', error.message);
      break;
    }
  }

  const finalItemCount = await page.evaluate(() => {
    const items = document.querySelectorAll('.mySearchList_item');
    return items.length;
  });

  console.log(`✅ 読み込み完了 (合計クリック回数: ${clickCount}回)\n`);
  return finalItemCount;
}

/**
 * 購入済み商品詳細ページから再生URLを抽出（複数対応）
 * @param {Page} pageObject - 詳細ページのページオブジェクト
 * @param {string} expectedProductCode - 期待するproductCode（検証用）
 */
async function extractPlayerUrlFromDetailPage(pageObject, expectedProductCode) {
  const result = await pageObject.evaluate(() => {
    // 複数のプレイボタンに対応：すべてのa[onclick*="window.open"]を取得
    const links = document.querySelectorAll('a[onclick*="window.open"]');

    if (links.length === 0) {
      return { success: false, error: '再生リンクが見つかりません' };
    }

    const playerUrls = [];

    for (const link of links) {
      const onclickText = link.getAttribute('onclick');
      const urlMatch = onclickText.match(/window\.open\('([^']+)'/);

      if (urlMatch && urlMatch[1]) {
        playerUrls.push(urlMatch[1]);
      }
    }

    if (playerUrls.length === 0) {
      return { success: false, error: 'URLの抽出に失敗' };
    }

    return {
      success: true,
      playerUrls: playerUrls  // 配列で返す
    };
  });

  // 抽出したURLのpidが期待するproductCodeと一致するか検証
  if (result.success && expectedProductCode) {
    const expectedPid = expectedProductCode.toLowerCase();
    const firstUrl = result.playerUrls[0];
    const pidMatch = firstUrl.match(/\/pid=([^/]+)\//);
    if (pidMatch && pidMatch[1] !== expectedPid) {
      return { success: false, error: `pid不一致: 期待=${expectedPid}, 実際=${pidMatch[1]}（前の商品のモーダルが残っている可能性）` };
    }
  }

  return result;
}

/**
 * 指定したproductCodeのモーダルが表示されるまで待機
 * pidを検証しながら待つことで、前のモーダルが残っていても正しく検知できる
 */
async function waitForModalWithPid(page, expectedProductCode, timeoutMs = 8000) {
  const expectedPid = expectedProductCode.toLowerCase();
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const result = await page.evaluate(() => {
      const links = document.querySelectorAll('a[onclick*="window.open"]');
      if (links.length === 0) return { hasLinks: false, pid: null };
      const onclickText = links[0].getAttribute('onclick');
      const m = onclickText && onclickText.match(/\/pid=([^/]+)\//);
      return { hasLinks: true, pid: m ? m[1] : null };
    });

    if (result.hasLinks && result.pid === expectedPid) {
      return true; // 正しい商品のモーダルが開いた
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  return false;
}

/**
 * thumbnail URLからproductCodeを抽出
 * scrape-dmm-library.js の extractLibraryData() と同じロジック
 */
function extractProductCodeFromThumbnail(src) {
  let productCode = '';

  // パターン1: /CODE/CODE[ps|js].jpg
  // 例: /vero00129/vero00129ps.jpg → vero00129
  let urlMatch = src.match(/\/([^/]+)\/\1(ps|js)\.(jpg|png|gif)$/i);
  if (urlMatch) {
    productCode = urlMatch[1].toUpperCase();
  }

  // パターン2: /CODE/CODE-[サフィックス].jpg
  // 例: /vero00129/vero00129-640.jpg → vero00129
  if (!productCode) {
    urlMatch = src.match(/\/([a-z0-9_-]+)\/\1[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)$/i);
    if (urlMatch) {
      productCode = urlMatch[1].toUpperCase();
    }
  }

  // パターン3: 最後のパスセグメントから抽出
  // 例: /path/to/CODE-640.jpg → CODE
  if (!productCode) {
    urlMatch = src.match(/\/([a-z0-9_-]+)[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)$/i);
    if (urlMatch) {
      productCode = urlMatch[1].toUpperCase();
    }
  }

  return productCode || null;
}

/**
 * 購入済み商品一覧ページから全商品の再生URLを取得
 */
async function extractAllPlayerUrls(page, browser) {
  console.log('🔍 各商品の再生URLを抽出中...\n');

  // 既にplayerUrlsがある商品のセットを読み込む
  const existingPlayerUrls = forceMode ? new Set() : loadExistingPlayerUrls();
  if (!forceMode) {
    console.log(`ℹ️  スキップ対象 (playerUrls取得済み): ${existingPlayerUrls.size}件`);
  }

  // 一覧ページの全商品を取得
  let productImages = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.mySearchList_item_pict img')).map(img => ({
      alt: img.alt || '',
      src: img.src || ''
    }));
  });

  console.log(`処理対象: ${productImages.length} 件\n`);

  const results = [];
  const failedProducts = [];

  for (let i = 0; i < productImages.length; i++) {
    const product = productImages[i];
    const progressPercentage = Math.round(((i + 1) / productImages.length) * 100);

    // productCodeを抽出
    const productCode = extractProductCodeFromThumbnail(product.src);

    console.log(`[${i + 1}/${productImages.length}] (${progressPercentage}%) ${product.alt.substring(0, 40)}`);

    if (!productCode) {
      console.log(`   ⚠️  productCode抽出失敗 (URL: ${product.src})`);
      failedProducts.push(product.alt);
      continue;
    }

    // 【VR】タイトルはスキップ
    if (product.alt.includes('【VR】')) {
      console.log(`   ⏭️  スキップ: ${productCode} (VR作品)`);
      continue;
    }

    // playerUrls取得済みの場合はスキップ
    if (existingPlayerUrls.has(productCode)) {
      console.log(`   ⏭️  スキップ: ${productCode} (取得済み)`);
      continue;
    }

    try {
      // 商品をクリック
      const clicked = await page.evaluate((targetProductCode) => {
        const images = document.querySelectorAll('.mySearchList_item_pict img');
        for (const img of images) {
          const src = img.src || '';

          // productCodeを抽出
          let productCode = '';
          let urlMatch = src.match(/\/([^/]+)\/\1(ps|js)\.(jpg|png|gif)$/i);
          if (urlMatch) {
            productCode = urlMatch[1].toUpperCase();
          }

          if (!productCode) {
            urlMatch = src.match(/\/([a-z0-9_-]+)\/\1[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)$/i);
            if (urlMatch) {
              productCode = urlMatch[1].toUpperCase();
            }
          }

          if (!productCode) {
            urlMatch = src.match(/\/([a-z0-9_-]+)[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)$/i);
            if (urlMatch) {
              productCode = urlMatch[1].toUpperCase();
            }
          }

          if (productCode && productCode === targetProductCode) {
            img.click();
            return true;
          }
        }
        return false;
      }, productCode);

      if (!clicked) {
        console.log(`   ⚠️  クリック失敗`);
        failedProducts.push(product.alt);
        continue;
      }

      // 正しい商品のモーダルが表示されるまで待機（pid検証付き）
      const modalOpened = await waitForModalWithPid(page, productCode);
      if (!modalOpened) {
        console.log(`   ⚠️  モーダル未表示: ${productCode}`);
        await page.keyboard.press('Escape');
        await new Promise(resolve => setTimeout(resolve, 500));
        failedProducts.push(product.alt);
        continue;
      }

      // 同じページを再評価してプレイボタンを探す（pid検証付き）
      const urlResult = await extractPlayerUrlFromDetailPage(page, productCode);

      if (urlResult.success) {
        // 複数のURLを取得できたので、全て保存
        const playerUrls = urlResult.playerUrls.map(url => 'https://www.dmm.co.jp' + url);

        results.push({
          productCode: productCode,
          playerUrls: playerUrls,
          title: product.alt
        });
        console.log(`   ✅ URL取得成功: ${productCode} (${playerUrls.length}個)`);
        playerUrls.forEach((url, idx) => {
          console.log(`      [${idx + 1}] ${url}`);
        });
      } else {
        console.log(`   ⚠️  URL抽出失敗: ${urlResult.error}`);
        failedProducts.push(product.alt);
      }

      // モーダルを閉じる（次のwaitForModalWithPidが正しいモーダルを待つので短い待機でOK）
      await page.keyboard.press('Escape');
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error) {
      console.log(`   ❌ エラー: ${error.message}`);
      failedProducts.push(product.alt);
    }
  }

  // URL抽出統計
  const totalUrls = results.reduce((sum, r) => sum + r.playerUrls.length, 0);
  const multiUrlCount = results.filter(r => r.playerUrls.length > 1).length;

  console.log(`\n✅ URL抽出完了: ${results.length}/${productImages.length} 件成功`);
  console.log(`   取得URL合計: ${totalUrls}個`);
  console.log(`   複数URL: ${multiUrlCount}件`);

  if (failedProducts.length > 0) {
    console.log(`\n⚠️  失敗した商品: ${failedProducts.length} 件`);
    failedProducts.slice(0, 5).forEach(product => {
      console.log(`   - ${product.substring(0, 50)}`);
    });
    if (failedProducts.length > 5) {
      console.log(`   ... 他 ${failedProducts.length - 5} 件`);
    }
  }

  return results;
}

/**
 * dmm-library.jsonを更新
 */
function updateLibraryJson(results) {
  console.log('\n💾 dmm-library.jsonを更新中...\n');

  const libraryPath = path.join(__dirname, '../data/dmm-library.json');
  const data = JSON.parse(fs.readFileSync(libraryPath, 'utf-8'));

  let updateCount = 0;
  let notFoundCount = 0;

  results.forEach(result => {
    const item = data.find(d => d.productCode === result.productCode);

    if (item) {
      item.playerUrls = result.playerUrls;
      updateCount++;
      if (updateCount <= 5) {
        console.log(`   ✅ ${result.productCode} (${result.playerUrls.length}個)`);
        result.playerUrls.forEach((url, idx) => {
          console.log(`      [${idx + 1}] ${url}`);
        });
      }
    } else {
      notFoundCount++;
    }
  });

  if (updateCount > 5) {
    console.log(`   ... 他 ${updateCount - 5} 件`);
  }

  fs.writeFileSync(libraryPath, JSON.stringify(data, null, 2), 'utf-8');

  // 複数URLの統計
  const totalUrls = results.reduce((sum, r) => sum + r.playerUrls.length, 0);
  const multiUrlCount = results.filter(r => r.playerUrls.length > 1).length;

  console.log(`\n✅ dmm-library.jsonを更新しました`);
  console.log(`   更新件数: ${updateCount}/${results.length}`);
  console.log(`   取得URL合計: ${totalUrls}個`);
  console.log(`   複数URL: ${multiUrlCount}件`);

  if (notFoundCount > 0) {
    console.log(`   ⚠️  見つからなかった件数: ${notFoundCount}`);
  }
}

/**
 * メイン処理
 */
async function fetchPlayerUrls() {
  let browser;
  const overallStartTime = Date.now();

  try {
    const executablePath = getChromeExecutablePath();
    if (executablePath) {
      console.log(`✓ Chrome を検出: ${executablePath}`);
    }

    console.log('\n🌐 購入済み商品一覧ページにアクセス中...');

    browser = await puppeteer.launch({
      headless: false,
      executablePath: executablePath,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled', // Puppeteer 検出対策
      ],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(120000);
    page.setDefaultTimeout(120000);

    // Puppeteer 検出対策：navigator.webdriver を上書き
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });
    });

    await page.goto(CONFIG.targetUrl, {
      waitUntil: 'domcontentloaded',
    }).catch(() => {});

    // 保存済みクッキーの復元を試みる
    const cookieRestored = await loadCookies(page);

    // クッキー復元後、ページをリロード
    if (cookieRestored) {
      console.log('🔄 ページをリロードしています...\n');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }

    // ログイン状態をチェック
    const isLoggedIn = await page.evaluate(() => {
      return document.querySelector('[class*="mylibrary"]') !== null ||
             document.querySelector('.mySearchList') !== null;
    });

    if (!isLoggedIn) {
      console.log('\n📌 年齢認証とログインを完了したら、Enterキーを押してください\n');
      console.log('⏳ ユーザー操作待機中...');

      // ユーザー操作待機
      await new Promise(resolve => {
        process.stdin.resume();
        process.stdin.once('data', () => {
          process.stdin.pause();
          resolve();
        });
      });

      // ログイン後、クッキーを保存
      await saveCookies(page);
    } else {
      console.log('✅ クッキーからのセッション復元成功！ログインをスキップします。\n');
    }

    console.log('\n');
    console.log('='.repeat(70));
    console.log('📊 プレイヤーURL自動取得処理を開始');
    console.log('='.repeat(70));
    console.log(`⏱️  開始時刻: ${new Date().toLocaleString('ja-JP')}`);
    console.log(`📋 モード: ${fullMode ? 'FULL (全ページ)' : 'FIRST PAGE (最初のページのみ)'}${forceMode ? ' + FORCE' : ''}\n`);

    // 全商品をロード
    await loadAllItems(page);

    // 全商品の再生URLを取得
    const results = await extractAllPlayerUrls(page, browser);

    if (results.length === 0) {
      console.log('\n⚠️  プレイヤーURLが取得できませんでした');
      return;
    }

    // dmm-library.json を更新
    updateLibraryJson(results);

    const elapsed = Math.floor((Date.now() - overallStartTime) / 1000);
    const minutes = Math.floor(elapsed / 60);

    console.log('\n' + '='.repeat(70));
    console.log('✅ 処理完了');
    console.log('='.repeat(70));
    console.log(`⏱️  終了時刻: ${new Date().toLocaleString('ja-JP')}`);
    console.log(`⏱️  所要時間: ${minutes}分${elapsed % 60}秒\n`);

  } catch (error) {
    console.error('❌ エラー:', error.message);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// エラーハンドリング
process.on('SIGINT', () => {
  console.log('\n\n⚠️  実行が中断されました');
  process.exit(1);
});

// 実行開始
fetchPlayerUrls().catch((error) => {
  console.error('❌ 予期しないエラーが発生しました:', error);
  process.exit(1);
});
