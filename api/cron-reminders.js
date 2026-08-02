// GET /api/cron-reminders
// Triggered automatically by Vercel Cron (see the "crons" entry in
// vercel.json — runs daily at 02:30 UTC / ~08:00 IST). Sends a WhatsApp
// reminder for every appointment scheduled *today*, across every
// hospital in the project, so reception doesn't have to click the 📱
// button one-by-one every morning.
//
// This reuses the same Twilio setup as api/send-reminder.js — no extra
// env vars needed beyond what that feature already requires:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM
//
// Vercel automatically sends `Authorization: Bearer <CRON_SECRET>` on
// cron-triggered requests once you set a CRON_SECRET env var — this
// endpoint checks for that, so nobody else can trigger it by guessing
// the URL. (If CRON_SECRET isn't set, Vercel's own cron dashboard still
// only fires it from Vercel's infrastructure, but setting CRON_SECRET
// is the documented way to make that verifiable here too.)

const { getAdminClient } = require('./_supabaseAdmin');

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return null;
  if (p.startsWith('+')) return p;
  if (p.length === 10) return '+91' + p;
  return '+' + p;
}

async function sendWhatsApp(to, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM;
  if (!accountSid || !authToken || !fromNumber) throw new Error('Twilio env vars not configured');
  const toNormalized = normalizePhone(to);
  if (!toNormalized) throw new Error('invalid phone number');
  const body = new URLSearchParams({ To: `whatsapp:${toNormalized}`, From: fromNumber, Body: message });
  const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64'),
    },
    body: body.toString(),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.message || `Twilio status ${resp.status}`);
  return data;
}

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${cronSecret}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    res.status(500).json({ error: e.message });
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const results = [];

  try {
    const { data: hospitals, error: hErr } = await admin.from('hospitals').select('id, name');
    if (hErr) throw hErr;

    for (const hosp of hospitals || []) {
      const [{ data: apptRow }, { data: patRow }, { data: docRow }] = await Promise.all([
        admin.from('hospital_data').select('value').eq('hospital_id', hosp.id).eq('category', 'appointments').maybeSingle(),
        admin.from('hospital_data').select('value').eq('hospital_id', hosp.id).eq('category', 'patients').maybeSingle(),
        admin.from('hospital_data').select('value').eq('hospital_id', hosp.id).eq('category', 'doctors').maybeSingle(),
      ]);
      const appts = ((apptRow && apptRow.value) || []).filter(a => a.date === today && a.status === 'booked');
      if (!appts.length) continue;
      const patients = (patRow && patRow.value) || [];
      const doctors = (docRow && docRow.value) || [];

      for (const a of appts) {
        const patient = patients.find(p => p.id === a.patientId);
        const doctor = doctors.find(d => d.id === a.doctorId);
        if (!patient || !patient.phone) { results.push({ hospital: hosp.name, appt: a.id, skipped: 'no phone on file' }); continue; }
        const message = `Reminder: Hi ${patient.name}, you have an appointment with ${doctor ? doctor.name : 'the doctor'} today at ${a.time} at ${hosp.name}. Please arrive 10 minutes early.`;
        try {
          await sendWhatsApp(patient.phone, message);
          results.push({ hospital: hosp.name, patient: patient.name, appt: a.id, sent: true });
        } catch (e) {
          results.push({ hospital: hosp.name, patient: patient.name, appt: a.id, error: e.message });
        }
      }
    }
    res.status(200).json({ ok: true, date: today, count: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Something went wrong.' });
  }
};
