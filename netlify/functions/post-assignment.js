// TeachToReach — posts newly-inserted assignments to the Telegram channel.
//
// Triggered by a Supabase Database Webhook on INSERT into `assignments`
// (same wiring pattern as notify-tutor-requests/notify-tutor-profiles in
// notify-submission.js). Formats the row into a channel message with an
// inline "Apply" button that deep-links into the bot (see
// telegram-webhook.js), then writes telegram_message_id back onto the row.
//
// Required env vars:
//   WEBHOOK_SECRET              - same shared secret already used by the
//                                 notify-submission.js Supabase webhooks
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_BOT_USERNAME       - no leading @, used to build the deep link
//   TELEGRAM_CHANNEL_ID         - numeric channel id or @channelusername;
//                                 the bot must be an admin of this channel
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY   - needed to write telegram_message_id back;
//                                 the public anon key has zero access to
//                                 the assignments table by design

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

function formatAssignmentMessage(a) {
  return (
    `📋 New Assignment\n\n` +
    `Level: ${a.student_level || '-'}\n` +
    `Subjects: ${(a.subjects || []).join(', ') || '-'}\n` +
    `Area: ${a.location || '-'}\n` +
    `Rate: $${a.rate_min || '?'}–${a.rate_max || '?'}/hr\n` +
    `Frequency: ${a.frequency || '-'}` +
    (a.notes ? `\n\n${a.notes}` : '')
  );
}

async function updateAssignment(id, fields) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/assignments?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(fields),
  });
}

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
  if (table !== 'assignments') {
    return { statusCode: 400, body: `Unknown table: ${table}` };
  }

  const deepLinkPayload = `assignment_${String(record.id).replace(/-/g, '')}`;
  const applyUrl = `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${deepLinkPayload}`;

  const res = await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHANNEL_ID,
      text: formatAssignmentMessage(record),
      reply_markup: { inline_keyboard: [[{ text: 'Click here to apply', url: applyUrl }]] },
    }),
  });

  const data = await res.json();
  if (!data.ok) {
    console.error('Telegram sendMessage failed:', data);
    await updateAssignment(record.id, { channel_post_error: data.description || 'Unknown error' });
    return { statusCode: 502, body: 'Failed to post to channel' };
  }

  await updateAssignment(record.id, { telegram_message_id: data.result.message_id, channel_post_error: null });
  return { statusCode: 200, body: 'OK' };
};

module.exports.__testables = { formatAssignmentMessage };
