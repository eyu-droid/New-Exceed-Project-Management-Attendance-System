/**
 * Exceed Attendance — Server with API Proxy + File Logging
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3003;
const EXCEED_HOST = '196.190.220.196';
const EXCEED_PORT = 3002;
const ROOT = __dirname;
const LOG_FILE = path.join(ROOT, 'server.log');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

// ──────────────────────────────────────────
// Logging (writes to server.log AND console)
// ──────────────────────────────────────────
function log(...args) {
    const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
    process.stdout.write(line);
    fs.appendFile(LOG_FILE, line, () => { });
}

// ──────────────────────────────────────────
// CORS headers helper
// ──────────────────────────────────────────
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

// ──────────────────────────────────────────
// API Proxy
// ──────────────────────────────────────────
function proxyRequest(req, res) {
    // Collect the request body first (important for POST)
    let bodyChunks = [];
    req.on('data', chunk => bodyChunks.push(chunk));
    req.on('end', () => {
        const bodyBuffer = Buffer.concat(bodyChunks);

        const proxyHeaders = {
            'content-type': req.headers['content-type'] || 'application/json',
            'authorization': req.headers['authorization'] || '',
            'content-length': bodyBuffer.length,
            'host': `${EXCEED_HOST}:${EXCEED_PORT}`,
        };
        // Remove empty authorization
        if (!proxyHeaders['authorization']) delete proxyHeaders['authorization'];

        const options = {
            hostname: EXCEED_HOST,
            port: EXCEED_PORT,
            path: req.url,
            method: req.method,
            headers: proxyHeaders,
        };

        log(`PROXY ${req.method} ${req.url} → ${EXCEED_HOST}:${EXCEED_PORT}${req.url}`);

        const proxyReq = http.request(options, (proxyRes) => {
            log(`PROXY RESPONSE ${proxyRes.statusCode} for ${req.url}`);

            // Collect response to detect if it's JSON or HTML (SPA fallback)
            let resChunks = [];
            proxyRes.on('data', c => resChunks.push(c));
            proxyRes.on('end', () => {
                const resBody = Buffer.concat(resChunks);
                const resText = resBody.toString();
                const contentType = proxyRes.headers['content-type'] || '';

                // If Exceed returned HTML (SPA fallback = route not found), convert to JSON error
                if (contentType.includes('text/html') && resText.includes('<!DOCTYPE')) {
                    log(`PROXY WARNING: Got HTML back for ${req.url} — endpoint may not exist`);
                    res.writeHead(404, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        success: false,
                        message: `API path not found: ${req.url}. Check server.log for details.`
                    }));
                    return;
                }

                res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, ...CORS_HEADERS });
                res.end(resBody);
            });
        });

        proxyReq.on('error', (err) => {
            log(`PROXY ERROR for ${req.url}: ${err.message}`);
            res.writeHead(502, { 'Content-Type': 'application/json', ...CORS_HEADERS });
            res.end(JSON.stringify({ success: false, message: 'Could not reach the Exceed server: ' + err.message }));
        });

        proxyReq.write(bodyBuffer);
        proxyReq.end();
    });
}

// ──────────────────────────────────────────
// Debug endpoint — tests Exceed connectivity
// ──────────────────────────────────────────
function handleDebug(req, res) {
    const parsedUrl = new URL(req.url, `http://localhost`);
    const token = parsedUrl.searchParams.get('token') || '';

    // Probe these paths — both authenticated and unauthenticated
    const paths = [
        ['GET', '/api/attendance'],
        ['GET', '/api/attendances'],
        ['GET', '/api/attendance/me'],
        ['GET', '/api/attendance/mine'],
        ['GET', '/api/attendance/today'],
        ['GET', '/api/attendance/user'],
        ['GET', '/api/user/attendance'],
        ['POST', '/api/attendance/checkout'],
        ['POST', '/api/attendance/check-out'],
        ['POST', '/api/checkout'],
        ['POST', '/api/attendance'],
        ['PATCH', '/api/attendance'],
    ];

    const results = {};
    let pending = paths.length;

    function done() {
        if (--pending === 0) {
            res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
            res.end(JSON.stringify(results, null, 2));
        }
    }

    paths.forEach(([method, p]) => {
        const headers = {
            'Content-Type': 'application/json',
            'host': `${EXCEED_HOST}:${EXCEED_PORT}`,
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        // For POST/PATCH send empty JSON body
        const body = (method !== 'GET') ? '{}' : null;
        if (body) headers['Content-Length'] = Buffer.byteLength(body);

        const probeReq = http.request(
            { hostname: EXCEED_HOST, port: EXCEED_PORT, path: p, method, headers },
            (r) => {
                let rawBody = '';
                r.on('data', d => rawBody += d);
                r.on('end', () => {
                    const isHtml = rawBody.includes('<!DOCTYPE');
                    results[`${method} ${p}`] = {
                        status: r.statusCode,
                        type: isHtml ? 'HTML (path not found)' : 'JSON ✅',
                        body: isHtml ? '—' : rawBody.slice(0, 200),
                    };
                    log(`DEBUG: ${method} ${p} → ${r.statusCode} (${isHtml ? 'HTML' : 'JSON'})`);
                    done();
                });
            }
        );
        probeReq.on('error', e => {
            results[`${method} ${p}`] = { error: e.message };
            done();
        });
        if (body) probeReq.write(body);
        probeReq.end();
    });
}


// ──────────────────────────────────────────
// Static file server
// ──────────────────────────────────────────
function serveStatic(req, res) {
    let urlPath = url.parse(req.url).pathname;
    if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

    const filePath = path.join(ROOT, urlPath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';

    if (!filePath.startsWith(ROOT)) {
        res.writeHead(403); res.end('Forbidden'); return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File not found: ' + urlPath);
            return;
        }
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
        res.end(data);
    });
}

// ──────────────────────────────────────────
// Main server
// ──────────────────────────────────────────
const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    if (req.url.startsWith('/debug')) {
        handleDebug(req, res);
    } else if (req.url.startsWith('/api/')) {
        proxyRequest(req, res);
    } else {
        serveStatic(req, res);
    }
});

server.listen(PORT, '0.0.0.0', () => {
    log(`✅ Exceed Attendance running on port ${PORT}`);
    log(`   Open: http://localhost:${PORT}`);
    log(`   Debug: http://localhost:${PORT}/debug`);
    log(`   Log file: ${LOG_FILE}`);
});

server.on('error', (err) => {
    log('SERVER ERROR: ' + err.message);
    process.exit(1);
});
