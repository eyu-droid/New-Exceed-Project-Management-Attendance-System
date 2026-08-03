// attendance-db.js
// handle(req, res) for:
// GET /api/attendance
// POST /api/attendance/checkin
// POST /api/attendance/checkout

const url = require('url');
const db = require('./db');
const upstreamAuth = require('./middleware/upstreamAuth');

function parseBodyFromBuffer(buffer) {
  if (!buffer || !buffer.length) return {};
  try { return JSON.parse(buffer.toString()); } catch { return {}; }
}

function formatDuration(mins) {
  if (mins == null) return null;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

async function handle(req, res) {
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    const body = parseBodyFromBuffer(Buffer.concat(chunks));
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    const auth = req.headers['authorization'] || '';
    const resolved = await upstreamAuth.resolveLocalUser(auth);
    const localUser = resolved?.local || null;

    if (!localUser) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Unauthorized: valid upstream token required in Authorization header' }));
      return;
    }

    const localUserId = localUser.id;

    // GET /api/attendance
    if (req.method === 'GET' && pathname === '/api/attendance') {
      try {
        const q = `
          SELECT a.*, u.full_name as user_full_name, u.upstream_id as upstream_id
          FROM attendance a
          JOIN local_users u ON a.user_id = u.id
          ORDER BY a.check_in_time DESC
          LIMIT 1000;
        `;
        const r = await db.query(q, []);
        const rows = r.rows.map(rw => ({
          id: rw.id,
          userId: rw.user_id,
          upstreamId: rw.upstream_id,
          userName: rw.user_full_name || null,
          date: rw.check_in_time ? new Date(rw.check_in_time).toISOString().slice(0,10) : null,
          checkInTime: rw.check_in_time,
          checkOutTime: rw.check_out_time,
          durationMinutes: rw.duration_minutes,
          duration: formatDuration(rw.duration_minutes),
          office: rw.office || null,
          location: rw.check_in_address || '-',
          checkoutType: rw.checkout_type || null,
          projectId: rw.project_id || null,
          notes: rw.notes || null
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'DB error', error: err.message }));
      }
      return;
    }

    // POST /api/attendance/checkin
    if (req.method === 'POST' && pathname === '/api/attendance/checkin') {
      try {
        const du = await db.query(
          `SELECT id FROM attendance WHERE user_id = $1 AND date(check_in_time) = current_date AND check_out_time IS NULL LIMIT 1`,
          [localUserId]
        );
        if (du.rows.length > 0) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'Already checked in today' }));
          return;
        }

        const insert = `
          INSERT INTO attendance (user_id, project_id, attendance_type, notes, check_in_time, check_in_lat, check_in_lng, check_in_address, office)
          VALUES ($1,$2,$3,$4, now(), $5,$6,$7,$8)
          RETURNING *;
        `;
        const params = [
          localUserId,
          body.projectId || null,
          body.attendanceType || null,
          body.notes || null,
          body.latitude != null ? body.latitude : null,
          body.longitude != null ? body.longitude : null,
          body.address || null,
          body.office || null
        ];
        const r = await db.query(insert, params);
        const rec = r.rows[0];

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Checked in', attendance: rec }));
        return;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'DB error', error: err.message }));
        return;
      }
    }

    // POST /api/attendance/checkout
    if (req.method === 'POST' && pathname === '/api/attendance/checkout') {
      try {
        const tx = await db.query(`
          WITH target AS (
            SELECT id, check_in_time FROM attendance
            WHERE user_id = $1 AND check_out_time IS NULL
              AND date(check_in_time) = current_date
            ORDER BY check_in_time DESC
            LIMIT 1
          )
          UPDATE attendance
          SET check_out_time = now(),
              check_out_lat = $2,
              check_out_lng = $3,
              check_out_address = $4,
              checkout_type = $5,
              duration_minutes = FLOOR(EXTRACT(EPOCH FROM (now() - (SELECT check_in_time FROM target))) / 60)::int,
              updated_at = now()
          WHERE id = (SELECT id FROM target)
          RETURNING *;
        `, [
          localUserId,
          body.latitude != null ? body.latitude : null,
          body.longitude != null ? body.longitude : null,
          body.address || null,
          body.checkoutType || 'Manual'
        ]);

        if (!tx.rows || tx.rows.length === 0) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, message: 'No active check-in found for today' }));
          return;
        }
        const updated = tx.rows[0];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Checked out', attendance: updated }));
        return;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'DB error', error: err.message }));
        return;
      }
    }

    // Not found
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, message: 'Attendance path not found' }));
  });
}

module.exports = { handle };
