-- ============================================================
-- PEZZANO FINAL SAFE SQL
-- Use this in Supabase SQL Editor
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Helper: current employee id
CREATE OR REPLACE FUNCTION current_employee_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT id
  FROM public.employees
  WHERE auth_id = auth.uid()
  LIMIT 1;
$$;

-- Helper: current employee role
CREATE OR REPLACE FUNCTION current_employee_role()
RETURNS user_role
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT role
  FROM public.employees
  WHERE auth_id = auth.uid()
  LIMIT 1;
$$;

-- Employee code -> email lookup
DROP FUNCTION IF EXISTS get_email_by_employee_code(text);
CREATE OR REPLACE FUNCTION get_email_by_employee_code(p_code text)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT u.email::text
  FROM public.employees e
  JOIN auth.users u ON u.id = e.auth_id
  WHERE UPPER(TRIM(e.employee_code)) = UPPER(TRIM(p_code))
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION get_email_by_employee_code(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_email_by_employee_code(text) TO anon;
GRANT EXECUTE ON FUNCTION get_email_by_employee_code(text) TO authenticated;
GRANT EXECUTE ON FUNCTION current_employee_id() TO authenticated;
GRANT EXECUTE ON FUNCTION current_employee_role() TO authenticated;

-- Create employee + auth user (sysAdmin only)
DROP FUNCTION IF EXISTS create_employee(text,text,text,text,int,text,text,user_role,text);
CREATE OR REPLACE FUNCTION create_employee(
  p_email         text,
  p_password      text,
  p_full_name     text,
  p_phone         text,
  p_age           int,
  p_department    text,
  p_position      text,
  p_role          user_role DEFAULT 'employee',
  p_work_location text DEFAULT 'Canning Vale'
)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, extensions
AS $$
DECLARE
  v_auth_id uuid;
  v_emp_code text;
  v_emp_id uuid;
  v_clean_email text := lower(trim(p_email));
BEGIN
  IF current_employee_role() != 'sysAdmin' THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  IF v_clean_email IS NULL OR v_clean_email = '' THEN
    RAISE EXCEPTION 'Email is required';
  END IF;

  IF p_password IS NULL OR length(p_password) < 6 THEN
    RAISE EXCEPTION 'Password must be at least 6 characters';
  END IF;

  SELECT id INTO v_auth_id
  FROM auth.users
  WHERE lower(email) = v_clean_email
  LIMIT 1;

  IF v_auth_id IS NULL THEN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      is_super_admin, confirmation_token
    )
    VALUES (
      '00000000-0000-0000-0000-000000000000',
      gen_random_uuid(),
      'authenticated', 'authenticated',
      v_clean_email,
      crypt(p_password, gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      '{}'::jsonb,
      false,
      ''
    )
    RETURNING id INTO v_auth_id;
  END IF;

  SELECT 'EMP' || LPAD(FLOOR(RANDOM() * 900000 + 100000)::text, 6, '0') INTO v_emp_code;
  WHILE EXISTS (SELECT 1 FROM employees WHERE employee_code = v_emp_code) LOOP
    SELECT 'EMP' || LPAD(FLOOR(RANDOM() * 900000 + 100000)::text, 6, '0') INTO v_emp_code;
  END LOOP;

  INSERT INTO employees (
    auth_id, employee_code, full_name, phone, age,
    work_location, department, position, role
  )
  VALUES (
    v_auth_id, v_emp_code, p_full_name, p_phone, p_age,
    p_work_location, p_department, p_position, p_role
  )
  RETURNING id INTO v_emp_id;

  RETURN json_build_object(
    'employee_id', v_emp_id,
    'employee_code', v_emp_code,
    'auth_id', v_auth_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION create_employee(text,text,text,text,int,text,text,user_role,text) TO authenticated;

-- Basic verification
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
AND routine_name IN (
  'current_employee_id',
  'current_employee_role',
  'get_email_by_employee_code',
  'create_employee'
)
ORDER BY routine_name;
