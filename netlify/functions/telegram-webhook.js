// TeachToReach — Telegram bot brain.
//
// Telegram POSTs every message/button-press here (registered once via
// Telegram's setWebhook API). Uses plain fetch against the Telegram Bot API
// and the Supabase REST API — no SDK dependency, matching the rest of this
// project's Netlify Functions.
//
// Required env vars:
//   TELEGRAM_BOT_TOKEN          - from @BotFather
//   TELEGRAM_BOT_USERNAME       - the bot's @handle, no leading @, used to
//                                 build t.me deep links
//   TELEGRAM_WEBHOOK_SECRET     - matched against the X-Telegram-Bot-Api-
//                                 Secret-Token header Telegram sends when
//                                 the webhook is registered with a secret;
//                                 anything else is silently ignored
//   SUPABASE_URL                - same project as the rest of the site
//   SUPABASE_SERVICE_ROLE_KEY   - NOT the public anon key. This bot needs
//                                 to read/write bot_sessions, assignments,
//                                 applications, and upsert tutor_profiles —
//                                 none of which the anon key can touch, by
//                                 design (see db/schema.sql).

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME;

const GRACE_CONTACT_MESSAGE =
  "Questions? Message Grace directly on the TeachToReach Telegram channel: https://t.me/tuitionassignmentsttrsg";

// ---------- Registration wizard step definitions ----------
// One place describing all 11 questions from the spec, so the state
// machine below can drive them generically instead of 11 near-duplicate
// handlers. `type: 'choice'` steps show inline buttons; `type: 'text'`
// steps accept a typed message (optionally with a maxLen validated before
// advancing, and an "allowNotApplicable" quick-answer button).
const STEPS = [
  { key: 'full_name', label: 'Full name', type: 'text', prompt: 'What is your full name?' },
  { key: 'age', label: 'Age', type: 'text', prompt: 'What is your age?' },
  { key: 'phone_number', label: 'Phone number', type: 'text', prompt: 'What is your phone number?' },
  {
    key: 'gender', label: 'Gender', type: 'choice', prompt: 'What is your gender?',
    choices: [['Male', 'male'], ['Female', 'female']],
  },
  {
    key: 'qualifications', label: 'Qualifications', type: 'text', maxLen: 500,
    prompt:
      "Please key in your qualifications, results and academic achievements (include your school and course of study).\n\n" +
      'Character limit: 500\n\n' +
      'Examples:\n' +
      '- Diploma in Biomedical Science (Ngee Ann Polytechnic)\n' +
      '- A-Level: GP A, H2 Biology (NJC)\n' +
      '- O-Level: English A1, A/E Math A2 (Raffles Girls School)\n' +
      "- PSLE: English A*, Mathematics A*, Science A, Tamil A* (Nan Hua Primary School)\n" +
      "- Director's list, Dean's list",
  },
  {
    key: 'current_education', label: 'Current education', type: 'text', maxLen: 100, allowNotApplicable: true,
    prompt:
      'Please key in your current education (include your school, course of study and projected year of graduation).\n\n' +
      'Character limit: 100\n\n' +
      'Example:\n- Undergraduate at NUS, Psychology, 2024',
  },
  {
    key: 'tutor_tier', label: 'Tutor category', type: 'choice', prompt: 'Which category of tutor do you belong to?',
    choices: [
      ['Part-time (Student)', 'pt_student'],
      ['Part-time (Non-student)', 'pt_nonstudent'],
      ['Full-time', 'ft'],
      ['Ex-MOE teacher', 'exmoe'],
      ['Current MOE teacher', 'curmoe'],
    ],
  },
  {
    key: 'tutoring_experience', label: 'Tutoring experience', type: 'text', maxLen: 1000,
    prompt:
      'Please describe your tutoring experiences such as:\n\n' +
      'Character limit: 1000\n\n' +
      '- Duration of tutoring experience\n' +
      '- Levels & subjects of current students, if applicable\n' +
      '- Levels & subjects of previous students within the past 2 years (optional)\n' +
      '- For new tutors without formal tutoring experience, you may describe any other informal tutoring experiences (e.g. peer tutoring, volunteering, siblings/relatives)\n\n' +
      'Please be as precise as possible to increase your chances in securing the assignments!',
  },
  {
    key: 'teaching_style', label: 'Teaching style', type: 'text', maxLen: 1000,
    prompt: 'Please BRIEFLY describe your teaching style and methods.\n\nCharacter limit: 1000',
  },
  {
    key: 'track_record', label: 'Track record', type: 'text', maxLen: 500,
    prompt:
      'Share with us some of your notable teaching improvements.\n\n' +
      'Character limit: 500\n\n' +
      'Examples:\n' +
      '- Pri 4 Math student improved to C from B\n' +
      '- PSLE student scored A for Science\n' +
      '- 80% improvement rate\n\n' +
      '💎 Please indicate if testimonials (screenshots/graded test papers/result slips) are available upon request.',
  },
  {
    key: 'can_present_certificates', label: 'Certificate availability', type: 'choice',
    prompt: 'Will you be able to present soft copies of your educational certificates to our agents upon request?',
    choices: [['Yes', 'yes'], ['No', 'no'], ['Prefer to present at 1st lesson', 'first_lesson']],
  },
];

// ---------- Telegram API helpers ----------
async function tg(method, body) {
  const res = await fetch(`${TELEGRAM_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error(`Telegram ${method} failed:`, data);
  return data;
}

function sendMessage(chatId, text, keyboard) {
  return tg('sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
}

function answerCallback(callbackQueryId, text) {
  return tg('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// ---------- Supabase REST helpers (service role — full read/write) ----------
async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase ${options.method || 'GET'} ${path} failed (${res.status}): ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getSession(telegramUserId) {
  const rows = await sb(`bot_sessions?telegram_user_id=eq.${telegramUserId}&select=*`);
  if (rows && rows.length) return rows[0];
  const created = await sb('bot_sessions', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({ telegram_user_id: telegramUserId, state: 'idle', context: {} }),
  });
  return created[0];
}

async function saveSession(telegramUserId, state, context) {
  await sb(`bot_sessions?telegram_user_id=eq.${telegramUserId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ state, context, updated_at: new Date().toISOString() }),
  });
}

async function getTutorProfileByTelegramId(telegramUserId) {
  const rows = await sb(`tutor_profiles?telegram_user_id=eq.${telegramUserId}&select=*`);
  return rows && rows.length ? rows[0] : null;
}

async function upsertTutorProfile(telegramUserId, draft) {
  const payload = {
    telegram_user_id: telegramUserId,
    tutor_name: draft.full_name,
    age: draft.age,
    tutor_phone: draft.phone_number,
    gender: draft.gender,
    qualifications: draft.qualifications,
    current_education: draft.current_education,
    tutor_tier: labelFor('tutor_tier', draft.tutor_tier),
    tutoring_experience: draft.tutoring_experience,
    teaching_style: draft.teaching_style,
    track_record: draft.track_record,
    can_present_certificates: labelFor('can_present_certificates', draft.can_present_certificates),
    profile_complete: true,
  };

  // If this phone number already has a site-submitted profile (no
  // telegram_user_id yet), merge into that row instead of creating a new
  // one — otherwise the subjects/levels/rate/location collected by the
  // website form (which the bot's wizard doesn't ask about) would be lost.
  const existing = await sb(
    `tutor_profiles?tutor_phone=eq.${encodeURIComponent(draft.phone_number)}&telegram_user_id=is.null&select=id&limit=1`
  );
  if (existing && existing.length) {
    await sb(`tutor_profiles?id=eq.${existing[0].id}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(payload),
    });
    return;
  }

  await sb('tutor_profiles?on_conflict=telegram_user_id', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(payload),
  });
}

async function getOpenAssignments(limit = 5) {
  return (await sb(`assignments?status=eq.open&order=created_at.desc&limit=${limit}&select=*`)) || [];
}

async function getAssignment(id) {
  const rows = await sb(`assignments?id=eq.${id}&select=*`);
  return rows && rows.length ? rows[0] : null;
}

async function getApplicationsForTutor(telegramUserId) {
  return (
    (await sb(
      `applications?tutor_telegram_id=eq.${telegramUserId}&order=created_at.desc&limit=10` +
        `&select=status,created_at,assignments(student_level,subjects,location)`
    )) || []
  );
}

async function createApplication(assignmentId, telegramUserId, tutorProfileId) {
  await sb('applications', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      assignment_id: assignmentId,
      tutor_telegram_id: telegramUserId,
      tutor_profile_id: tutorProfileId,
      status: 'applied',
    }),
  });
}

// ---------- Small formatting helpers ----------
function labelFor(stepKey, value) {
  const step = STEPS.find((s) => s.key === stepKey);
  if (!step || step.type !== 'choice') return value;
  const found = step.choices.find(([, v]) => v === value);
  return found ? found[0] : value;
}

function hexToUuid(hex) {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function formatAssignment(a) {
  return (
    `📋 Assignment\n\n` +
    `Level: ${a.student_level || '-'}\n` +
    `Subjects: ${(a.subjects || []).join(', ') || '-'}\n` +
    `Area: ${a.location || '-'}\n` +
    `Rate: $${a.rate_min || '?'}–${a.rate_max || '?'}/hr\n` +
    `Frequency: ${a.frequency || '-'}` +
    (a.notes ? `\n\n${a.notes}` : '')
  );
}

function navRow(stepIndex) {
  const row = [];
  if (stepIndex > 0) row.push({ text: '⬅️ Back', callback_data: 'nav:back' });
  row.push({ text: 'Cancel', callback_data: 'nav:cancel' });
  row.push({ text: '💾 Save & Exit', callback_data: 'nav:save_exit' });
  return row;
}

async function sendStepPrompt(chatId, stepIndex) {
  const step = STEPS[stepIndex];
  const keyboard = [];
  if (step.type === 'choice') {
    step.choices.forEach(([label, value]) => keyboard.push([{ text: label, callback_data: `ans:${value}` }]));
  }
  if (step.allowNotApplicable) {
    keyboard.push([{ text: 'Not applicable', callback_data: 'ans:not_applicable' }]);
  }
  keyboard.push(navRow(stepIndex));
  await sendMessage(chatId, `Step ${stepIndex + 1} of ${STEPS.length}\n\n${step.prompt}`, keyboard);
}

function formatConfirmScreen(draft) {
  const lines = STEPS.map((s) => `🔸 *${s.label}*: ${s.type === 'choice' ? labelFor(s.key, draft[s.key]) : draft[s.key]}`);
  return `Is this profile correct?\n\n${lines.join('\n')}`;
}

const GREETING_KEYBOARD = [
  [{ text: 'View available assignments', callback_data: 'menu:assignments' }],
  [{ text: 'View applications', callback_data: 'menu:applications' }],
  [{ text: 'Contact admin', callback_data: 'menu:contact' }],
  [{ text: 'Exit', callback_data: 'menu:exit' }],
];

async function sendGreeting(chatId, firstName) {
  await sendMessage(
    chatId,
    `Hi ${firstName || 'there'},\n\n` +
      'Welcome to Teach To Reach Tuition agency!\n\n' +
      '⚠️ Please *DO NOT* share any sensitive information such as your IC number, contact number & address in the chat itself — your profile is collected through the form questions only, and is only shared with parents once you are shortlisted.',
    GREETING_KEYBOARD
  );
}

async function sendGoodbye(chatId) {
  await sendMessage(chatId, 'Goodbye, we hope to see you again soon! 👋\n\nType (or press) /start to begin another conversation.');
}

// ---------- Main state machine ----------
async function handleStart(session, chatId, telegramUserId, firstName, payload) {
  if (payload && payload.startsWith('assignment_')) {
    const assignmentId = hexToUuid(payload.replace('assignment_', ''));
    await saveSession(telegramUserId, 'viewing_assignment_prompt', { assignmentId });
    await sendMessage(
      chatId,
      `You have selected Assignment ${assignmentId.slice(0, 8)}.\n\nDo you wish to view this assignment?`,
      [[{ text: 'Yes', callback_data: 'view:yes' }, { text: 'Exit', callback_data: 'view:exit' }]]
    );
    return;
  }

  // Resume a saved-but-incomplete registration — register.md's first line
  // is explicit that /start should bring the user back to their last saved
  // response, not discard it.
  if (session.state.startsWith('registering_') && session.state !== 'registering_confirm') {
    const stepIndex = Number(session.state.split('_')[1]);
    await sendMessage(chatId, "Welcome back — let's continue where you left off.");
    await sendStepPrompt(chatId, stepIndex);
    return;
  }
  if (session.state === 'registering_confirm') {
    await sendMessage(chatId, "Welcome back — here's your saved profile so far.");
    await sendMessage(chatId, formatConfirmScreen(session.context.draft || {}), [
      [{ text: '✅ Confirm', callback_data: 'nav:confirm' }, { text: 'Start over', callback_data: 'nav:cancel' }],
    ]);
    return;
  }

  await saveSession(telegramUserId, 'idle', {});
  await sendGreeting(chatId, firstName);
}

async function showAssignmentAndMaybeRegister(chatId, telegramUserId, assignmentId) {
  const assignment = await getAssignment(assignmentId);
  if (!assignment) {
    await sendMessage(chatId, "Sorry, this assignment isn't available anymore.");
    await saveSession(telegramUserId, 'idle', {});
    return;
  }
  await sendMessage(chatId, formatAssignment(assignment));

  const profile = await getTutorProfileByTelegramId(telegramUserId);
  if (!profile || !profile.profile_complete) {
    await saveSession(telegramUserId, 'awaiting_register_decision', { assignmentId });
    await sendMessage(
      chatId,
      'You do not have a completed tutor profile yet. You may fill a new one now! (The profile will be saved and can be used for future applications)',
      [[{ text: 'Register', callback_data: 'reg:start' }, { text: 'Back', callback_data: 'nav:back_to_menu' }]]
    );
    return;
  }

  // Already registered — apply directly.
  await createApplication(assignmentId, telegramUserId, profile.id);
  await saveSession(telegramUserId, 'idle', {});
  await sendMessage(chatId, "You're all set — your application has been recorded. Grace will be in touch if you're shortlisted!");
}

async function handleMenu(chatId, telegramUserId, action) {
  if (action === 'assignments') {
    const assignments = await getOpenAssignments();
    if (!assignments.length) {
      await sendMessage(chatId, 'No open assignments right now — check back soon!');
      return;
    }
    for (const a of assignments) {
      await sendMessage(chatId, formatAssignment(a), [
        [{ text: 'Apply', callback_data: `apply:${a.id.replace(/-/g, '')}` }],
      ]);
    }
    return;
  }
  if (action === 'applications') {
    const apps = await getApplicationsForTutor(telegramUserId);
    if (!apps.length) {
      await sendMessage(chatId, "You haven't applied to any assignments yet.");
      return;
    }
    const lines = apps.map((app) => {
      const a = app.assignments || {};
      return `• ${a.student_level || '-'} · ${(a.subjects || []).join('/')} · ${a.location || '-'} — *${app.status}*`;
    });
    await sendMessage(chatId, `Your applications:\n\n${lines.join('\n')}`);
    return;
  }
  if (action === 'contact') {
    await sendMessage(chatId, GRACE_CONTACT_MESSAGE);
    return;
  }
  if (action === 'exit') {
    await saveSession(telegramUserId, 'idle', {});
    await sendGoodbye(chatId);
  }
}

async function startRegistration(chatId, telegramUserId, assignmentId) {
  await saveSession(telegramUserId, 'registering_0', { assignmentId: assignmentId || null, draft: {} });
  await sendStepPrompt(chatId, 0);
}

async function handleRegistrationInput(session, chatId, telegramUserId, input, stepIndex) {
  const step = STEPS[stepIndex];
  const draft = { ...(session.context.draft || {}) };

  if (input.kind === 'callback' && input.data === 'nav:back') {
    const prevIndex = Math.max(0, stepIndex - 1);
    await saveSession(telegramUserId, `registering_${prevIndex}`, { ...session.context, draft });
    await sendStepPrompt(chatId, prevIndex);
    return;
  }
  if (input.kind === 'callback' && input.data === 'nav:cancel') {
    await saveSession(telegramUserId, 'idle', {});
    await sendMessage(chatId, 'Registration cancelled — no changes were saved.');
    await sendGreeting(chatId);
    return;
  }
  if (input.kind === 'callback' && input.data === 'nav:save_exit') {
    await saveSession(telegramUserId, `registering_${stepIndex}`, { ...session.context, draft });
    await sendGoodbye(chatId);
    return;
  }

  // Collect the answer for this step.
  let value;
  if (input.kind === 'callback' && input.data.startsWith('ans:')) {
    const raw = input.data.slice('ans:'.length);
    value = raw === 'not_applicable' ? 'Not applicable' : raw;
  } else if (input.kind === 'text' && step.type === 'text') {
    if (step.maxLen && input.text.length > step.maxLen) {
      await sendMessage(chatId, `That's a bit long — please keep it under ${step.maxLen} characters (yours was ${input.text.length}).`);
      return;
    }
    value = input.text;
  } else {
    // Wrong input type for this step (e.g. typed text on a choice-only step).
    await sendMessage(chatId, 'Please use the buttons above to answer this question.');
    return;
  }

  draft[step.key] = value;
  const nextIndex = stepIndex + 1;

  if (nextIndex >= STEPS.length) {
    await saveSession(telegramUserId, 'registering_confirm', { ...session.context, draft });
    await sendMessage(chatId, formatConfirmScreen(draft), [
      [{ text: '✅ Confirm', callback_data: 'nav:confirm' }, { text: 'Start over', callback_data: 'nav:cancel' }],
    ]);
    return;
  }

  await saveSession(telegramUserId, `registering_${nextIndex}`, { ...session.context, draft });
  await sendStepPrompt(chatId, nextIndex);
}

async function handleConfirm(session, chatId, telegramUserId, input) {
  if (input.kind === 'callback' && input.data === 'nav:cancel') {
    await saveSession(telegramUserId, 'idle', {});
    await sendMessage(chatId, 'No problem — starting over. Type /start when ready.');
    return;
  }
  if (input.kind === 'callback' && input.data === 'nav:confirm') {
    const draft = session.context.draft || {};
    await upsertTutorProfile(telegramUserId, draft);
    const profile = await getTutorProfileByTelegramId(telegramUserId);

    const assignmentId = session.context.assignmentId;
    if (assignmentId) {
      await createApplication(assignmentId, telegramUserId, profile?.id);
      await saveSession(telegramUserId, 'idle', {});
      await sendMessage(chatId, 'Profile saved and your application has been recorded. Grace will be in touch if you\'re shortlisted!');
      return;
    }

    await saveSession(telegramUserId, 'idle', {});
    await sendMessage(chatId, "Profile saved! You're ready to apply to assignments — try 'View available assignments' from /start.");
    return;
  }
  await sendMessage(chatId, 'Please tap Confirm or Start over.');
}

async function handleInput(session, chatId, telegramUserId, input) {
  const state = session.state;

  if (state === 'viewing_assignment_prompt') {
    if (input.data === 'view:yes') {
      await showAssignmentAndMaybeRegister(chatId, telegramUserId, session.context.assignmentId);
    } else {
      await saveSession(telegramUserId, 'idle', {});
      await sendGoodbye(chatId);
    }
    return;
  }

  if (state === 'awaiting_register_decision') {
    if (input.data === 'reg:start') {
      await startRegistration(chatId, telegramUserId, session.context.assignmentId);
    } else {
      await saveSession(telegramUserId, 'idle', {});
      await sendGreeting(chatId);
    }
    return;
  }

  if (state.startsWith('registering_') && state !== 'registering_confirm') {
    const stepIndex = Number(state.split('_')[1]);
    await handleRegistrationInput(session, chatId, telegramUserId, input, stepIndex);
    return;
  }

  if (state === 'registering_confirm') {
    await handleConfirm(session, chatId, telegramUserId, input);
    return;
  }

  // idle (or anything else): menu actions + apply:<id> deep-link-equivalent taps
  if (input.kind === 'callback' && input.data?.startsWith('menu:')) {
    await handleMenu(chatId, telegramUserId, input.data.slice('menu:'.length));
    return;
  }
  if (input.kind === 'callback' && input.data?.startsWith('apply:')) {
    const assignmentId = hexToUuid(input.data.slice('apply:'.length));
    await saveSession(telegramUserId, 'viewing_assignment_prompt', { assignmentId });
    await showAssignmentAndMaybeRegister(chatId, telegramUserId, assignmentId);
    return;
  }
  // Unrecognized input while idle — just re-show the greeting.
  await sendGreeting(chatId);
}

// ---------- Netlify Function entry point ----------
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 200, body: 'ok' };
  }

  const secret = event.headers['x-telegram-bot-api-secret-token'];
  if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    // Not really Telegram — ignore silently rather than error, so no retries.
    return { statusCode: 200, body: 'ignored' };
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch {
    return { statusCode: 200, body: 'ignored' };
  }

  try {
    const cq = update.callback_query;
    const msg = update.message;
    const from = cq ? cq.from : msg?.from;
    if (!from) return { statusCode: 200, body: 'ok' };

    const telegramUserId = from.id;
    const chatId = cq ? cq.message.chat.id : msg.chat.id;
    const session = await getSession(telegramUserId);

    if (cq) {
      await answerCallback(cq.id);
      await handleInput(session, chatId, telegramUserId, { kind: 'callback', data: cq.data });
    } else if (msg) {
      const text = (msg.text || '').trim();
      if (text === '/start' || text.startsWith('/start ')) {
        const payload = text.split(' ')[1];
        await handleStart(session, chatId, telegramUserId, from.first_name, payload);
      } else {
        await handleInput(session, chatId, telegramUserId, { kind: 'text', text });
      }
    }
  } catch (err) {
    console.error('telegram-webhook error:', err);
  }

  return { statusCode: 200, body: 'ok' };
};

module.exports.__testables = {
  STEPS,
  hexToUuid,
  labelFor,
  formatAssignment,
  formatConfirmScreen,
  navRow,
};
