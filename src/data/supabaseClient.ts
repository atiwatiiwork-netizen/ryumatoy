import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * Supabase client — the single connection to the cloud database. URL + anon key
 * come from NEXT_PUBLIC_ env vars (.env.local for dev, the Vercel dashboard for
 * prod). The anon key is safe in the browser bundle. When unset, the app runs on
 * the localStorage seed (preview mode).
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const hasSupabase = Boolean(url && key);

export const supabase: SupabaseClient | null = hasSupabase
  ? createClient(url as string, key as string, { auth: { persistSession: true } })
  : null;
