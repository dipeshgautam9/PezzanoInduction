-- ============================================================
-- STEP 1: Run this first to check what already exists
-- Supabase SQL Editor → New Query → paste → Run
-- ============================================================

-- Check tables
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public'
ORDER BY table_name;
