/**
 * Exceed Attendance — Server with API Proxy + File Logging
 *
 * Modified to implement local /api/attendance checkin/checkout handlers that
 * store attendance records to a local JSON file (data/attendance.json).
 * If an Authorization header (Bearer token) is present we will try to
 * resolve the current user by calling the upstream /api/users/me endpoint
 * and use the returned id for per-user records. This allows the front-end
 * to keep using the same token while attendance is stored locally.
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
const DATA_DIR = path.join(ROOT, 'data');
const ATT_FILE = path.join(DATA_DIR, 'attendance.json');

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
// Simple file-backed attendance store helpers
// ──────────────────────────────────────────
function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
    if (!fs.existsSync(ATT_FILE)) fs.writeFileSync(ATT_FILE, '[]');
}

function readAttendance() {
    ensureDataDir();
    try {
        const raw = fs.readFileSync(ATT_FILE, 'utf8');
        return JSON.parse(raw || '[]');
    } catch (e) {
        log('ERROR reading attendance file:', e.message);
        return [];
    }
}

function writeAttendance(records) {
    ensureDataDir();
    try {
        fs.writeFileSync(ATT_FILE, JSON.stringify(records, null, 2));
    } catch (e) {
        log('ERROR writing attendance file:', e.message);
    }
}

// Helper: fetch upstream /api/users/me to determine user identity (if token present)
function fetchUpstreamUser(authHeader) {
    return new Promise((resolve) => {
        if (!authHeader) return resolve(null);
        const headers = { 'Content-Type': 'application/json', 'host': `${EXCEED_HOST}:${EXCEED_PORT}` };
        headers['Authorization'] = authHeader;

        const req = http.request({ hostname: EXCEED_HOST, port: EXCEED_PORT, path: '/api/users/me', method: 'GET', headers }, (r) => {
            let raw = '';
            r.on('data', d => raw += d);
            r.on('end', () => {
                try {
                    const json = JSON.parse(raw);
                    // Common shapes: { user: {...} } or direct user object
                    const user = json.user || json;
                    const id = user && (user._id || user.id || user.userId || user.id_user || user.uuid);
                    resolve({ id, user });
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

// ──────────────────────────────────────────
// Local handlers for attendance API
// ──────────────────────────────────────────
async function handleLocalAttendance(req, res) {
    // Collect body
    let bodyChunks = [];
    req.on('data', c => bodyChunks.push(c));
    req.on('end', async () => {
        const bodyBuffer = Buffer.concat(bodyChunks);
        let body = {};
        if (bodyBuffer.length) {
            try { body = JSON.parse(bodyBuffer.toString()); } catch { body = {}; }
        }

        const auth = req.headers['authorization'] || '';
        const upstreamUser = await fetchUpstreamUser(auth);
        const userId = upstreamUser?.id || body.userId || body.user_id || 'anonymous';
        const userObj = upstreamUser?.user || { id: userId };

        const records = readAttendance();
        const now = new Date();

        // Helpers to compare dates (same day)
        function sameDay(a, b) {
            const da = new Date(a); const db = new Date(b);
            return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
        }

        // Routes
        if (req.method === 'GET' && req.url === '/api/attendance') {
            // If authenticated return this user's records; otherwise return all
            const userRecords = userId && userId !== 'anonymous' ? records.filter(r => r.userId === userId) : records;
            res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
            res.end(JSON.stringify(userRecords));
            return;
        }

        if (req.method === 'POST' && req.url === '/api/attendance/checkin') {
            // Prevent duplicate check-in for the same day for same user
            const existing = records.find(r => r.userId === userId && sameDay(r.checkInTime, now) && !r.deleted);
            if (existing && !existing.checkOutTime) {
                res.writeHead(409, { 'Content-Type': 'application/json', ...CORS_HEADERS });
                res.end(JSON.stringify({ success: false, message: 'Already checked in today', attendance: existing }));
                return;
            }

            const newRec = {
                id: Date.now().toString(36) + Math.random().toString(36).slice(2,8),
                userId: userId,
                user: { ...userObj },
                projectId: body.projectId || null,
                attendanceType: body.attendanceType || null,
                notes: body.notes || body.note || null,
                checkInTime: now.toISOString(),
                checkInLocation: (body.latitude != null && body.longitude != null) ? { lat: body.latitude, lng: body.longitude, address: body.address || null } : null,
                checkOutTime: null,
                checkOutLocation: null,
                checkoutType: null,
                durationMinutes: null,
                createdAt: now.toISOString()
            };
            records.push(newRec);
            writeAttendance(records);
            res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
            res.end(JSON.stringify({ success: true, message: 'Checked in', attendance: newRec }));
            log(`LOCAL CHECKIN for user=${userId}`);
            return;
        }

        if (req.method === 'POST' && req.url === '/api/attendance/checkout') {
            // Find latest record for today for user without checkout
            const candidate = [...records].reverse().find(r => r.userId === userId && !r.checkOutTime && sameDay(r.checkInTime, now));
            if (!candidate) {
                res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
                res.end(JSON.stringify({ success: false, message: 'No active check-in found for today' }));
                return;
            }
            candidate.checkOutTime = now.toISOString();
            candidate.checkOutLocation = (body.latitude != null && body.longitude != null) ? { lat: body.latitude, lng: body.longitude, address: body.address || null } : null;
            candidate.checkoutType = body.checkoutType || 'Manual';
            candidate.durationMinutes = Math.round((new Date(candidate.checkOutTime) - new Date(candidate.checkInTime)) / 60000);
            candidate.updatedAt = now.toISOString();

            writeAttendance(records);
            res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
            res.end(JSON.stringify({ success: true, message: 'Checked out', attendance: candidate }));
            log(`LOCAL CHECKOUT for user=${userId} id=${candidate.id}`);
            return;
        }

        // If we got here, not a local attendance path
        res.writeHead(404, { 'Content-Type': 'application/json', ...CORS_HEADERS });
        res.end(JSON.stringify({ success: false, message: 'Local attendance handler: path not found' }));
    });
}

// ──────────────────────────────────────────
// API Proxy (unchanged)
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
    } else if (req.url.startsWith('/api/attendance')) {
        // Handle attendance locally (checkin/checkout/history)
        handleLocalAttendance(req, res);
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
