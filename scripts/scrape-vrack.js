const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const readline = require('readline');

/**
 * V-RACK（Hey動画・一本道・HEYZO）から購入済み動画一覧をスクレイプするスクリプト
 *
 * 使用方法:
 *   npm run scrape-vrack
 *   npm run scrape-vrack -- --force   # 既存データも上書き
 */

const CONFIG = {
  targetUrl: 'https://www.heydouga.com/index.html',
  outputFile: path.join(__dirname, '../data/vrack-library.json'),
  scrollDelay: 500,      // 短縮: 1500ms → 500ms
  maxScrollAttempts: 100,
  scrollStep: 800,       // 増加: 300px → 800px
};

const forceMode = process.argv.includes('--force');

function waitForEnter(message) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(message, () => { rl.close(); resolve(); });
  });
}

/**
 * FIGUREのテキスト内容からタイトル・時間・女優名をパース
 * テキスト例: "New就職祝い乱交コンパ 〜前編〜1:03:56日向ひなた"
 */
function parseItemText(rawText) {
  let text = rawText
    .replace(/^New\s*/i, '')
    .replace(/この作品は削除されました/g, '')
    .trim();

  // 時間フォーマットを検出（H:MM:SS または MM:SS）
  const durationMatch = text.match(/(\d{1,2}:\d{2}:\d{2}|\d{1,2}:\d{2})/);
  if (!durationMatch) {
    return { title: text, duration: null, actresses: [] };
  }

  const duration = durationMatch[0];
  const durationIndex = text.indexOf(duration);
  const title = text.substring(0, durationIndex).trim();
  const afterDuration = text.substring(durationIndex + duration.length).trim();

  // 女優名（複数の場合は改行や読点で区切られている可能性）
  const actresses = afterDuration
    ? afterDuration.split(/[、,\n]/).map(s => s.trim()).filter(s => s.length > 0)
    : [];

  return { title, duration, actresses };
}

/**
 * サムネイルURLからprovider_idとmovie_codeを抽出
 * 例: https://image01-www.heydouga.com/contents/3003/ppv-042712_01/player_thumb.jpg
 *  → { provider_id: '3003', movie_code: 'ppv-042712_01' }
 */
function parseThumbnailUrl(thumbnailUrl) {
  if (!thumbnailUrl) return { provider_id: null, movie_code: null };
  const match = thumbnailUrl.match(/\/contents\/(\w+)\/([^/]+)\//);
  if (!match) return { provider_id: null, movie_code: null };
  return { provider_id: match[1], movie_code: match[2] };
}

/**
 * スクロールコンテナを取得
 */
async function getScrollContainer(vrackFrame) {
  return await vrackFrame.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('*')).filter(el => {
      const style = window.getComputedStyle(el);
      const overflow = style.overflow + style.overflowY;
      return (overflow.includes('auto') || overflow.includes('scroll')) &&
             el.scrollHeight > el.clientHeight &&
             el.clientHeight > 100;
    });
    if (candidates.length === 0) return null;
    const container = candidates.reduce((a, b) =>
      a.scrollHeight > b.scrollHeight ? a : b
    );
    // 識別用にユニークなdata属性を付与
    container.setAttribute('data-vrack-scroll', 'true');
    return {
      tag: container.tagName,
      className: container.className.substring(0, 60),
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
    };
  });
}

/**
 * V-RACKフレーム内のアイテムを全件取得（バーチャルスクロール対応）
 *
 * V-RACKはバーチャルスクロール（画面外のDOMを削除）を使用しているため、
 * スクロールしながら都度アイテムを収集し、data-idをキーに重複排除する。
 */
async function scrapeAllItems(vrackFrame) {
  console.log('📥 V-RACKアイテムを読み込んでいます（バーチャルスクロール対応）...');

  // スクロールコンテナを特定
  const containerInfo = await getScrollContainer(vrackFrame);
  console.log(`   スクロールコンテナ: ${JSON.stringify(containerInfo)}`);

  // 収集済みアイテム（data-idをキーとするMap）
  const collectedItems = new Map();

  // 現在表示中のアイテムを収集する関数
  const collectVisible = async () => {
    const items = await vrackFrame.evaluate(() => {
      const figures = document.querySelectorAll('figure[data-id]');
      return Array.from(figures).map(fig => ({
        dataId: fig.getAttribute('data-id'),
        thumbnailUrl: (() => {
          const img = fig.querySelector('img');
          return img ? (img.getAttribute('data-src') || img.src) : null;
        })(),
        rawText: fig.textContent || '',
      }));
    });
    let newCount = 0;
    for (const item of items) {
      if (item.dataId && !collectedItems.has(item.dataId)) {
        collectedItems.set(item.dataId, item);
        newCount++;
      }
    }
    return newCount;
  };

  // スクロール位置を少しずつ下げながら収集
  let noNewCount = 0;
  const maxNoNew = 4;

  // まず現在表示中を収集
  await collectVisible();
  console.log(`   収集済み: ${collectedItems.size}件`);

  for (let i = 0; i < CONFIG.maxScrollAttempts; i++) {
    // scrollStep ずつ下にスクロール
    await vrackFrame.evaluate((step) => {
      const container = document.querySelector('[data-vrack-scroll]');
      if (container) {
        container.scrollTop += step;
      } else {
        document.documentElement.scrollTop += step;
        document.body.scrollTop += step;
        window.scrollBy(0, step);
      }
    }, CONFIG.scrollStep);

    await new Promise(r => setTimeout(r, CONFIG.scrollDelay));

    const newCount = await collectVisible();
    console.log(`   スクロール ${i + 1}回目: +${newCount}件 (合計${collectedItems.size}件)`);

    if (newCount === 0) {
      noNewCount++;
      if (noNewCount >= maxNoNew) {
        console.log('   ✓ 全アイテム読み込み完了');
        break;
      }
    } else {
      noNewCount = 0;
    }
  }

  return Array.from(collectedItems.values());
}

/**
 * 既存のheydouga-library.jsonを読み込む
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
  console.log('🎬 Hey動画 V-RACKスクレイパーを起動します');
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
    await page.goto(CONFIG.targetUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('手順:');
    console.log('  1. ブラウザでログインしてください');
    console.log('  2. ログイン後、Enter を押してください');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    await waitForEnter('ログインが完了したら Enter を押してください...');

    // 購入動画（Moviesリスト）を自動で表示
    console.log('\n🔄 V-RACKの購入動画を自動で表示しています...');
    try {
      const libraryClicked = await page.evaluate(() => {
        // data-rocket-id="library" のリンク（購入動画）を探す
        const libraryLink = document.querySelector('a[data-rocket-id="library"]');
        if (libraryLink) {
          libraryLink.click();
          return true;
        }
        return false;
      });

      if (libraryClicked) {
        console.log('   ✓ 購入動画リンクをクリックしました');
        await page.waitForTimeout(3000); // ページ遷移待ち
      } else {
        console.log('   ⚠️  購入動画リンクが見つかりません');
      }
    } catch (e) {
      console.log(`   ⚠️  購入動画の自動表示に失敗: ${e.message}`);
    }

    // V-RACK iframe が読み込まれるのを待つ
    console.log('🔄 V-RACKフレームが読み込まれるのを待機中...');
    try {
      await page.waitForFunction(() => {
        const frames = page.frames();
        return frames.some(f => f.url().includes('api.vrack.me'));
      }, { timeout: 10000 });
      console.log('   ✓ V-RACKフレームが読み込まれました');
    } catch (e) {
      console.log('   ⚠️  V-RACKフレームの読み込みがタイムアウト');
    }

    // 画面を最大化（V-RACK iframe内の右上矢印ボタンをクリック）
    console.log('🔄 画面を最大化しています...');
    try {
      const allFrames = page.frames();
      const vrackFrame = allFrames.find(f => f.url().includes('api.vrack.me'));

      if (vrackFrame) {
        const fullscreenClicked = await vrackFrame.evaluate(() => {
          // V-RACK iframe内の右上矢印ボタン（フルスクリーン化）を探す
          // SVGパスで矢印を判定：M19.25 は右上矢印のパターン
          const buttons = document.querySelectorAll('button');

          for (const btn of buttons) {
            const rect = btn.getBoundingClientRect();
            const isTopRight = rect.right > window.innerWidth * 0.90 && rect.top < 150;

            if (isTopRight) {
              const svg = btn.querySelector('svg');
              if (svg) {
                const path = svg.querySelector('path');
                if (path) {
                  const pathData = path.getAttribute('d') || '';
                  // 右上矢印パターン（↗）を判定
                  if (pathData.includes('M19.25') || pathData.includes('M18.')) {
                    btn.click();
                    return { clicked: true, pathData: pathData.substring(0, 20) };
                  }
                }
              }
            }
          }
          return { clicked: false };
        });

        if (fullscreenClicked && fullscreenClicked.clicked) {
          console.log(`   ✓ 画面を最大化しました`);
          await page.waitForTimeout(1000);
        } else {
          console.log('   ⚠️  最大化ボタンが見つかりません。手動で最大化してください。');
        }
      } else {
        console.log('   ⚠️  V-RACKフレームが見つかりません');
      }
    } catch (e) {
      console.log(`   ⚠️  画面最大化に失敗: ${e.message}`);
    }

    // V-RACKフレームを探す
    console.log('\n🔍 V-RACKフレームを検索しています...');
    const frames = page.frames();
    let vrackFrame = null;
    let vrackBaseUrl = null;

    for (const frame of frames) {
      if (frame.url().includes('api.vrack.me')) {
        vrackFrame = frame;
        console.log(`   ✓ V-RACKフレーム検出: ${frame.url().substring(0, 80)}`);
        break;
      }
    }

    // heydouga.comのセッションクッキーを保存
    console.log('\n🍪 セッションクッキーを保存しています...');
    const allCookies = await page.cookies('https://www.heydouga.com');
    const cookiesPath = path.join(__dirname, '../data/heydouga-cookies.json');
    await fs.writeFile(cookiesPath, JSON.stringify(allCookies, null, 2), 'utf-8');
    const netiACookie = allCookies.find(c => c.name === 'NetiA');
    if (netiACookie) {
      console.log(`   ✓ NetiAクッキー保存済み (ログアウトまで有効)`);
    } else {
      console.log(`   ⚠️  NetiAクッキーが見つかりません。ログインしてから再実行してください。`);
    }

    if (!vrackFrame) {
      console.error('❌ V-RACKフレームが見つかりません');
      console.error('   V-RACKを開いて購入済みリストを表示してから再実行してください');
      return;
    }

    // アイテム数確認
    const initialCount = await vrackFrame.evaluate(() => {
      return document.querySelectorAll('figure[data-id]').length;
    });

    if (initialCount === 0) {
      console.error('❌ figure[data-id] が見つかりません');
      console.error('   V-RACKのMoviesタブ（購入済みリスト）を表示してから再実行してください');
      return;
    }

    console.log(`   初期アイテム数: ${initialCount}件`);

    // 既存データを先に読み込む（重複チェック用）
    const existing = await loadExistingLibrary();
    const existingMap = new Map(existing.map(item => [item.productCode, item]));
    console.log(`📚 既存ライブラリ: ${existing.length}件\n`);

    // 全アイテムをスクレイプ
    const rawItems = await scrapeAllItems(vrackFrame);
    console.log(`✓ スクレイプ完了: ${rawItems.length}件\n`);

    // データを整形（新規アイテムのみ処理）
    const newItems = [];
    let skippedCount = 0;

    for (const raw of rawItems) {
      const { dataId, thumbnailUrl, rawText } = raw;
      const productCode = dataId;

      // 既存アイテムはスキップ
      if (existingMap.has(productCode) && !forceMode) {
        skippedCount++;
        // playerUrls（認証トークン）のみ更新
        const existingItem = existingMap.get(productCode);
        existingMap.set(productCode, { ...existingItem, playerUrls: [`/heydouga/play/${productCode}`] });
        continue;
      }

      // 新規アイテムのみ処理
      const { title, duration, actresses } = parseItemText(rawText);
      const { provider_id, movie_code } = parseThumbnailUrl(thumbnailUrl);
      const makerName = productCode ? productCode.split('_')[0] : null;

      // サーバープロキシ経由で再生
      // serve-viewer.js の GET /heydouga/play/:productCode が
      // heydouga-cookies.json から NetiA を読み、正しい形式で V-RACK にリダイレクト
      const playerUrl = `/heydouga/play/${productCode}`;

      const item = {
        productCode,
        title,
        actresses,
        makerName,
        thumbnail: thumbnailUrl,
        playerUrls: [playerUrl],
        duration,
        provider_id,
        movie_code,
        isFetched: true,
        isUncensored: true,
        registeredAt: new Date().toISOString(),
      };

      newItems.push(item);
    }

    console.log(`📊 新規アイテム: ${newItems.length}件 (スキップ: ${skippedCount}件)\n`);

    // 新規アイテムをマージ
    let addedCount = 0;

    for (const item of newItems) {
      if (!item.productCode) continue;

      const prev = existingMap.get(item.productCode) || {};
      existingMap.set(item.productCode, {
        ...prev,
        ...item,
        // 既存の registeredAt を保持（上書きしない）
        registeredAt: prev.registeredAt || item.registeredAt,
      });
      addedCount++;
    }

    const merged = Array.from(existingMap.values());

    // 保存
    await fs.writeFile(CONFIG.outputFile, JSON.stringify(merged, null, 2), 'utf-8');

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ 完了');
    console.log(`   スクレイプ件数: ${newItems.length}件`);
    console.log(`   新規追加:       ${addedCount}件`);
    console.log(`   スキップ:       ${skippedCount}件`);
    console.log(`   合計:           ${merged.length}件`);
    console.log(`   保存先:         heydouga-library.json`);

    // サンプル表示
    console.log('\n📋 取得データサンプル（最初の3件）:');
    newItems.slice(0, 3).forEach((item, i) => {
      console.log(`  [${i + 1}] ${item.productCode}`);
      console.log(`       タイトル: ${item.title}`);
      console.log(`       女優名:   ${item.actresses.join(', ')}`);
      console.log(`       メーカー: ${item.makerName}`);
      console.log(`       再生URL:  ${item.playerUrls[0]}`);
    });

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
