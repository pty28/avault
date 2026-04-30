const https = require('https');
const fs = require('fs').promises;
const path = require('path');

/**
 * dmm-library.jsonの作品に対して、DMM APIから女優名を取得
 */

// 環境変数からAPI IDを取得
const API_ID = process.env.DMM_API_ID;
const AFFILIATE_ID = process.env.DMM_AFFILIATES_ID;
const RATE_LIMIT_DELAY = 1000; // API呼び出し間隔（ミリ秒）

// API IDが設定されていない場合はエラー
if (!API_ID || !AFFILIATE_ID) {
  console.error('❌ エラー: 必要な環境変数が設定されていません');
  if (!API_ID) console.error('   - DMM_API_ID が未設定です');
  if (!AFFILIATE_ID) console.error('   - DMM_AFFILIATES_ID が未設定です');
  console.log('\n💡 使用方法:');
  console.log('   DMM_API_ID=your_api_id DMM_AFFILIATES_ID=your_affiliate_id npm run fetch-actresses');
  console.log('\nまたは、環境変数を設定してください:');
  console.log('   export DMM_API_ID=your_api_id');
  console.log('   export DMM_AFFILIATES_ID=your_affiliate_id');
  process.exit(1);
}

function callDmmApi(cid, floor = 'videoa') {
  return new Promise((resolve, reject) => {
    // 作品コードを小文字に変換（DMM APIは小文字を要求）
    const cidLower = cid.toLowerCase();
    const url = `https://api.dmm.com/affiliate/v3/ItemList?api_id=${API_ID}&affiliate_id=${AFFILIATE_ID}&site=FANZA&service=digital&floor=${floor}&cid=${cidLower}&output=json`;

    https.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (error) {
          reject(new Error(`JSON parse error: ${error.message}`));
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 女優名をクリーニング：括弧内の別名を削除
 * - Alice（鈴木ありす）のみ特別処理で鈴木ありすに変換
 * - その他は括弧内の内容を削除（）がない場合も対応）
 */
function cleanActressName(name) {
  if (!name) return name;

  // Alice（...）の場合、括弧内を採用
  if (name.includes('Alice')) {
    const match = name.match(/Alice（(.+)）?/);
    if (match && match[1]) {
      return match[1];
    }
  }

  // 括弧の位置で分割（）があってもなくても対応）
  if (name.includes('（')) {
    return name.split('（')[0];
  }

  return name;
}

/**
 * 女優名の配列をクリーニング
 */
function cleanActresses(actresses) {
  if (!Array.isArray(actresses)) {
    return [];
  }

  return actresses.map(name => cleanActressName(name)).filter(name => name.length > 0);
}

async function fetchActressForItem(item, index, total) {
  // itemURL フィールドが存在しない場合は追加
  if (!item.hasOwnProperty('itemURL')) {
    item.itemURL = '';
  }

  // isFetched フィールドが存在しない場合は追加
  if (!item.hasOwnProperty('isFetched')) {
    item.isFetched = false;
  }

  // isShirouto フィールドが存在しない場合は追加
  if (!item.hasOwnProperty('isShirouto')) {
    item.isShirouto = false;
  }

  if (!item.productCode) {
    console.log(`[${index + 1}/${total}] ⏭️  作品コードなし: ${item.title.substring(0, 40)}...`);
    return {
      ...item,
      isFetched: true,
      isShirouto: false,
    };
  }

  try {
    console.log(`[${index + 1}/${total}] 🔍 ${item.productCode} - ${item.title.substring(0, 40)}...`);

    // まず videoa で試す
    let result = await callDmmApi(item.productCode, 'videoa');

    if (result.result && result.result.status === 200 && result.result.items && result.result.items.length > 0) {
      const apiItem = result.result.items[0];

      let actresses = (apiItem.iteminfo && apiItem.iteminfo.actress && apiItem.iteminfo.actress.length > 0)
        ? apiItem.iteminfo.actress.map(a => a.name)
        : [];
      actresses = cleanActresses(actresses);
      const itemURL = apiItem.URL || '';

      if (actresses.length > 0) {
        console.log(`   ✅ [videoa] 女優: ${actresses.join(', ')}`);
      } else {
        console.log(`   ℹ️  [videoa] 女優情報なし`);
      }

      return {
        ...item,
        actresses: actresses,
        itemURL: itemURL,
        isFetched: true,
        isShirouto: false,
      };
    } else {
      // videoa で結果がない場合、videoc で試す
      console.log(`   ⚠️  [videoa] API結果なし - videoc で再試行...`);

      result = await callDmmApi(item.productCode, 'videoc');

      if (result.result && result.result.status === 200 && result.result.items && result.result.items.length > 0) {
        const apiItem = result.result.items[0];

        let actresses = (apiItem.iteminfo && apiItem.iteminfo.actress && apiItem.iteminfo.actress.length > 0)
          ? apiItem.iteminfo.actress.map(a => a.name)
          : [];
        actresses = cleanActresses(actresses);
        const itemURL = apiItem.URL || '';

        if (actresses.length > 0) {
          console.log(`   ✅ [videoc] 女優: ${actresses.join(', ')}`);
        } else {
          console.log(`   ℹ️  [videoc] 女優情報なし`);
        }

        return {
          ...item,
          actresses: actresses,
          itemURL: itemURL,
          isFetched: true,
          isShirouto: true,
        };
      } else {
        console.log(`   ⚠️  [videoc] API結果なし`);

        // 作品コードに "00" が含まれている場合、最初の1つを削除して videoa で再試行
        if (item.productCode.includes('00')) {
          const modifiedCode = item.productCode.replace(/00/, '');
          console.log(`   🔄 作品コードを修正して videoa で再試行: ${item.productCode} → ${modifiedCode}`);

          result = await callDmmApi(modifiedCode, 'videoa');

          if (result.result && result.result.status === 200 && result.result.items && result.result.items.length > 0) {
            const apiItem = result.result.items[0];

            let actresses = (apiItem.iteminfo && apiItem.iteminfo.actress && apiItem.iteminfo.actress.length > 0)
              ? apiItem.iteminfo.actress.map(a => a.name)
              : [];
            actresses = cleanActresses(actresses);
            const itemURL = apiItem.URL || '';

            if (actresses.length > 0) {
              console.log(`   ✅ [videoa-modified] 女優: ${actresses.join(', ')}`);
            } else {
              console.log(`   ℹ️  [videoa-modified] 女優情報なし`);
            }

            return {
              ...item,
              actresses: actresses,
              itemURL: itemURL,
              isFetched: true,
              isShirouto: false,
            };
          } else {
            console.log(`   ⚠️  [videoa-modified] API結果なし`);
          }
        }

        // すべての試行で結果がない場合でも itemURL を空で追加し、isFetchedをtrueに設定
        return {
          ...item,
          itemURL: item.itemURL || '',
          isFetched: true,
          isShirouto: false,
        };
      }
    }

  } catch (error) {
    console.log(`   ❌ エラー: ${error.message}`);

    // エラーの場合でも itemURL を空で追加し、isFetchedをtrueに設定
    return {
      ...item,
      itemURL: item.itemURL || '',
      isFetched: true,
      isShirouto: false,
    };
  }
}

async function main() {
  console.log('🚀 女優名取得スクリプトを開始します\n');

  try {
    // dmm-library.json を読み込み
    const data = JSON.parse(await fs.readFile(path.join(__dirname, '../data/dmm-library.json'), 'utf-8'));
    console.log(`📚 ${data.length}件の作品を読み込みました\n`);

    const withCode = data.filter(item => item.productCode);
    const withoutCode = data.filter(item => !item.productCode);
    const alreadyHasActress = data.filter(item => item.actresses && item.actresses.length > 0);
    const needsFetch = data.filter(item =>
      item.productCode &&
      (!item.actresses || item.actresses.length === 0) &&
      (!item.hasOwnProperty('isFetched') || item.isFetched === false)
    );

    console.log(`   作品コードあり: ${withCode.length}件`);
    console.log(`   作品コードなし: ${withoutCode.length}件`);
    console.log(`   女優情報あり（スキップ）: ${alreadyHasActress.length}件`);
    console.log(`   取得が必要: ${needsFetch.length}件\n`);

    if (needsFetch.length === 0) {
      console.log('✨ すべての作品に女優情報が既に存在します！');
      return;
    }

    console.log('📥 DMM APIから女優名を取得しています...\n');

    const updatedItems = [];
    let processedCount = 0;

    for (let i = 0; i < data.length; i++) {
      const item = data[i];

      // 既に女優情報がある場合はスキップ
      if (item.actresses && item.actresses.length > 0) {
        console.log(`[${i + 1}/${data.length}] ⏭️  スキップ: ${item.title.substring(0, 40)}... (女優情報あり)`);
        updatedItems.push(item);
        continue;
      }

      // 既にAPI取得済み（isFetched = true）の場合はスキップ
      if (item.hasOwnProperty('isFetched') && item.isFetched === true) {
        console.log(`[${i + 1}/${data.length}] ⏭️  スキップ: ${item.title.substring(0, 40)}... (取得済み)`);
        updatedItems.push(item);
        continue;
      }

      // APIから取得
      const updatedItem = await fetchActressForItem(item, i, data.length);
      updatedItems.push(updatedItem);
      processedCount++;

      // レート制限を守るため待機
      if (processedCount < needsFetch.length) {
        await sleep(RATE_LIMIT_DELAY);
      }
    }

    // 結果を保存（インプットファイルと同じファイルに上書き）
    console.log('\n💾 結果を保存しています...');
    await fs.writeFile(path.join(__dirname, '../data/dmm-library.json'), JSON.stringify(updatedItems, null, 2), 'utf-8');

    // 統計情報
    const withActresses = updatedItems.filter(item => item.actresses && item.actresses.length > 0);

    console.log('\n✅ 完了！\n');
    console.log('📊 統計:');
    console.log(`   総作品数: ${updatedItems.length}件`);
    console.log(`   女優情報あり: ${withActresses.length}件`);
    console.log(`   女優情報なし: ${updatedItems.length - withActresses.length}件`);
    console.log(`   API呼び出し回数: ${processedCount}件`);
    console.log(`\n💾 保存先: dmm-library.json`);

  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error('❌ エラー: dmm-library.json が見つかりません');
      console.log('💡 先に npm run scrape を実行してください');
    } else {
      console.error('❌ エラーが発生しました:', error.message);
      console.error('   スタック:', error.stack);
    }
    process.exit(1);
  }
}

main();
