/**
 * Dashboard app logic for Exceed Attendance
 */
import {
    isLoggedIn, getUser, clearSession,
    checkIn, checkOut, getAttendance, getMe, getProjects,
    getLocation
} from './api.js';

// ── Guard ──────────────────────────────────────
if (!isLoggedIn()) {
    window.location.href = 'index.html';
}

// ── DOM refs ───────────────────────────────────
const loadingOverlay = document.getElementById('loadingOverlay');
const avatarEl = document.getElementById('avatarInitial');
const userNameEl = document.getElementById('userName');
const userRoleEl = document.getElementById('userRole');
const clockTimeEl = document.getElementById('clockTime');
const clockDateEl = document.getElementById('clockDate');
const headerDateEl = document.getElementById('headerDate');
const statusBadge = document.getElementById('statusBadge');
const statusText = document.getElementById('statusText');
const statusLabel = document.getElementById('statusLabel');
const timeRecord = document.getElementById('timeRecord');
const checkinTimeEl = document.getElementById('checkinTime');
const checkoutTimeEl = document.getElementById('checkoutTime');
const alreadyBar = document.getElementById('alreadyCheckedInBar');
const bypassBtn = document.getElementById('bypassBtn');

// Check-in form
const checkinFormCard = document.getElementById('checkinFormCard');
const attendanceTypeEl = document.getElementById('attendanceType');
const projectSelectEl = document.getElementById('projectSelect');
const notesInputEl = document.getElementById('notesInput');
const locationBar = document.getElementById('locationBar');
const locationDot = document.getElementById('locationDot');
const locationText = document.getElementById('locationText');
const checkinBtn = document.getElementById('checkinBtn');
const checkinMsg = document.getElementById('checkinMessage');

// Check-out form
const checkoutFormCard = document.getElementById('checkoutFormCard');
const checkoutNotesEl = document.getElementById('checkoutNotes');
const locationBar2 = document.getElementById('locationBar2');
const locationDot2 = document.getElementById('locationDot2');
const locationText2 = document.getElementById('locationText2');
const checkoutBtn = document.getElementById('checkoutBtn');
const checkoutMsg = document.getElementById('checkoutMessage');

const historyList = document.getElementById('historyList');
const logoutBtn = document.getElementById('logoutBtn');

// ── State ──────────────────────────────────────
let coords = { latitude: null, longitude: null };
let todayRecord = null;
let currentStatus = 'not-started'; // 'not-started' | 'checked-in' | 'checked-out'
let actionInProgress = false;

// ── Clock ──────────────────────────────────────
function updateClock() {
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour12: false });
    const date = now.toLocaleDateString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });
    const short = now.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric'
    });
    clockTimeEl.textContent = time;
    clockDateEl.textContent = short;
    headerDateEl.textContent = date;
}
setInterval(updateClock, 1000);
updateClock();

// ── Format helpers ─────────────────────────────
function fmtTime(v) {
    if (!v) return '—';
    try {
        const d = new Date(v);
        if (isNaN(d)) return v;
        return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
    } catch { return v; }
}
function fmtDate(v) {
    if (!v) return '—';
    try {
        const d = new Date(v);
        if (isNaN(d)) return v;
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    } catch { return v; }
}

// ── Show message ───────────────────────────────
function showMsg(el, text, type = 'error') {
    const icon = type === 'success' ? '✅' : type === 'info' ? 'ℹ️' : '⚠️';
    el.innerHTML = `<div class="alert alert-${type}"><span>${icon}</span> ${text}</div>`;
    if (type === 'success') setTimeout(() => { el.innerHTML = ''; }, 5000);
}

// ── Switch view based on status ────────────────
function applyStatus(status) {
    currentStatus = status;
    alreadyBar.style.display = 'none';

    if (status === 'not-started') {
        statusBadge.className = 'status-badge not-started';
        statusText.textContent = 'Not Started';
        statusLabel.textContent = 'No check-in recorded for today.';
        timeRecord.style.display = 'none';
        checkinFormCard.style.display = 'block';
        checkoutFormCard.style.display = 'none';
        // Show "already checked in?" bar after 3 seconds
        setTimeout(() => { alreadyBar.style.display = 'block'; }, 3000);
    } else if (status === 'checked-in') {
        statusBadge.className = 'status-badge checked-in';
        statusText.textContent = 'Checked In';
        const cin = todayRecord ? fmtTime(
            todayRecord.checkIn || todayRecord.check_in || todayRecord.checkin_time
        ) : '—';
        statusLabel.textContent = `You checked in at ${cin}. Don't forget to check out!`;
        if (todayRecord) {
            timeRecord.style.display = 'grid';
            checkinTimeEl.textContent = cin;
            checkoutTimeEl.textContent = '—';
        }
        checkinFormCard.style.display = 'none';
        checkoutFormCard.style.display = 'block';
        updateLocationBar2();
    } else if (status === 'checked-out') {
        statusBadge.className = 'status-badge checked-out';
        statusText.textContent = 'Checked Out';
        const cin = fmtTime(
            todayRecord?.checkIn || todayRecord?.check_in || todayRecord?.checkin_time
        );
        const cout = fmtTime(
            todayRecord?.checkOut || todayRecord?.check_out || todayRecord?.checkout_time
        );
        statusLabel.textContent = `Checked in: ${cin} · Checked out: ${cout}. Have a great day!`;
        timeRecord.style.display = 'grid';
        checkinTimeEl.textContent = cin;
        checkoutTimeEl.textContent = cout;
        checkinFormCard.style.display = 'none';
        checkoutFormCard.style.display = 'none';
    }
}

// ── Extract today's record ─────────────────────
function extractToday(records) {
    if (!Array.isArray(records) || records.length === 0) return null;
    const today = new Date().toDateString();
    return records.find(r => {
        const dateStr = r.date || r.checkIn || r.check_in || r.checkin_time
            || r.createdAt || r.created_at || r.updatedAt;
        if (!dateStr) return false;
        return new Date(dateStr).toDateString() === today;
    }) || null;
}

// ── Determine status from today's record ───────
function statusFromRecord(rec) {
    if (!rec) return 'not-started';
    const hasOut = rec.checkOut || rec.check_out || rec.checkout_time;
    const hasIn = rec.checkIn || rec.check_in || rec.checkin_time;
    if (hasOut) return 'checked-out';
    if (hasIn) return 'checked-in';
    return 'not-started';
}

// ── Load attendance ────────────────────────────
async function loadAttendance() {
    try {
        const res = await getAttendance();
        const records = res.data || res.attendance || res.records || (Array.isArray(res) ? res : []);
        todayRecord = extractToday(records);
        const status = statusFromRecord(todayRecord);
        applyStatus(status);
        renderHistory(records);
    } catch (err) {
        statusLabel.textContent = 'Could not load status — please refresh.';
        historyList.innerHTML = `<div class="history-empty">Could not load history: ${err.message}</div>`;
        applyStatus('not-started');
    }
}

// ── Render history ─────────────────────────────
function renderHistory(records) {
    if (!records || records.length === 0) {
        historyList.innerHTML = '<div class="history-empty">No attendance records found.</div>';
        return;
    }
    const sorted = [...records].sort((a, b) => {
        const da = new Date(a.date || a.checkIn || a.check_in || a.createdAt || 0);
        const db = new Date(b.date || b.checkIn || b.check_in || b.createdAt || 0);
        return db - da;
    }).slice(0, 10);

    historyList.innerHTML = sorted.map(r => {
        const dateStr = r.date || r.checkIn || r.check_in || r.checkin_time || r.createdAt;
        const cinRaw = r.checkIn || r.check_in || r.checkin_time;
        const coutRaw = r.checkOut || r.check_out || r.checkout_time;
        const proj = r.project?.name || r.projectName || r.project || '';
        return `<div class="history-item">
      <div>
        <div class="history-item-date">${fmtDate(dateStr)}${proj ? ` · ${proj}` : ''}</div>
      </div>
      <div class="history-item-times">
        <span class="in">In: ${fmtTime(cinRaw)}</span>
        <span class="out">Out: ${fmtTime(coutRaw)}</span>
      </div>
    </div>`;
    }).join('');
}

// ── Load user info ─────────────────────────────
async function loadUserInfo() {
    let user = getUser();
    try {
        const res = await getMe();
        user = res.user || res.data || res;
    } catch { /* use cached */ }
    if (user) {
        const name = user.full_name || user.fullName || user.name || user.username || 'Employee';
        const role = user.role || user.department || 'Exceed Project Management';
        userNameEl.textContent = name;
        userRoleEl.textContent = role;
        avatarEl.textContent = name.charAt(0).toUpperCase();
    }
}

// ── Load projects ──────────────────────────────
async function loadProjects() {
    try {
        const res = await getProjects();
        const projects = res.data || res.projects || (Array.isArray(res) ? res : []);
        if (projects.length > 0) {
            projectSelectEl.innerHTML =
                '<option value="">Select a project…</option>' +
                projects.map(p => {
                    const id = p._id || p.id || p.projectId;
                    const name = p.name || p.projectName || p.title || id;
                    return `<option value="${id}">${name}</option>`;
                }).join('');
        } else {
            projectSelectEl.innerHTML = '<option value="">No projects found</option>';
        }
    } catch {
        projectSelectEl.innerHTML = '<option value="">Could not load projects</option>';
    }
}

// ── Geolocation ────────────────────────────────
function updateLocationBar2() {
    if (coords.latitude) {
        locationDot2.classList.add('active');
        locationText2.textContent = `Location ready (${coords.latitude.toFixed(4)}, ${coords.longitude.toFixed(4)})`;
    } else {
        locationText2.textContent = 'Location unavailable — check-out will proceed without GPS.';
    }
}

async function initLocation() {
    locationText.textContent = 'Requesting location…';
    const loc = await getLocation();
    coords = { latitude: loc.latitude, longitude: loc.longitude };

    if (loc.latitude) {
        locationDot.classList.add('active');
        locationText.textContent = `Location ready (${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)})`;
        locationDot2.classList.add('active');
        locationText2.textContent = `Location ready (${loc.latitude.toFixed(4)}, ${loc.longitude.toFixed(4)})`;
    } else {
        locationText.textContent = 'Location unavailable — check-in will proceed without GPS.';
        locationText2.textContent = 'Location unavailable — check-out will proceed without GPS.';
    }
}

// ── Bypass: "Already checked in" ──────────────
bypassBtn.addEventListener('click', () => {
    todayRecord = null; // no local record but force checked-in view
    applyStatus('checked-in');
    statusLabel.textContent = 'You indicated you already checked in via the main system.';
});

// ── Check In ───────────────────────────────────
checkinBtn.addEventListener('click', async () => {
    if (actionInProgress) return;
    const attendanceType = attendanceTypeEl.value;
    const projectId = projectSelectEl.value;
    const notes = notesInputEl.value.trim();

    if (!attendanceType) {
        showMsg(checkinMsg, 'Please select an Attendance Type.', 'error');
        return;
    }
    if (!projectId) {
        showMsg(checkinMsg, 'Please select a Project.', 'error');
        return;
    }

    actionInProgress = true;
    checkinBtn.disabled = true;
    checkinBtn.innerHTML = '<span class="spinner"></span> Checking in…';
    checkinMsg.innerHTML = '';

    try {
        const res = await checkIn({
            attendanceType,
            projectId,
            notes,
            latitude: coords.latitude,
            longitude: coords.longitude
        });
        showMsg(checkinMsg, res.message || 'Checked in successfully!', 'success');
        setTimeout(() => loadAttendance(), 1000);
    } catch (err) {
        showMsg(checkinMsg, err.message || 'Check-in failed. Please try again.', 'error');
        checkinBtn.disabled = false;
    } finally {
        checkinBtn.innerHTML = '✅ Check In';
        actionInProgress = false;
    }
});

// ── Check Out ──────────────────────────────────
checkoutBtn.addEventListener('click', async () => {
    if (actionInProgress) return;
    actionInProgress = true;
    checkoutBtn.disabled = true;
    checkoutBtn.innerHTML = '<span class="spinner"></span> Checking out…';
    checkoutMsg.innerHTML = '';

    try {
        const res = await checkOut({
            notes: checkoutNotesEl.value.trim(),
            latitude: coords.latitude,
            longitude: coords.longitude
        });
        showMsg(checkoutMsg, res.message || 'Checked out successfully!', 'success');
        setTimeout(() => loadAttendance(), 1000);
    } catch (err) {
        showMsg(checkoutMsg, err.message || 'Check-out failed. Please try again.', 'error');
        checkoutBtn.disabled = false;
    } finally {
        checkoutBtn.innerHTML = '🚪 Check Out';
        actionInProgress = false;
    }
});

// ── Logout ─────────────────────────────────────
logoutBtn.addEventListener('click', () => {
    clearSession();
    window.location.href = 'index.html';
});

// ── Init ───────────────────────────────────────
async function init() {
    await Promise.all([
        loadUserInfo(),
        loadAttendance(),
        loadProjects(),
        initLocation()
    ]);
    loadingOverlay.classList.add('hidden');
    setTimeout(() => { loadingOverlay.style.display = 'none'; }, 400);
}

init();
