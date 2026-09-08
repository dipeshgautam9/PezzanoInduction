// config.js — Corrected for Pezzano Enterprise Warehouse Induction
// Supabase project: jookdsjvbticdgvxagyt (ap-southeast-2)

const SUPABASE_URL = "https://jookdsjvbticdgvxagyt.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_1emkeuRvXdsF6S-yyxcUeQ_BdUBJ5PF";

// Legacy anon key (still supported, but publishable key is preferred)
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impvb2tkc2p2YnRpY2RndnhhZ3l0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA5MDI2ODEsImV4cCI6MjA5NjQ3ODY4MX0.HZlGlzCmloaHgY2vvIZx3Y1UEZaQ8h1PYz-Fj45aQTg";

// Export for browser usage
if (typeof window !== "undefined") {
  window.SUPABASE_URL = SUPABASE_URL;
  window.SUPABASE_PUBLISHABLE_KEY = SUPABASE_PUBLISHABLE_KEY;
  window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;
}