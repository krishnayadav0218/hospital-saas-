// Server-only helper. Never import this from frontend code (index.html) —
// it uses the Supabase service_role key, which can bypass Row Level
// Security entirely and must never reach the browser.
const { createClient } = require('@supabase/supabase-js');

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set as Vercel ' +
      'environment variables (Project Settings → Environment Variables).'
    );
  }
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Supabase's admin API has no direct "get user by email" call, so we page
// through auth.users and match by email. Fine for staff-sized user counts.
async function findUserByEmail(admin, email) {
  const target = String(email || '').trim().toLowerCase();
  if (!target) return null;
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const found = data.users.find((u) => (u.email || '').toLowerCase() === target);
    if (found) return found;
    if (!data.users.length || data.users.length < perPage) return null;
    page += 1;
  }
}

module.exports = { getAdminClient, findUserByEmail };
