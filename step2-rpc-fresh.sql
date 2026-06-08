-- ============================================================
-- STEP 2: RPC Functions — paste in a NEW query tab and Run
-- This is safe to run multiple times (uses CREATE OR REPLACE)
-- ============================================================

-- 1. Employee code → email lookup (used by login page)
CREATE OR REPLACE FUNCTION get_email_by_employee_code(p_code text)
RETURNS text LANGUAGE sql SECURITY DEFINER AS $$
  SELECT u.email
  FROM employees e
  JOIN auth.users u ON u.id = e.auth_id
  WHERE UPPER(e.employee_code) = UPPER(p_code)
  LIMIT 1;
$$;

-- 2. Helper: get current user's employee id
CREATE OR REPLACE FUNCTION current_employee_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT id FROM employees WHERE auth_id = auth.uid() LIMIT 1;
$$;

-- 3. Helper: get current user's role
CREATE OR REPLACE FUNCTION current_employee_role()
RETURNS user_role LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT role FROM employees WHERE auth_id = auth.uid() LIMIT 1;
$$;

-- 4. Create a new employee + auth user (sysAdmin only)
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
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_auth_id   uuid;
  v_emp_code  text;
  v_emp_id    uuid;
BEGIN
  IF current_employee_role() != 'sysAdmin' THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  -- Generate unique employee code
  v_emp_code := 'EMP' || LPAD(FLOOR(RANDOM() * 900000 + 100000)::text, 6, '0');
  WHILE EXISTS (SELECT 1 FROM employees WHERE employee_code = v_emp_code) LOOP
    v_emp_code := 'EMP' || LPAD(FLOOR(RANDOM() * 900000 + 100000)::text, 6, '0');
  END LOOP;

  -- Create auth user
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
    p_email,
    crypt(p_password, gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}',
    '{}', false, ''
  )
  RETURNING id INTO v_auth_id;

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
    'employee_code', v_emp_code
  );
END;
$$;

-- 5. Get full dashboard data for managers
CREATE OR REPLACE FUNCTION get_dashboard_data()
RETURNS json LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_role   user_role;
  v_result json;
BEGIN
  v_role := current_employee_role();
  IF v_role NOT IN ('locationManager','sysAdmin') THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  SELECT json_agg(row_to_json(t)) INTO v_result FROM (
    SELECT
      e.id, e.employee_code, e.full_name, e.phone, e.age,
      e.work_location, e.department, e.position, e.role,
      e.start_date, e.induction_date,
      e.completion_status, e.completion_date,
      e.progress_pct, e.employee_signature,
      e.supervisor_name, e.supervisor_signature
    FROM employees e
    ORDER BY e.created_at DESC
  ) t;

  RETURN COALESCE(v_result, '[]'::json);
END;
$$;

-- 6. Save module progress and recalculate overall percentage
CREATE OR REPLACE FUNCTION save_module_progress(
  p_module_id  text,
  p_answers    jsonb,
  p_completed  boolean
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_emp_id uuid := current_employee_id();
  v_total  int  := 12;
  v_done   int;
  v_pct    int;
BEGIN
  INSERT INTO module_progress (
    employee_id, module_id, answers, completed, completed_at
  )
  VALUES (
    v_emp_id, p_module_id, p_answers, p_completed,
    CASE WHEN p_completed THEN now() ELSE NULL END
  )
  ON CONFLICT (employee_id, module_id) DO UPDATE
    SET answers      = EXCLUDED.answers,
        completed    = EXCLUDED.completed,
        completed_at = CASE
          WHEN EXCLUDED.completed AND module_progress.completed_at IS NULL
          THEN now()
          ELSE module_progress.completed_at
        END,
        updated_at = now();

  SELECT COUNT(*) INTO v_done
  FROM module_progress
  WHERE employee_id = v_emp_id AND completed = true;

  v_pct := ROUND(v_done::numeric / v_total * 100);

  UPDATE employees
  SET
    progress_pct      = v_pct,
    completion_status = CASE
      WHEN v_pct = 0                                          THEN 'pending'::induction_status
      WHEN completion_status = 'completed'::induction_status  THEN 'completed'::induction_status
      ELSE 'in_progress'::induction_status
    END
  WHERE id = v_emp_id;
END;
$$;

-- 7. Write audit log entry
CREATE OR REPLACE FUNCTION write_audit(
  p_target_id  uuid,
  p_action     text,
  p_detail     text,
  p_old_value  jsonb DEFAULT NULL,
  p_new_value  jsonb DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_actor employees%ROWTYPE;
BEGIN
  SELECT * INTO v_actor FROM employees WHERE id = current_employee_id();
  INSERT INTO audit_logs (
    actor_id, actor_name, actor_role,
    target_id, action, detail, old_value, new_value
  )
  VALUES (
    v_actor.id, v_actor.full_name, v_actor.role::text,
    p_target_id, p_action, p_detail, p_old_value, p_new_value
  );
END;
$$;

-- 8. SysAdmin: edit employee profile (never touches dates)
CREATE OR REPLACE FUNCTION admin_edit_employee(
  p_emp_id     uuid,
  p_full_name  text,
  p_phone      text,
  p_age        int,
  p_position   text,
  p_department text
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_old employees%ROWTYPE;
BEGIN
  IF current_employee_role() != 'sysAdmin' THEN
    RAISE EXCEPTION 'Permission denied';
  END IF;

  SELECT * INTO v_old FROM employees WHERE id = p_emp_id;

  UPDATE employees
  SET full_name  = p_full_name,
      phone      = p_phone,
      age        = p_age,
      position   = p_position,
      department = p_department
  WHERE id = p_emp_id;

  PERFORM write_audit(
    p_emp_id, 'profile_edited', 'SysAdmin edited employee profile',
    json_build_object('full_name',v_old.full_name,'phone',v_old.phone,
      'age',v_old.age,'position',v_old.position,'department',v_old.department)::jsonb,
    json_build_object('full_name',p_full_name,'phone',p_phone,
      'age',p_age,'position',p_position,'department',p_department)::jsonb
  );
END;
$$;

-- 9. SysAdmin: reset employee password
CREATE OR REPLACE FUNCTION admin_reset_password(p_emp_id uuid, p_new_password text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_auth_id uuid;
BEGIN
  IF current_employee_role() != 'sysAdmin' THEN RAISE EXCEPTION 'Permission denied'; END IF;
  SELECT auth_id INTO v_auth_id FROM employees WHERE id = p_emp_id;
  UPDATE auth.users
  SET encrypted_password = crypt(p_new_password, gen_salt('bf'))
  WHERE id = v_auth_id;
  PERFORM write_audit(p_emp_id,'password_reset','SysAdmin reset employee password',NULL,NULL);
END;
$$;

-- 10. SysAdmin: delete employee
CREATE OR REPLACE FUNCTION admin_delete_employee(p_emp_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_auth_id uuid;
  v_name    text;
  v_actor   employees%ROWTYPE;
BEGIN
  IF current_employee_role() != 'sysAdmin' THEN RAISE EXCEPTION 'Permission denied'; END IF;
  SELECT auth_id, full_name INTO v_auth_id, v_name FROM employees WHERE id = p_emp_id;
  SELECT * INTO v_actor FROM employees WHERE id = current_employee_id();
  DELETE FROM employees WHERE id = p_emp_id;
  IF v_auth_id IS NOT NULL THEN DELETE FROM auth.users WHERE id = v_auth_id; END IF;
  INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, detail)
  VALUES (v_actor.id, v_actor.full_name, v_actor.role::text,
    'employee_deleted', 'Deleted: ' || v_name);
END;
$$;

-- ── Final check: shows all 10 functions if successful ─────────
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'get_email_by_employee_code','current_employee_id',
    'current_employee_role','create_employee',
    'get_dashboard_data','save_module_progress',
    'write_audit','admin_edit_employee',
    'admin_reset_password','admin_delete_employee'
  )
ORDER BY routine_name;
