// POST /api/send-reminder
// Body: { "to": "+91XXXXXXXXXX", "message": "...", "channel": "whatsapp" | "sms" }
// Header: Authorization: Bearer <the calling user's Supabase access_token>
//
// Sends a WhatsApp or SMS message via Twilio's REST API. Any signed-in,
// non-pending staff member can use this (not just admins) — receptionists
// and doctors are usually the ones actually sending appointment reminders.
// The Twilio credentials stay server-side; the browser never sees them.
//
// Requires (Vercel → Project Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (same as the other api/ functions — used only to verify the caller)
//   TWILIO_ACCOUNT_SID                        Twilio Console → Account SID
//   TWILIO_AUTH_TOKEN                         Twilio Console → Auth Token
//   TWILIO_WHATSAPP_FROM                      e.g. "whatsapp:+14155238886" (Twilio's sandbox number, or your approved WhatsApp sender)
//   TWILIO_SMS_FROM                           e.g. "+14155551234" (a Twilio phone number with SMS enabled) — optional if you only use WhatsApp
//
// If Twilio env vars aren't set, this endpoint returns a clear error
// instead of silently failing, so the UI can tell the admin what to do.

const { getAdminClient } = require('./_supabaseAdmin');

async function requireActiveStaff(req, admin) {
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
  if (!profile || profile.role === 'pending') return { error: 'Your account has no role assigned yet.' };

  return { user: userData.user, role: profile.role };
}

function getJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_e) { return {}; }
  }
  return {};
}

// Normalizes to E.164-ish (assumes India +91 if no country code given —
// change this default if most of your patients aren't in India).
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) return p;
  if (p.length === 10) return '+91' + p;
  return '+' + p;
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

  const auth = await requireActiveStaff(req, admin);
  if (auth.error) {
    res.status(403).json({ error: auth.error });
    return;
  }

  const { to, message, channel } = getJsonBody(req);
  if (!to || !message) {
    res.status(400).json({ error: 'to and message are required.' });
    return;
  }
  const useChannel = channel === 'sms' ? 'sms' : 'whatsapp';

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = useChannel === 'whatsapp' ? process.env.TWILIO_WHATSAPP_FROM : process.env.TWILIO_SMS_FROM;
  if (!accountSid || !authToken || !fromNumber) {
    res.status(500).json({
      error: `Reminders aren't set up yet — ask your admin to add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and ${useChannel === 'whatsapp' ? 'TWILIO_WHATSAPP_FROM' : 'TWILIO_SMS_FROM'} in Vercel (see README).`,
    });
    return;
  }

  const toNormalized = normalizePhone(to);
  if (!toNormalized) {
    res.status(400).json({ error: 'That phone number looks invalid.' });
    return;
  }
  const toField = useChannel === 'whatsapp' ? `whatsapp:${toNormalized}` : toNormalized;

  try {
    const body = new URLSearchParams({ To: toField, From: fromNumber, Body: message });
    const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
      },
      body: body.toString(),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(data.message || `Twilio rejected the message (status ${resp.status}).`);
    }
    res.status(200).json({ ok: true, sid: data.sid, status: data.status });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not send the message. Please try again.' });
  }
};
