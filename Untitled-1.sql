-- ============================================================
-- FIX: Employee login - function not accessible before auth
-- Run in Supabase SQL Editor → New Query → Run
-- ============================================================

-- Step 1: Recreate the lookup function with proper permissions
-- Using SECURITY DEFINER so it runs as DB owner (bypasses auth)
DROP FUNCTION IF EXISTS get_email_by_employee_code(text);

CREATE OR REPLACE FUNCTION get_email_by_employee_code(p_code text)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.email
  FROM employees e
  JOIN auth.users u ON u.id = e.auth_id
  WHERE UPPER(e.employee_code) = UPPER(p_code)
  LIMIT 1;
$$;

-- Step 2: Grant to both anon and authenticated
REVOKE ALL ON FUNCTION get_email_by_employee_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_email_by_employee_code(text) TO anon;
GRANT EXECUTE ON FUNCTION get_email_by_employee_code(text) TO authenticated;
GRANT EXECUTE ON FUNCTION get_email_by_employee_code(text) TO service_role;

-- Step 3: Test it directly — should return the email for EMP824428
SELECT get_email_by_employee_code('EMP824428') AS result;
