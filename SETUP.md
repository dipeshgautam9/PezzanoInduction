# Pezzano Induction Portal — Supabase + Netlify Setup Guide

## Files in this package
| File | Purpose |
|------|---------|
| `schema.sql` | Run first — creates all tables, triggers, RLS, indexes |
| `supabase-rpc.sql` | Run second — creates all RPC functions |
| `login.html` | Login page (employee code + password OR manager email + password) |
| `dashboard.html` | Main portal (works for employees AND managers/admins) |
| `session.js` | Shared auth helpers — included on every page |
| `netlify.toml` | Security headers and redirect rules for Netlify |

---

## Step 1 — Create Supabase Project
1. Go to https://supabase.com → New project
2. Name it `pezzano-induction` → choose a strong DB password → region: Asia Pacific (Sydney)
3. Wait for project to provision

## Step 2 — Run SQL
1. In Supabase Dashboard → SQL Editor
2. Paste and run `schema.sql` → click Run
3. Paste and run `supabase-rpc.sql` → click Run

## Step 3 — Create System Administrator account
1. Supabase Dashboard → Authentication → Users → Invite User
2. Email: `admin@pezzano.com.au` → set a strong password
3. Copy the UUID shown for that user
4. In SQL Editor, run:
```sql
INSERT INTO employees (auth_id, employee_code, full_name, role, department, position, work_location)
VALUES ('<PASTE_UUID_HERE>', 'ADMIN001', 'System Administrator', 'sysAdmin', 'Admin', 'System Administrator', 'Canning Vale');
```

## Step 4 — Add your Supabase keys to the code
In both `login.html` and `session.js`, replace:
```
const SUPABASE_URL = 'https://YOUR_PROJECT_REF.supabase.co';
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
```
Find these in: Supabase Dashboard → Settings → API → Project URL and anon/public key.

## Step 5 — Deploy to Netlify
1. Go to https://netlify.com → Add new site → Deploy manually
2. Drag and drop this entire folder into Netlify
3. Your site goes live instantly at a `.netlify.app` URL
4. Optional: add a custom domain in Netlify → Domain settings

## Step 6 — Add first employees
1. Sign in to the portal with the System Administrator account
2. Go to Dashboard → Add Staff → fill in the form
3. The system auto-generates an Employee Code (e.g. EMP382910)
4. Give the employee their code and temporary password
5. Employee signs in via the Employee tab using their code + password

---

## How login works (secure design)
| Role | Login method | Identity used |
|------|-------------|---------------|
| Employee | Employee Code + Password | Code never changes even if name/phone edited |
| Manager / Admin | Work Email + Password | Standard Supabase Auth |

**Changing an employee's name or phone has ZERO effect on their login.**
The Employee Code is permanent and is the only login identifier.

## Cross-browser sync
Because all data is in Supabase (not localStorage), any browser, any device, any phone
automatically shows the same progress — as long as the employee signs in with their code.

## Security features built in
- Passwords hashed with bcrypt in Supabase Auth
- Row Level Security: employees can ONLY read their own data
- Start date and induction date locked by a database trigger — cannot be changed by anyone
- All admin changes recorded in `audit_logs` table
- JWT sessions expire after 1 hour (configurable in Supabase Auth settings)
- Security headers set via `netlify.toml`
