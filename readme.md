# Pezzano Supabase Employee Portal

This is a full static replacement for the old name-and-phone login flow.

## Architecture

- Authentication: Supabase Auth email + password.
- Employee identity: `public.employees.employee_id`, generated permanently as `PEZ000001`, `PEZ000002`, etc.
- Auth link: `public.employees.auth_user_id` references `auth.users.id`.
- Profile data: name, phone, department, position, role, and status live in `public.employees`.
- Induction state: `public.induction_records`.
- Audit trail: `public.audit_logs`, written by database triggers.
- Hosting: static HTML/CSS/JS on Netlify.

Password auth is used instead of full name + phone, because it works reliably on shared warehouse devices, supports password reset, and does not break when managers update employee profile data.

## Setup

1. Create a Supabase project.
2. Open Supabase SQL Editor and run `schema.sql`.
3. In Supabase Dashboard > Authentication > Users, create your first admin user.
4. Copy that user's UUID.
5. Run the bootstrap SQL at the bottom of `schema.sql`, replacing the UUID, email, and name.
6. Open `config.js` and replace:
   - `supabaseUrl`
   - `supabaseAnonKey`
7. Deploy this folder to Netlify.

The login form will not submit until `config.js` contains real Supabase values. The anon key is safe to place in browser code; the service role key is not.

## Employee Onboarding

1. A manager signs in.
2. The manager creates an employee record with the employee's email.
3. The employee opens the portal and uses "First-time setup" with that same email.
4. Supabase Auth creates the login account.
5. The database trigger links `auth.users.id` to the existing employee record.

## Security Notes

- Never expose the Supabase `service_role` key in frontend code.
- Keep Row Level Security enabled.
- Require email confirmation in Supabase Auth settings for production.
- Use Supabase Dashboard or a server-side function for password resets and emergency admin recovery.
- Location Managers can create and manage normal employee records, but only System Administrators can grant or change elevated portal roles; that is enforced by a database trigger.
