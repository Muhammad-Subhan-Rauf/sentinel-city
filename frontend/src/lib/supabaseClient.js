// ============================================================
// Sentinel-City — Supabase Client
// Singleton pattern so we don't create multiple GoTrue clients.
// ============================================================

import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    '[Sentinel-City] Missing Supabase env vars. ' +
    'Copy frontend/.env.example → .env and fill in your keys.'
  )
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey)
