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

const TEAM_CONTACT_MESSAGE =
  "💬 Questions? Message our team directly on the TeachToReach Telegram channel: https://t.me/tuitionassignmentsttrsg";

// ---------- Registration wizard step definitions ----------
// One place describing every question, so the state machine below can
// drive them generically instead of near-duplicate handlers per question.
// `type: 'choice'` = single-select buttons. `type: 'multi-choice'` = toggle
// buttons + a Continue button (used for levels/subjects, mirroring the
// site's chip-select fields). `type: 'text'` = a typed message, optionally
// with `maxLen` and/or a `validate` regex checked before advancing.
//
// Steps 0–10 are the original vetting questions from the spec. Steps 11+
// were added to collect the same matching fields the website's "Become a
// tutor" form does (levels, subjects, rate, area, availability) — the
// original bot spec never asked for these, which left every bot-only
// profile unmatchable via match_tutors() and left the notification email
// showing empty fields.
const STEPS = [
  { key: 'full_name', label: 'Full name', type: 'text', prompt: "👋 What's your full name?" },
  { key: 'age', label: 'Age', type: 'text', prompt: "🎂 What's your age?" },
  { key: 'phone_number', label: 'Phone number', type: 'text', prompt: "📱 What's your phone number?" },
  {
    key: 'gender', label: 'Gender', type: 'choice', prompt: "🚻 What's your gender?",
    choices: [['Male', 'male'], ['Female', 'female']],
  },
  {
    key: 'qualifications', label: 'Qualifications', type: 'text', maxLen: 600,
    prompt:
      "🎓 Please key in your academic background — qualifications, results and achievements, plus what you're currently studying if applicable (include school and course of study for each).\n\n" +
      'Character limit: 600\n\n' +
      'Examples:\n' +
      '- Diploma in Biomedical Science (Ngee Ann Polytechnic)\n' +
      '- A-Level: GP A, H2 Biology (NJC)\n' +
      '- O-Level: English A1, A/E Math A2 (Raffles Girls School)\n' +
      "- PSLE: English A*, Mathematics A*, Science A, Tamil A* (Nan Hua Primary School)\n" +
      "- Director's list, Dean's list\n" +
      '- Currently: Undergraduate at NUS, Psychology, expected 2027',
  },
  {
    key: 'tutor_tier', label: 'Tutor category', type: 'choice', prompt: '🏷️ Which category of tutor do you belong to?',
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
      '🧑‍🏫 Please describe your tutoring experiences such as:\n\n' +
      'Character limit: 1000\n\n' +
      '- Duration of tutoring experience\n' +
      '- Levels & subjects of current students, if applicable\n' +
      '- Levels & subjects of previous students within the past 2 years (optional)\n' +
      '- For new tutors without formal tutoring experience, you may describe any other informal tutoring experiences (e.g. peer tutoring, volunteering, siblings/relatives)\n\n' +
      'Please be as precise as possible to increase your chances in securing the assignments!',
  },
  {
    key: 'teaching_style', label: 'Teaching style', type: 'text', maxLen: 1000,
    prompt: '🎨 Please BRIEFLY describe your teaching style and methods.\n\nCharacter limit: 1000',
  },
  {
    key: 'track_record', label: 'Track record', type: 'text', maxLen: 500,
    prompt:
      '🌟 Share with us some of your notable teaching improvements.\n\n' +
      'Character limit: 500\n\n' +
      'Examples:\n' +
      '- Pri 4 Math student improved to C from B\n' +
      '- PSLE student scored A for Science\n' +
      '- 80% improvement rate\n\n' +
      '💎 Please indicate if testimonials (screenshots/graded test papers/result slips) are available upon request.',
  },
  {
    key: 'levels', label: 'Levels taught', type: 'multi-choice',
    prompt: '🎓 Which levels do you teach? (tap all that apply, then Continue)',
    choices: [
      ['Preschool', 'Preschool'],
      ['Primary', 'Primary'],
      ['Secondary', 'Secondary'],
      ['JC / A-Level', 'JC/A-Level'],
      ['IB / IP', 'IB/IP'],
      ['Polytechnic', 'Polytechnic'],
    ],
  },
  {
    key: 'subjects', label: 'Subjects taught', type: 'multi-choice',
    prompt: '📚 Which subjects do you teach? (tap all that apply, then Continue)',
    choices: [
      ['Mathematics', 'Mathematics'],
      ['Physics', 'Physics'],
      ['Chemistry', 'Chemistry'],
      ['Biology', 'Biology'],
      ['English', 'English'],
      ['Chinese', 'Chinese'],
      ['Economics', 'Economics'],
      ['Other', 'Other'],
    ],
  },
  {
    key: 'rate_min', label: 'Rate — from', type: 'text',
    validate: /^\d+(\.\d+)?$/, validateMessage: 'Please enter just a number, e.g. 40. 🙂',
    prompt: "💰 What's the lower end of your rate range? ($/hr — numbers only, e.g. 40)",
  },
  {
    key: 'rate_max', label: 'Rate — to', type: 'text',
    validate: /^\d+(\.\d+)?$/, validateMessage: 'Please enter just a number, e.g. 60. 🙂',
    prompt: '💰 And the upper end? ($/hr, e.g. 60)',
  },
  {
    key: 'tutor_location', label: 'Areas covered', type: 'text',
    prompt: '📍 Which areas do you cover? (e.g. "Punggol, Sengkang", or "anywhere North-East")',
  },
  {
    key: 'tutor_avail', label: 'Availability', type: 'choice', prompt: '🗓️ When are you generally available?',
    choices: [
      ['Weekday evenings', 'weekday_evenings'],
      ['Weekday daytime', 'weekday_daytime'],
      ['Weekends', 'weekends'],
      ['Flexible / anytime', 'flexible'],
    ],
  },
];

// Parent/student "request a tutor" wizard — mirrors request-tutor.html's
// fields and choice values exactly (same tutor_requests columns, same
// dropdown text) so a request made via the bot is indistinguishable from
// one made on the website once it lands in Grace's inbox.
const REQUEST_STEPS = [
  { key: 'parent_name', label: 'Your name', type: 'text', prompt: "👋 What's your name?" },
  { key: 'parent_phone', label: 'Phone number', type: 'text', prompt: "📱 What's the best phone number to reach you on?" },
  { key: 'parent_email', label: 'Email', type: 'text', allowNotApplicable: true, prompt: "📧 What's your email? (optional — tap Not applicable to skip)" },
  {
    key: 'student_level', label: 'Student level', type: 'choice', prompt: '🎓 What level is your child in?',
    choices: [
      ['Preschool / Kindergarten', 'Preschool / Kindergarten'],
      ['Primary 1–3', 'Primary 1–3'],
      ['Primary 4–6 (PSLE)', 'Primary 4–6 (PSLE)'],
      ['Secondary 1–2', 'Secondary 1–2'],
      ['Secondary 3–4 (O-Level)', 'Secondary 3–4 (O-Level)'],
      ['JC 1–2 (A-Level)', 'JC 1–2 (A-Level)'],
      ['IB / IP', 'IB / IP'],
      ['Polytechnic', 'Polytechnic'],
    ],
  },
  { key: 'school_type', label: 'School type', type: 'text', allowNotApplicable: true, prompt: '🏫 What type of school? (optional — e.g. "Neighbourhood school", "IP school")' },
  {
    key: 'subjects', label: 'Subjects needed', type: 'multi-choice',
    prompt: '📚 Which subject(s) do you need help with? (tap all that apply, then Continue)',
    choices: [
      ['Mathematics', 'Mathematics'], ['Science', 'Science'], ['English', 'English'], ['Chinese', 'Chinese'],
      ['Physics', 'Physics'], ['Chemistry', 'Chemistry'], ['Economics', 'Economics'], ['Other', 'Other'],
    ],
  },
  {
    key: 'frequency', label: 'Lessons per week', type: 'choice', prompt: '🗓️ How many lessons per week?',
    choices: [['1x/week', '1x/week'], ['2x/week', '2x/week'], ['3x/week or more', '3x/week or more'], ['Ad-hoc / exam prep only', 'Ad-hoc / exam prep only']],
  },
  {
    key: 'budget', label: 'Budget', type: 'choice', prompt: "💰 What's your budget per hour?",
    choices: [['Under $30', 'Under $30'], ['$30–50', '$30–50'], ['$50–80', '$50–80'], ['$80–120', '$80–120'], ['$120+', '$120+']],
  },
  { key: 'location', label: 'Area', type: 'text', prompt: '📍 Which area / neighbourhood are you in? (e.g. "Punggol, Tampines")' },
  {
    key: 'mode', label: 'Lesson mode', type: 'choice', prompt: '💻 Where would lessons happen?',
    choices: [["At student's home", "At student's home"], ['Online', 'Online'], ['Either works', 'Either works']],
  },
  { key: 'concerns', label: 'Anything else', type: 'text', maxLen: 500, allowNotApplicable: true, prompt: '✏️ Any specific concerns our team should know? (optional — e.g. "needs help staying focused")' },
];

function stepsFor(flow) {
  return flow === 'request' ? REQUEST_STEPS : STEPS;
}
function prefixFor(flow) {
  return flow === 'request' ? 'requesting_' : 'registering_';
}

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

async function upsertTutorProfile(telegramUserId, draft, telegramUsername) {
  const payload = {
    telegram_user_id: telegramUserId,
    tutor_name: draft.full_name,
    age: draft.age,
    tutor_phone: draft.phone_number,
    gender: draft.gender,
    qualifications: draft.qualifications,
    tutor_tier: labelFor('tutor_tier', draft.tutor_tier),
    tutoring_experience: draft.tutoring_experience,
    teaching_style: draft.teaching_style,
    track_record: draft.track_record,
    levels: draft.levels || [],
    subjects: draft.subjects || [],
    rate_min: draft.rate_min,
    rate_max: draft.rate_max,
    tutor_location: draft.tutor_location,
    tutor_avail: labelFor('tutor_avail', draft.tutor_avail),
    // Auto-filled from the tutor's Telegram account rather than asked —
    // always accurate, one less question. Left blank (not asked) if they
    // don't have a public username set.
    telegram_handle: telegramUsername ? `@${telegramUsername}` : null,
    profile_complete: true,
  };

  // If this phone number already has a site-submitted profile (no
  // telegram_user_id yet), merge into that row instead of creating a new
  // one — otherwise anything already collected there gets orphaned.
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

// Lets a tutor who already registered on the website get recognized by the
// bot immediately, instead of being forced through the full wizard again —
// the bot has no way to know who someone is until either they've talked to
// it before (telegram_user_id) or they tell it the phone number they used
// on the website.
async function findUnlinkedProfileByPhone(phone) {
  const rows = await sb(`tutor_profiles?tutor_phone=eq.${encodeURIComponent(phone)}&telegram_user_id=is.null&select=*&limit=1`);
  return rows && rows.length ? rows[0] : null;
}

async function linkProfileToTelegram(profileId, telegramUserId, telegramUsername) {
  const payload = { telegram_user_id: telegramUserId, profile_complete: true };
  if (telegramUsername) payload.telegram_handle = `@${telegramUsername}`;
  await sb(`tutor_profiles?id=eq.${profileId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
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
function labelFor(stepKey, value, steps = STEPS) {
  const step = steps.find((s) => s.key === stepKey);
  if (!step) return value;
  if (step.type === 'multi-choice') {
    const values = Array.isArray(value) ? value : [];
    const labels = values.map((v) => {
      const found = step.choices.find(([, cv]) => cv === v);
      return found ? found[0] : v;
    });
    return labels.length ? labels.join(', ') : '-';
  }
  if (step.type !== 'choice') return value;
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

// One-line label for the assignment list menu — keeps the list scannable
// instead of sending a separate full-detail message per assignment.
function formatAssignmentSummary(a) {
  const subjects = (a.subjects || []).slice(0, 2).join('/') || '?';
  const more = (a.subjects || []).length > 2 ? '+' : '';
  const scorePrefix = typeof a._score === 'number' && a._score > 0 ? `🎯 ${a._score}% · ` : '';
  return `${scorePrefix}${a.student_level || '?'} · ${subjects}${more} · ${a.location || '?'} · $${a.rate_min || '?'}–${a.rate_max || '?'}/hr`;
}

// Most STEPS keys map 1:1 onto tutor_profiles columns; these two don't.
const STEP_KEY_TO_COLUMN = { full_name: 'tutor_name', phone_number: 'tutor_phone' };
function columnForStep(key) {
  return STEP_KEY_TO_COLUMN[key] || key;
}

// upsertTutorProfile() stores gender as the raw choice value ('male') but
// tutor_tier/tutor_avail as the display label ('Full-time') — matched here
// so a single-field edit writes the same format the original registration
// would have.
const LABEL_STORED_CHOICE_KEYS = new Set(['tutor_tier', 'tutor_avail']);

// Reverses a stored column value back into the raw choice value(s) STEPS
// buttons are keyed by, so an edit prompt can pre-mark the tutor's current
// answer regardless of which of the two storage formats above was used.
function valueForStoredField(step, stored) {
  if (stored == null) return stored;
  if (step.type === 'multi-choice') {
    const arr = Array.isArray(stored) ? stored : [];
    return arr.map((v) => {
      const byValue = step.choices.find(([, cv]) => String(cv).toLowerCase() === String(v).toLowerCase());
      if (byValue) return byValue[1];
      const byLabel = step.choices.find(([lbl]) => lbl.toLowerCase() === String(v).toLowerCase());
      return byLabel ? byLabel[1] : v;
    });
  }
  if (step.type === 'choice') {
    const byValue = step.choices.find(([, cv]) => String(cv).toLowerCase() === String(stored).toLowerCase());
    if (byValue) return byValue[1];
    const byLabel = step.choices.find(([lbl]) => lbl.toLowerCase() === String(stored).toLowerCase());
    return byLabel ? byLabel[1] : stored;
  }
  return stored;
}

function navRow(stepIndex) {
  const row = [];
  if (stepIndex > 0) row.push({ text: '⬅️ Back', callback_data: 'nav:back' });
  row.push({ text: '🚫 Cancel', callback_data: 'nav:cancel' });
  row.push({ text: '💾 Save & Exit', callback_data: 'nav:save_exit' });
  return row;
}

async function sendStepPrompt(chatId, stepIndex, selectedValues, opts = {}) {
  const steps = stepsFor(opts.flow);
  const step = steps[stepIndex];
  const keyboard = [];
  if (step.type === 'choice') {
    step.choices.forEach(([label, value]) => {
      const mark = opts.isEdit && selectedValues === value ? '✅ ' : '';
      keyboard.push([{ text: `${mark}${label}`, callback_data: `ans:${value}` }]);
    });
  } else if (step.type === 'multi-choice') {
    const selected = selectedValues || [];
    step.choices.forEach(([label, value]) => {
      const mark = selected.includes(value) ? '✅ ' : '';
      keyboard.push([{ text: `${mark}${label}`, callback_data: `msel:${value}` }]);
    });
    keyboard.push([{ text: `➡️ Continue (${selected.length} selected)`, callback_data: 'msel_done' }]);
  }
  if (step.allowNotApplicable) {
    keyboard.push([{ text: 'Not applicable', callback_data: 'ans:not_applicable' }]);
  }
  keyboard.push(opts.isEdit ? [{ text: '🚫 Cancel', callback_data: 'nav:cancel' }] : navRow(stepIndex));

  let promptText = `Step ${stepIndex + 1} of ${steps.length}\n\n${step.prompt}`;
  if (opts.isEdit) {
    promptText = step.type === 'text' && selectedValues ? `Current: ${selectedValues}\n\n${step.prompt}` : step.prompt;
  }
  const res = await sendMessage(chatId, promptText, keyboard);
  return res?.result?.message_id;
}

function formatConfirmScreen(draft, flow = 'register') {
  const steps = stepsFor(flow);
  const heading = flow === 'request' ? "double check — is this request correct?" : 'double check — is this profile correct?';
  const lines = steps.map((s) => `🔸 *${s.label}*: ${s.type === 'text' ? (draft[s.key] || '-') : labelFor(s.key, draft[s.key], steps)}`);
  return `👀 Let's ${heading}\n\n${lines.join('\n')}`;
}

// Mirrors js/main.js's client-side matching helpers so a bot-submitted
// request gets the same instant anonymized teaser the website shows.
function mapBudgetToRange(budget) {
  switch (budget) {
    case 'Under $30': return { min: 0, max: 30 };
    case '$30–50': return { min: 30, max: 50 };
    case '$50–80': return { min: 50, max: 80 };
    case '$80–120': return { min: 80, max: 120 };
    case '$120+': return { min: 120, max: 9999 };
    default: return { min: 0, max: 9999 };
  }
}
function mapLevelToBucket(level) {
  if (!level) return null;
  if (level.startsWith('Preschool')) return 'Preschool';
  if (level.startsWith('Primary')) return 'Primary';
  if (level.startsWith('Secondary')) return 'Secondary';
  if (level.startsWith('JC')) return 'JC/A-Level';
  if (level.startsWith('IB')) return 'IB/IP';
  if (level.startsWith('Polytechnic')) return 'Polytechnic';
  return null;
}
function expandSubjectsForMatching(subjects) {
  const expanded = new Set();
  (subjects || []).forEach((s) => {
    if (s === 'Science') ['Physics', 'Chemistry', 'Biology'].forEach((sub) => expanded.add(sub));
    else expanded.add(s);
  });
  return Array.from(expanded);
}
async function fetchTutorMatchTeaser(draft) {
  const budgetRange = mapBudgetToRange(draft.budget);
  const rows = await sb('rpc/match_tutors', {
    method: 'POST',
    body: JSON.stringify({
      p_subjects: expandSubjectsForMatching(draft.subjects),
      p_level_bucket: mapLevelToBucket(draft.student_level),
      p_location: draft.location || null,
      p_budget_min: budgetRange.min,
      p_budget_max: budgetRange.max,
    }),
  });
  return rows || [];
}
function formatMatchTeaserMessage(rows) {
  if (!rows.length) {
    return '📭 No exact match in the pool yet — our team will personally source one for you within 24–48 hours.';
  }
  const cards = rows.map((r) => {
    const rate = r.rate_min && r.rate_max ? `$${r.rate_min}–${r.rate_max}/hr` : '';
    const subjectsLabel = (r.subjects || []).slice(0, 3).join(', ');
    return `• *${r.tutor_tier || 'Tutor'}* — ${[rate, r.tutor_location, r.tutor_avail].filter(Boolean).join(' · ')}\n  Teaches ${subjectsLabel} (${r.score}% fit)`;
  });
  return (
    `🎉 ${rows.length} tutor${rows.length > 1 ? 's' : ''} in the pool already look like a good fit:\n\n${cards.join('\n\n')}\n\n` +
    `Our team will confirm details and personally introduce you to the best fit within 24–48 hours.`
  );
}

// ---------- Tutor-side assignment matching ----------
// Assignments' student_level is freeform text Grace types per-assignment
// (e.g. "Sec 4", "P6"), unlike tutor_requests' clean dropdown values — so
// this is a looser best-effort match than mapLevelToBucket(), not a strict
// prefix check.
function guessLevelBucket(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('presch') || t.includes('kinder')) return 'Preschool';
  if (t.includes('poly')) return 'Polytechnic';
  if (t.includes('ib') || t.includes('/ip') || t.includes(' ip')) return 'IB/IP';
  if (t.includes('jc') || t.includes('a-level') || t.includes('a level')) return 'JC/A-Level';
  if (t.includes('sec')) return 'Secondary';
  if (t.includes('pri') || /\bp[1-6]\b/.test(t)) return 'Primary';
  return null;
}

// Scores an open assignment against a tutor's own profile: subject overlap
// (50), level/age-group match (30), location match (20) — the three
// factors requested, weighted the same way match_tutors() weights the
// parent-side match (subject weighted highest).
function scoreAssignmentForTutor(assignment, tutor) {
  const tutorSubjects = tutor.subjects || [];
  const assignmentSubjects = assignment.subjects || [];
  const overlap = assignmentSubjects.filter((s) => tutorSubjects.includes(s)).length;
  const subjectScore = assignmentSubjects.length ? (50 * overlap) / assignmentSubjects.length : 0;

  const bucket = guessLevelBucket(assignment.student_level);
  const levelScore = bucket && (tutor.levels || []).includes(bucket) ? 30 : 0;

  const tutorLoc = (tutor.tutor_location || '').toLowerCase();
  const aLoc = (assignment.location || '').toLowerCase();
  let locationScore = 0;
  if (tutorLoc.includes('anywhere')) locationScore = 20;
  else if (aLoc && tutorLoc && (tutorLoc.includes(aLoc) || aLoc.includes(tutorLoc))) locationScore = 20;

  return Math.round(subjectScore + levelScore + locationScore);
}

function rankAssignmentsForTutor(assignments, tutor) {
  return assignments
    .map((a) => ({ ...a, _score: scoreAssignmentForTutor(a, tutor) }))
    .sort((a, b) => b._score - a._score);
}

// Shown once right after a tutor finishes registering — a welcome-moment
// nudge toward whatever's already open and a good fit, on top of the
// ranking applied to the regular "View available assignments" list.
async function sendAssignmentSuggestions(chatId, tutorProfile, excludeAssignmentId) {
  const assignments = await getOpenAssignments(20);
  const pool = excludeAssignmentId ? assignments.filter((a) => a.id !== excludeAssignmentId) : assignments;
  if (!pool.length) return;
  const ranked = rankAssignmentsForTutor(pool, tutorProfile).filter((a) => a._score > 0).slice(0, 3);
  if (!ranked.length) return;
  const keyboard = ranked.map((a) => [
    { text: formatAssignmentSummary(a), callback_data: `apply:${a.id.replace(/-/g, '')}` },
  ]);
  await sendMessage(chatId, '🎯 Based on your profile, these look like a good fit:', keyboard);
}

async function insertTutorRequest(draft, source = 'bot') {
  const clean = (v) => (v === 'Not applicable' ? null : v);
  await sb('tutor_requests', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      parent_name: draft.parent_name,
      parent_phone: draft.parent_phone,
      parent_email: clean(draft.parent_email),
      student_level: draft.student_level,
      school_type: clean(draft.school_type),
      concerns: clean(draft.concerns),
      subjects: draft.subjects || [],
      frequency: draft.frequency,
      budget: draft.budget,
      location: draft.location,
      mode: draft.mode,
      source,
    }),
  });
}

async function getUnconvertedRequests(limit = 10) {
  return (await sb(`tutor_requests?converted_assignment_id=is.null&order=created_at.desc&limit=${limit}&select=*`)) || [];
}

async function getTutorRequest(id) {
  const rows = await sb(`tutor_requests?id=eq.${id}&select=*`);
  return rows && rows.length ? rows[0] : null;
}

function draftFromRequest(request) {
  const budgetRange = mapBudgetToRange(request.budget);
  return {
    student_level: request.student_level,
    subjects: request.subjects || [],
    location: request.location,
    rate_min: String(budgetRange.min || ''),
    rate_max: budgetRange.max && budgetRange.max !== 9999 ? String(budgetRange.max) : '',
    frequency: request.frequency,
    notes: request.concerns || '',
  };
}

function formatAssignmentDraft(draft) {
  return (
    `📋 Draft assignment from this request:\n\n` +
    `Level: ${draft.student_level || '-'}\n` +
    `Subjects: ${(draft.subjects || []).join(', ') || '-'}\n` +
    `Area: ${draft.location || '-'}\n` +
    `Rate: $${draft.rate_min || '?'}–${draft.rate_max || '?'}/hr\n` +
    `Frequency: ${draft.frequency || '-'}` +
    (draft.notes ? `\n\n${draft.notes}` : '') +
    `\n\nPost this to the channel?`
  );
}

async function createAssignmentFromDraft(draft, requestId) {
  const created = await sb('assignments', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      student_level: draft.student_level,
      subjects: draft.subjects || [],
      location: draft.location,
      rate_min: draft.rate_min || null,
      rate_max: draft.rate_max || null,
      frequency: draft.frequency,
      notes: draft.notes || null,
      status: 'open',
    }),
  });
  const assignment = created && created[0];
  if (assignment && requestId) {
    await sb(`tutor_requests?id=eq.${requestId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ converted_assignment_id: assignment.id }),
    });
  }
  return assignment;
}

// Telegram user IDs allowed to see the admin menu (Grace + anyone else on
// the team) — comma-separated in the ADMIN_TELEGRAM_USER_IDS env var.
const ADMIN_IDS = (process.env.ADMIN_TELEGRAM_USER_IDS || '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => !Number.isNaN(n));
function isAdmin(telegramUserId) {
  return ADMIN_IDS.includes(Number(telegramUserId));
}

function buildGreetingKeyboard(telegramUserId) {
  const keyboard = [
    [{ text: '🎓 Request a tutor for my child', callback_data: 'menu:request_tutor' }],
    [{ text: '📝 Register as a tutor', callback_data: 'menu:register_tutor' }],
    [{ text: 'View available assignments', callback_data: 'menu:assignments' }],
    [{ text: 'View applications', callback_data: 'menu:applications' }],
    [{ text: '✏️ Edit my profile', callback_data: 'menu:edit_profile' }],
    [{ text: 'Contact our team', callback_data: 'menu:contact' }],
  ];
  if (isAdmin(telegramUserId)) {
    keyboard.push([{ text: '🛠️ Admin tools', callback_data: 'menu:admin_tools' }]);
  }
  keyboard.push([{ text: 'Exit', callback_data: 'menu:exit' }]);
  return keyboard;
}

async function sendEditMenu(telegramUserId, chatId) {
  await saveSession(telegramUserId, 'editing_menu', {});
  const keyboard = STEPS.map((step, idx) => [{ text: step.label, callback_data: `editfield:${idx}` }]);
  keyboard.push([{ text: '✅ Done editing', callback_data: 'edit:done' }]);
  await sendMessage(chatId, '✏️ What would you like to update?', keyboard);
}

async function applyFieldEdit(telegramUserId, chatId, step, rawValue) {
  const column = columnForStep(step.key);
  const dbValue = step.type === 'choice' && LABEL_STORED_CHOICE_KEYS.has(step.key) ? labelFor(step.key, rawValue) : rawValue;
  await sb(`tutor_profiles?telegram_user_id=eq.${telegramUserId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ [column]: dbValue }),
  });
  await sendMessage(chatId, `✅ ${step.label} updated!`);
  await sendEditMenu(telegramUserId, chatId);
}

async function sendGreeting(chatId, firstName, telegramUserId) {
  await sendMessage(
    chatId,
    `Hi ${firstName || 'there'}! 👋\n\n` +
      'Welcome to Teach To Reach Tuition agency! 🎉\n\n' +
      '⚠️ Please *DO NOT* share any sensitive information such as your IC number, contact number & address in the chat itself — your profile is collected through the form questions only, and is only shared with parents once you are shortlisted.',
    buildGreetingKeyboard(telegramUserId)
  );
}

async function sendGoodbye(chatId) {
  await sendMessage(chatId, 'Goodbye, we hope to see you again soon! 👋\n\nType (or press) /start to begin another conversation.');
}

// ---------- Registration flow helpers (shared by advance/back navigation) ----------
async function goToStep(telegramUserId, chatId, context, draft, index, flow = 'register') {
  const steps = stepsFor(flow);
  const step = steps[index];
  const multiSelect = step.type === 'multi-choice' ? (draft[step.key] || []) : undefined;
  await saveSession(telegramUserId, `${prefixFor(flow)}${index}`, { ...context, draft, multiSelect, flow });
  await sendStepPrompt(chatId, index, multiSelect, { flow });
}

async function advanceOrConfirm(telegramUserId, chatId, context, draft, nextIndex, flow = 'register') {
  const steps = stepsFor(flow);
  if (nextIndex >= steps.length) {
    await saveSession(telegramUserId, `${prefixFor(flow)}confirm`, { ...context, draft, multiSelect: undefined, flow });
    await sendMessage(chatId, formatConfirmScreen(draft, flow), [
      [{ text: '✅ Confirm', callback_data: 'nav:confirm' }, { text: '🔄 Start over', callback_data: 'nav:cancel' }],
    ]);
    return;
  }
  await goToStep(telegramUserId, chatId, context, draft, nextIndex, flow);
}

// ---------- Main state machine ----------
async function handleStart(session, chatId, telegramUserId, firstName, payload, username) {
  if (payload && payload.startsWith('assignment_')) {
    const assignmentId = hexToUuid(payload.replace('assignment_', ''));
    await saveSession(telegramUserId, 'viewing_assignment_prompt', { assignmentId });
    await sendMessage(
      chatId,
      "📋 You've selected an assignment — want to see the details?",
      [[{ text: '👀 Yes', callback_data: 'view:yes' }, { text: 'Exit', callback_data: 'view:exit' }]]
    );
    return;
  }

  // Direct entry point for "Register as a tutor" links (e.g. from the
  // website) — skips the greeting menu and goes straight into the wizard,
  // since intent is already known from the link they tapped. Only applies
  // to a brand-new/idle session; an in-progress registration still resumes
  // normally below rather than restarting.
  if (payload === 'register' && !session.state.startsWith('registering_') && session.state !== 'registering_confirm') {
    await startRegistration(chatId, telegramUserId, null, username);
    return;
  }

  // Resume a saved-but-incomplete registration/request — register.md's first
  // line is explicit that /start should bring the user back to their last
  // saved response, not discard it. Applies to both wizards.
  if (
    (session.state.startsWith('registering_') || session.state.startsWith('requesting_')) &&
    session.state !== 'registering_confirm' &&
    session.state !== 'requesting_confirm'
  ) {
    const flow = session.context.flow || (session.state.startsWith('requesting_') ? 'request' : 'register');
    const stepIndex = Number(session.state.split('_')[1]);
    await sendMessage(chatId, "Welcome back — let's continue where you left off. 🙂");
    await sendStepPrompt(chatId, stepIndex, session.context.multiSelect, { flow });
    return;
  }
  if (session.state === 'registering_confirm' || session.state === 'requesting_confirm') {
    const flow = session.state === 'requesting_confirm' ? 'request' : 'register';
    await sendMessage(chatId, flow === 'request' ? "Welcome back — here's your saved request so far." : "Welcome back — here's your saved profile so far.");
    await sendMessage(chatId, formatConfirmScreen(session.context.draft || {}, flow), [
      [{ text: '✅ Confirm', callback_data: 'nav:confirm' }, { text: '🔄 Start over', callback_data: 'nav:cancel' }],
    ]);
    return;
  }

  await saveSession(telegramUserId, 'idle', {});
  await sendGreeting(chatId, firstName, telegramUserId);
}

async function showAssignmentAndMaybeRegister(chatId, telegramUserId, assignmentId) {
  const assignment = await getAssignment(assignmentId);
  if (!assignment) {
    await sendMessage(chatId, "😕 Sorry, this assignment isn't available anymore.");
    await saveSession(telegramUserId, 'idle', {});
    return;
  }
  await sendMessage(chatId, formatAssignment(assignment));

  const profile = await getTutorProfileByTelegramId(telegramUserId);
  if (profile && profile.profile_complete) {
    // Already registered — apply directly.
    await createApplication(assignmentId, telegramUserId, profile.id);
    await saveSession(telegramUserId, 'idle', {});
    await sendMessage(chatId, "✅ You're all set — your application has been recorded. Our team will be in touch if you're shortlisted!");
    return;
  }

  // Not recognized by Telegram account yet — check for an existing website
  // registration by phone before assuming they need the full wizard.
  await saveSession(telegramUserId, 'awaiting_phone_check', { assignmentId });
  await sendMessage(
    chatId,
    "📱 Have you already registered as a tutor on our website? If so, reply with the phone number you used and we'll link it up — no need to fill everything in again.",
    [[{ text: "No, I'm new — register me", callback_data: 'reg:start' }]]
  );
}

async function handleMenu(chatId, telegramUserId, action, username) {
  if (action === 'request_tutor') {
    await startRequest(chatId, telegramUserId);
    return;
  }
  if (action === 'register_tutor') {
    const profile = await getTutorProfileByTelegramId(telegramUserId);
    if (profile && profile.profile_complete) {
      await sendMessage(chatId, "✅ You're already registered! Tap below if you'd like to update anything.", [
        [{ text: '✏️ Edit my profile', callback_data: 'menu:edit_profile' }],
      ]);
      return;
    }
    await startRegistration(chatId, telegramUserId, null, username);
    return;
  }
  if (action === 'assignments') {
    let assignments = await getOpenAssignments();
    if (!assignments.length) {
      await sendMessage(chatId, '📭 No open assignments right now — check back soon!');
      return;
    }
    const profile = await getTutorProfileByTelegramId(telegramUserId);
    if (profile && profile.profile_complete) {
      assignments = rankAssignmentsForTutor(assignments, profile);
    }
    const keyboard = assignments.map((a) => [
      { text: formatAssignmentSummary(a), callback_data: `apply:${a.id.replace(/-/g, '')}` },
    ]);
    await sendMessage(
      chatId,
      `📋 ${assignments.length} open assignment${assignments.length > 1 ? 's' : ''} — tap one to view details & apply:`,
      keyboard
    );
    return;
  }
  if (action === 'edit_profile') {
    const profile = await getTutorProfileByTelegramId(telegramUserId);
    if (!profile || !profile.profile_complete) {
      await sendMessage(chatId, "📝 You don't have a completed profile yet — register first via an assignment (see 'View available assignments').");
      return;
    }
    await sendEditMenu(telegramUserId, chatId);
    return;
  }
  if (action === 'applications') {
    const apps = await getApplicationsForTutor(telegramUserId);
    if (!apps.length) {
      await sendMessage(chatId, "📭 You haven't applied to any assignments yet.");
      return;
    }
    const lines = apps.map((app) => {
      const a = app.assignments || {};
      return `• ${a.student_level || '-'} · ${(a.subjects || []).join('/')} · ${a.location || '-'} — *${app.status}*`;
    });
    await sendMessage(chatId, `📋 Your applications:\n\n${lines.join('\n')}`);
    return;
  }
  if (action === 'contact') {
    await sendMessage(chatId, TEAM_CONTACT_MESSAGE);
    return;
  }
  if (action === 'exit') {
    await saveSession(telegramUserId, 'idle', {});
    await sendGoodbye(chatId);
    return;
  }
  if (action === 'admin_tools') {
    if (!isAdmin(telegramUserId)) return;
    await sendMessage(chatId, '🛠️ Admin tools', [
      [{ text: '📝 Log a parent request', callback_data: 'admin:log_request' }],
      [{ text: '✅ Convert a request to an assignment', callback_data: 'admin:convert_request' }],
    ]);
  }
}

async function startRegistration(chatId, telegramUserId, assignmentId, username) {
  await saveSession(telegramUserId, 'registering_0', { assignmentId: assignmentId || null, draft: {}, username: username || null, flow: 'register' });
  await sendStepPrompt(chatId, 0, undefined, { flow: 'register' });
}

async function startRequest(chatId, telegramUserId, opts = {}) {
  await saveSession(telegramUserId, 'requesting_0', {
    draft: {},
    flow: 'request',
    source: opts.source || 'bot',
    adminFlow: !!opts.adminFlow,
  });
  await sendStepPrompt(chatId, 0, undefined, { flow: 'request' });
}

async function handleRegistrationInput(session, chatId, telegramUserId, input, stepIndex, isEdit, flow = 'register') {
  const steps = stepsFor(flow);
  const step = steps[stepIndex];
  const draft = { ...(session.context.draft || {}) };
  const statePrefix = isEdit ? 'editing_' : prefixFor(flow);

  if (input.kind === 'callback' && (input.data === 'nav:back' || input.data === 'nav:cancel')) {
    if (isEdit) {
      await sendMessage(chatId, 'No changes made.');
      await sendEditMenu(telegramUserId, chatId);
      return;
    }
    if (input.data === 'nav:back') {
      await goToStep(telegramUserId, chatId, session.context, draft, Math.max(0, stepIndex - 1), flow);
      return;
    }
    await saveSession(telegramUserId, 'idle', {});
    await sendMessage(chatId, 'Cancelled — no changes were saved.');
    await sendGreeting(chatId, undefined, telegramUserId);
    return;
  }
  if (input.kind === 'callback' && input.data === 'nav:save_exit') {
    if (isEdit) {
      await sendEditMenu(telegramUserId, chatId);
      return;
    }
    await saveSession(telegramUserId, `${prefixFor(flow)}${stepIndex}`, { ...session.context, draft, flow });
    await sendGoodbye(chatId);
    return;
  }

  // ---- Multi-choice steps: toggle selections, editing the same message in place ----
  if (step.type === 'multi-choice') {
    const current = session.context.multiSelect || [];

    if (input.kind === 'callback' && input.data.startsWith('msel:')) {
      const val = input.data.slice('msel:'.length);
      const updated = current.includes(val) ? current.filter((v) => v !== val) : [...current, val];
      await saveSession(telegramUserId, `${statePrefix}${stepIndex}`, { ...session.context, draft, multiSelect: updated });

      const keyboard = [];
      step.choices.forEach(([label, value]) => {
        const mark = updated.includes(value) ? '✅ ' : '';
        keyboard.push([{ text: `${mark}${label}`, callback_data: `msel:${value}` }]);
      });
      keyboard.push([{ text: `➡️ Continue (${updated.length} selected)`, callback_data: 'msel_done' }]);
      keyboard.push(isEdit ? [{ text: '🚫 Cancel', callback_data: 'nav:cancel' }] : navRow(stepIndex));
      if (input.messageId) {
        await tg('editMessageReplyMarkup', {
          chat_id: chatId,
          message_id: input.messageId,
          reply_markup: { inline_keyboard: keyboard },
        });
      }
      return;
    }

    if (input.kind === 'callback' && input.data === 'msel_done') {
      if (!current.length) {
        await sendMessage(chatId, 'Please select at least one option first. ☝️');
        return;
      }
      draft[step.key] = current;
      if (isEdit) {
        await applyFieldEdit(telegramUserId, chatId, step, current);
        return;
      }
      await advanceOrConfirm(telegramUserId, chatId, session.context, draft, stepIndex + 1, flow);
      return;
    }

    await sendMessage(chatId, 'Please use the buttons above to answer this question.');
    return;
  }

  // ---- Text / single-choice steps ----
  let value;
  if (input.kind === 'callback' && input.data.startsWith('ans:')) {
    const raw = input.data.slice('ans:'.length);
    value = raw === 'not_applicable' ? 'Not applicable' : raw;
  } else if (input.kind === 'text' && step.type === 'text') {
    if (step.maxLen && input.text.length > step.maxLen) {
      await sendMessage(chatId, `That's a bit long — please keep it under ${step.maxLen} characters (yours was ${input.text.length}). ✂️`);
      return;
    }
    if (step.validate && !step.validate.test(input.text)) {
      await sendMessage(chatId, step.validateMessage || "That doesn't look quite right — please try again.");
      return;
    }
    value = input.text;
  } else {
    await sendMessage(chatId, 'Please use the buttons above to answer this question.');
    return;
  }

  draft[step.key] = value;
  if (isEdit) {
    await applyFieldEdit(telegramUserId, chatId, step, value);
    return;
  }
  await advanceOrConfirm(telegramUserId, chatId, session.context, draft, stepIndex + 1, flow);
}

async function handleConfirm(session, chatId, telegramUserId, input, flow = 'register') {
  if (input.kind === 'callback' && input.data === 'nav:cancel') {
    await saveSession(telegramUserId, 'idle', {});
    await sendMessage(chatId, 'No problem — starting over. Type /start when ready.');
    return;
  }
  if (input.kind === 'callback' && input.data === 'nav:confirm') {
    const draft = session.context.draft || {};

    if (flow === 'request') {
      await insertTutorRequest(draft, session.context.source || 'bot');
      await saveSession(telegramUserId, 'idle', {});

      if (session.context.adminFlow) {
        await sendMessage(chatId, '✅ Logged! You can convert it to a published assignment anytime from Admin tools.');
        return;
      }

      await sendMessage(chatId, "🎉 Got it — our team will personally review this and be in touch soon!");
      try {
        const matches = await fetchTutorMatchTeaser(draft);
        await sendMessage(chatId, formatMatchTeaserMessage(matches));
      } catch (err) {
        console.error('match teaser failed:', err);
      }
      return;
    }

    const username = session.context.username;
    await upsertTutorProfile(telegramUserId, draft, username);
    const profile = await getTutorProfileByTelegramId(telegramUserId);

    const assignmentId = session.context.assignmentId;
    if (assignmentId) {
      await createApplication(assignmentId, telegramUserId, profile?.id);
      await saveSession(telegramUserId, 'idle', {});
      await sendMessage(chatId, "🎉 Profile saved and your application has been recorded. Our team will be in touch if you're shortlisted!");
      if (profile) await sendAssignmentSuggestions(chatId, profile, assignmentId);
      return;
    }

    await saveSession(telegramUserId, 'idle', {});
    await sendMessage(chatId, "🎉 Profile saved! You're ready to apply to assignments — try 'View available assignments' from /start.");
    if (profile) await sendAssignmentSuggestions(chatId, profile);
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

  if (state === 'awaiting_phone_check') {
    if (input.kind === 'callback') {
      if (input.data === 'reg:start') {
        await startRegistration(chatId, telegramUserId, session.context.assignmentId, input.username);
      } else {
        await saveSession(telegramUserId, 'idle', {});
        await sendGreeting(chatId, undefined, telegramUserId);
      }
      return;
    }

    const existing = await findUnlinkedProfileByPhone(input.text.trim());
    if (!existing) {
      await sendMessage(
        chatId,
        "🤔 We couldn't find a profile with that number. Try a different number, or register fresh.",
        [[{ text: "No, I'm new — register me", callback_data: 'reg:start' }]]
      );
      return;
    }

    await linkProfileToTelegram(existing.id, telegramUserId, input.username);
    const assignmentId = session.context.assignmentId;
    if (assignmentId) {
      await createApplication(assignmentId, telegramUserId, existing.id);
      await saveSession(telegramUserId, 'idle', {});
      await sendMessage(chatId, "🎉 Found it — you're linked up, and your application has been recorded. Our team will be in touch if you're shortlisted!");
      return;
    }
    await saveSession(telegramUserId, 'idle', {});
    await sendMessage(chatId, "🎉 Found it — you're linked up and ready to apply to assignments!");
    return;
  }

  if (state.startsWith('registering_') && state !== 'registering_confirm') {
    const stepIndex = Number(state.split('_')[1]);
    await handleRegistrationInput(session, chatId, telegramUserId, input, stepIndex, false, 'register');
    return;
  }

  if (state === 'registering_confirm') {
    await handleConfirm(session, chatId, telegramUserId, input, 'register');
    return;
  }

  if (state.startsWith('requesting_') && state !== 'requesting_confirm') {
    const stepIndex = Number(state.split('_')[1]);
    await handleRegistrationInput(session, chatId, telegramUserId, input, stepIndex, false, 'request');
    return;
  }

  if (state === 'requesting_confirm') {
    await handleConfirm(session, chatId, telegramUserId, input, 'request');
    return;
  }

  if (state === 'editing_menu') {
    if (input.kind === 'callback' && input.data === 'edit:done') {
      await saveSession(telegramUserId, 'idle', {});
      await sendGreeting(chatId, undefined, telegramUserId);
      return;
    }
    if (input.kind === 'callback' && input.data?.startsWith('editfield:')) {
      const idx = Number(input.data.slice('editfield:'.length));
      const step = STEPS[idx];
      const profile = await getTutorProfileByTelegramId(telegramUserId);
      const currentValue = valueForStoredField(step, profile ? profile[columnForStep(step.key)] : null);
      await saveSession(telegramUserId, `editing_${idx}`, {
        multiSelect: step.type === 'multi-choice' ? currentValue || [] : undefined,
      });
      await sendStepPrompt(chatId, idx, currentValue, { isEdit: true });
      return;
    }
    await sendEditMenu(telegramUserId, chatId);
    return;
  }

  if (state.startsWith('editing_')) {
    const stepIndex = Number(state.split('_')[1]);
    await handleRegistrationInput(session, chatId, telegramUserId, input, stepIndex, true);
    return;
  }

  if (state === 'admin_confirm_assignment') {
    if (!isAdmin(telegramUserId)) {
      await saveSession(telegramUserId, 'idle', {});
      await sendGreeting(chatId, undefined, telegramUserId);
      return;
    }
    if (input.kind === 'callback' && input.data === 'nav:cancel') {
      await saveSession(telegramUserId, 'idle', {});
      await sendMessage(chatId, 'Cancelled — nothing was posted.');
      await sendGreeting(chatId, undefined, telegramUserId);
      return;
    }
    if (input.kind === 'callback' && input.data === 'nav:confirm') {
      const { draft, requestId } = session.context;
      const assignment = await createAssignmentFromDraft(draft, requestId);
      await saveSession(telegramUserId, 'idle', {});
      await sendMessage(chatId, assignment ? '✅ Posted! It will appear in the channel shortly.' : '⚠️ Something went wrong creating this assignment.');
      return;
    }
    await sendMessage(chatId, 'Please tap Confirm or Cancel.');
    return;
  }

  // idle (or anything else): menu actions + apply:<id> deep-link-equivalent taps
  if (input.kind === 'callback' && input.data?.startsWith('menu:')) {
    await handleMenu(chatId, telegramUserId, input.data.slice('menu:'.length), input.username);
    return;
  }
  if (input.kind === 'callback' && input.data?.startsWith('apply:')) {
    const assignmentId = hexToUuid(input.data.slice('apply:'.length));
    await saveSession(telegramUserId, 'viewing_assignment_prompt', { assignmentId });
    await showAssignmentAndMaybeRegister(chatId, telegramUserId, assignmentId);
    return;
  }
  if (input.kind === 'callback' && input.data?.startsWith('admin:') && isAdmin(telegramUserId)) {
    const action = input.data.slice('admin:'.length);
    if (action === 'log_request') {
      await startRequest(chatId, telegramUserId, { source: 'whatsapp', adminFlow: true });
      return;
    }
    if (action === 'convert_request') {
      const requests = await getUnconvertedRequests();
      if (!requests.length) {
        await sendMessage(chatId, '📭 No pending requests to convert right now.');
        return;
      }
      const keyboard = requests.map((r) => [
        {
          text: `${r.parent_name || 'Unnamed'} · ${r.student_level || '?'} · ${(r.subjects || []).join('/') || '?'}`,
          callback_data: `convertreq:${r.id.replace(/-/g, '')}`,
        },
      ]);
      await sendMessage(chatId, '📋 Pick a request to turn into a published assignment:', keyboard);
      return;
    }
    return;
  }
  if (input.kind === 'callback' && input.data?.startsWith('convertreq:') && isAdmin(telegramUserId)) {
    const requestId = hexToUuid(input.data.slice('convertreq:'.length));
    const request = await getTutorRequest(requestId);
    if (!request) {
      await sendMessage(chatId, "😕 Couldn't find that request — it may have been converted already.");
      return;
    }
    const draft = draftFromRequest(request);
    await saveSession(telegramUserId, 'admin_confirm_assignment', { draft, requestId });
    await sendMessage(chatId, formatAssignmentDraft(draft), [
      [{ text: '✅ Confirm & post', callback_data: 'nav:confirm' }, { text: '🚫 Cancel', callback_data: 'nav:cancel' }],
    ]);
    return;
  }
  // Unrecognized input while idle — just re-show the greeting.
  await sendGreeting(chatId, undefined, telegramUserId);
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
      await handleInput(session, chatId, telegramUserId, {
        kind: 'callback',
        data: cq.data,
        messageId: cq.message?.message_id,
        username: from.username,
      });
    } else if (msg) {
      const text = (msg.text || '').trim();
      if (text === '/start' || text.startsWith('/start ')) {
        const payload = text.split(' ')[1];
        await handleStart(session, chatId, telegramUserId, from.first_name, payload, from.username);
      } else {
        await handleInput(session, chatId, telegramUserId, { kind: 'text', text, username: from.username });
      }
    }
  } catch (err) {
    console.error('telegram-webhook error:', err);
  }

  return { statusCode: 200, body: 'ok' };
};

module.exports.__testables = {
  STEPS,
  REQUEST_STEPS,
  hexToUuid,
  labelFor,
  formatAssignment,
  formatAssignmentSummary,
  formatConfirmScreen,
  formatMatchTeaserMessage,
  navRow,
  columnForStep,
  valueForStoredField,
};
