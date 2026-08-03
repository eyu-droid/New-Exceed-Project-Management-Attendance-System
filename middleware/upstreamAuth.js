// middleware/upstreamAuth.js
// Resolves Authorization: Bearer <token> by calling upstream /api/users/me
// Then finds-or-creates a local_users row and returns the local user.

const http = require('http');
const db = require('../db');

const EXCEED_HOST = process.env.EXCEED_HOST || '196.190.220.196';
const EXCEED_PORT = process.env.EXCEED_PORT || 3002;

async function callUpstreamMe(authHeader) {
  return new Promise((resolve) => {
    if (!authHeader) return resolve(null);
    const headers = { 'Content-Type': 'application/json', host: `${EXCEED_HOST}:${EXCEED_PORT}`, Authorization: authHeader };

    const req = http.request({ hostname: EXCEED_HOST, port: EXCEED_PORT, path: '/api/users/me', method: 'GET', headers }, (r) => {
      let raw = '';
      r.on('data', d => raw += d);
      r.on('end', () => {
        try {
          const json = JSON.parse(raw || '{}');
          const user = json.user || json; // handle common shapes
          resolve(user);
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function findOrCreateLocalUser(upstreamUser) {
  if (!upstreamUser) return null;
  const upstreamId = upstreamUser._id || upstreamUser.id || upstreamUser.userId || upstreamUser.id_user || String(upstreamUser.id);
  if (!upstreamId) return null;

  const res = await db.query('SELECT * FROM local_users WHERE upstream_id = $1 LIMIT 1', [upstreamId]);
  if (res.rows.length > 0) return res.rows[0];

  const username = upstreamUser.username || upstreamUser.name || upstreamUser.email || null;
  const email = upstreamUser.email || null;
  const fullName = upstreamUser.full_name || upstreamUser.fullName || upstreamUser.name || null;

  const ins = await db.query(
    `INSERT INTO local_users (upstream_id, username, email, full_name)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [upstreamId, username, email, fullName]
  );
  return ins.rows[0];
}

module.exports = {
  resolveLocalUser: async function (authHeader) {
    if (!authHeader) return null;
    const upstreamUser = await callUpstreamMe(authHeader);
    if (!upstreamUser) return null;
    const local = await findOrCreateLocalUser(upstreamUser);
    return { upstreamUser, local };
  }
};
