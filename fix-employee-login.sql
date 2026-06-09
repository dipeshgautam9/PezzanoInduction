-- ============================================================
-- FIX: Employee login not working
-- Run this in Supabase SQL Editor → New Query → Run
-- ============================================================

-- Step 1: Allow the email lookup function to work without login
ALTER FUNCTION get_email_by_employee_code(text) SECURITY DEFINER;
REVOKE ALL ON FUNCTION get_email_by_employee_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_email_by_employee_code(text) TO anon;
GRANT EXECUTE ON FUNCTION get_email_by_employee_code(text) TO authenticated;

-- Step 2: Allow anon role to call the other helper functions too
GRANT EXECUTE ON FUNCTION current_employee_id() TO authenticated;
GRANT EXECUTE ON FUNCTION current_employee_role() TO authenticated;
GRANT EXECUTE ON FUNCTION save_module_progress(text, jsonb, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION write_audit(uuid, text, text, jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION get_dashboard_data() TO authenticated;
GRANT EXECUTE ON FUNCTION admin_edit_employee(uuid, text, text, int, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_reset_password(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION admin_delete_employee(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION create_employee(text, text, text, text, int, text, text, user_role, text) TO authenticated;

-- Step 3: Fix RLS — employees must be able to read their own row after login
-- Drop existing policies and recreate cleanly
DROP POLICY IF EXISTS emp_select_own   ON employees;
DROP POLICY IF EXISTS mgr_select_all   ON employees;
DROP POLICY IF EXISTS mgr_update       ON employees;
DROP POLICY IF EXISTS admin_insert     ON employees;
DROP POLICY IF EXISTS admin_delete     ON employees;

-- Employee: read own row only
CREATE POLICY emp_select_own ON employees
  FOR SELECT
  USING (auth_id = auth.uid());

-- Manager/Admin: read all rows
CREATE POLICY mgr_select_all ON employees
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM employees e2
      WHERE e2.auth_id = auth.uid()
      AND e2.role IN ('locationManager','sysAdmin')
    )
  );

-- Manager/Admin: update any row
CREATE POLICY mgr_update ON employees
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM employees e2
      WHERE e2.auth_id = auth.uid()
      AND e2.role IN ('locationManager','sysAdmin')
    )
  );

-- Employee: update own row (for knowledge_viewed, signatures etc)
CREATE POLICY emp_update_own ON employees
  FOR UPDATE
  USING (auth_id = auth.uid());

-- SysAdmin: insert new employees
CREATE POLICY admin_insert ON employees
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM employees e2
      WHERE e2.auth_id = auth.uid()
      AND e2.role = 'sysAdmin'
    )
  );

-- SysAdmin: delete employees
CREATE POLICY admin_delete ON employees
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM employees e2
      WHERE e2.auth_id = auth.uid()
      AND e2.role = 'sysAdmin'
    )
  );

-- Step 4: Fix module_progress RLS
DROP POLICY IF EXISTS emp_progress_own  ON module_progress;
DROP POLICY IF EXISTS mgr_progress_read ON module_progress;

CREATE POLICY emp_progress_own ON module_progress
  FOR ALL
  USING (employee_id = (SELECT id FROM employees WHERE auth_id = auth.uid() LIMIT 1));

CREATE POLICY mgr_progress_read ON module_progress
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM employees e2
      WHERE e2.auth_id = auth.uid()
      AND e2.role IN ('locationManager','sysAdmin')
    )
  );

-- Step 5: Fix audit_logs RLS
DROP POLICY IF EXISTS admin_audit_read ON audit_logs;
DROP POLICY IF EXISTS audit_insert     ON audit_logs;

CREATE POLICY admin_audit_read ON audit_logs
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM employees e2
      WHERE e2.auth_id = auth.uid()
      AND e2.role = 'sysAdmin'
    )
  );

CREATE POLICY audit_insert ON audit_logs
  FOR INSERT
  WITH CHECK (auth.role() = 'authenticated');

-- Step 6: Confirm both employees are correctly linked to auth users
SELECT
  e.employee_code,
  e.full_name,
  e.role,
  e.department,
  e.auth_id,
  u.email,
  u.email_confirmed_at
FROM employees e
LEFT JOIN auth.users u ON u.id = e.auth_id
ORDER BY e.created_at DESC;
