// TeachToReach — new-submission email notifier.
// Called by a Supabase Database Webhook whenever a row is inserted into
// tutor_requests or tutor_profiles, so Grace (or whoever NOTIFY_EMAIL is
// set to) doesn't have to remember to check the Supabase table manually.
//
// Required environment variables (set in Netlify site settings):
//   RESEND_API_KEY   - API key from resend.com
//   NOTIFY_EMAIL     - where the notification email gets sent
//   WEBHOOK_SECRET   - shared secret checked against the x-webhook-secret header
//   NOTIFY_FROM      - optional, defaults to Resend's sandbox sender

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
    html = `
      <h2>New tutor profile</h2>
      <p>
        <b>Name:</b> ${escapeHtml(record.tutor_name)}<br>
        <b>Phone:</b> ${escapeHtml(record.tutor_phone)}<br>
        <b>Tier:</b> ${escapeHtml(record.tutor_tier)}<br>
        <b>Experience:</b> ${escapeHtml(record.tutor_exp) || '-'} yrs<br>
        <b>Levels:</b> ${(record.levels || []).join(', ')}<br>
        <b>Subjects:</b> ${(record.subjects || []).join(', ')}<br>
        <b>Rate:</b> $${escapeHtml(record.rate_min)}–${escapeHtml(record.rate_max)}/hr<br>
        <b>Area:</b> ${escapeHtml(record.tutor_location)}<br>
        <b>Availability:</b> ${escapeHtml(record.tutor_avail) || '-'}<br>
        <b>Telegram:</b> ${escapeHtml(record.telegram_handle) || '-'}<br>
        <b>Notes:</b> ${escapeHtml(record.tutor_notes) || '-'}
      </p>`;
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

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
