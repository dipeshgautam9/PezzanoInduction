const config = window.PEZZANO_CONFIG || {};
const page = document.body.dataset.page;
const isConfigured =
  config.supabaseUrl &&
  config.supabaseAnonKey &&
  !config.supabaseUrl.includes('YOUR-PROJECT-REF') &&
  !config.supabaseAnonKey.includes('YOUR-SUPABASE');

const supabase = isConfigured && window.supabase?.createClient
  ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
  : null;

let session = null;
let currentUser = null;
let currentProfile = null;
let currentInduction = null;

const $ = (selector) => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value) return 'Not set';
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: value.includes('T') ? 'short' : undefined
  }).format(new Date(value));
}

function friendlyRole(role) {
  return {
    employee: 'Employee',
    location_manager: 'Location Manager',
    sys_admin: 'System Administrator'
  }[role] || 'Employee';
}

function friendlyStatus(status) {
  return String(status || 'not_started').replaceAll('_', ' ');
}

function showMessage(selector, message, type = '') {
  const node = $(selector);
  if (!node) return;
  node.textContent = message;
  node.className = `notice ${type}`.trim();
  node.classList.remove('hidden');
}

function disableForms(reason) {
  document.querySelectorAll('form input, form select, form button').forEach((element) => {
    element.disabled = true;
  });
  showMessage(page === 'login' ? '#auth-message' : '#dashboard-message', reason, 'error');
}

function clearMessage(selector) {
  const node = $(selector);
  if (!node) return;
  node.classList.add('hidden');
  node.textContent = '';
}

function requireConfig() {
  if (!window.supabase?.createClient) {
    disableForms('Supabase client did not load. Check your internet connection or deploy through Netlify so the CDN script can load.');
    return false;
  }

  if (isConfigured) return true;
  const message = 'Supabase is not configured yet. Open config.js and replace YOUR-PROJECT-REF and YOUR-SUPABASE-ANON-KEY with your real Supabase project values.';
  disableForms(message);
  return false;
}

function isAdmin() {
  return currentProfile && ['location_manager', 'sys_admin'].includes(currentProfile.role);
}

function isSysAdmin() {
  return currentProfile?.role === 'sys_admin';
}

async function getActiveSession() {
  if (!requireConfig()) return null;
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  session = data.session;
  currentUser = data.session?.user || null;
  return session;
}

async function initAuthWatcher() {
  if (!requireConfig()) return;
  supabase.auth.onAuthStateChange((event, nextSession) => {
    session = nextSession;
    currentUser = nextSession?.user || null;
    if (event === 'SIGNED_OUT' && page !== 'login') {
      window.location.href = './login.html';
    }
    if (event === 'SIGNED_IN' && page === 'login') {
      window.location.href = './dashboard.html';
    }
  });
}

async function initLoginPage() {
  await initAuthWatcher();
  if (!requireConfig()) return;

  const existing = await getActiveSession();
  if (existing) {
    window.location.replace('./dashboard.html');
    return;
  }

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessage('#auth-message');
    const form = new FormData(event.currentTarget);
    const email = form.get('email').trim();
    const password = form.get('password');

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      showMessage('#auth-message', error.message, 'error');
      return;
    }

    window.location.href = './dashboard.html';
  });

  $('#signup-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessage('#auth-message');
    const form = new FormData(event.currentTarget);
    const email = form.get('email').trim();
    const password = form.get('password');
    const full_name = form.get('full_name').trim();

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/login.html`,
        data: { full_name }
      }
    });

    if (error) {
      showMessage('#auth-message', error.message, 'error');
      return;
    }

    event.currentTarget.reset();
    showMessage('#auth-message', 'Account created. Check your email if confirmation is enabled, then sign in.', 'success');
  });

  $('#reset-password').addEventListener('click', async () => {
    const email = $('#login-email').value.trim();
    if (!email) {
      showMessage('#auth-message', 'Enter your email first, then click reset password.', 'error');
      return;
    }

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password.html`
    });

    if (error) {
      showMessage('#auth-message', error.message, 'error');
      return;
    }

    showMessage('#auth-message', 'Password reset email sent.', 'success');
  });
}

async function loadProfile() {
  const { data, error } = await supabase
    .from('employees')
    .select('*')
    .eq('auth_id', currentUser.id)
    .maybeSingle();

  if (error) throw error;
  currentProfile = data;
  return data;
}

async function loadInduction() {
  if (!currentProfile) return null;

  const { data, error } = await supabase
    .from('induction_records')
    .select('*')
    .eq('employee_uuid', currentProfile.id)
    .maybeSingle();

  if (error) throw error;
  currentInduction = data;
  return data;
}

async function ensureInduction() {
  if (currentInduction || !currentProfile) return currentInduction;

  const { data, error } = await supabase
    .from('induction_records')
    .insert({ employee_uuid: currentProfile.id })
    .select('*')
    .single();

  if (error) throw error;
  currentInduction = data;
  return data;
}

function renderProfile() {
  const card = $('#profile-card');
  if (!currentProfile) {
    card.innerHTML = `
      <div class="notice">
        Your Auth account exists, but no employee profile is linked yet.
        Ask a manager to create or approve your employee record using ${escapeHtml(currentUser.email)}.
      </div>
    `;
    return;
  }

  $('#session-label').textContent = `${currentProfile.full_name} · ${friendlyRole(currentProfile.role)}`;
  card.innerHTML = `
    <div class="profile-row"><span>Employee ID</span><strong>${escapeHtml(currentProfile.employee_id)}</strong></div>
    <div class="profile-row"><span>Name</span><strong>${escapeHtml(currentProfile.full_name)}</strong></div>
    <div class="profile-row"><span>Email</span><strong>${escapeHtml(currentProfile.email)}</strong></div>
    <div class="profile-row"><span>Phone</span><strong>${escapeHtml(currentProfile.phone || 'Not set')}</strong></div>
    <div class="profile-row"><span>Department</span><strong>${escapeHtml(currentProfile.department)}</strong></div>
    <div class="profile-row"><span>Position</span><strong>${escapeHtml(currentProfile.position)}</strong></div>
    <div class="profile-row"><span>Portal role</span><strong>${friendlyRole(currentProfile.role)}</strong></div>
    <div class="profile-row"><span>Status</span><strong><span class="status ${escapeHtml(currentProfile.status)}">${friendlyStatus(currentProfile.status)}</span></strong></div>
  `;
}

function renderInduction() {
  const card = $('#induction-card');
  if (!currentProfile) {
    card.innerHTML = '<p class="muted">Induction is unavailable until your employee profile is linked.</p>';
    return;
  }

  const progress = currentInduction?.progress_percent || 0;
  const status = currentInduction?.status || 'not_started';
  card.innerHTML = `
    <div class="button-row" style="justify-content:space-between;margin-bottom:14px">
      <span class="status ${escapeHtml(status)}">${friendlyStatus(status)}</span>
      <strong>${progress}%</strong>
    </div>
    <div class="progress-track" aria-label="Induction progress"><span style="width:${progress}%"></span></div>
    <div class="profile-list">
      <div class="profile-row"><span>Current module</span><strong>${escapeHtml(currentInduction?.current_module || 'Not started')}</strong></div>
      <div class="profile-row"><span>Declaration</span><strong>${currentInduction?.declaration_accepted ? 'Accepted' : 'Not accepted'}</strong></div>
      <div class="profile-row"><span>Completed</span><strong>${formatDate(currentInduction?.completed_at)}</strong></div>
    </div>
    <div class="button-row" style="margin-top:18px">
      <button class="btn" id="start-induction" type="button">Start induction</button>
      <button class="btn primary" id="complete-induction" type="button">Accept declaration and complete</button>
    </div>
  `;

  $('#start-induction').addEventListener('click', markInductionStarted);
  $('#complete-induction').addEventListener('click', completeInduction);
}

async function markInductionStarted() {
  clearMessage('#dashboard-message');
  const record = await ensureInduction();
  const { data, error } = await supabase
    .from('induction_records')
    .update({
      status: 'in_progress',
      progress_percent: Math.max(record.progress_percent || 0, 10),
      current_module: 'Warehouse safety induction'
    })
    .eq('id', record.id)
    .select('*')
    .single();

  if (error) {
    showMessage('#dashboard-message', error.message, 'error');
    return;
  }

  currentInduction = data;
  renderInduction();
  showMessage('#dashboard-message', 'Induction progress saved.', 'success');
}

async function completeInduction() {
  clearMessage('#dashboard-message');
  if (!window.confirm('Confirm that you have completed the induction and accept the declaration?')) return;

  const record = await ensureInduction();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('induction_records')
    .update({
      status: 'completed',
      progress_percent: 100,
      current_module: 'Completed',
      declaration_accepted: true,
      declaration_accepted_at: now,
      completed_at: now
    })
    .eq('id', record.id)
    .select('*')
    .single();

  if (error) {
    showMessage('#dashboard-message', error.message, 'error');
    return;
  }

  currentInduction = data;
  renderInduction();
  showMessage('#dashboard-message', 'Induction completed and audited.', 'success');
}

async function renderAdminPanel() {
  if (!isAdmin()) return;

  $('#admin-panel').classList.remove('hidden');
  $('#audit-panel').classList.remove('hidden');

  if (!isSysAdmin()) {
    $('#employee-role').value = 'employee';
    $('#employee-role').disabled = true;
    $('#employee-role').title = 'Only System Administrators can grant elevated portal roles.';
  }

  $('#employee-form').addEventListener('submit', createEmployee);
  await Promise.all([loadEmployeesTable(), loadAuditLogs()]);
}

async function createEmployee(event) {
  event.preventDefault();
  clearMessage('#dashboard-message');
  const form = new FormData(event.currentTarget);
  const payload = {
    full_name: form.get('full_name').trim(),
    email: form.get('email').trim(),
    phone: form.get('phone').trim() || null,
    department: form.get('department').trim(),
    position: form.get('position').trim(),
    role: isSysAdmin() ? form.get('role') : 'employee',
    status: 'invited'
  };

  const { error } = await supabase.from('employees').insert(payload);
  if (error) {
    showMessage('#dashboard-message', error.message, 'error');
    return;
  }

  event.currentTarget.reset();
  $('#employee-department').value = 'Warehouse';
  $('#employee-position').value = 'Employee';
  showMessage('#dashboard-message', 'Employee record created. Ask the employee to complete first-time setup with the same email.', 'success');
  await Promise.all([loadEmployeesTable(), loadAuditLogs()]);
}

async function loadEmployeesTable() {
  const { data, error } = await supabase
    .from('employees')
    .select('id, employee_id, full_name, email, department, role, status, auth_id')
    .order('employee_id', { ascending: true });

  if (error) throw error;

  $('#employees-table').innerHTML = data.map((employee) => `
    <tr>
      <td><strong>${escapeHtml(employee.employee_id)}</strong></td>
      <td>${escapeHtml(employee.full_name)}</td>
      <td>${escapeHtml(employee.email)}${employee.auth_id ? '' : '<br><span class="muted">Auth not linked</span>'}</td>
      <td>${escapeHtml(employee.department)}</td>
      <td>${friendlyRole(employee.role)}</td>
      <td><span class="status ${escapeHtml(employee.status)}">${friendlyStatus(employee.status)}</span></td>
      <td>
        <div class="button-row">
          <button class="btn" data-action="activate" data-id="${employee.id}" type="button">Activate</button>
          <button class="btn" data-action="inactive" data-id="${employee.id}" type="button">Set inactive</button>
          ${isSysAdmin() ? `<button class="btn danger" data-action="delete" data-id="${employee.id}" type="button">Delete</button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  $('#employees-table').querySelectorAll('button[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleEmployeeAction(button.dataset.action, button.dataset.id));
  });
}

async function handleEmployeeAction(action, id) {
  clearMessage('#dashboard-message');

  if (action === 'delete') {
    if (!window.confirm('Delete this employee record? This is restricted to System Administrators.')) return;
    const { error } = await supabase.from('employees').delete().eq('id', id);
    if (error) {
      showMessage('#dashboard-message', error.message, 'error');
      return;
    }
  } else {
    const status = action === 'activate' ? 'active' : 'inactive';
    const { error } = await supabase.from('employees').update({ status }).eq('id', id);
    if (error) {
      showMessage('#dashboard-message', error.message, 'error');
      return;
    }
  }

  showMessage('#dashboard-message', 'Employee record updated.', 'success');
  await Promise.all([loadEmployeesTable(), loadAuditLogs()]);
}

async function loadAuditLogs() {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('id, action, table_name, record_id, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) throw error;

  $('#audit-list').innerHTML = data.length
    ? data.map((item) => `
        <article class="audit-item">
          <strong>${escapeHtml(item.action)}</strong>
          <span>${escapeHtml(item.table_name)} · ${escapeHtml(item.record_id || 'no record id')}</span>
          <time datetime="${escapeHtml(item.created_at)}">${formatDate(item.created_at)}</time>
        </article>
      `).join('')
    : '<p class="muted">No audit events yet.</p>';
}

async function initDashboardPage() {
  await initAuthWatcher();
  if (!requireConfig()) return;

  try {
    const active = await getActiveSession();
    if (!active) {
      window.location.replace('./login.html');
      return;
    }

    $('#logout-button').addEventListener('click', async () => {
      await supabase.auth.signOut();
      window.location.href = './login.html';
    });

    $('#refresh-dashboard').addEventListener('click', () => window.location.reload());

    await loadProfile();
    await loadInduction();
    renderProfile();
    renderInduction();
    await renderAdminPanel();
  } catch (error) {
    showMessage('#dashboard-message', error.message, 'error');
  }
}

if (page === 'login') {
  initLoginPage();
}

if (page === 'dashboard') {
  initDashboardPage();
}
