const http = require('http');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const contentsDir = path.join(__dirname, '../contents');
const dbPath = path.join(__dirname, '../data/actresses.db');

// SQLite データベース（女優別名検索用）
let db = null;
if (fs.existsSync(dbPath)) {
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('Failed to open actresses.db:', err);
            db = null;
        }
    });
}

/**
 * リクエストボディをJSONとしてパース
 */
function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString()));
            } catch (e) {
                reject(new Error('Invalid JSON'));
            }
        });
        req.on('error', reject);
    });
}

/**
 * JSONレスポンスを返す
 */
function jsonResponse(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

const PORT = 8000;
const ALLOWED_ORIGINS = new Set([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
]);

/**
 * Origin / Host を検証する。
 * - GET: Origin 未設定（同一オリジン直接アクセス）も許可
 * - POST: Origin が ALLOWED_ORIGINS に一致する必要あり（CSRF対策）
 */
function validateOrigin(req, requirePost) {
    const origin = req.headers.origin;
    if (requirePost) {
        return origin && ALLOWED_ORIGINS.has(origin);
    }
    return !origin || ALLOWED_ORIGINS.has(origin);
}

/**
 * </script> や </ で始まるシーケンスをエスケープして JS リテラルに安全に埋め込む。
 */
function safeJsonForScript(value) {
    return JSON.stringify(value, null, 2)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

const server = http.createServer(async (req, res) => {
    // CORS ヘッダー（localhost のみ許可）
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // OPTIONS リクエストへの対応
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // ---- 女優別名検索 API ----

    // GET /search?alias=<value> - 別名からメイン名を検索
    if (req.method === 'GET' && req.url.startsWith('/search')) {
        const url = new URL(req.url, 'http://localhost');
        const alias = url.searchParams.get('alias');
        if (!alias) {
            jsonResponse(res, 400, { error: 'Bad Request', message: 'Query parameter "alias" is required' });
            return;
        }
        if (!db) {
            jsonResponse(res, 503, { error: 'Service Unavailable', message: 'Database not found' });
            return;
        }
        db.all(
            `SELECT DISTINCT a.id, a.main_name, a.page_url
             FROM actresses a
             JOIN aliases al ON a.id = al.actress_id
             WHERE al.alias_name = ?`,
            [alias],
            (err, rows) => {
                if (err) {
                    jsonResponse(res, 500, { error: 'Internal Server Error', message: err.message });
                    return;
                }
                if (!rows || rows.length === 0) {
                    jsonResponse(res, 404, { message: 'No actresses found with this alias', alias, results: [] });
                    return;
                }
                jsonResponse(res, 200, { alias, count: rows.length, results: rows });
            }
        );
        return;
    }

    // GET /details?name=<value> - メイン名から詳細情報を取得
    if (req.method === 'GET' && req.url.startsWith('/details')) {
        const url = new URL(req.url, 'http://localhost');
        const name = url.searchParams.get('name');
        if (!name) {
            jsonResponse(res, 400, { error: 'Bad Request', message: 'Query parameter "name" is required' });
            return;
        }
        if (!db) {
            jsonResponse(res, 503, { error: 'Service Unavailable', message: 'Database not found' });
            return;
        }
        db.get(
            'SELECT id, main_name, page_url FROM actresses WHERE main_name = ?',
            [name],
            (err, actress) => {
                if (err) {
                    jsonResponse(res, 500, { error: 'Internal Server Error', message: err.message });
                    return;
                }
                if (!actress) {
                    jsonResponse(res, 404, { message: 'Actress not found', name });
                    return;
                }
                db.all(
                    'SELECT alias_name FROM aliases WHERE actress_id = ? ORDER BY alias_name',
                    [actress.id],
                    (err2, rows) => {
                        if (err2) {
                            jsonResponse(res, 500, { error: 'Internal Server Error', message: err2.message });
                            return;
                        }
                        const aliases = rows.map(r => r.alias_name);
                        jsonResponse(res, 200, {
                            id: actress.id,
                            main_name: actress.main_name,
                            page_url: actress.page_url,
                            aliases,
                            alias_count: aliases.length
                        });
                    }
                );
            }
        );
        return;
    }

    // GET /list - 全女優リストを取得
    if (req.method === 'GET' && req.url === '/list') {
        if (!db) {
            jsonResponse(res, 503, { error: 'Service Unavailable', message: 'Database not found' });
            return;
        }
        db.all(
            'SELECT id, main_name, page_url FROM actresses ORDER BY main_name',
            [],
            (err, rows) => {
                if (err) {
                    jsonResponse(res, 500, { error: 'Internal Server Error', message: err.message });
                    return;
                }
                jsonResponse(res, 200, { count: rows.length, actresses: rows });
            }
        );
        return;
    }

    // ---- API エンドポイント ----

    // POST /api/tag-definitions - タグ定義を保存
    if (req.method === 'POST' && req.url === '/api/tag-definitions') {
        if (!validateOrigin(req, true)) {
            jsonResponse(res, 403, { success: false, error: 'Forbidden: invalid Origin' });
            return;
        }
        try {
            const body = await parseBody(req);
            const filePath = path.join(contentsDir, 'tag-definitions.json');
            fs.writeFileSync(filePath, JSON.stringify(body, null, 2), 'utf-8');

            // tag-definitions-data.js も同時更新してリロード後も定義が消えないようにする
            const tagDefsDataPath = path.join(contentsDir, 'tag-definitions-data.js');
            fs.writeFileSync(tagDefsDataPath, `const TAG_DEFINITIONS = ${safeJsonForScript(body)};`, 'utf-8');

            jsonResponse(res, 200, { success: true });
        } catch (e) {
            jsonResponse(res, 400, { success: false, error: e.message });
        }
        return;
    }

    // POST /api/tags/bulk - タグを一括割り当て/解除
    if (req.method === 'POST' && req.url === '/api/tags/bulk') {
        if (!validateOrigin(req, true)) {
            jsonResponse(res, 403, { success: false, error: 'Forbidden: invalid Origin' });
            return;
        }
        try {
            const { productCodes, addTags, removeTags } = await parseBody(req);
            const filePath = path.join(contentsDir, 'tags.json');

            // 既存データ読み込み
            let tags = {};
            try {
                tags = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            } catch { /* ファイルなければ空 */ }

            // prototype pollution 対策: __proto__ / constructor / prototype を弾く
            const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

            // 各 productCode に対してタグを追加/削除
            for (const code of productCodes) {
                if (typeof code !== 'string' || FORBIDDEN_KEYS.has(code)) continue;
                let itemTags = Object.prototype.hasOwnProperty.call(tags, code) ? tags[code] : [];

                // タグ追加
                if (addTags && addTags.length > 0) {
                    for (const tag of addTags) {
                        if (!itemTags.includes(tag)) {
                            itemTags.push(tag);
                        }
                    }
                }

                // タグ削除
                if (removeTags && removeTags.length > 0) {
                    itemTags = itemTags.filter(t => !removeTags.includes(t));
                }

                // 空なら削除、そうでなければ更新
                if (itemTags.length === 0) {
                    delete tags[code];
                } else {
                    tags[code] = itemTags;
                }
            }

            fs.writeFileSync(filePath, JSON.stringify(tags, null, 2), 'utf-8');

            // tags-data.js も同時更新してリロード後もタグが消えないようにする
            const tagsDataPath = path.join(contentsDir, 'tags-data.js');
            fs.writeFileSync(tagsDataPath, `const TAGS = ${safeJsonForScript(tags)};`, 'utf-8');

            jsonResponse(res, 200, { success: true, tags });
        } catch (e) {
            jsonResponse(res, 400, { success: false, error: e.message });
        }
        return;
    }

    // ---- Hey動画プレイヤーページ ----

    // GET /heydouga/play/:productCode
    // V-RACK は iframe 専用アプリ（postMessage で親とハンドシェイク）のため、
    // 302 リダイレクトではなく V-RACK を iframe 埋め込みした HTML を返す
    const heydougaMatch = req.method === 'GET' && req.url.match(/^\/heydouga\/play\/([A-Za-z0-9_\-]+)$/);
    if (heydougaMatch) {
        const productCode = heydougaMatch[1];
        const cookiesPath = path.join(__dirname, '../data/heydouga-cookies.json');
        try {
            const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
            const netiA = (cookies.find(c => c.name === 'NetiA') || {}).value;
            if (!netiA) {
                res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('NetiA cookie not found. Run: npm run scrape-heydouga');
                return;
            }
            // heydouga.com が V-RACK iframe に渡す形式を再現:
            // hash = encodeURIComponent("site=heydouga&theme=dark&NetiA=TOKEN&...")
            const params = [
                'site=heydouga',
                'theme=dark',
                `NetiA=${netiA}`,
                'NetiI=undefined',
                'isoLang=ja',
                'xNetiPath=/d2ptb',
                'xNetiDomain=www.heydouga.com',
                'zMin=10',
                'zMax=5000',
            ].join('&');
            const vrackUrl = `https://api.vrack.me/iframe.html/movies/${productCode}#${encodeURIComponent(params)}`;

            // V-RACK は親フレームとの postMessage ハンドシェイクを必要とする。
            // heydouga.com の実際の応答シーケンスを再現する:
            // 1. {"type":"call"} 受信 → {"type":"reply"} 返す
            // 2. {"type":"analytics","action":"Launch"} (basic)
            // 3. {"type":"analytics","action":"Launch", palette付き}
            // 4. {"type":"show"}
            const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>V-RACK Player</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #000; width: 100vw; height: 100vh; overflow: hidden; }
    iframe { width: 100%; height: 100%; border: none; display: block; }

    /* オーバーレイメッセージ */
    #message-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.7);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    #message-content {
      background: #1a1a1a;
      border: 2px solid #02d7f2;
      border-radius: 8px;
      padding: 40px;
      text-align: center;
      color: #fff;
      max-width: 500px;
      box-shadow: 0 0 20px rgba(2, 215, 242, 0.3);
    }

    #message-content h2 {
      color: #02d7f2;
      margin-bottom: 20px;
      font-size: 24px;
    }

    #message-content p {
      margin: 15px 0;
      font-size: 16px;
      line-height: 1.6;
    }

    #message-content .instruction {
      background: rgba(2, 215, 242, 0.1);
      padding: 20px;
      border-radius: 4px;
      margin-top: 20px;
      border-left: 3px solid #02d7f2;
    }

    #message-content .step {
      display: flex;
      align-items: center;
      margin: 10px 0;
      justify-content: center;
    }

    #message-content .step-number {
      display: inline-block;
      width: 30px;
      height: 30px;
      background: #02d7f2;
      color: #000;
      border-radius: 50%;
      text-align: center;
      line-height: 30px;
      margin-right: 10px;
      font-weight: bold;
    }

    #close-button {
      margin-top: 25px;
      padding: 12px 30px;
      background: #02d7f2;
      color: #000;
      border: none;
      border-radius: 4px;
      font-size: 16px;
      font-weight: bold;
      cursor: pointer;
      transition: all 0.3s;
    }

    #close-button:hover {
      background: #00b0d0;
      transform: scale(1.05);
    }

    #message-overlay.hidden {
      display: none;
    }
  </style>
</head>
<body>
  <iframe id="vrack" src="${vrackUrl}" allow="autoplay; fullscreen" allowfullscreen></iframe>

  <div id="message-overlay">
    <div id="message-content">
      <h2>🎬 V-RACK 初期化中</h2>
      <p>プレイヤーを使用する前に、以下の手順を実行してください：</p>
      <div class="instruction">
        <div class="step">
          <span class="step-number">1</span>
          <span>右下の <strong>V-RACK ロゴ</strong> をクリック</span>
        </div>
        <div class="step">
          <span class="step-number">2</span>
          <span><strong>Moviesタブ</strong> をクリック</span>
        </div>
        <div class="step">
          <span class="step-number">3</span>
          <span>動画リストが表示されます</span>
        </div>
      </div>
      <button id="close-button">了解しました</button>
    </div>
  </div>

  <script>
    const iframe = document.getElementById('vrack');
    const messageOverlay = document.getElementById('message-overlay');
    const closeButton = document.getElementById('close-button');
    const VRACK_ORIGIN = 'https://api.vrack.me';
    const HREF = 'https://www.heydouga.com/';
    const PALETTE = {
      primary:   { main: '#02d7f2', contrast: '#000000' },
      secondary: { main: '#ffee08', contrast: '#000000' },
      surfaces:  { dark: '#21272a', main: '#293034', light: '#343a3f', contrast: '#ffffff' },
      minor:     { main: '#f51e80', contrast: '#ffffff' },
      error:     { main: '#ea232e' },
      success:   { main: '#4c9f70' }
    };

    function send(data) {
      iframe.contentWindow.postMessage(data, VRACK_ORIGIN);
    }

    // メッセージを非表示にする
    function hideMessage() {
      messageOverlay.classList.add('hidden');
    }

    closeButton.addEventListener('click', hideMessage);

    // Escキーでも非表示に
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideMessage();
    });

    window.addEventListener('message', function(e) {
      if (e.origin !== VRACK_ORIGIN) return;
      const msg = e.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'call') {
        // heydouga.com が {"type":"call"} に対して送る実際のシーケンス
        send({ type: 'reply',     payload: { origin: 'https://www.heydouga.com' }, href: HREF });
        send({ type: 'analytics', payload: { action: 'Launch' }, href: HREF });
        send({ type: 'analytics', payload: { action: 'Launch', isGiftAdded: true, shouldNotify: false, palette: PALETTE, code: 'ja' }, href: HREF });
        send({ type: 'show',      payload: {}, href: HREF });

        // V-RACK 初期化完了後、ダイアログを自動消去
        setTimeout(() => {
          hideMessage();
        }, 500);
      }
    });
  </script>
</body>
</html>`;

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(html);
        } catch (e) {
            res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('heydouga-cookies.json not found. Run: npm run scrape-heydouga');
        }
        return;
    }

    // ---- 静的ファイルサーブ ----

    let pathname;
    try {
        pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;
    } catch {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
    }
    if (pathname === '/') pathname = '/viewer.html';

    const requested = path.resolve(contentsDir, '.' + pathname);
    if (requested !== contentsDir && !requested.startsWith(contentsDir + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }

    fs.readFile(requested, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not Found');
            return;
        }

        // Content-Type を自動判定
        let contentType = 'text/html';
        if (requested.endsWith('.json')) {
            contentType = 'application/json';
        } else if (requested.endsWith('.js')) {
            contentType = 'application/javascript';
        } else if (requested.endsWith('.css')) {
            contentType = 'text/css';
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`🌐 HTTPサーバー起動: http://localhost:${PORT}/viewer.html`);
    console.log(`📁 提供ディレクトリ: ${contentsDir}`);
    console.log(`🔒 バインドアドレス: 127.0.0.1（localhost のみ）`);
});
