// session.js — Corrected session and employee-profile helpers
// Uses Supabase client and the live schema: employees(id, auth_id, employee_code, full_name, role, ...)

const SUPABASE_URL = window.SUPABASE_URL || "https://jookdsjvbticdgvxagyt.supabase.co";
const SUPABASE_KEY = window.SUPABASE_PUBLISHABLE_KEY || "sb_publishable_1emkeuRvXdsF6S-yyxcUeQ_BdUBJ5PF";

// Simple Supabase client wrapper (assumes @supabase/supabase-js is loaded globally as `supabase`)
function getSupabaseClient() {
  if (window.supabase && window.supabase.createClient) {
    return window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  throw new Error("Supabase JS client not loaded. Include the Supabase script before session.js.");
}

// Session storage keys
const SESSION_KEY = "pezzano_session";
const EMPLOYEE_CACHE_KEY = "pezzano_employee_cache";

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function loadSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  localStorage.removeItem(EMPLOYEE_CACHE_KEY);
}

// Fetch current employee profile from employees table using auth.users link
async function fetchCurrentEmployee() {
  const client = getSupabaseClient();
  const { data: { user }, error: authError } = await client.auth.getUser();
  if (authError || !user) {
    clearSession();
    return null;
  }

  // employees.auth_id is uuid nullable unique, linked to auth.users.id
  const { data: rows, error } = await client
    .from("employees")
    .select("id, auth_id, employee_code, full_name, phone, age, work_location, department, position, role, start_date, induction_date, completion_status, completion_date, progress_pct, email")
    .eq("auth_id", user.id)
    .limit(1);

  if (error || !rows || rows.length === 0) {
    // Fallback: no employee row yet; caller may create one
    return null;
  }

  const employee = rows[0];
  localStorage.setItem(EMPLOYEE_CACHE_KEY, JSON.stringify(employee));
  return employee;
}

function getCachedEmployee() {
  const raw = localStorage.getItem(EMPLOYEE_CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Check role-based access using employees.role enum: 'employee' | 'locationManager' | 'sysAdmin'
function hasRole(requiredRoles) {
  const employee = getCachedEmployee();
  if (!employee || !employee.role) return false;
  if (Array.isArray(requiredRoles)) {
    return requiredRoles.includes(employee.role);
  }
  return employee.role === requiredRoles;
}

// Initialize session on page load
async function initSession() {
  const session = loadSession();
  const employee = await fetchCurrentEmployee();
  return { session, employee };
}

// Export for browser usage
if (typeof window !== "undefined") {
  window.saveSession = saveSession;
  window.loadSession = loadSession;
  window.clearSession = clearSession;
  window.fetchCurrentEmployee = fetchCurrentEmployee;
  window.getCachedEmployee = getCachedEmployee;
  window.hasRole = hasRole;
  window.initSession = initSession;
}