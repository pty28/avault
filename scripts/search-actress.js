#!/usr/bin/env node

/**
 * search-actress.js
 *
 * 女優情報が未取得のアイテムに対して、avwikidb.com、av-wiki.net、adult-wiki.net、shiroutowiki.work、jav321.com から女優名を取得します
 * また、productCode を引数として指定した場合、そのアイテムのみを処理します（makerName チェックはスキップ）
 *
 * 機能：
 * 1. actresses が null/undefined/空配列のアイテムをフィルタ（isSearched !== true）
 * 2. タイトルに除外パターン（福袋、お中元セット、夏ギフトセット、お歳暮セット、冬ギフトセット）が含まれるアイテムを除外
 * 3. manufacturerCode を小文字に変換（存在しない場合は productCode から生成）
 * 4. 優先順位で女優情報を取得：avwikidb.com → av-wiki.net → adult-wiki.net → shiroutowiki.work → jav321.com
 * 5. 取得データを採用して dmm-library.json に保存
 * 6. 処理済みアイテムに isSearched: true フラグを設定
 * 7. 各サイトのメーカー名が dmm-library.json のメーカー名と不一致の場合は suspicious.log に記録
 *
 * 使用方法:
 *   npm run search-actress                                        (通常モード: 未処理のみ、dmm-library.json を使用)
 *   npm run search-actress -- --force                            (強制モード: 全アイテムを再処理)
 *   npm run search-actress -- --jewel                            (ジュエルモード: 指定メーカーのみ処理)
 *   npm run search-actress -- --jewel --force                    (ジュエル強制モード)
 *   npm run search-actress -- SIRO-5588                          (productCode モード: 指定アイテムのみ、makerName チェックなし)
 *   npm run search-actress -- --file mgstage-library.json        (別ライブラリファイルを指定)
 *   npm run search-actress -- --file mgstage-library.json --force
 *   node search-actress.js
 *   node search-actress.js --force
 *   node search-actress.js --jewel
 *   node search-actress.js --jewel --force
 *   node search-actress.js VERO00129
 *   node search-actress.js --file mgstage-library.json
 *
 * モード説明:
 *   - 通常モード: actresses が空 かつ isSearched !== true のアイテムを処理
 *   - --force モード: actresses が空のすべてのアイテムを処理（isSearched フラグを無視）
 *   - --jewel モード: ジュエル系メーカー（46165,45339,46654）で未処理のアイテムを処理
 *   - --jewel --force: ジュエル系メーカーのすべてのアイテムを再処理
 *   - productCode モード: 指定された productCode のアイテムのみ処理（makerName チェックなし）
 *
 * 検索優先順位:
 *   1. avwikidb.com - Puppeteer使用
 *   2. av-wiki.net - Puppeteer使用
 *   3. adult-wiki.net - Puppeteer使用（検索結果が1件のみの場合のみ詳細ページにアクセス）
 *   4. shiroutowiki.work - Puppeteer使用（productCode使用）
 *   5. jav321.com - Puppeteer使用
 *
 * 出力ファイル:
 *   - dmm-library.json: 更新されたアイテムを保存
 *   - suspicious.log: メーカー名が不一致だったアイテムをログ（タイムスタンプ付き）
 */

const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const querystring = require('querystring');

// =====================================================================
// Configuration
// =====================================================================

const CONFIG = {
  avwikidb: 'https://avwikidb.com/work',
  avwiki: 'https://av-wiki.net',
  adultwiki: 'https://adult-wiki.net/search/',
  shiroutowiki: 'https://shiroutowiki.work/fanza-video',
  rateLimit: 1000,
  timeout: 20000,
  headless: true,
};

// =====================================================================
// Utility Functions
// =====================================================================

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * タイトルに除外パターンが含まれているかチェック
 */
function shouldExcludeByTitle(title) {
  if (!title) return false;
  const excludePatterns = ['福袋', 'お中元セット', '夏ギフトセット', 'お歳暮セット', '冬ギフトセット'];
  return excludePatterns.some(pattern => title.includes(pattern));
}

/**
 * suspicious.log にメーカー名不一致情報を追記
 */
async function appendSuspiciousLog(productCode, expectedMaker, actualMaker, site, actresses, url) {
  try {
    const timestamp = new Date().toISOString();
    const performerList = actresses.join(', ');
    const logLine = `${timestamp} | ${productCode} | 期待: ${expectedMaker} | 実際: ${actualMaker} | サイト: ${site} | URL: ${url} | 女優: ${performerList}\n`;

    await fs.appendFile('../suspicious.log', logLine, 'utf-8');
  } catch (error) {
    console.error('❌ suspicious.log への書き込みエラー:', error.message);
  }
}

/**
 * Manufacturer Code を productCode から生成
 * ロジック:
 *   1. ^[hH]_[0-9]+ を削除
 *   2. ^[0-9]+ を削除
 *   3. 数字部分の先頭の0をすべてスキップし、最初の0以外の数字からすべての数字を保持
 *
 * 例:
 *   C02290 → C-2290
 *   D12345 → D-12345
 *   E00123 → E-123
 *   F00012 → F-012
 */
function generateManufacturerCode(productCode) {
  if (!productCode) return null;

  let code = productCode.toString();

  // Step 1: Remove ^[hH]_[0-9]+ prefix
  code = code.replace(/^[hH]_\d+/i, '');

  // Step 2: Remove ^[0-9]+ prefix
  code = code.replace(/^\d+/, '');

  if (!code) return null;

  // Step 3: Extract letters and numbers
  const match = code.match(/^([A-Za-z]+)(\d+)$/);
  if (match) {
    const prefix = match[1].toLowerCase();
    const numbers = match[2];

    // Trim leading zeros intelligently:
    // - If numbers has more than 3 digits, check the head part (before last 3 digits)
    // - If head part has non-zero digit, keep from that digit onward
    // - Otherwise keep only last 3 digits
    // Examples: 00123 → 123, 02290 → 2290, 12345 → 12345, 00012 → 012
    let trimmedNumbers;
    if (numbers.length <= 3) {
      trimmedNumbers = numbers;
    } else {
      const headPart = numbers.slice(0, -3);
      const firstNonZeroIndexInHead = headPart.search(/[1-9]/);

      if (firstNonZeroIndexInHead !== -1) {
        // Head part has non-zero digit, keep from that digit onward
        trimmedNumbers = numbers.slice(firstNonZeroIndexInHead);
      } else {
        // Head part is all zeros, keep only last 3 digits
        trimmedNumbers = numbers.slice(-3);
      }
    }

    return `${prefix}-${trimmedNumbers}`;
  }

  return code.toLowerCase();
}

// =====================================================================
// Web Fetching Functions
// =====================================================================

/**
 * avwikidb.com から女優情報を取得
 * メーカー情報も一緒に返す
 */
async function fetchFromAvwikidb(mc, page) {
  try {
    const url = `${CONFIG.avwikidb}/${mc}/`;
    console.log(`     URL: ${url}`);

    // User-Agent を設定してブラウザに見せる
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Cloudflare チャレンジ対策
    await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });

    // ページが読み込まれた後、追加で待機
    await sleep(1000);

    // 「出演女優」セクションとメーカー情報を探す
    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      let actresses = [];

      // パターン1: QA セクションから「出演しているのは...です」を探す（最も信頼性が高い）
      const qaMatch = bodyText.match(/出演しているのは\s*(.+?)\s*(?:です|。)/);
      if (qaMatch && qaMatch[1]) {
        const qaText = qaMatch[1].trim().replace(/[（(][^）)]*[）)]/g, '');
        const qaNames = qaText
          .split(/[、,]/)
          .map(name => name.trim())
          .filter(name => name.length > 0)
          .filter(name => !name.match(/^[0-9]/))
          .filter(name => name.length >= 2 && name.length <= 30);

        if (qaNames.length > 0) {
          actresses = qaNames;
        }
      }

      // パターン2: 「\n出演女優\n」というセクションラベルを探す（フォールバック）
      if (actresses.length === 0) {
        const womenSectionMatch = bodyText.match(/\n出演女優\n([\s\S]*?)(?=\n品番|\n出演男優|\n監督|\n制作|\n配信開始日|$)/);

        if (womenSectionMatch && womenSectionMatch[1]) {
          // セクションテキストを取得
          const sectionText = womenSectionMatch[1].trim().replace(/[（(][^）)]*[）)]/g, '');

          // 名前を抽出
          const names = sectionText
            .split(/[、\n,]/)
            .map(name => name.trim())
            .filter(name => name.length > 0)
            .filter(name => !name.match(/^[0-9]/))
            .filter(name => name !== '出演女優' && !name.includes('FANZA') && name !== '--')
            .filter(name => !name.match(/^全\d+名/))  // 「全8名を表示」などを除外
            .filter(name => !name.includes('表示'))    // UI要素を除外
            .filter(name => name.length >= 2 && name.length <= 20);  // 名前の長さチェック

          if (names.length > 0) {
            actresses = names;
          }
        }
      }

      // メーカー情報を抽出
      // ページには複数の「メーカー」テキストがあるため、FANZA Content ID以降の方にある実データセクションを探す
      let makerName = null;
      const fanzaIndex = bodyText.indexOf('FANZA Content ID');
      if (fanzaIndex !== -1) {
        // FANZA Content ID以降のテキストから「メーカー」を探す
        const textAfterFanza = bodyText.substring(fanzaIndex);
        const makerMatch = textAfterFanza.match(/\nメーカー\n([^\n]+)/);
        if (makerMatch && makerMatch[1]) {
          makerName = makerMatch[1].trim();
        }
      }

      return { actresses, makerName };
    });

    return result;
  } catch (error) {
    console.log(`   ⚠️  avwikidb.com エラー: ${error.message}`);
    return { actresses: [], makerName: null };
  }
}

/**
 * av-wiki.net から女優情報を取得
 * 「AV女優名」という行のデータを女優名とします
 * メーカー情報も一緒に返す
 */
async function fetchFromAvWiki(mc, page) {
  try {
    // MC で直接URL構築（検索URLではなく）
    const url = `${CONFIG.avwiki}/${mc}/`;
    console.log(`     URL: ${url}`);

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // ページアクセス（domcontentloaded で十分、一部リソース失敗を許容）
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeout });
    } catch (error) {
      // ERR_ABORTED など一部リソースロード失敗は無視して続行
      if (!error.message.includes('ERR_ABORTED')) {
        throw error;
      }
      // ページ読み込み中止でも DOM は存在するため続行
    }
    await sleep(1000);

    // 女優情報とメーカー情報を抽出
    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText;
      const lines = bodyText.split('\n');

      // 「AV女優名」というセクションヘッダを正確に探す（単独行またはセクションヘッダ）
      let avActressIndex = -1;

      // 複数の「AV女優名」が存在する可能性があるため、最初の有効なものを探す
      for (let idx = 0; idx < lines.length; idx++) {
        const line = lines[idx].trim();

        // 正確に「AV女優名」のセクションヘッダを探す
        if (line === 'AV女優名' && idx + 1 < lines.length) {
          const nextLine = lines[idx + 1].trim();
          // 次の行が空でなければ採用（英字で始まるか日本語かは問わない）
          if (nextLine !== '' && nextLine !== '#') {
            avActressIndex = idx;
            break;
          }
        }
      }

      let actresses = [];
      if (avActressIndex !== -1) {
        // AV女優名の次の行から女優名を抽出
        const names = [];
        for (let i = avActressIndex + 1; i < lines.length; i++) {
          const line = lines[i].trim();

          // 空行で終了
          if (line === '') {
            break;
          }

          // セパレータ「#」で終了（女優名リストのセパレータ）
          if (line === '#') {
            break;
          }

          // セクションヘッダキーワード（品番、メーカー、レーベル等）で終了
          if (line.includes('品番') || line.includes('メーカー') || line.includes('レーベル') ||
              line.includes('配信') || line.includes('関連') || line.includes('作品の概要')) {
            break;
          }

          // 女優名として追加（フィルタ処理）
          if (line &&
              !line.includes(':') &&
              !line.includes('http') &&
              !line.includes('FANZA') &&
              !line.includes('＊') &&
              line !== '(≥o≤)' &&
              !line.match(/^[0-9]/)) {
            names.push(line);
          }
        }

        if (names.length > 0) {
          actresses = names;
        }
      }

      // メーカー情報を抽出
      let makerName = null;
      for (let idx = 0; idx < lines.length; idx++) {
        if (lines[idx].trim() === 'メーカー' && idx + 1 < lines.length) {
          const nextLine = lines[idx + 1].trim();
          if (nextLine !== '' && !nextLine.match(/^[A-Za-z]/)) {
            makerName = nextLine;
            break;
          }
        }
      }

      return { actresses, makerName };
    });

    return result;
  } catch (error) {
    console.log(`   ⚠️  av-wiki.net エラー: ${error.message}`);
    return { actresses: [], makerName: null };
  }
}

/**
 * shiroutowiki.work から女優情報を取得
 * productCode を使用してページにアクセスし、女優名とメーカー名を抽出
 */
async function fetchFromShiroutowiki(productCode, page) {
  try {
    const url = `${CONFIG.shiroutowiki}/${productCode.toLowerCase()}/`;
    console.log(`     URL: ${url}`);

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
    await sleep(1000);

    // 女優情報を抽出
    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      let actresses = [];
      let makerName = null;

      // パターン1: 「女優名\s+(.+)」形式で直接抽出（最も確実）
      const performerMatches = bodyText.match(/女優名\s+([^\n,]+)/g);
      if (performerMatches && performerMatches.length > 0) {
        performerMatches.forEach(match => {
          const name = match.replace(/女優名\s+/, '').trim();
          // 女優名として有効か確認（短く、特殊文字なし）
          if (name && name.length > 0 && name.length < 20 &&
              !name.includes('(') && !name.includes('http')) {
            actresses.push(name);
          }
        });
      }

      // パターン2: 「女優名」の直後の行をチェック（フォールバック）
      if (actresses.length === 0) {
        const lines = bodyText.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.includes('女優名') && i + 1 < lines.length) {
            const nextLine = lines[i + 1].trim();
            if (nextLine && nextLine.length > 0 && nextLine.length < 20 &&
                !nextLine.includes(':') && !nextLine.includes('http')) {
              actresses.push(nextLine);
              break;
            }
          }
        }
      }

      // メーカー名を抽出
      const makerMatch = bodyText.match(/(?:メーカー|メーカー名)\s+([^\n]+)/);
      if (makerMatch && makerMatch[1]) {
        const name = makerMatch[1].trim();
        if (name && name.length > 0 && !name.includes('[')) {
          makerName = name;
        }
      }

      return { actresses, makerName };
    });

    return result;
  } catch (error) {
    console.log(`   ⚠️  shiroutowiki.work エラー: ${error.message}`);
    return { actresses: [], makerName: null };
  }
}

/**
 * jav321.com から女優情報を取得
 * productCode を使用してページにアクセスし、出演者とメーカー情報を抽出
 */
async function fetchFromJav321(productCode, browser) {
  try {
    const url = `https://www.jav321.com/video/${productCode}`;
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(20000);
    page.setDefaultTimeout(20000);

    try {
      await page.goto(url, { waitUntil: 'networkidle2' });

      // 出演者情報を抽出
      const actresses = await page.evaluate(() => {
        let performerNames = [];

        // 方法1: <b>出演者</b> 要素を探してテキストベースで抽出
        const boldElements = Array.from(document.querySelectorAll('b')).filter(
          el => el.textContent.includes('出演者')
        );

        if (boldElements.length > 0) {
          // <b>出演者</b>の後の要素を探す
          let currentNode = boldElements[0].nextSibling;
          while (currentNode) {
            if (currentNode.nodeType === Node.TEXT_NODE) {
              // テキストノードの場合、コンテンツを抽出
              const text = currentNode.textContent.trim();
              // ": 名前" または "　名前" の形式を処理
              if (text.startsWith(':') || text.startsWith('：')) {
                const nameText = text.replace(/^[:：]\s*/, '').trim();
                if (nameText && nameText.length > 0 && !nameText.includes('メーカー')) {
                  performerNames.push(nameText);
                }
                break;
              }
            } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
              const el = currentNode;
              // <br>, <hr>, 次のセクションが出現したら終了
              if (['BR', 'HR'].includes(el.tagName)) break;
              if (el.tagName === 'B') break; // 次のセクションに到達

              // <a> 要素から名前を取得
              if (el.tagName === 'A') {
                const name = el.textContent.trim();
                if (name && name.length > 0) {
                  performerNames.push(name);
                }
              } else {
                // その他の要素のテキストコンテンツを取得
                const text = el.textContent.trim();
                if (text && text.length > 0 && !text.includes('メーカー') && !text.includes('出演者')) {
                  performerNames.push(text);
                  break;
                }
              }
            }
            currentNode = currentNode.nextSibling;
          }
        }

        // 方法2: innerText を使ったテキストベース抽出（フォールバック）
        if (performerNames.length === 0) {
          const pageText = document.body.innerText;
          // 「出演者:」または「出演者：」のパターンを探す
          const performerMatch = pageText.match(/出演者[:\：]\s*(.+?)(?:\n|メーカー|$)/);
          if (performerMatch) {
            const names = performerMatch[1].trim();
            // 複数の出演者の場合は「、」で分割
            if (names.includes('、')) {
              performerNames = names.split('、').map(n => n.trim()).filter(n => n.length > 0);
            } else if (names.length > 0) {
              performerNames = [names];
            }
          }
        }

        // 方法3: CSS セレクタフォールバック
        if (performerNames.length === 0) {
          const selectors = [
            '.video-actors a',
            '.actors a',
            '[class*="actor"] a',
            'a[href*="/actor/"]',
            'a[href*="/star/"]',
          ];

          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            if (elements.length > 0) {
              performerNames = Array.from(elements)
                .map(el => el.textContent.trim())
                .filter(name => name.length > 0);
              break;
            }
          }
        }

        return performerNames.filter(name => name.length > 0 && !name.includes('メーカー'));
      });

      // メーカー情報を抽出
      const makerInfo = await page.evaluate(() => {
        let makerName = null;

        // 方法1: <b>メーカー</b> 要素を探してテキストベースで抽出
        const boldElements = Array.from(document.querySelectorAll('b')).filter(
          el => el.textContent.includes('メーカー')
        );

        if (boldElements.length > 0) {
          // <b>メーカー</b>の後の要素を探す
          let currentNode = boldElements[0].nextSibling;
          while (currentNode) {
            if (currentNode.nodeType === Node.TEXT_NODE) {
              // テキストノードの場合、コンテンツを抽出
              const text = currentNode.textContent.trim();
              // ": 名前" または "　名前" の形式を処理
              if (text.startsWith(':') || text.startsWith('：')) {
                makerName = text.replace(/^[:：]\s*/, '').trim();
                if (makerName && makerName.length > 0) {
                  return makerName;
                }
              }
            } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
              const el = currentNode;
              // <br>, <hr>, 次のセクションが出現したら終了
              if (['BR', 'HR'].includes(el.tagName)) break;
              if (el.tagName === 'B') break; // 次のセクションに到達

              // <a> 要素から名前を取得
              if (el.tagName === 'A') {
                makerName = el.textContent.trim();
                if (makerName && makerName.length > 0) {
                  return makerName;
                }
              } else {
                // その他の要素のテキストコンテンツを取得
                const text = el.textContent.trim();
                if (text && text.length > 0 && !text.includes('出演者')) {
                  makerName = text;
                  break;
                }
              }
            }
            currentNode = currentNode.nextSibling;
          }
        }

        // 方法2: innerText を使ったテキストベース抽出（フォールバック）
        if (!makerName) {
          const pageText = document.body.innerText;
          // 「メーカー:」または「メーカー：」のパターンを探す
          const makerMatch = pageText.match(/メーカー[:\：]\s*(.+?)(?:\n|$)/);
          if (makerMatch) {
            makerName = makerMatch[1].trim();
            if (makerName && makerName.length > 0) {
              return makerName;
            }
          }
        }

        // 方法3: CSS セレクタフォールバック
        if (!makerName) {
          const selectors = [
            '.video-maker',
            '.maker-info',
            '[class*="maker"]',
            '[class*="studio"]',
          ];

          for (const selector of selectors) {
            const element = document.querySelector(selector);
            if (element) {
              makerName = element.textContent.trim();
              if (makerName && makerName.length > 0) {
                return makerName;
              }
            }
          }
        }

        return makerName;
      });

      await page.close();

      return {
        actresses: actresses.length > 0 ? actresses : [],
        makerName: makerInfo,
        url: url,
      };
    } catch (pageError) {
      try {
        await page.close();
      } catch (e) {
        // page close failed, ignore
      }
      return { actresses: [], makerName: null, url: url };
    }
  } catch (error) {
    return { actresses: [], makerName: null, url: '' };
  }
}

/**
 * adult-wiki.net から女優情報を取得
 * ロジック：
 * 1. adult-wiki.net で productCode を検索
 * 2. 検索結果が1つのみの場合、詳細ページにアクセス
 * 3. 複数の女優名を取得（複数人出演の場合も対応）
 */
async function fetchFromAdultWiki(productCode, page) {
  try {
    const searchUrl = `${CONFIG.adultwiki}?keyword=${encodeURIComponent(productCode)}`;
    console.log(`     URL: ${searchUrl}`);

    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
    await sleep(1000);

    // 検索結果の件数をチェック
    const searchResult = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      // 「[検索結果] 0 作品」の形式を探す
      const countMatch = bodyText.match(/\[検索結果\]\s*(\d+)\s*作品/);
      if (!countMatch) {
        return { count: 0, link: null };
      }

      const count = parseInt(countMatch[1], 10);
      if (count !== 1) {
        return { count, link: null };
      }

      // 結果が1つの場合、詳細ページへのリンクを抽出
      const linkElement = document.querySelector('a[href*="/details/"]');
      if (linkElement) {
        const href = linkElement.getAttribute('href');
        if (href) {
          // 相対パスの場合は絶対パスに変換
          const fullHref = href.startsWith('http') ? href : new URL(href, window.location.href).href;
          return { count: 1, link: fullHref };
        }
      }

      return { count: 1, link: null };
    });

    // 検索結果がない、またはリンクが見つからない場合
    // 複数結果でも最初のリンクがあれば詳細ページにアクセス
    if (searchResult.count === 0 || !searchResult.link) {
      return { actresses: [], makerName: null };
    }

    // 詳細ページにアクセス
    await page.goto(searchResult.link, { waitUntil: 'networkidle2', timeout: CONFIG.timeout });
    await sleep(1000);

    // 女優情報を抽出
    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      let actresses = [];
      let makerName = null;

      // パターン1: 「女優名\s+(.+)」形式で直接抽出（最も確実）
      const performerMatches = bodyText.match(/女優名\s+([^\n,]+)/g);
      if (performerMatches && performerMatches.length > 0) {
        performerMatches.forEach(match => {
          const name = match.replace(/女優名\s+/, '').trim();
          // 女優名として有効か確認（短く、特殊文字なし）
          if (name && name.length > 0 && name.length < 20 &&
              !name.includes('(') && !name.includes('(') && !name.includes('http')) {
            actresses.push(name);
          }
        });
      }

      // パターン2: 「女優名」の直後の行をチェック（フォールバック）
      if (actresses.length === 0) {
        const lines = bodyText.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (line.includes('女優名') && i + 1 < lines.length) {
            const nextLine = lines[i + 1].trim();
            if (nextLine && nextLine.length > 0 && nextLine.length < 20 &&
                !nextLine.includes(':') && !nextLine.includes('http')) {
              actresses.push(nextLine);
              break;
            }
          }
        }
      }

      // メーカー名を抽出
      const makerMatch = bodyText.match(/(?:メーカー|メーカー名)\s+([^\n]+)/);
      if (makerMatch && makerMatch[1]) {
        const name = makerMatch[1].trim();
        if (name && name.length > 0 && !name.includes('[')) {
          makerName = name;
        }
      }

      return { actresses, makerName };
    });

    return result;
  } catch (error) {
    console.log(`   ⚠️  adult-wiki.net エラー: ${error.message}`);
    return { actresses: [], makerName: null };
  }
}

// =====================================================================
// productCode Mode Handler
// =====================================================================

async function handleProductCodeMode(productCode) {
  let browser;
  try {
    // 末尾の "AI" を削除
    if (productCode.endsWith('AI')) {
      const originalCode = productCode;
      productCode = productCode.slice(0, -2);
      console.log(`🔍 productCode: ${originalCode} → ${productCode}（末尾の AI を削除）\n`);
    } else {
      console.log(`🔍 productCode: ${productCode}\n`);
    }

    // ブラウザを起動
    console.log('🚀 ブラウザを起動中...');
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

    try {
      browser = await puppeteer.launch({
        headless: CONFIG.headless,
        executablePath: executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
        ],
      });
      console.log('   ✅ ブラウザ起動完了\n');
    } catch (launchError) {
      console.error('❌ ブラウザ起動失敗:', launchError.message);
      process.exit(1);
    }

    // Manufacturer Code を生成
    const mc = generateManufacturerCode(productCode);
    if (!mc) {
      console.error(`❌ Manufacturer Code を生成できません\n`);
      process.exit(1);
    }

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });

    let result = { actresses: [] };

    // 優先順位: avwikidb.com → av-wiki.net → adult-wiki.net → shiroutowiki.work → jav321.com
    console.log('   🌐 avwikidb.com から取得中...');
    const avwikidbResult = await fetchFromAvwikidb(mc, page);
    console.log(`     📊 ${avwikidbResult.actresses.length}件`);
    if (avwikidbResult.actresses.length > 0) {
      result = { source: 'avwikidb', actresses: avwikidbResult.actresses };
    } else {
      console.log('   🌐 av-wiki.net から取得中...');
      const avwikiResult = await fetchFromAvWiki(mc, page);
      console.log(`     📊 ${avwikiResult.actresses.length}件`);
      if (avwikiResult.actresses.length > 0) {
        result = { source: 'av-wiki.net', actresses: avwikiResult.actresses };
      } else {
        console.log('   🌐 av-wiki.net から再取得中（productCode）...');
        const avwikiResultProductCode = await fetchFromAvWiki(productCode.toLowerCase(), page);
        console.log(`     📊 ${avwikiResultProductCode.actresses.length}件`);
        if (avwikiResultProductCode.actresses.length > 0) {
          result = { source: 'av-wiki.net', actresses: avwikiResultProductCode.actresses };
        } else {
          console.log('   🌐 adult-wiki.net から取得中...');
          const adultwikiResult = await fetchFromAdultWiki(productCode, page);
          console.log(`     📊 ${adultwikiResult.actresses.length}件`);
          if (adultwikiResult.actresses.length > 0) {
            result = { source: 'adult-wiki.net', actresses: adultwikiResult.actresses };
          } else {
            console.log('   🌐 shiroutowiki.work から取得中...');
            const shiroutozResult = await fetchFromShiroutowiki(productCode, page);
            console.log(`     📊 ${shiroutozResult.actresses.length}件`);
            if (shiroutozResult.actresses.length > 0) {
              result = { source: 'shiroutowiki.work', actresses: shiroutozResult.actresses };
            } else {
              console.log('   🌐 jav321.com から取得中...');
              const jav321Result = await fetchFromJav321(productCode, browser);
              console.log(`     📊 ${jav321Result.actresses.length}件`);
              if (jav321Result.actresses.length > 0) {
                result = { source: 'jav321.com', actresses: jav321Result.actresses };
              }
            }
          }
        }
      }
    }

    // ページを閉じる
    await page.close();

    // 結果を表示
    console.log('\n' + '═'.repeat(70));
    console.log('📊 検索結果');
    console.log('═'.repeat(70));
    console.log(`\n作品コード: ${productCode}`);
    console.log(`MC:       ${mc}`);
    console.log(`出演女優:  ${result.actresses.length > 0 ? result.actresses.join(', ') : 'なし'}`);
    if (result.source) {
      console.log(`取得元:   ${result.source}`);
    }
    console.log('');

  } catch (error) {
    console.error('❌ エラーが発生しました:', error.message);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// =====================================================================
// Data Comparison & Selection
// =====================================================================

/**
 * 注: 現在は使用されていません
 * avwikidb を優先するロジックに変更されたため、単純な順序優先を実装
 */
// function compareAndSelect(gravurefitData, avwikidbData) {
//   if (!Array.isArray(gravurefitData)) gravurefitData = [];
//   if (!Array.isArray(avwikidbData)) avwikidbData = [];
//
//   const gravurefitCount = gravurefitData.length;
//   const avwikidbCount = avwikidbData.length;
//
//   if (gravurefitCount > avwikidbCount) {
//     return { source: 'gravurefit', actresses: gravurefitData, count: gravurefitCount };
//   } else {
//     return { source: 'avwikidb', actresses: avwikidbData, count: avwikidbCount };
//   }
// }

// =====================================================================
// Main Function
// =====================================================================

async function main() {
  // 引数を処理（process.argv[0]=node, process.argv[1]=script path）
  const args = process.argv.slice(2);

  // オプションをチェック
  const force = args.includes('--force');
  const jewel = args.includes('--jewel');

  // --file <path> オプション（ライブラリファイルを指定）
  const fileArgIndex = args.indexOf('--file');
  const libraryFile = fileArgIndex !== -1 && args[fileArgIndex + 1]
    ? path.resolve(args[fileArgIndex + 1])
    : path.join(__dirname, '../data/dmm-library.json');

  // productCode が引数で指定されているかチェック（-- で始まらない最初の引数、--file の値は除く）
  const productCode = args.find((arg, i) => {
    if (arg.startsWith('--')) return false;
    if (i > 0 && args[i - 1] === '--file') return false;
    return true;
  });
  const skipMakerNameCheck = !!productCode; // productCode が指定された場合、makerName チェックをスキップ

  // ジュエル系メーカーの ID
  const jewelMakerIds = [46165, 45339, 46654]; // ジュエル、豊彦、メガハーツ

  console.log('\n' + '═'.repeat(70));
  console.log('🌐 Web から女優情報を取得');
  if (productCode) {
    console.log(`(productCode モード: ${productCode} のみ処理、makerName チェックなし)`);
  } else {
    if (jewel) {
      console.log('(--jewel モード: ジュエル系メーカーのみ処理)');
    }
    if (force) {
      console.log('(--force モード: 全アイテムを処理)');
    }
  }
  console.log('═'.repeat(70) + '\n');

  let browser;
  try {
    // productCode モード時は独立して処理（dmm-library.json に依存しない）
    if (productCode) {
      await handleProductCodeMode(productCode);
      return;
    }

    // 1. ライブラリファイルを読み込む
    const libraryFileName = path.basename(libraryFile);
    console.log(`📚 ${libraryFileName} を読み込み中...`);
    const data = JSON.parse(
      await fs.readFile(libraryFile, 'utf-8')
    );
    console.log(`   ✅ ${data.length}件のアイテムを読み込みました\n`);

    // 2. フィルタリング条件を決定
    let needsFetch;
    if (jewel) {
      if (force) {
        // --jewel --force: ジュエルメーカーのすべてのアイテムを処理（actressesの値に関わらず）
        needsFetch = data.filter(
          item =>
            jewelMakerIds.includes(item.makerId) &&
            !shouldExcludeByTitle(item.title)
        );
      } else {
        // --jewel のみ: ジュエルメーカーで未処理のアイテムを処理（actressesの値は問わず）
        needsFetch = data.filter(
          item =>
            jewelMakerIds.includes(item.makerId) &&
            (!item.isSearched || item.isSearched !== true) &&
            !shouldExcludeByTitle(item.title)
        );
      }
    } else if (force) {
      // --force のみ: actresses が空の全アイテムを処理
      needsFetch = data.filter(
        item =>
          (!item.actresses ||
           item.actresses === null ||
           (Array.isArray(item.actresses) && item.actresses.length === 0)) &&
          !shouldExcludeByTitle(item.title)
      );
    } else {
      // 通常モード: actresses が空で未処理のアイテムのみ処理
      needsFetch = data.filter(
        item =>
          (!item.actresses ||
           item.actresses === null ||
           (Array.isArray(item.actresses) && item.actresses.length === 0)) &&
          (!item.isSearched || item.isSearched !== true) &&
          !shouldExcludeByTitle(item.title)
      );
    }

    console.log(`📋 処理対象: ${needsFetch.length}件\n`);

    if (needsFetch.length === 0) {
      console.log('✅ 処理対象のアイテムがありません！\n');
      return;
    }

    // 3. ブラウザを起動
    console.log('🚀 ブラウザを起動中...');

    // システムにインストール済みのブラウザを探す
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

    try {
      browser = await puppeteer.launch({
        headless: CONFIG.headless,
        executablePath: executablePath,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
        ],
      });
      console.log('   ✅ ブラウザ起動完了\n');
    } catch (launchError) {
      console.error('❌ ブラウザ起動失敗:', launchError.message);
      console.log('   💡 対処方法:');
      if (!executablePath) {
        console.log('      - Google Chrome、Chromium、または Brave Browser をインストールしてください');
      } else {
        console.log('      - 別のブラウザウィンドウを閉じてからもう一度試してください');
      }
      process.exit(1);
    }

    // 4. 各アイテムを処理
    let successCount = 0;
    let updatedCount = 0;
    let generatedMCCount = 0;

    for (let index = 0; index < needsFetch.length; index++) {
      const item = needsFetch[index];

      console.log(
        `[${index + 1}/${needsFetch.length}] 🔍 ${item.productCode} - ${item.title.substring(0, 40)}...`
      );

      // manufacturerCode を決定
      let mc = item.manufacturerCode;
      let generatedMC = null;

      if (!mc || mc === '' || mc === 'TOP100' || (mc && /^BEST\d+$/.test(mc))) {
        // manufacturerCode がない場合、TOP100 の場合、または BEST[0-9]+ の場合は生成
        generatedMC = generateManufacturerCode(item.productCode);
        if (!generatedMC) {
          console.log('   ⚠️  Manufacturer Code を生成できません\n');
          continue;
        }
        mc = generatedMC;
        console.log(`   📝 MC 生成: ${mc}`);
      } else {
        mc = mc.toLowerCase();
        console.log(`   📝 MC: ${mc}`);
      }

      // 新しいページを作成（前のページを閉じる）
      let page;
      try {
        page = await browser.newPage();
        await page.setViewport({ width: 1280, height: 720 });

        // 優先順位: avwikidb.com → av-wiki.net → adult-wiki.net → shiroutowiki.work → jav321.com
        console.log('   🌐 avwikidb.com から取得中...');
        const avwikidbResult = await fetchFromAvwikidb(mc, page);
        console.log(`     📊 ${avwikidbResult.actresses.length}件`);

        // メーカー名の不一致をチェック（productCode モードではチェックしない）
        if (!skipMakerNameCheck && avwikidbResult.actresses.length > 0 && avwikidbResult.makerName &&
            item.makerName && avwikidbResult.makerName !== item.makerName) {
          const avwikidbUrl = `${CONFIG.avwikidb}/${mc}/`;
          await appendSuspiciousLog(
            item.productCode,
            item.makerName,
            avwikidbResult.makerName,
            'avwikidb',
            avwikidbResult.actresses,
            avwikidbUrl
          );
        }

        let result = {
          source: 'avwikidb',
          actresses: avwikidbResult.actresses,
          count: avwikidbResult.actresses.length,
        };

        // avwikidb に見つからない場合は av-wiki.net を検索
        if (result.count === 0) {
          console.log('   🌐 av-wiki.net から取得中...');
          const avwikiResult = await fetchFromAvWiki(mc, page);
          console.log(`     📊 ${avwikiResult.actresses.length}件`);

          // メーカー名の不一致をチェック（productCode モードではチェックしない）
          if (!skipMakerNameCheck && avwikiResult.actresses.length > 0 && avwikiResult.makerName &&
              item.makerName && avwikiResult.makerName !== item.makerName) {
            const avwikiUrl = `${CONFIG.avwiki}/${mc}/`;
            await appendSuspiciousLog(
              item.productCode,
              item.makerName,
              avwikiResult.makerName,
              'av-wiki.net',
              avwikiResult.actresses,
              avwikiUrl
            );
          }

          result = {
            source: 'av-wiki.net',
            actresses: avwikiResult.actresses,
            count: avwikiResult.actresses.length,
          };
        }

        // av-wiki.net にも見つからない場合は productCode（小文字化）で再試行
        if (result.count === 0) {
          console.log('   🌐 av-wiki.net から再取得中（productCode）...');
          const avwikiResultProductCode = await fetchFromAvWiki(item.productCode.toLowerCase(), page);
          console.log(`     📊 ${avwikiResultProductCode.actresses.length}件`);

          // メーカー名の不一致をチェック（productCode モードではチェックしない）
          if (!skipMakerNameCheck && avwikiResultProductCode.actresses.length > 0 && avwikiResultProductCode.makerName &&
              item.makerName && avwikiResultProductCode.makerName !== item.makerName) {
            const avwikiUrl = `${CONFIG.avwiki}/${item.productCode.toLowerCase()}/`;
            await appendSuspiciousLog(
              item.productCode,
              item.makerName,
              avwikiResultProductCode.makerName,
              'av-wiki.net',
              avwikiResultProductCode.actresses,
              avwikiUrl
            );
          }

          if (avwikiResultProductCode.actresses.length > 0) {
            result = {
              source: 'av-wiki.net',
              actresses: avwikiResultProductCode.actresses,
              count: avwikiResultProductCode.actresses.length,
            };
          }
        }

        // av-wiki.net にも見つからない場合のみ adult-wiki.net を検索
        if (result.count === 0) {
          console.log('   🌐 adult-wiki.net から取得中...');
          const adultwikiResult = await fetchFromAdultWiki(item.productCode, page);
          console.log(`     📊 ${adultwikiResult.actresses.length}件`);

          // メーカー名の不一致をチェック（productCode モードではチェックしない）
          if (!skipMakerNameCheck && adultwikiResult.actresses.length > 0 && adultwikiResult.makerName &&
              item.makerName && adultwikiResult.makerName !== item.makerName) {
            const adultwikiUrl = `${CONFIG.adultwiki}?keyword=${encodeURIComponent(item.productCode)}`;
            await appendSuspiciousLog(
              item.productCode,
              item.makerName,
              adultwikiResult.makerName,
              'adult-wiki.net',
              adultwikiResult.actresses,
              adultwikiUrl
            );
          }

          result = {
            source: 'adult-wiki.net',
            actresses: adultwikiResult.actresses,
            count: adultwikiResult.actresses.length,
          };
        }

        // adult-wiki.net にも見つからない場合のみ shiroutowiki.work を検索
        if (result.count === 0) {
          console.log('   🌐 shiroutowiki.work から取得中...');
          const shiroutozResult = await fetchFromShiroutowiki(item.productCode, page);
          console.log(`     📊 ${shiroutozResult.actresses.length}件`);

          // メーカー名の不一致をチェック（productCode モードではチェックしない）
          if (!skipMakerNameCheck && shiroutozResult.actresses.length > 0 && shiroutozResult.makerName &&
              item.makerName && shiroutozResult.makerName !== item.makerName) {
            const shiroutozUrl = `${CONFIG.shiroutowiki}/${item.productCode.toLowerCase()}/`;
            await appendSuspiciousLog(
              item.productCode,
              item.makerName,
              shiroutozResult.makerName,
              'shiroutowiki.work',
              shiroutozResult.actresses,
              shiroutozUrl
            );
          }

          result = {
            source: 'shiroutowiki.work',
            actresses: shiroutozResult.actresses,
            count: shiroutozResult.actresses.length,
          };
        }

        // shiroutowiki.work にも見つからない場合のみ jav321.com を検索
        if (result.count === 0) {
          console.log('   🌐 jav321.com から取得中...');
          const jav321Result = await fetchFromJav321(item.productCode, browser);
          console.log(`     📊 ${jav321Result.actresses.length}件`);
          console.log(`     🔗 ${jav321Result.url}`);

          // メーカー名の不一致をチェック（productCode モードではチェックしない）
          if (!skipMakerNameCheck && jav321Result.actresses.length > 0 && jav321Result.makerName &&
              item.makerName && jav321Result.makerName !== item.makerName) {
            await appendSuspiciousLog(
              item.productCode,
              item.makerName,
              jav321Result.makerName,
              'jav321.com',
              jav321Result.actresses,
              jav321Result.url
            );
          }

          result = {
            source: 'jav321.com',
            actresses: jav321Result.actresses,
            count: jav321Result.actresses.length,
          };
        }

        // アイテムを更新
        if (result.count > 0) {
          item.actresses = result.actresses;
          updatedCount++;

          // 生成した MC を保存（データが見つかった場合のみ）
          if (generatedMC && !item.manufacturerCode) {
            item.manufacturerCode = generatedMC;
            generatedMCCount++;
          }

          console.log(
            `   ✅ 採用: ${result.source} (${result.actresses.join(', ')})`
          );
        } else {
          console.log('   ⚠️  データが見つかりません');
        }

        // 処理完了フラグを設定
        item.isSearched = true;
        successCount++;

        console.log('');

        // Rate limiting
        if (index < needsFetch.length - 1) {
          await sleep(CONFIG.rateLimit);
        }
      } finally {
        if (page) {
          await page.close();
        }
      }
    }

    // 5. ライブラリファイルに保存
    console.log(`💾 ${path.basename(libraryFile)} に保存中...`);
    await fs.writeFile(
      libraryFile,
      JSON.stringify(data, null, 2),
      'utf-8'
    );
    console.log('   ✅ 保存完了\n');

    // 統計情報を表示
    console.log('═'.repeat(70));
    console.log('📊 実行結果');
    console.log('═'.repeat(70));
    console.log(`  処理対象:       ${needsFetch.length}件`);
    console.log(`  成功:          ${successCount}件`);
    console.log(`  女優情報更新:   ${updatedCount}件`);
    console.log(`  MC 生成:       ${generatedMCCount}件`);
    console.log('');
  } catch (error) {
    console.error('❌ エラーが発生しました:', error.message);
    process.exit(1);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// =====================================================================
// Execution
// =====================================================================

main().catch(error => {
  console.error('❌ 予期しないエラーが発生しました:', error);
  process.exit(1);
});
