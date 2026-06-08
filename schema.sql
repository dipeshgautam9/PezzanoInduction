-- ============================================================
-- PEZZANO INDUCTION PORTAL — SUPABASE DATABASE SCHEMA
-- Run this entire file in Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── ENUMS ─────────────────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('employee', 'locationManager', 'sysAdmin');
CREATE TYPE induction_status AS ENUM ('pending', 'in_progress', 'completed');

-- ── EMPLOYEES TABLE ───────────────────────────────────────────
-- Stores profile data. Login identity (email+password) lives in
-- Supabase Auth (auth.users). The two are linked by auth_id.
CREATE TABLE employees (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id         uuid UNIQUE REFERENCES auth.users(id) ON DELETE SET NULL,
  employee_code   text UNIQUE NOT NULL,   -- e.g. EMP100421 — permanent, never changes
  full_name       text NOT NULL,
  phone           text,
  age             int,
  work_location   text NOT NULL DEFAULT 'Canning Vale',
  department      text NOT NULL,
  position        text NOT NULL,
  role            user_role NOT NULL DEFAULT 'employee',
  start_date      date NOT NULL DEFAULT CURRENT_DATE,   -- locked by trigger
  induction_date  date NOT NULL DEFAULT CURRENT_DATE,   -- locked by trigger
  completion_status induction_status NOT NULL DEFAULT 'pending',
  completion_date date,
  employee_signature text,
  supervisor_name    text,
  supervisor_signature text,
  knowledge_viewed   text[] DEFAULT '{}',
  progress_pct    int NOT NULL DEFAULT 0 CHECK (progress_pct >= 0 AND progress_pct <= 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ── MODULE PROGRESS TABLE ─────────────────────────────────────
CREATE TABLE module_progress (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  module_id   text NOT NULL,
  answers     jsonb NOT NULL DEFAULT '{}',
  completed   boolean NOT NULL DEFAULT false,
  completed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, module_id)
);

-- ── AUDIT LOG TABLE ───────────────────────────────────────────
CREATE TABLE audit_logs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    uuid REFERENCES employees(id) ON DELETE SET NULL,
  actor_name  text,
  actor_role  text,
  target_id   uuid REFERENCES employees(id) ON DELETE SET NULL,
  action      text NOT NULL,
  detail      text,
  old_value   jsonb,
  new_value   jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── TRIGGER: Lock start_date and induction_date ───────────────
CREATE OR REPLACE FUNCTION lock_employee_dates()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Preserve original dates regardless of what UPDATE tries to set
  NEW.start_date     := OLD.start_date;
  NEW.induction_date := OLD.induction_date;
  NEW.updated_at     := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_lock_dates
  BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION lock_employee_dates();

-- ── TRIGGER: Auto-update updated_at on module_progress ────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_module_updated
  BEFORE UPDATE ON module_progress
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── ROW LEVEL SECURITY ────────────────────────────────────────
ALTER TABLE employees       ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs      ENABLE ROW LEVEL SECURITY;

-- Helper: get current employee row from auth.uid()
CREATE OR REPLACE FUNCTION current_employee_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM employees WHERE auth_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION current_employee_role() RETURNS user_role LANGUAGE sql STABLE AS $$
  SELECT role FROM employees WHERE auth_id = auth.uid() LIMIT 1;
$$;

-- ── RLS POLICIES: employees ───────────────────────────────────

-- Employees: read own row only
CREATE POLICY emp_select_own ON employees
  FOR SELECT USING (auth_id = auth.uid());

-- Location managers: read all employees
CREATE POLICY mgr_select_all ON employees
  FOR SELECT USING (current_employee_role() IN ('locationManager','sysAdmin'));

-- Location managers: update department + position only
CREATE POLICY mgr_update_dept ON employees
  FOR UPDATE USING (current_employee_role() IN ('locationManager','sysAdmin'))
  WITH CHECK (current_employee_role() IN ('locationManager','sysAdmin'));

-- System admin: insert new employees
CREATE POLICY admin_insert ON employees
  FOR INSERT WITH CHECK (current_employee_role() = 'sysAdmin');

-- System admin: delete employees
CREATE POLICY admin_delete ON employees
  FOR DELETE USING (current_employee_role() = 'sysAdmin');

-- ── RLS POLICIES: module_progress ────────────────────────────

-- Employees: read + write own progress only
CREATE POLICY emp_progress_own ON module_progress
  FOR ALL USING (employee_id = current_employee_id());

-- Managers: read all progress
CREATE POLICY mgr_progress_read ON module_progress
  FOR SELECT USING (current_employee_role() IN ('locationManager','sysAdmin'));

-- ── RLS POLICIES: audit_logs ─────────────────────────────────

-- Only sysAdmin can read audit logs
CREATE POLICY admin_audit_read ON audit_logs
  FOR SELECT USING (current_employee_role() = 'sysAdmin');

-- Any authenticated user can insert audit entries (via service role edge function)
CREATE POLICY audit_insert ON audit_logs
  FOR INSERT WITH CHECK (auth.role() = 'authenticated');

-- ── INDEXES ───────────────────────────────────────────────────
CREATE INDEX idx_employees_auth_id     ON employees(auth_id);
CREATE INDEX idx_employees_employee_code ON employees(employee_code);
CREATE INDEX idx_module_employee       ON module_progress(employee_id);
CREATE INDEX idx_audit_actor           ON audit_logs(actor_id);
CREATE INDEX idx_audit_target          ON audit_logs(target_id);
CREATE INDEX idx_audit_created         ON audit_logs(created_at DESC);

-- ── SEED: Default System Administrator ───────────────────────
-- After running this schema, create the sysAdmin auth user via:
-- Supabase Dashboard → Authentication → Users → Invite User
-- Email: admin@pezzano.com.au   Password: (set a strong one)
-- Then run this INSERT with the auth user's UUID:
--
-- INSERT INTO employees (auth_id, employee_code, full_name, role, department, position)
-- VALUES ('<AUTH_UUID_HERE>', 'ADMIN001', 'System Administrator', 'sysAdmin', 'Admin', 'System Administrator');
