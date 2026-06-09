-- ============================================================
-- FINAL FIX: Breaks the RLS circular loop completely
-- Run in Supabase SQL Editor → New Query → Run
-- ============================================================

-- Step 1: Drop ALL existing policies on all 3 tables
DROP POLICY IF EXISTS emp_select_own    ON employees;
DROP POLICY IF EXISTS mgr_select_all    ON employees;
DROP POLICY IF EXISTS mgr_update        ON employees;
DROP POLICY IF EXISTS emp_update_own    ON employees;
DROP POLICY IF EXISTS admin_insert      ON employees;
DROP POLICY IF EXISTS admin_delete      ON employees;
DROP POLICY IF EXISTS emp_progress_own  ON module_progress;
DROP POLICY IF EXISTS mgr_progress_read ON module_progress;
DROP POLICY IF EXISTS admin_audit_read  ON audit_logs;
DROP POLICY IF EXISTS audit_insert      ON audit_logs;

-- Step 2: Temporarily disable RLS so we can fix functions first
ALTER TABLE employees       DISABLE ROW LEVEL SECURITY;
ALTER TABLE module_progress DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs      DISABLE ROW LEVEL SECURITY;

-- Step 3: Recreate helper functions using SECURITY DEFINER
-- This means they run as the DB owner, bypassing RLS entirely
-- which breaks the circular dependency
CREATE OR REPLACE FUNCTION current_employee_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM employees WHERE auth_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION current_employee_role()
RETURNS user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM employees WHERE auth_id = auth.uid() LIMIT 1;
$$;

-- Step 4: Re-enable RLS
ALTER TABLE employees       ENABLE ROW LEVEL SECURITY;
ALTER TABLE module_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs      ENABLE ROW LEVEL SECURITY;

-- Step 5: Recreate all policies using the fixed helper functions
-- These now work because current_employee_role() bypasses RLS

-- employees: any authenticated user can read their own row
CREATE POLICY emp_select_own ON employees
  FOR SELECT
  TO authenticated
  USING (auth_id = auth.uid());

-- employees: managers and admins can read ALL rows
CREATE POLICY mgr_select_all ON employees
  FOR SELECT
  TO authenticated
  USING (current_employee_role() IN ('locationManager', 'sysAdmin'));

-- employees: managers and admins can update any row
CREATE POLICY mgr_update ON employees
  FOR UPDATE
  TO authenticated
  USING (current_employee_role() IN ('locationManager', 'sysAdmin'));

-- employees: any employee can update their own row
CREATE POLICY emp_update_own ON employees
  FOR UPDATE
  TO authenticated
  USING (auth_id = auth.uid());

-- employees: only sysAdmin can insert
CREATE POLICY admin_insert ON employees
  FOR INSERT
  TO authenticated
  WITH CHECK (current_employee_role() = 'sysAdmin');

-- employees: only sysAdmin can delete
CREATE POLICY admin_delete ON employees
  FOR DELETE
  TO authenticated
  USING (current_employee_role() = 'sysAdmin');

-- module_progress: employee manages own rows
CREATE POLICY emp_progress_own ON module_progress
  FOR ALL
  TO authenticated
  USING (employee_id = current_employee_id());

-- module_progress: managers can read all
CREATE POLICY mgr_progress_read ON module_progress
  FOR SELECT
  TO authenticated
  USING (current_employee_role() IN ('locationManager', 'sysAdmin'));

-- audit_logs: only sysAdmin can read
CREATE POLICY admin_audit_read ON audit_logs
  FOR SELECT
  TO authenticated
  USING (current_employee_role() = 'sysAdmin');

-- audit_logs: any authenticated user can insert
CREATE POLICY audit_insert ON audit_logs
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Step 6: Grant all functions to authenticated role
GRANT EXECUTE ON FUNCTION current_employee_id()       TO authenticated;
GRANT EXECUTE ON FUNCTION current_employee_role()     TO authenticated;
GRANT EXECUTE ON FUNCTION get_email_by_employee_code(text) TO anon;
GRANT EXECUTE ON FUNCTION get_email_by_employee_code(text) TO authenticated;
GRANT EXECUTE ON FUNCTION save_module_progress(text, jsonb, boolean)               TO authenticated;
GRANT EXECUTE ON FUNCTION write_audit(uuid, text, text, jsonb, jsonb)              TO authenticated;
GRANT EXECUTE ON FUNCTION get_dashboard_data()                                     TO authenticated;
GRANT EXECUTE ON FUNCTION admin_edit_employee(uuid, text, text, int, text, text)   TO authenticated;
GRANT EXECUTE ON FUNCTION admin_reset_password(uuid, text)                         TO authenticated;
GRANT EXECUTE ON FUNCTION admin_delete_employee(uuid)                              TO authenticated;
GRANT EXECUTE ON FUNCTION create_employee(text,text,text,text,int,text,text,user_role,text) TO authenticated;

-- Step 7: Verify everything looks correct
-- Should show both employees with emails and confirmed dates
SELECT
  e.employee_code,
  e.full_name,
  e.role,
  e.auth_id IS NOT NULL AS has_auth,
  u.email,
  u.email_confirmed_at IS NOT NULL AS is_confirmed
FROM employees e
LEFT JOIN auth.users u ON u.id = e.auth_id
ORDER BY e.created_at DESC;
