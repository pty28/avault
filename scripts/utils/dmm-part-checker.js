/**
 * DMM マイライブラリの「ストリーミング再生」part数を実ブラウザで検証するための共通ロジック。
 *
 * 背景: DMMのGraphQL API（ContentMeta）にはpart数の情報が無いため、
 * `scrape-dmm-library.js`のbuildPlayerUrlsは常に「所有productにつきpart=1のURLを1本」
 * しか生成できない。正しいpart数は、マイライブラリでカードをクリックして開く
 * モーダルの「ストリーミング再生」ボタン数と完全一致する（実データで検証済み）。
 *
 * カードの特定方法（重要）: サムネイル画像のURLからcidを推測する方式は、
 *   - pidが `〜st` のような別名形式で、サムネイルの生cidと一致しない作品
 *   - DMM側がisDiscontinued:trueとして画像を持たない（now_printingプレースホルダー）作品
 * で失敗することが実データで判明した。検索ボックスによるフォールバックも試したが、
 * 短い/汎用的なタイトル（例:「りょうちゃん」）で検索結果が複数件になり不安定だった。
 *
 * 最終的に採用した方式: 各カードのDOM要素（img等）から **React Fiber を辿って
 * コンポーネントのprops（`memoizedProps.content`）を直接読む**。ここには
 * `{ id, title, isDiscontinued, packageImage }` がAPIレスポンスそのままの形で
 * 入っており、サムネイル画像の有無や形式に一切左右されない
 * （isDiscontinued:trueでpackageImageがnullのSCPXG00001でも `id:"scpxg00001"` を
 * 正しく取得できることを実データで確認済み）。fiberの親方向(`.return`)を
 * 最大25階層まで辿る必要がある（マイライブラリのグリッド項目は「おすすめ」枠より
 * ラップ階層が深いことを確認済み）。
 */

const MYLIBRARY_BASE = 'https://video.dmm.co.jp/mylibrary/';
const FIBER_WALK_MAX_DEPTH = 25;

function parsePidAndParent(url) {
  const pidM = url.match(/pid=([^/]+)\//);
  const parentM = url.match(/parent_product_id=([^/]+)\//);
  return { pid: pidM ? pidM[1] : null, parent: parentM ? parentM[1] : null };
}

// 検証済みのURL形式(pid + parent_product_id + part=N)でpart=1..countのURLを生成する。
// 実URLナビゲーションで実際に再生できることを確認済み(15ALD00099のpart=1〜4等)。
function buildPlayerUrlsForCount(pid, parent, count) {
  return Array.from({ length: count }, (_, i) =>
    `https://www.dmm.co.jp/digital/-/player/=/player=html5/act=playlist/pid=${pid}/view_flag=1/parent_product_id=${parent}/part=${i + 1}/`
  );
}

async function getTotalPages(page) {
  await page.goto(MYLIBRARY_BASE, { waitUntil: 'networkidle2', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1200));
  const text = await page.evaluate(() => document.body.innerText);
  const m = text.match(/全(\d+)ページ中/);
  return m ? parseInt(m[1], 10) : 1;
}

// 現在ロード中のページに表示されている全カードの {id, title, isDiscontinued, x, y} を
// DOM出現順のまま返す(重複除去)。画像の有無・形式に依存しない。
async function getPageItems(page) {
  return page.evaluate((maxDepth) => {
    function extractContentFromFiber(el) {
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) return null;
      let fiber = el[fiberKey];
      for (let i = 0; i < maxDepth && fiber; i++) {
        const props = fiber.memoizedProps;
        if (props && props.content && props.content.id) {
          return {
            id: props.content.id,
            title: props.content.title,
            isDiscontinued: !!props.content.isDiscontinued,
          };
        }
        fiber = fiber.return;
      }
      return null;
    }

    const imgs = Array.from(document.querySelectorAll('img'));
    const seen = new Set();
    const items = [];
    for (const img of imgs) {
      const content = extractContentFromFiber(img);
      if (!content || seen.has(content.id)) continue;
      seen.add(content.id);
      const r = img.getBoundingClientRect();
      items.push({ ...content, x: r.x + r.width / 2, y: r.y + r.height / 2 });
    }
    return items;
  }, FIBER_WALK_MAX_DEPTH);
}

// 指定cidのカードを今の時点で再検索し、スクロール後の座標を取得する
// (座標を先にまとめて取得すると、他アイテムの処理でモーダル開閉するたびに
//  ページのレイアウトがずれて古くなり、無関係な要素をクリックしてしまう事故が
//  実際に発生したため、クリック直前に毎回cidで再検索する)
async function locateCandidate(page, cid) {
  return page.evaluate((cid, maxDepth) => {
    function extractContentFromFiber(el) {
      const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
      if (!fiberKey) return null;
      let fiber = el[fiberKey];
      for (let i = 0; i < maxDepth && fiber; i++) {
        const props = fiber.memoizedProps;
        if (props && props.content && props.content.id) {
          return {
            id: props.content.id,
            title: props.content.title,
            isDiscontinued: !!props.content.isDiscontinued,
          };
        }
        fiber = fiber.return;
      }
      return null;
    }

    const imgs = Array.from(document.querySelectorAll('img'));
    for (const img of imgs) {
      const content = extractContentFromFiber(img);
      if (content && content.id === cid) {
        img.scrollIntoView({ block: 'center' });
        const r = img.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  }, cid, FIBER_WALK_MAX_DEPTH);
}

// モーダル内の商品詳細ページへの<a href>をそのまま読む(ナビゲーションはしない、属性読み取りのみ)。
// buildItemURL(floorベースのテンプレート構築)ではなく、DMMが実際に埋め込んでいるリンクをそのまま使う。
// 注意: モーダル内のpartボタンの<a href>(digital/-/proxy/...)は絶対に直接ナビゲーションしないこと。
// 実際に動画ファイルそのもののダウンロードが発生することを実地検証で確認済み(transfer_type=download)。
// 実URLが必要な場合は必ずクリックをシミュレートしてwindow.open先を捕捉する(このファイルでは行っていない)。
async function readModalItemUrl(page) {
  return page.evaluate(() => {
    const closeBtn = document.querySelector('button[data-e2eid="close"]');
    if (!closeBtn) return null;
    const dialog = closeBtn.closest('.global-dialog') || closeBtn.parentElement.parentElement;
    if (!dialog) return null;
    const anchor = Array.from(dialog.querySelectorAll('a[href]')).find(a => /\/content\/\?id=/.test(a.href));
    return anchor ? anchor.href : null;
  });
}

async function readStreamingButtonCount(page) {
  return page.evaluate(() => {
    const allEls = Array.from(document.querySelectorAll('*'));
    const heading = allEls.find(el =>
      el.children.length === 0 && (el.textContent || '').includes('ストリーミング再生')
    );
    if (!heading) return { ok: false, reason: 'modal_heading_not_found' };
    let container = heading.parentElement;
    for (let i = 0; i < 5 && container; i++) {
      if (container.querySelectorAll('button').length >= 1) break;
      container = container.parentElement;
    }
    const allLabels = Array.from(container.querySelectorAll('button')).map(b => (b.textContent || '').trim());
    // part番号ボタンは純粋な数字のみ("1","2"...)。4K再生が不安定な場合に表示される
    // 「再生（H.264）」等の代替コーデックボタンが同じコンテナ内に入ることがあるため、
    // 数字以外のラベルは part 数に含めない。
    const labels = allLabels.filter(l => /^\d+$/.test(l));
    return { ok: true, count: labels.length, labels, allLabels };
  });
}

// ボタン描画が非同期で遅れるケースがあるため、連続2回同じ件数が読めるまでポーリングする。
// 「ストリーミング再生」見出し自体がまだ描画されていない(modal_heading_not_found)場合も、
// 実際には少し待てば現れるケースがほとんどだったため、ok:falseでも即座に諦めずリトライする。
async function countStreamingButtons(page, { maxAttempts = 10, intervalMs = 400 } = {}) {
  let prev = null;
  let lastNotOk = null;
  for (let i = 0; i < maxAttempts; i++) {
    const result = await readStreamingButtonCount(page);
    if (!result.ok) {
      lastNotOk = result;
      prev = null; // 見出しが消えた/現れていない状態なので安定判定をリセット
      await new Promise(r => setTimeout(r, intervalMs));
      continue;
    }
    if (prev !== null && prev.count === result.count) {
      return result;
    }
    prev = result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return prev || lastNotOk;
}

// モーダルが実際にDOMから消えるまで待つ(閉じるボタンを押しただけでは
// アンマウントが完了しておらず、次のモーダルを開いた際に古い「ストリーミング再生」要素が
// 残存して誤読される事故が実際に発生したため、確実に消滅を確認する)
async function closeModal(page, { maxAttempts = 15, intervalMs = 300 } = {}) {
  await page.evaluate(() => {
    const btn = document.querySelector('button[data-e2eid="close"]');
    if (btn) btn.click();
  });
  for (let i = 0; i < maxAttempts; i++) {
    const stillOpen = await page.evaluate(() =>
      document.body.innerText.includes('ストリーミング再生')
    );
    if (!stillOpen) return true;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return false; // モーダルが消えなかった(異常系。呼び出し側でリロード等のフォールバックが必要)
}

/**
 * 与えられたitems（productCode・playerUrls[0]を持つdmm-library.jsonのレコード群）について
 * マイライブラリを先頭ページから走査し、実際のpart数を検証・（信頼できる方向のみ）修正する。
 * itemのplayerUrlsを直接書き換える（呼び出し側でファイル保存すること）。
 *
 * options.onItemResult(result) は各アイテム処理直後に呼ばれる(進捗の逐次永続化用)。
 * options.shouldStop() が true を返した時点で走査を打ち切る(件数上限などに利用)。
 *
 * 戻り値: 処理した各アイテムの結果配列
 *   { productCode, ok, reason?, match?, fixed?, currentCount?, actualCount? }
 */
async function verifyAndFixPartCounts(page, items, { onItemResult, shouldStop } = {}) {
  const byCid = new Map();
  for (const item of items) {
    if (!item.productCode) continue;
    if (!Array.isArray(item.playerUrls) || item.playerUrls.length < 1) continue;
    const { pid, parent } = parsePidAndParent(item.playerUrls[0]);
    if (!pid || !parent) continue;
    byCid.set(item.productCode.toLowerCase(), { item, pid, parent });
  }
  if (byCid.size === 0) return [];

  const results = [];
  const remaining = new Set(byCid.keys());
  const totalPages = await getTotalPages(page);

  const emit = (result) => {
    results.push(result);
    if (onItemResult) onItemResult(result);
  };

  for (let pageNum = 1; pageNum <= totalPages && remaining.size > 0; pageNum++) {
    if (shouldStop && shouldStop()) break;
    await page.goto(`${MYLIBRARY_BASE}?page=${pageNum}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 1000));

    const pageItems = await getPageItems(page);
    for (const pageItem of pageItems) {
      if (!remaining.has(pageItem.id)) continue;
      if (shouldStop && shouldStop()) { remaining.delete(pageItem.id); continue; }

      const { item, pid, parent } = byCid.get(pageItem.id);
      remaining.delete(pageItem.id);

      await new Promise(r => setTimeout(r, 300));
      const point = await locateCandidate(page, pageItem.id);
      if (!point) {
        emit({ productCode: item.productCode, ok: false, reason: 'not_found_at_click_time' });
        continue;
      }
      await page.mouse.click(point.x, point.y);
      await new Promise(r => setTimeout(r, 1800));

      const countResult = await countStreamingButtons(page);
      const capturedItemUrl = await readModalItemUrl(page);
      const closed = await closeModal(page);
      if (!closed) {
        await page.goto(`${MYLIBRARY_BASE}?page=${pageNum}`, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r => setTimeout(r, 1000));
      }

      let itemUrlFixed = false;
      if (capturedItemUrl) {
        if (item.itemURL !== capturedItemUrl) {
          item.itemURL = capturedItemUrl;
          itemUrlFixed = true;
        }
      } else if (item.itemURL) {
        // モーダルが開けた(＝カードは実在する)のにitemURL用<a href>が無い場合、
        // 廃盤等でDMM側の公開詳細ページが無くなっていることを意味する(実地検証済み:
        // isDiscontinued:trueのAPKH00071・H_172VGD00048はどちらもモーダル内に
        // itemURLアンカーが無く、直接アクセスしてもstatus 200・本文空のページになる。
        // 一方playerUrls(ストリーミング再生)は引き続きアクセス可能なため別物として保持する。
        // buildItemURL(Pass 1)はisDiscontinued判定不能なためitemURLを一律生成してしまうが、
        // それはここで空に是正する(playerUrlsは触らない)。
        item.itemURL = '';
        itemUrlFixed = true;
      }

      if (!countResult.ok) {
        emit({ productCode: item.productCode, ok: false, reason: countResult.reason, itemUrlFixed });
        continue;
      }

      const currentCount = item.playerUrls.length;
      const actualCount = countResult.count;
      const match = currentCount === actualCount;
      if (match) {
        emit({ productCode: item.productCode, ok: true, match: true, currentCount, actualCount, itemUrlFixed });
      } else if (actualCount > currentCount) {
        item.playerUrls = buildPlayerUrlsForCount(pid, parent, actualCount);
        emit({ productCode: item.productCode, ok: true, match: false, fixed: true, currentCount, actualCount, itemUrlFixed });
      } else {
        emit({ productCode: item.productCode, ok: true, match: false, fixed: false, currentCount, actualCount, itemUrlFixed });
      }
    }
  }

  for (const cid of remaining) {
    const { item } = byCid.get(cid);
    emit({ productCode: item.productCode, ok: false, reason: 'not_found_in_any_page' });
  }

  return results;
}

module.exports = {
  MYLIBRARY_BASE,
  FIBER_WALK_MAX_DEPTH,
  parsePidAndParent,
  buildPlayerUrlsForCount,
  getTotalPages,
  getPageItems,
  locateCandidate,
  countStreamingButtons,
  readModalItemUrl,
  closeModal,
  verifyAndFixPartCounts,
};
