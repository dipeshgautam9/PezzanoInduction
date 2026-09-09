// ============================================================
// session.js — include this on EVERY page before other scripts
// Handles auth state, session guard, and shared Supabase client
// ============================================================

const SUPABASE_URL     = 'https://jookdsjvbticdgvxagyt.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_1emkeuRvXdsF6S-yyxcUeQ_BdUBJ5PF';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,          // stores JWT in localStorage securely
    detectSessionInUrl: true
  }
});

// ── Auth state cache ──────────────────────────────────────────
let _session   = null;
let _profile   = null;   // employees row

async function getSession() {
  if (_session) return _session;
  const { data } = await sb.auth.getSession();
  _session = data.session;
  return _session;
}

async function getProfile() {
  if (_profile) return _profile;
  const session = await getSession();
  if (!session) return null;
  const { data, error } = await sb
    .from('employees')
    .select('*')
    .eq('auth_id', session.user.id)
    .single();
  if (!error) _profile = data;
  return _profile;
}

// ── Guards ───────────────────────────────────────────────────
// Call on protected pages — redirects to login if not signed in
async function requireAuth() {
  const session = await getSession();
  if (!session) { window.location.href = 'login.html'; return null; }
  return session;
}

// Call on manager-only pages
async function requireManager() {
  const profile = await getProfile();
  if (!profile || !['locationManager','sysAdmin'].includes(profile.role)) {
    alert('Access denied.');
    window.location.href = 'dashboard.html';
    return null;
  }
  return profile;
}

// ── Sign out ─────────────────────────────────────────────────
async function signOut() {
  await sb.auth.signOut();
  _session = null; _profile = null;
  window.location.href = 'login.html';
}

// ── Helpers ──────────────────────────────────────────────────
function isManager(profile)   { return profile && ['locationManager','sysAdmin'].includes(profile.role); }
function isSysAdmin(profile)  { return profile && profile.role === 'sysAdmin'; }
function fmtDate(d)           { return d ? new Date(d).toLocaleDateString('en-AU') : '—'; }
function esc(v)               { return String(v ?? '').replace(/[&<>"']/g, s => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s])); }

// ── Audit helper ─────────────────────────────────────────────
async function audit(targetId, action, detail, oldVal = null, newVal = null) {
  await sb.rpc('write_audit', {
    p_target_id: targetId,
    p_action:    action,
    p_detail:    detail,
    p_old_value: oldVal ? JSON.stringify(oldVal) : null,
    p_new_value: newVal ? JSON.stringify(newVal) : null
  });
}
