const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const GROUP_CLASS_KEY = process.env.GROUP_CLASS_KEY || 'english-camp-mvp';

function ensureSupabaseConfig() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error('Supabase is not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Netlify environment variables.');
    error.statusCode = 500;
    throw error;
  }
}

async function supabaseFetch(path, options = {}) {
  ensureSupabaseConfig();
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.prefer || 'return=representation',
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.message || data?.error || `Supabase request failed with status ${response.status}`;
    const error = new Error(message);
    error.statusCode = response.status;
    error.details = data;
    throw error;
  }
  return data;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    },
    body: JSON.stringify(body)
  };
}

function getAdminCode() {
  return process.env.GROUP_ADMIN_CODE || process.env.BOOKING_ADMIN_CODE || '';
}

function requireAdmin(event) {
  const adminCode = getAdminCode();
  if (!adminCode) {
    const error = new Error('Group admin code is not configured.');
    error.statusCode = 500;
    throw error;
  }
  const provided = event.headers['x-group-admin-code'] || event.headers['X-Group-Admin-Code'] || '';
  if (String(provided).trim() !== adminCode) {
    const error = new Error('Invalid admin code.');
    error.statusCode = 401;
    throw error;
  }
}

function userError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

module.exports = {
  GROUP_CLASS_KEY,
  supabaseFetch,
  json,
  requireAdmin,
  userError
};
