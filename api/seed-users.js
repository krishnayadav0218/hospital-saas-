// POST (or GET) /api/seed-users
//
// Reads the following environment variables (set in Vercel → Project
// Settings → Environment Variables) and makes sure each account exists in
// Supabase Auth with that exact password and role. If an account already
// exists, its password is reset to match whatever is currently in the env
// var — so changing a password is just: update the env var → redeploy (or
// let Vercel pick it up) → call this endpoint again.
//
//   SEED_SECRET                 required — a long random string only you know
//   SUPABASE_URL                required — same project URL as config.js
//   SUPABASE_SERVICE_ROLE_KEY   required — Supabase → Project Settings → API → service_role (SECRET, never in config.js)
//
//   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD / SEED_ADMIN_NAME
//   SEED_DOCTOR_EMAIL / SEED_DOCTOR_PASSWORD / SEED_DOCTOR_NAME
//   SEED_RECEPTIONIST_EMAIL / SEED_RECEPTIONIST_PASSWORD / SEED_RECEPTIONIST_NAME
//   SEED_ACCOUNT_EMAIL / SEED_ACCOUNT_PASSWORD / SEED_ACCOUNT_NAME
//
// Any role slot left unset (no _EMAIL/_PASSWORD) is skipped, so you don't
// have to seed all four — set only the ones you want.
//
// Call it like:
//   curl -X POST https://your-site.vercel.app/api/seed-users \
//        -H "x-seed-secret: <your SEED_SECRET value>"
//
// Do this once after first deploy, and again any time you change one of
// the SEED_*_PASSWORD env vars.

const { getAdminClient, findUserByEmail } = require('./_supabaseAdmin');

const ROLE_SLOTS = [
  { role: 'admin', prefix: 'SEED_ADMIN' },
  { role: 'doctor', prefix: 'SEED_DOCTOR' },
  { role: 'receptionist', prefix: 'SEED_RECEPTIONIST' },
  { role: 'account', prefix: 'SEED_ACCOUNT' },
];

module.exports = async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed. Use POST (or GET) with the x-seed-secret header.' });
    return;
  }

  const secret = process.env.SEED_SECRET;
  const provided = req.headers['x-seed-secret'] || (req.query && req.query.secret);
  if (!secret) {
    res.status(500).json({ error: 'SEED_SECRET is not set on the server. Add it in Vercel env vars first.' });
    return;
  }
  if (!provided || provided !== secret) {
    res.status(401).json({ error: 'Missing or incorrect seed secret.' });
    return;
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    res.status(500).json({ error: e.message });
    return;
  }

  const results = [];
  for (const slot of ROLE_SLOTS) {
    const email = process.env[`${slot.prefix}_EMAIL`];
    const password = process.env[`${slot.prefix}_PASSWORD`];
    const fullName =
      process.env[`${slot.prefix}_NAME`] ||
      slot.role.charAt(0).toUpperCase() + slot.role.slice(1);

    if (!email || !password) {
      results.push({ role: slot.role, skipped: true, reason: `set ${slot.prefix}_EMAIL and ${slot.prefix}_PASSWORD to seed this role` });
      continue;
    }

    try {
      const existing = await findUserByEmail(admin, email);
      if (!existing) {
        const { data, error } = await admin.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { full_name: fullName },
        });
        if (error) throw error;
        const { error: profErr } = await admin
          .from('profiles')
          .upsert({ id: data.user.id, full_name: fullName, role: slot.role });
        if (profErr) throw profErr;
        results.push({ role: slot.role, email, action: 'created' });
      } else {
        const { error: updErr } = await admin.auth.admin.updateUserById(existing.id, {
          password,
          email_confirm: true,
        });
        if (updErr) throw updErr;
        const { error: profErr } = await admin
          .from('profiles')
          .upsert({ id: existing.id, full_name: fullName, role: slot.role });
        if (profErr) throw profErr;
        results.push({ role: slot.role, email, action: 'password synced' });
      }
    } catch (e) {
      results.push({ role: slot.role, email, error: e.message || String(e) });
    }
  }

  res.status(200).json({ ok: true, results });
};
