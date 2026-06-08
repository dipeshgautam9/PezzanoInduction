window.PEZZANO_CONFIG = {
  // Replace these two values with Supabase Dashboard > Project Settings > API.
  // This is the public anon key. Never put a service_role key in frontend code.
  supabaseUrl: 'https://YOUR-PROJECT-REF.supabase.co',
  supabaseAnonKey: 'YOUR-SUPABASE-ANON-KEY',

  // Password auth is the best default for a warehouse portal:
  // it works on shared devices, does not rely on SMS reception, and can be reset centrally.
  authMode: 'password'
};
