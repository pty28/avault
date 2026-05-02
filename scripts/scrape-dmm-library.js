const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

/**
 * DMMマイライブラリから作品情報を取得するスクリプト
 *
 * 使用方法:
 *   npm run scrape          - 最初のページのデータのみを取得
 *   npm run scrape -- --full - すべてのページをロードして取得
 */

const CONFIG = {
  targetUrl: 'https://www.dmm.co.jp/digital/-/mylibrary/search/',
  outputFile: path.join(__dirname, '../data/dmm-library.json'),
  cookieFile: path.join(__dirname, '../.puppeteer-profiles/dmm-cookies.json'),
  waitTimeout: 60000, // ログイン待機時間（60秒）
  clickDelay: 2000,   // 「もっと見る」ボタンクリック間隔（2秒）
};

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
 * 「もっと見る」ボタンを繰り返しクリックしてすべてのデータをロード
 */
async function loadAllItems(page) {
  console.log('📥 すべてのアイテムを読み込んでいます...');

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

      // 「もっと見る」ボタンをページ内で探してクリック
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

      // 新しいアイテムがロードされるまで待機
      await new Promise(r => setTimeout(r, CONFIG.clickDelay));

      // 新しいアイテム数を取得
      const newItemCount = await page.evaluate(() => {
        const items = document.querySelectorAll('.mySearchList_item');
        return items.length;
      });

      // アイテム数が増えているか確認
      if (newItemCount === currentItemCount) {
        consecutiveNoChangeCount++;
        console.log(`   ⚠️  アイテム数が増加していません (${consecutiveNoChangeCount}/${maxNoChangeAttempts})`);

        if (consecutiveNoChangeCount >= maxNoChangeAttempts) {
          console.log('   ℹ 読み込み完了と判断します。');
          break;
        }

        // 少し長めに待ってリトライ
        await new Promise(r => setTimeout(r, CONFIG.clickDelay * 2));
      } else {
        console.log(`   ✓ ${newItemCount - currentItemCount}件の新しいアイテムが読み込まれました`);
        consecutiveNoChangeCount = 0;
      }

    } catch (error) {
      console.log('   ⚠️  エラーが発生しました:', error.message);
      console.log('   スタックトレース:', error.stack);
      break;
    }
  }

  console.log(`✅ 読み込み完了 (合計クリック回数: ${clickCount}回)`);
}

/**
 * thumbnail URLからproductCodeを抽出
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

  return productCode || null;
}

/**
 * モーダルから再生URLを配列で抽出
 * @param {string} expectedProductCode - 期待するproductCode（検証用）
 */
async function extractPlayerUrlFromDetailPage(page, expectedProductCode) {
  const result = await page.evaluate(() => {
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

    return { success: true, playerUrls };
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
 * 同一ブラウザセッション内で表示中の商品一覧からプレイヤーURLを取得
 */
async function fetchPlayerUrlsInSession(page, libraryData, forceMode) {
  console.log('\n🎬 プレイヤーURL取得を開始...');

  // 取得済み商品のセット（forceMode時はスキップしない）
  const existingSet = new Set(
    forceMode ? [] : libraryData
      .filter(item => item.playerUrls && item.playerUrls.length > 0)
      .map(item => item.productCode)
  );

  // 一覧ページの全商品を取得
  const productImages = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('.mySearchList_item_pict img')).map(img => ({
      alt: img.alt || '',
      src: img.src || '',
    }));
  });

  console.log(`   処理対象: ${productImages.length}件\n`);

  let successCount = 0;
  let skipCount = 0;
  let failCount = 0;

  for (let i = 0; i < productImages.length; i++) {
    const product = productImages[i];
    const productCode = extractProductCodeFromThumbnail(product.src);
    const progress = `[${i + 1}/${productImages.length}]`;

    if (!productCode) {
      console.log(`   ${progress} ⚠️  productCode抽出失敗`);
      failCount++;
      continue;
    }

    // 【VR】タイトルはスキップ
    if (product.alt.includes('【VR】')) {
      console.log(`   ${progress} ⏭️  スキップ: ${productCode} (VR作品)`);
      skipCount++;
      continue;
    }

    // 取得済みはスキップ
    if (existingSet.has(productCode)) {
      console.log(`   ${progress} ⏭️  スキップ: ${productCode} (取得済み)`);
      skipCount++;
      continue;
    }

    try {
      // 商品をクリック
      const clicked = await page.evaluate((targetCode) => {
        const images = document.querySelectorAll('.mySearchList_item_pict img');
        for (const img of images) {
          const src = img.src || '';
          let code = '';
          let m = src.match(/\/([^/]+)\/\1(ps|js)\.(jpg|png|gif)$/i);
          if (m) code = m[1].toUpperCase();
          if (!code) {
            m = src.match(/\/([a-z0-9_-]+)\/\1[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)$/i);
            if (m) code = m[1].toUpperCase();
          }
          if (!code) {
            m = src.match(/\/([a-z0-9_-]+)[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)$/i);
            if (m) code = m[1].toUpperCase();
          }
          if (code === targetCode) {
            img.click();
            return true;
          }
        }
        return false;
      }, productCode);

      if (!clicked) {
        console.log(`   ${progress} ⚠️  クリック失敗: ${productCode}`);
        failCount++;
        continue;
      }

      // 正しい商品のモーダルが表示されるまで待機（pid検証付き）
      const modalOpened = await waitForModalWithPid(page, productCode);
      if (!modalOpened) {
        console.log(`   ${progress} ⚠️  モーダル未表示: ${productCode}`);
        await page.keyboard.press('Escape');
        await new Promise(resolve => setTimeout(resolve, 500));
        failCount++;
        continue;
      }

      // URLを抽出（pid検証付き）
      const urlResult = await extractPlayerUrlFromDetailPage(page, productCode);

      if (urlResult.success) {
        const playerUrls = urlResult.playerUrls.map(url => 'https://www.dmm.co.jp' + url);

        // libraryData を更新
        const item = libraryData.find(d => d.productCode === productCode);
        if (item) {
          item.playerUrls = playerUrls;
        }

        console.log(`   ${progress} ✅ ${productCode} (${playerUrls.length}個)`);
        playerUrls.forEach((url, idx) => {
          console.log(`         [${idx + 1}] ${url}`);
        });
        successCount++;
      } else {
        console.log(`   ${progress} ⚠️  URL抽出失敗: ${productCode} - ${urlResult.error}`);
        failCount++;
      }

      // モーダルを閉じる（次のwaitForModalWithPidが正しいモーダルを待つので短い待機でOK）
      await page.keyboard.press('Escape');
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error) {
      console.log(`   ${progress} ❌ エラー: ${productCode} - ${error.message}`);
      failCount++;
    }
  }

  console.log(`\n   ✅ プレイヤーURL取得完了: 成功${successCount}件 / スキップ${skipCount}件 / 失敗${failCount}件`);
}

/**
 * ページから作品情報を抽出
 */
async function extractLibraryData(page) {
  console.log('🔍 作品情報を抽出しています...');

  const items = await page.evaluate(() => {
    const results = [];
    const itemElements = document.querySelectorAll('.mySearchList_item');

    console.log(`Found ${itemElements.length} items`);

    itemElements.forEach((item, index) => {
      try {
        // 画像要素を取得
        const imgElement = item.querySelector('.mySearchList_item_pict img');
        if (!imgElement) return;

        // サムネイル画像URLの抽出
        const thumbnail = imgElement.src || '';

        // 画像URLから作品コード（品番）を抽出
        let productCode = '';

        // パターン1: /CODE/CODE[ps|js].jpg
        // - ps: 一般作品 (例: vero00129/vero00129ps.jpg)
        // - js: 素人系作品 (例: merc287/merc287js.jpg)
        let urlMatch = thumbnail.match(/\/([^/]+)\/\1(ps|js)\.(jpg|png|gif)$/i);
        if (urlMatch) {
          productCode = urlMatch[1].toUpperCase();
        }

        // パターン2: /CODE/CODE-[サフィックス].jpg (例: CODE/CODE-640.jpg)
        if (!productCode) {
          urlMatch = thumbnail.match(/\/([a-z0-9_-]+)\/\1[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)$/i);
          if (urlMatch) {
            productCode = urlMatch[1].toUpperCase();
          }
        }

        // パターン3: 最後のパスセグメントから抽出 (例: /path/to/CODE-640.jpg)
        if (!productCode) {
          urlMatch = thumbnail.match(/\/([a-z0-9_-]+)[-_](ps|js|pl|pt|pb|jp|640|360)\.(jpg|png|gif)$/i);
          if (urlMatch) {
            productCode = urlMatch[1].toUpperCase();
          }
        }

        // タイトルの抽出（画像のalt属性から取得）
        let title = imgElement.alt || '';

        // タイトル要素からも取得を試みる
        if (!title) {
          const titleElement = item.querySelector('.mySearchList_item_title');
          if (titleElement) {
            // HD マークなどを除いたテキストを取得
            const deliveryMark = titleElement.querySelector('.mySearchList_item_delivery');
            if (deliveryMark) {
              deliveryMark.remove();
            }
            title = titleElement.textContent.trim();
          }
        }

        // 出演者名の抽出（マイライブラリページには表示されていないため空配列）
        const actresses = [];

        // デバッグ情報: wrapper div の ID を取得
        let debugId = '';
        const wrapperDiv = item.querySelector('div[id]');
        if (wrapperDiv && wrapperDiv.id) {
          debugId = wrapperDiv.id;
        }

        // 最低限の情報がある場合のみ追加
        if (productCode || title || thumbnail) {
          const itemData = {
            productCode,
            title,
            actresses,
            thumbnail,
            itemURL: '',
            isFetched: false,
            isShirouto: false,
            registeredAt: new Date().toISOString(),
          };

          // 作品コードが取得できなかった場合、デバッグ情報を追加
          if (!productCode && thumbnail) {
            itemData._debug = {
              thumbnailUrl: thumbnail,
              wrapperId: debugId,
              note: 'Product code could not be extracted from thumbnail URL',
            };
          }

          results.push(itemData);
        }
      } catch (error) {
        console.error(`Item ${index} extraction error:`, error);
      }
    });

    return results;
  });

  console.log(`✅ ${items.length}件の作品情報を抽出しました`);
  return items;
}

/**
 * メイン処理
 */
async function main() {
  console.log('🚀 DMM Library Scraper を起動します\n');

  // --full / --force フラグをチェック
  const fullMode = process.argv.includes('--full');
  const forceMode = process.argv.includes('--force');
  if (fullMode) {
    console.log('📋 モード: FULL - すべてのページをロードして取得します');
  } else {
    console.log('📋 モード: FIRST PAGE - 最初のページのデータのみを取得します');
    console.log('   (すべてのページを取得するには: npm run scrape-dmm -- --full)\n');
  }

  let browser;

  try {
    // Puppeteerブラウザを起動
    console.log('🌐 ブラウザを起動しています...');

    // システムのChromeを使用するパスを設定
    const chromePaths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];

    let executablePath = chromePaths.find(path => {
      try {
        require('fs').accessSync(path);
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
      headless: false, // ログインできるように表示モード
      executablePath: executablePath, // システムのChromeを使用
      userDataDir: path.join(__dirname, '../.puppeteer-profiles/dmm'), // セッション保持用プロファイル
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

    // ログイン状態をチェック（マイライブラリページが表示されているか）
    const isLoggedIn = await page.evaluate(() => {
      return document.querySelector('.mySearchList_item') !== null ||
             document.querySelector('[class*="mylibrary"]') !== null;
    });

    if (!isLoggedIn) {
      // ログインが必要な場合、ユーザーに手動でログインしてもらう
      console.log('⏳ ログインしてください...');
      console.log('   ブラウザでDMMにログインしてマイライブラリページを表示してください。');
      console.log('   完了後、このターミナルで Enterキーを押してください。\n');

      // ユーザーの入力待ち（Enterキー）
      await new Promise(resolve => {
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

    // --full モードの場合のみすべてのアイテムをロード
    if (fullMode) {
      await loadAllItems(page);
    } else {
      console.log('📥 最初のページのデータを取得します（フルモードではありません）\n');
    }

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
        }, 100);
      });
    });

    // 作品情報を抽出
    const scrapedData = await extractLibraryData(page);

    // 既存データを読み込み
    console.log(`\n📂 既存データを確認しています...`);
    let existingData = [];
    try {
      const existingJson = await fs.readFile(CONFIG.outputFile, 'utf-8');
      existingData = JSON.parse(existingJson);
      console.log(`   ✓ ${existingData.length}件の既存データを読み込みました`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(`   ℹ️  既存ファイルが見つかりません。新規作成します。`);
      } else {
        console.log(`   ⚠️  既存ファイルの読み込みに失敗: ${error.message}`);
      }
    }

    // 既存のproductCodeをSetに格納（大文字小文字を区別しない比較のため小文字化）
    const existingCodes = new Set(
      existingData
        .map(item => item.productCode)
        .filter(code => code) // 空のコードを除外
        .map(code => code.toLowerCase())
    );

    // 新規データのみをフィルタ
    const newItems = scrapedData.filter(item => {
      if (!item.productCode) {
        // productCodeがない場合は常に追加（重複チェック不可能）
        return true;
      }
      return !existingCodes.has(item.productCode.toLowerCase());
    });

    console.log(`   📊 スクレイピング結果: ${scrapedData.length}件`);
    console.log(`   ➕ 新規作品: ${newItems.length}件`);
    console.log(`   ⏭️  既存作品（スキップ）: ${scrapedData.length - newItems.length}件`);

    // 既存データと新規データを統合
    const mergedData = [...existingData, ...newItems];

    // JSONファイルに保存
    console.log(`\n💾 ${CONFIG.outputFile} に保存しています...`);
    await fs.writeFile(
      CONFIG.outputFile,
      JSON.stringify(mergedData, null, 2),
      'utf-8'
    );

    console.log(`✅ 完了！`);
    console.log(`   総作品数: ${mergedData.length}件（既存 ${existingData.length}件 + 新規 ${newItems.length}件）`);
    console.log(`   ファイル: ${CONFIG.outputFile}\n`);

    // プレイヤーURL取得処理（同一ブラウザセッションで実行）
    await fetchPlayerUrlsInSession(page, mergedData, forceMode);

    // playerUrls を含めて再保存
    await fs.writeFile(
      CONFIG.outputFile,
      JSON.stringify(mergedData, null, 2),
      'utf-8'
    );
    console.log(`💾 playerUrls を含めて再保存しました\n`);

    // 統計情報を表示
    const withCode = mergedData.filter(item => item.productCode).length;
    const withPerformers = mergedData.filter(item => item.actresses.length > 0).length;

    console.log('📊 統計:');
    console.log(`   作品コードあり: ${withCode}件`);
    console.log(`   出演者情報あり: ${withPerformers}件`);

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

// スクリプト実行
main().catch(console.error);
