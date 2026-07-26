// POST /api/patient-lookup
// Body: { "code": "<6-char patient code>", "phone": "<registered phone>" }
//
// This is the ONLY endpoint in the app meant to be called by someone who
// is NOT signed in. A patient types their 6-character code (shown to them
// by staff, on the Patient Profile page in the app — it's just the last 6
// characters of their internal record id) plus their registered phone
// number. If — and only if — both match the same patient record, this
// returns that one patient's own appointments, vitals and billing status.
// It never returns anything about other patients, staff, or hospital-wide
// data, and it uses the service_role key only on the server, never in the
// browser.
//
// Requires the same env vars as seed-users.js / admin-users.js:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

const { getAdminClient } = require('./_supabaseAdmin');

function patientCode(id) {
  return String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-6).toUpperCase();
}
function digitsOnly(s) {
  return String(s || '').replace(/\D/g, '');
}
function getJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_e) { return {}; }
  }
  return {};
}

// Very small in-memory throttle per IP. This resets whenever the
// serverless instance recycles, so it's a soft speed bump against casual
// abuse/brute-forcing, not a hard guarantee — if you need real rate
// limiting, put this behind Vercel's Web Application Firewall / a proper
// rate-limit service (e.g. Upstash) instead.
const attempts = new Map(); // ip -> array of timestamps (ms)
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 15;
function isRateLimited(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  attempts.set(ip, list);
  return list.length > MAX_ATTEMPTS;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.' });
    return;
  }

  const { code, phone } = getJsonBody(req);
  const cleanCode = String(code || '').trim().toUpperCase();
  const cleanPhone = digitsOnly(phone);
  if (!cleanCode || !cleanPhone) {
    res.status(400).json({ error: 'Enter both your patient code and registered phone number.' });
    return;
  }

  let admin;
  try {
    admin = getAdminClient();
  } catch (e) {
    res.status(500).json({ error: e.message });
    return;
  }

  // Generic "not found" message on every failure path below — deliberately
  // vague so this endpoint can't be used to fish for which codes/phones
  // exist.
  const NOT_FOUND = { error: "We couldn't find a matching record. Double-check your code and phone number, or ask hospital reception." };

  try {
    const { data: hospitals, error: hErr } = await admin.from('hospitals').select('id, name');
    if (hErr) throw hErr;

    const { data: patientRows, error: pErr } = await admin
      .from('hospital_data')
      .select('hospital_id, value')
      .eq('category', 'patients');
    if (pErr) throw pErr;

    let match = null;
    let matchHospitalId = null;
    for (const row of patientRows || []) {
      const list = Array.isArray(row.value) ? row.value : [];
      const found = list.find(
        (p) => patientCode(p.id) === cleanCode && digitsOnly(p.phone) === cleanPhone
      );
      if (found) { match = found; matchHospitalId = row.hospital_id; break; }
    }

    if (!match) {
      res.status(404).json(NOT_FOUND);
      return;
    }

    const hospital = (hospitals || []).find((h) => h.id === matchHospitalId);

    const [{ data: doctorRows }, { data: apptRows }, { data: trackRows }, { data: invRows }] = await Promise.all([
      admin.from('hospital_data').select('value').eq('category', 'doctors').eq('hospital_id', matchHospitalId).maybeSingle(),
      admin.from('hospital_data').select('value').eq('category', 'appointments').eq('hospital_id', matchHospitalId).maybeSingle(),
      admin.from('hospital_data').select('value').eq('category', 'tracking').eq('hospital_id', matchHospitalId).maybeSingle(),
      admin.from('hospital_data').select('value').eq('category', 'invoices').eq('hospital_id', matchHospitalId).maybeSingle(),
    ]);

    const doctors = (doctorRows && doctorRows.value) || [];
    const doctorName = (id) => (doctors.find((d) => d.id === id) || {}).name || null;

    const appointments = ((apptRows && apptRows.value) || [])
      .filter((a) => a.patientId === match.id)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 20)
      .map((a) => ({
        date: a.date, time: a.time, reason: a.reason || '', status: a.status,
        doctorName: doctorName(a.doctorId),
      }));

    const vitals = ((trackRows && trackRows.value) || [])
      .filter((v) => v.patientId === match.id)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 10)
      .map((v) => ({ date: v.date, sys: v.sys, dia: v.dia, pulse: v.pulse, temp: v.temp, spo2: v.spo2 }));

    const invoiceTotal = (inv) => {
      const itemsTotal = (inv.items || []).reduce((s, it) => s + (Number(it.qty) || 0) * (Number(it.price) || 0), 0);
      const afterDiscount = Math.max(0, itemsTotal - (Number(inv.discount) || 0));
      const withTax = afterDiscount * (1 + (Number(inv.tax) || 0) / 100);
      return Math.round(withTax * 100) / 100;
    };
    const invoicePaid = (inv) => (inv.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);

    const invoices = ((invRows && invRows.value) || [])
      .filter((i) => i.patientId === match.id)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 20)
      .map((i) => {
        const total = invoiceTotal(i);
        const paid = invoicePaid(i);
        return { date: i.date, total, paid, balance: Math.max(0, total - paid), status: i.status };
      });

    res.status(200).json({
      hospitalName: hospital ? hospital.name : '',
      patient: {
        name: match.name, age: match.age, gender: match.gender,
        blood: match.blood, allergies: match.allergies || '',
      },
      appointments,
      vitals,
      invoices,
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Something went wrong. Please try again shortly.' });
  }
};
