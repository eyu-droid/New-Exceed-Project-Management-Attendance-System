/**
 * Exceed Attendance API Client
 * Communicates with http://196.190.220.196:3002
 */

// Empty string = relative URLs → requests go through our own proxy server.
// The proxy (server.js) forwards /api/* to http://196.190.220.196:3002.
// This avoids the browser's "mixed content" block on HTTPS-hosted free servers.
const BASE_URL = '';
const TOKEN_KEY = 'exceed_token';
const USER_KEY = 'exceed_user';

// ──────────────────────────────────────────────
// Token helpers
// ──────────────────────────────────────────────
export function saveToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function saveUser(user) {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY));
  } catch { return null; }
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function isLoggedIn() {
  return !!getToken();
}

// ──────────────────────────────────────────────
// HTTP helpers
// ──────────────────────────────────────────────
async function request(method, path, body) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body && Object.keys(body).length > 0) opts.body = JSON.stringify(body);

  let response;
  try {
    response = await fetch(`${BASE_URL}${path}`, opts);
  } catch (err) {
    throw new Error('Cannot connect to server. Is the server running? (' + err.message + ')');
  }

  // Try to parse JSON; fall back to raw text
  let data = {};
  let rawText = '';
  try {
    rawText = await response.text();
    data = JSON.parse(rawText);
  } catch {
    // rawText holds the response body (might be HTML)
    data = {};
  }

  // Auto-logout on 401
  if (response.status === 401) {
    clearSession();
    window.location.href = 'index.html';
    throw new Error('Session expired. Please log in again.');
  }

  if (!response.ok || data.success === false) {
    const msg = data.message ||
      (rawText.includes('<!DOCTYPE') ? `Server returned HTML (path not found: ${path})` : rawText.slice(0, 150)) ||
      `HTTP ${response.status}`;
    throw new Error(msg);
  }

  return data;
}

// ──────────────────────────────────────────────
// Auth
// ──────────────────────────────────────────────
export async function login(username, password) {
  // Try the primary login path; if it 404s, try alternate path
  let data;
  try {
    data = await request('POST', '/api/auth/login', { username, password });
  } catch (err) {
    if (err.message.includes('not found') || err.message.includes('404')) {
      // Try alternate path
      data = await request('POST', '/api/login', { username, password });
    } else {
      throw err;
    }
  }
  if (data.token) saveToken(data.token);
  if (data.user) saveUser(data.user);
  return data;
}

// ──────────────────────────────────────────────
// Attendance
// ──────────────────────────────────────────────
export async function checkIn({ attendanceType, projectId, notes, latitude, longitude } = {}) {
  const payload = {};
  if (attendanceType) payload.attendanceType = attendanceType;
  if (projectId) payload.projectId = projectId;
  if (notes) payload.notes = notes;
  if (latitude != null) payload.latitude = latitude;
  if (longitude != null) payload.longitude = longitude;
  return request('POST', '/api/attendance/checkin', payload);
}

export async function checkOut({ notes, latitude, longitude } = {}) {
  const payload = {};
  if (notes) payload.notes = notes;
  if (latitude != null) payload.latitude = latitude;
  if (longitude != null) payload.longitude = longitude;
  return request('POST', '/api/attendance/checkout', payload);
}

export async function getAttendance() {
  return request('GET', '/api/attendance');
}

export async function getMe() {
  return request('GET', '/api/users/me');
}

export async function getProjects() {
  return request('GET', '/api/projects');
}

// ──────────────────────────────────────────────
// Geolocation helper
// ──────────────────────────────────────────────
export function getLocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) {
      resolve({ latitude: null, longitude: null, error: 'Geolocation not supported' });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, error: null }),
      (err) => {
        console.warn('Geolocation error:', err.message);
        resolve({ latitude: null, longitude: null, error: err.message });
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  });
}
