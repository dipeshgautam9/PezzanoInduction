-- ============================================================
-- STEP 3: Create System Administrator employee row
-- IMPORTANT: Replace <PASTE_UUID_HERE> with the UUID from
-- Supabase → Authentication → Users after you create the
-- admin@pezzano.com.au user there first.
-- ============================================================

INSERT INTO employees (
  auth_id,
  employee_code,
  full_name,
  role,
  department,
  position,
  work_location
)
VALUES (
  '<PASTE_UUID_HERE>',
  'ADMIN001',
  'System Administrator',
  'sysAdmin',
  'Admin',
  'System Administrator',
  'Canning Vale'
);

-- Confirm it was inserted:
SELECT id, employee_code, full_name, role FROM employees;
