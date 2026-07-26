// POST /api/admin-users
// Body: { "action": "create" | "setPassword" | "delete", "payload": {...} }
// Header: Authorization: Bearer <the calling user's Supabase access_token>
//
// This is the endpoint index.html calls from the Users page so an admin can
// create a new login, change someone's password, or delete a login entirely
// — none of which the anon key can do from the browser. Every request is
// re-verified server-side (valid session + role === 'admin' in `profiles`)
// using the service_role key, so it's safe to call from the browser even
// though the browser is untrusted.
//
// Requires the same env vars as seed-users.js:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { getAdminClient } = require('./_supabaseAdmin');

async function requireAdmin(req, admin) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return { error: 'Missing Authorization bearer token.' };

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData || !userData.user) return { error: 'Invalid or expired session — please sign in again.' };

  const { data: profile, error: profErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', userData.user.id)
    .maybeSingle();
  if (profErr) return { error: profErr.message };
  if (!profile || profile.role !== 'admin') return { error: 'Only an admin can manage users.' };

  return { user: userData.user };
}

function getJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_e) { return {}; }
  }
  return {};
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    res.status(500).json({ error: e.message });
    return;
  }

  const auth = await requireAdmin(req, admin);
  if (auth.error) {
    res.status(403).json({ error: auth.error });
    return;
  }

  const { action, payload } = getJsonBody(req);

  try {
    if (action === 'create') {
      const { email, password, fullName, role } = payload || {};
      if (!email || !password || !role) throw new Error('email, password and role are required.');
      if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');

      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName || email.split('@')[0] },
      });
      if (error) throw error;

      const { error: profErr } = await admin
        .from('profiles')
        .upsert({ id: data.user.id, full_name: fullName || email.split('@')[0], role });
      if (profErr) throw profErr;

      res.status(200).json({ ok: true, id: data.user.id });
      return;
    }

    if (action === 'setPassword') {
      const { userId, password } = payload || {};
      if (!userId || !password) throw new Error('userId and password are required.');
      if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');

      const { error } = await admin.auth.admin.updateUserById(userId, { password });
      if (error) throw error;

      res.status(200).json({ ok: true });
      return;
    }

    if (action === 'delete') {
      const { userId } = payload || {};
      if (!userId) throw new Error('userId is required.');
      if (userId === auth.user.id) throw new Error("You can't delete your own account while signed in as it.");

      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
      // `profiles.id` has "on delete cascade" against auth.users, so the
      // profile row is removed automatically — no separate cleanup needed.

      res.status(200).json({ ok: true });
      return;
    }

    throw new Error('Unknown action: ' + action);
  } catch (e) {
    res.status(400).json({ error: e.message || String(e) });
  }
};
