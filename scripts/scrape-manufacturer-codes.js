const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');

/**
 * dmm-library.json のアイテムに対して、FANZAページからメーカー品番を取得してスクレイピング
 * 既にmanufacturerCodeが存在するレコードはスキップ
 */

const CONFIG = {
  inputFile: path.join(__dirname, '../data/dmm-library.json'),
  rateLimit: 1000,    // API呼び出し間隔（ミリ秒）
  timeout: 20000,     // ページ読み込みタイムアウト
  waitAfterLoad: 3000, // ページ読み込み後の追加待機（ミリ秒）
};

/**
 * FANZAページからメーカー品番を抽出
 */
async function scrapeManufacturerCodeFromPage(page, contentId, itemURL) {
  try {
    // itemURLからパスを判定（/av/content/ か /amateur/content/ か）
    let url;
    if (itemURL && itemURL.includes('/amateur/content/')) {
      url = `https://video.dmm.co.jp/amateur/content/?id=${contentId}`;
    } else {
      url = `https://video.dmm.co.jp/av/content/?id=${contentId}`;
    }

    // クッキーをクリアして完全なリセット状態を確保
    await page.deleteCookie();

    // ページアクセス（より厳密な待機）
    await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });

    // 年齢確認「はい」ボタンをクリック
    const ageCheckClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('a, button'));
      const yesBtn = buttons.find(btn => btn.textContent.includes('はい'));

      if (yesBtn) {
        yesBtn.click();
        return true;
      }
      return false;
    });

    if (ageCheckClicked) {
      // ナビゲーション完了を待つ
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: CONFIG.timeout });
      } catch (e) {
        // ナビゲーションが発生しない場合もあるため、タイムアウトは無視
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    // ページ読み込み完了を確保（リダイレクト後のコンテンツ読み込み待機）
    await new Promise(r => setTimeout(r, CONFIG.waitAfterLoad));

    // 最終的なURLを確認（リダイレクト検出）
    const finalUrl = page.url();
    const hasRedirected = !finalUrl.includes(`id=${contentId}`);

    if (hasRedirected) {
      // リダイレクト先のページから品番を抽出するか、
      // 元のURLに戻ってアクセスしなおす
      const originalUrl = itemURL.includes('/amateur/content/')
        ? `https://video.dmm.co.jp/amateur/content/?id=${contentId}`
        : `https://video.dmm.co.jp/av/content/?id=${contentId}`;
      try {
        // ページをリロード（新しいページを開く）
        await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });

        // リダイレクト前のコンテンツで短めに待機
        await new Promise(r => setTimeout(r, 800));
      } catch (e) {
        // リダイレクト後のコンテンツで取得を試みる
      }
    }

    // メーカー品番を抽出
    const manufacturerCode = await page.evaluate(() => {
      // パターン1: 「メーカー品番：」テーブルセルから直接抽出
      const textContent = document.body.innerText;
      // 「メーカー品番：」の後から次の改行またはラベルまでを抽出
      const makerMatch = textContent.match(/メーカー品番[：:]\s*([^\n]*?)(?=\n|平均評価|視聴期限|レビュー|配信形式|$)/);
      if (makerMatch && makerMatch[1]) {
        const code = makerMatch[1].trim();
        // 空または「なし」「—」などの場合はスキップ
        if (code && code !== 'なし' && code !== '—' && code !== '-' && code !== '取扱い中止') {
          return { code: code, pattern: 'maker-label' };
        }
      }

      // パターン2: body内のテキストから商品情報を探す（大文字パターン）
      const codeMatches = textContent.match(/[A-Z]{2,}[-_]?\d{2,}/g);
      if (codeMatches && codeMatches.length > 0) {
        return { code: codeMatches[0], pattern: 'body-upper' };
      }

      // パターン3: 小文字を含むパターン（ハイフン区切り）
      const lowerCaseMatches = textContent.match(/[a-z]{2,}[-][0-9]{3,}/gi);
      if (lowerCaseMatches && lowerCaseMatches.length > 0) {
        return { code: lowerCaseMatches[0], pattern: 'body-lower' };
      }

      // パターン4: h1タグから抽出
      const h1 = document.querySelector('h1');
      if (h1) {
        const text = h1.textContent.trim();
        const match = text.match(/([A-Z]+[-_]?[0-9]+)/);
        if (match) {
          return { code: match[1], pattern: 'h1' };
        }
      }

      // パターン5: メタタグから抽出
      const metaTags = Array.from(document.querySelectorAll('meta'));
      const ogTitle = metaTags.find(m =>
        m.getAttribute('property') === 'og:title' ||
        m.getAttribute('name') === 'description'
      );
      if (ogTitle) {
        const content = ogTitle.getAttribute('content');
        const match = content.match(/([A-Z]+[-_]?[0-9]+)/);
        if (match) {
          return { code: match[1], pattern: 'meta' };
        }
      }

      // パターン6: JSON-LD（構造化データ）から抽出
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      for (const script of scripts) {
        try {
          const json = JSON.parse(script.textContent);
          // productIdまたはsku属性をチェック
          if (json.productID || json.sku) {
            const code = json.productID || json.sku;
            const match = code.match(/([A-Z]+[-_]?[0-9]+)/);
            if (match) {
              return { code: match[1], pattern: 'json-ld' };
            }
          }
          // 再帰的に全プロパティをチェック
          const checkObject = (obj) => {
            for (const [key, value] of Object.entries(obj || {})) {
              if (typeof value === 'string') {
                const match = value.match(/^([A-Z]{2,}[-_]?\d{2,})$/);
                if (match) {
                  return { code: match[1], pattern: 'json-ld-value' };
                }
              } else if (typeof value === 'object') {
                const result = checkObject(value);
                if (result) return result;
              }
            }
            return null;
          };
          const result = checkObject(json);
          if (result) return result;
        } catch (e) {
          // JSON解析失敗は無視
        }
      }

      // パターン5: data属性から抽出（カスタムデータ属性）
      const dataElements = Array.from(document.querySelectorAll('[data-product-code], [data-product-id], [data-sku], [data-item-id]'));
      for (const elem of dataElements) {
        const code = elem.getAttribute('data-product-code') ||
                     elem.getAttribute('data-product-id') ||
                     elem.getAttribute('data-sku') ||
                     elem.getAttribute('data-item-id');
        if (code) {
          const match = code.match(/([A-Z]+[-_]?[0-9]+)/);
          if (match) {
            return { code: match[1], pattern: 'data-attr' };
          }
        }
      }

      return null;
    });

    // 品番が見つからない場合はHTMLを保存
    if (!manufacturerCode) {
      try {
        const fs = require('fs');
        const path = require('path');

        // debugディレクトリを作成（存在しなければ）
        const debugDir = 'debug';
        if (!fs.existsSync(debugDir)) {
          fs.mkdirSync(debugDir, { recursive: true });
        }

        // HTMLを保存
        const html = await page.content();
        const debugPath = path.join(debugDir, `debug_page_${contentId}.html`);
        fs.writeFileSync(debugPath, html, 'utf-8');

        // スクリーンショットも保存（ページの視覚的な確認用）
        const screenshotPath = path.join(debugDir, `debug_screenshot_${contentId}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });
      } catch (saveError) {
        // 保存に失敗しても処理は続行
      }
    }

    return manufacturerCode ? manufacturerCode.code : null;
  } catch (error) {
    return null;
  }
}

/**
 * メイン処理
 */
async function main() {
  // コマンドラインオプションを解析
  const forceMode = process.argv.includes('--force');

  console.log('🚀 メーカー品番バッチスクレイピングを開始します\n');
  if (forceMode) {
    console.log('⚠️  --force モード: 既に空文字列のmanufacturerCodeも再取得します\n');
  }

  let browser;
  let browserContext;

  try {
    // ブラウザ起動
    console.log('🌐 ブラウザを起動中...\n');

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

    browser = await puppeteer.launch({
      headless: true,
      executablePath: executablePath,
      defaultViewport: { width: 1280, height: 800 },
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // プライベートコンテキストを作成（クッキーやセッション状態を共有しない）
    browserContext = await browser.createBrowserContext();

    // dmm-library.json を読み込み
    console.log(`📂 ${CONFIG.inputFile} を読み込み中...\n`);
    const libraryData = JSON.parse(await fs.readFile(CONFIG.inputFile, 'utf-8'));

    // manufacturerCode を持たないアイテムをフィルタ
    let needsManufacturerCode;
    let alreadyHasCode;

    if (forceMode) {
      // --force モード: 空文字列のものも含めて処理
      needsManufacturerCode = libraryData.filter(item => {
        return item.itemURL &&
          item.productCode &&
          (!item.hasOwnProperty('manufacturerCode') || item.manufacturerCode === '');
      });

      alreadyHasCode = libraryData.filter(item =>
        item.manufacturerCode && item.manufacturerCode !== ''
      );
    } else {
      // 通常モード: フィールドが存在しない場合のみ対象（空文字列や既存値はスキップ）
      needsManufacturerCode = libraryData.filter(item => {
        return item.itemURL &&
          item.productCode &&
          !item.hasOwnProperty('manufacturerCode');
      });

      alreadyHasCode = libraryData.filter(item => item.manufacturerCode);
    }

    console.log(`📊 統計情報:`);
    console.log(`   総アイテム数: ${libraryData.length}件`);

    if (forceMode) {
      const emptyCode = libraryData.filter(item =>
        item.itemURL && item.productCode && item.manufacturerCode === ''
      );
      const noFieldCode = libraryData.filter(item =>
        item.itemURL && item.productCode && !item.hasOwnProperty('manufacturerCode')
      );
      console.log(`   既にmanufacturerCode（値あり）: ${alreadyHasCode.length}件`);
      console.log(`   manufacturerCode（空文字列）: ${emptyCode.length}件`);
      console.log(`   manufacturerCodeフィールド（なし）: ${noFieldCode.length}件`);
    } else {
      console.log(`   既にmanufacturerCode: ${alreadyHasCode.length}件`);
    }
    console.log(`   処理対象: ${needsManufacturerCode.length}件\n`);

    if (needsManufacturerCode.length === 0) {
      console.log('✨ すべてのアイテムにmanufacturerCodeが存在します！');
      return;
    }

    console.log(`📥 メーカー品番を取得開始...\n`);

    let successCount = 0;
    let failureCount = 0;

    for (let i = 0; i < needsManufacturerCode.length; i++) {
      const item = needsManufacturerCode[i];

      // itemURLからContent_idを抽出
      const contentIdMatch = item.itemURL.match(/id=([^&]+)/);
      if (!contentIdMatch) {
        console.log(`[${i + 1}/${needsManufacturerCode.length}] ⏭️  ${item.productCode}: Content_idを抽出できません`);
        failureCount++;
        continue;
      }

      const contentId = contentIdMatch[1];

      let page;
      try {
        console.log(`[${i + 1}/${needsManufacturerCode.length}] 🔍 ${item.productCode} (${contentId})`);
        console.log(`   📍 ${item.itemURL}`);

        // 新しいページを作成（プライベートコンテキスト使用）
        page = await browserContext.newPage();

        // メーカー品番を取得
        const manufacturerCode = await scrapeManufacturerCodeFromPage(page, contentId, item.itemURL);

        // 元のデータを取得
        const originalItem = libraryData.find(d => d.productCode === item.productCode);
        if (originalItem) {
          if (manufacturerCode) {
            originalItem.manufacturerCode = manufacturerCode;
            console.log(`   ✅ ${manufacturerCode}`);
            successCount++;
          } else {
            // メーカー品番が見つからない場合は空文字列を設定（次回実行時にスキップされるようにする）
            originalItem.manufacturerCode = '';
            console.log(`   ⚠️  メーカー品番が見つかりません（空で記録）`);
            failureCount++;
          }
        } else {
          console.log(`   ❌ 元のデータが見つかりません`);
          failureCount++;
        }

        // レート制限（次のリクエストまで待機）
        if (i < needsManufacturerCode.length - 1) {
          await new Promise(resolve => setTimeout(resolve, CONFIG.rateLimit));
        }

      } catch (error) {
        console.log(`   ❌ エラー: ${error.message}`);
        failureCount++;
      } finally {
        // ページを確実に閉じる（リソースリーク防止）
        if (page) {
          try {
            await page.close();
          } catch (closeError) {
            // ページクローズエラーは無視
          }
        }
      }
    }

    // 結果を保存
    console.log(`\n💾 ${CONFIG.inputFile} に保存中...\n`);
    await fs.writeFile(
      CONFIG.inputFile,
      JSON.stringify(libraryData, null, 2),
      'utf-8'
    );

    // 統計情報を表示
    console.log('✅ 完了！\n');
    console.log('📊 結果統計:');
    console.log(`   成功: ${successCount}件`);
    console.log(`   失敗: ${failureCount}件`);
    console.log(`   スキップ（既存）: ${alreadyHasCode.length}件`);

    const finalStats = libraryData.filter(item => item.manufacturerCode);
    console.log(`   総manufacturerCode: ${finalStats.length}件`);
    console.log(`\n💾 保存先: ${CONFIG.inputFile}`);

  } catch (error) {
    console.error('❌ エラーが発生しました:', error);
    process.exit(1);
  } finally {
    if (browserContext) {
      console.log('\n🔚 プライベートコンテキストを閉じています...');
      await browserContext.close();
    }
    if (browser) {
      console.log('🔚 ブラウザを閉じています...');
      await browser.close();
    }
  }
}

main();
