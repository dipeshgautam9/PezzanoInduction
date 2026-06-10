# Supabase URL Configuration for Password Reset

Go to:
Supabase Dashboard → Authentication → URL Configuration

Set these EXACTLY:

Site URL:
https://pezzano-portal.vercel.app

Redirect URLs (add both):
https://pezzano-portal.vercel.app
https://pezzano-portal.vercel.app/**

Save.

Then go to:
Authentication → Providers → Email

Make sure:
- "Confirm email" = OFF (so new accounts work immediately)
- "Secure email change" = ON
- "Enable email provider" = ON

Save.

Then go to:
Authentication → Email Templates → Reset Password

The default template is fine. It will send a link to the employee's Gmail.
When they click the link, it redirects back to your portal where they can set a new password.
