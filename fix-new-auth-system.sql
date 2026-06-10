-- ============================================================
-- NEW AUTH SYSTEM: Email + Password for everyone
-- Fixes create_employee to use Supabase Admin API properly
-- Run in Supabase SQL Editor → New Query → Run
-- ============================================================

-- Step 1: Drop old create_employee versions
DROP FUNCTION IF EXISTS create_employee(text,text,text,text,int,text,text,user_role,text) CASCADE;
DROP FUNCTION IF EXISTS create_employee(text,text,text,int,text,text,user_role,text) CASCADE;

-- Step 2: New create_employee - links to existing auth user by email
-- Admin creates auth user in Supabase Dashboard first, then calls this
CREATE OR REPLACE FUNCTION create_employee(
  p_email         text,
  p_full_name     text,
  p_phone         text,
  p_age           int,
  p_department    text,
  p_position      text,
  p_role          user_role DEFAULT 'employee',
  p_work_location text DEFAULT 'Canning Vale'
)
RETURNS json LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_auth_id   uuid;
  v_emp_code  text;
  v_emp_id    uuid;
  v_clean_email text := lower(trim(p_email));
BEGIN
  IF current_employee_role() != 'sysAdmin' THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  -- Find existing auth user by email
  SELECT id INTO v_auth_id
  FROM auth.users
  WHERE lower(email) = v_clean_email
  LIMIT 1;

  IF v_auth_id IS NULL THEN
    RAISE EXCEPTION 'No auth user found with email %. Create the user in Supabase Dashboard → Authentication → Users first.', v_clean_email;
  END IF;

  -- Check not already linked
  IF EXISTS (SELECT 1 FROM employees WHERE auth_id = v_auth_id) THEN
    RAISE EXCEPTION 'This email is already linked to an employee record.';
  END IF;

  -- Generate unique employee code
  v_emp_code := 'EMP' || LPAD(FLOOR(RANDOM() * 900000 + 100000)::text, 6, '0');
  WHILE EXISTS (SELECT 1 FROM employees WHERE employee_code = v_emp_code) LOOP
    v_emp_code := 'EMP' || LPAD(FLOOR(RANDOM() * 900000 + 100000)::text, 6, '0');
  END LOOP;

  -- Create employee profile
  INSERT INTO employees (
    auth_id, employee_code, full_name, phone, age,
    department, position, role, work_location
  )
  VALUES (
    v_auth_id, v_emp_code, p_full_name, p_phone, p_age,
    p_department, p_position, p_role, p_work_location
  )
  RETURNING id INTO v_emp_id;

  RETURN json_build_object(
    'employee_id',   v_emp_id,
    'employee_code', v_emp_code,
    'auth_linked',   true
  );
END;
$$;

GRANT EXECUTE ON FUNCTION create_employee(text,text,text,int,text,text,user_role,text) TO authenticated;

-- Step 3: Fix existing broken employee accounts
-- Kazi - relink to her confirmed auth user
UPDATE employees SET auth_id = (
  SELECT id FROM auth.users WHERE lower(email) = 'kazi@pezzano.com.au' LIMIT 1
)
WHERE employee_code = 'EMP824428'
  AND (auth_id IS NULL OR auth_id != (SELECT id FROM auth.users WHERE lower(email) = 'kazi@pezzano.com.au' LIMIT 1));

-- Gautam Dipesh - relink
UPDATE employees SET auth_id = (
  SELECT id FROM auth.users WHERE lower(email) = 'acharyasujal765@gmail.com' LIMIT 1
)
WHERE employee_code = 'EMP231565'
  AND (auth_id IS NULL OR auth_id != (SELECT id FROM auth.users WHERE lower(email) = 'acharyasujal765@gmail.com' LIMIT 1));

-- Step 4: Final verification
SELECT
  e.employee_code,
  e.full_name,
  e.role,
  u.email,
  u.email_confirmed_at IS NOT NULL AS confirmed,
  e.auth_id IS NOT NULL AS linked
FROM employees e
LEFT JOIN auth.users u ON u.id = e.auth_id
ORDER BY e.created_at;
