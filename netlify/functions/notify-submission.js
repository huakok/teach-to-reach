// TeachToReach — new-submission email notifier.
// Called by a Supabase Database Webhook whenever a row is inserted into
// tutor_requests, tutor_profiles, or applications, so Grace (or whoever
// NOTIFY_EMAIL is set to) doesn't have to remember to check the Supabase
// table manually.
//
// Required environment variables (set in Netlify site settings):
//   RESEND_API_KEY              - API key from resend.com
//   NOTIFY_EMAIL                - where the notification email gets sent
//   WEBHOOK_SECRET              - shared secret checked against the
//                                 x-webhook-secret header
//   NOTIFY_FROM                 - optional, defaults to Resend's sandbox sender
//   SUPABASE_URL                - same project as the rest of the site —
//   SUPABASE_SERVICE_ROLE_KEY     needed for the `applications` case only,
//                                 to look up the assignment/tutor an
//                                 application row points to (the webhook
//                                 payload only carries raw IDs, not the
//                                 joined details). Already set for the bot,
//                                 no new secret to add.

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const secret = event.headers['x-webhook-secret'] || event.headers['X-Webhook-Secret'];
  if (secret !== process.env.WEBHOOK_SECRET) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { table, record } = payload;
  let subject;
  let html;

  if (table === 'tutor_requests') {
    subject = `New tutor request — ${record.parent_name || 'unnamed'}`;
    html = `
      <h2>New parent request</h2>
      <p>
        <b>Name:</b> ${escapeHtml(record.parent_name)}<br>
        <b>Phone:</b> ${escapeHtml(record.parent_phone)}<br>
        <b>Email:</b> ${escapeHtml(record.parent_email) || '-'}<br>
        <b>Student level:</b> ${escapeHtml(record.student_level)}<br>
        <b>Subjects:</b> ${(record.subjects || []).join(', ')}<br>
        <b>Frequency:</b> ${escapeHtml(record.frequency)}<br>
        <b>Budget:</b> ${escapeHtml(record.budget)}<br>
        <b>Location:</b> ${escapeHtml(record.location)}<br>
        <b>Mode:</b> ${escapeHtml(record.mode) || '-'}<br>
        <b>Concerns:</b> ${escapeHtml(record.concerns) || '-'}
      </p>`;
  } else if (table === 'tutor_profiles') {
    subject = `New tutor profile — ${record.tutor_name || 'unnamed'}`;
    // Bot registrations populate a richer field set (age, gender, qualifications,
    // etc. — see db/schema.sql) that the original website-only form never asked
    // for. Showing both keeps this email complete regardless of submission source.
    const experience = record.tutoring_experience || (record.tutor_exp ? `${record.tutor_exp} yrs` : '-');
    html = `
      <h2>New tutor profile</h2>
      <p>
        <b>Source:</b> ${record.telegram_user_id ? 'Telegram bot' : 'Website form'}<br>
        <b>Name:</b> ${escapeHtml(record.tutor_name)}<br>
        <b>Phone:</b> ${escapeHtml(record.tutor_phone)}<br>
        <b>Age:</b> ${escapeHtml(record.age) || '-'}<br>
        <b>Gender:</b> ${escapeHtml(record.gender) || '-'}<br>
        <b>Tier:</b> ${escapeHtml(record.tutor_tier) || '-'}<br>
        <b>Qualifications:</b> ${escapeHtml(record.qualifications) || '-'}<br>
        <b>Experience:</b> ${escapeHtml(experience)}<br>
        <b>Teaching style:</b> ${escapeHtml(record.teaching_style) || '-'}<br>
        <b>Track record:</b> ${escapeHtml(record.track_record) || '-'}<br>
        <b>Levels:</b> ${(record.levels || []).join(', ') || '-'}<br>
        <b>Subjects:</b> ${(record.subjects || []).join(', ') || '-'}<br>
        <b>Rate:</b> $${escapeHtml(record.rate_min) || '?'}–${escapeHtml(record.rate_max) || '?'}/hr<br>
        <b>Area:</b> ${escapeHtml(record.tutor_location) || '-'}<br>
        <b>Availability:</b> ${escapeHtml(record.tutor_avail) || '-'}<br>
        <b>Telegram:</b> ${escapeHtml(record.telegram_handle) || '-'}<br>
        <b>Notes:</b> ${escapeHtml(record.tutor_notes) || '-'}
      </p>`;
  } else if (table === 'applications') {
    const [assignment, tutor] = await Promise.all([
      fetchSupabaseRow('assignments', record.assignment_id),
      fetchSupabaseRow('tutor_profiles', record.tutor_profile_id),
    ]);
    subject = `New application — ${tutor?.tutor_name || 'a tutor'} → ${assignment?.student_level || 'an assignment'}`;
    html = `
      <h2>New assignment application</h2>
      <p>
        <b>Assignment:</b> ${escapeHtml(assignment?.student_level) || '-'} ·
        ${(assignment?.subjects || []).join(', ') || '-'} ·
        ${escapeHtml(assignment?.location) || '-'} ·
        $${escapeHtml(assignment?.rate_min) || '?'}–${escapeHtml(assignment?.rate_max) || '?'}/hr
      </p>
      <p>
        <b>Tutor:</b> ${escapeHtml(tutor?.tutor_name) || '-'}<br>
        <b>Phone:</b> ${escapeHtml(tutor?.tutor_phone) || '-'}<br>
        <b>Telegram:</b> ${escapeHtml(tutor?.telegram_handle) || '-'}<br>
        <b>Tier:</b> ${escapeHtml(tutor?.tutor_tier) || '-'}<br>
        <b>Subjects:</b> ${(tutor?.subjects || []).join(', ') || '-'}<br>
        <b>Levels:</b> ${(tutor?.levels || []).join(', ') || '-'}<br>
        <b>Rate:</b> $${escapeHtml(tutor?.rate_min) || '?'}–${escapeHtml(tutor?.rate_max) || '?'}/hr<br>
        <b>Qualifications:</b> ${escapeHtml(tutor?.qualifications) || '-'}
      </p>
      <p>Review in the Supabase Table Editor (<code>applications</code>) to shortlist, then send the tutor's details to the parent for their approval before connecting the two directly.</p>`;
  } else {
    return { statusCode: 400, body: `Unknown table: ${table}` };
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.NOTIFY_FROM || 'TeachToReach <onboarding@resend.dev>',
      to: process.env.NOTIFY_EMAIL,
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Resend error:', errText);
    return { statusCode: 502, body: 'Email send failed' };
  }

  return { statusCode: 200, body: 'OK' };
};

async function fetchSupabaseRow(table, id) {
  if (!id) return null;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}&select=*`, {
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows && rows.length ? rows[0] : null;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
