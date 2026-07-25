// ─────────────────────────────────────────────────────────────
// MedGrid — Supabase connection settings
// ─────────────────────────────────────────────────────────────
// Get these two values from your Supabase project:
//   Supabase Dashboard → Project Settings → API
//     - "Project URL"        → SUPABASE_URL
//     - "anon" "public" key  → SUPABASE_ANON_KEY
//
// This file is loaded as a plain <script> before the app runs, so the
// values just need to be valid JS strings. The anon key is safe to expose
// in frontend code — it is the public, rate-limited key Supabase is
// designed to have shipped to browsers. It is NOT the service_role key
// (never put the service_role key in frontend code).
// ─────────────────────────────────────────────────────────────

window.SUPABASE_URL = "YOUR_SUPABASE_PROJECT_URL";
window.SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_PUBLIC_KEY";
