// api/identify-product.js — improved product identification endpoint
// Uses Supabase client and the live schema: product_photos(id, name, department, category, description, image_path, keywords, sort_order)

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://jookdsjvbticdgvxagyt.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_1emkeuRvXdsF6S-yyxcUeQ_BdUBJ5PF';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { imageUrl, fileName, department, category, query } = req.body || {};

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  let q = supabase
    .from('product_photos')
    .select('id, name, department, category, description, image_path, keywords, sort_order');

  // Filter by department if provided
  if (department) {
    q = q.eq('department', department);
  }

  // Filter by category if provided
  if (category) {
    q = q.eq('category', category);
  }

  // Text search if query provided
  if (query && typeof query === 'string') {
    const term = `%${query}%`;
    q = q.or(`name.ilike.${term},description.ilike.${term},keywords.ilike.${term}`);
  }

  // If only fileName is given, try to match by name
  if (fileName && !query) {
    const term = `%${fileName}%`;
    q = q.or(`name.ilike.${term},description.ilike.${term}`);
  }

  const { data, error } = await q.order('sort_order', { ascending: true }).limit(10);
  if (error) {
    console.error('Identify product error:', error);
    return res.status(500).json({ error: 'Failed to identify product', details: error.message });
  }

  return res.status(200).json({ candidates: data || [] });
}
