// Mocked end-to-end tests for the Telegram bot. No network: Supabase is an
// in-memory fake and Telegram calls are recorded, not sent.
//
// Run from the repo root:  node tests/bot.test.js
const assert = require('assert');
process.env.TELEGRAM_WEBHOOK_SECRET = 's';
process.env.SUPABASE_URL = 'https://sb.test';
process.env.TELEGRAM_BOT_TOKEN = 't';
process.env.ADMIN_TELEGRAM_USER_IDS = '999';

const db = { bot_sessions: [], tutor_profiles: [] };
const tgCalls = [];
const rpcCalls = [];
const eqFilters = (qs) => [...qs.entries()].filter(([, v]) => v.startsWith('eq.')).map(([k, v]) => [k, v.slice(3)]);

global.fetch = async (url, opts = {}) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => (body == null ? '' : JSON.stringify(body)) });
  if (url.startsWith('https://api.telegram.org')) {
    tgCalls.push({ method: url.split('/').pop(), body: JSON.parse(opts.body || '{}') });
    return ok({ ok: true, result: { message_id: tgCalls.length } });
  }
  const u = new URL(url);
  const table = u.pathname.replace('/rest/v1/', '');
  if (table.startsWith('rpc/')) { rpcCalls.push(JSON.parse(opts.body)); return ok([]); }
  const rows = db[table] || (db[table] = []);
  const f = eqFilters(u.searchParams);
  const match = (r) => f.every(([k, v]) => String(r[k]) === v) && ![...u.searchParams.entries()].some(([k, v]) => v === 'is.null' && r[k] != null);
  const method = opts.method || 'GET';
  if (method === 'GET') return ok(rows.filter(match));
  const body = JSON.parse(opts.body);
  if (method === 'PATCH') { rows.filter(match).forEach((r) => Object.assign(r, body)); return ok(null); }
  if (method === 'POST') {
    const conflict = u.searchParams.get('on_conflict');
    const existing = conflict && rows.find((r) => r[conflict] === body[conflict]);
    if (existing) Object.assign(existing, body); else rows.push({ id: require("crypto").randomUUID(), ...body });
    return ok((opts.headers?.Prefer || '').includes('representation') ? [existing || rows.at(-1)] : null);
  }
};

const { handler, __testables: T } = require('../netlify/functions/telegram-webhook.js');
const UID = 111;
const send = (update) => handler({ httpMethod: 'POST', headers: { 'x-telegram-bot-api-secret-token': 's' }, body: JSON.stringify(update) });
const text = (t) => send({ message: { from: { id: UID, first_name: 'L', username: 'lt' }, chat: { id: UID }, text: t } });
const tap = (data) => send({ callback_query: { id: 'q', data, from: { id: UID, username: 'lt' }, message: { message_id: 1, chat: { id: UID } } } });
const session = () => db.bot_sessions.find((s) => s.telegram_user_id === UID);
const lastKeyboard = () => { const c = [...tgCalls].reverse().find((c) => c.body.reply_markup); return c.body.reply_markup.inline_keyboard.flat().map((b) => b.text); };

(async () => {
  let passed = 0;
  const t = async (name, fn) => { await fn(); passed++; console.log('✓', name); };
  const step = T.STEPS.find((s) => s.key === 'tutor_avail');

  await t('availability step is multi-choice and question count is still 15', () => {
    assert.strictEqual(step.type, 'multi-choice');
    assert.strictEqual(T.STEPS.length, 15);
    assert.strictEqual(T.STEPS.indexOf(step), 14);
  });

  await t('toggle: Flexible clears others, others clear Flexible, re-tap removes', () => {
    assert.deepStrictEqual(T.toggleMultiSelect(step, ['saturday', 'sunday'], 'flexible'), ['flexible']);
    assert.deepStrictEqual(T.toggleMultiSelect(step, ['flexible'], 'saturday'), ['saturday']);
    assert.deepStrictEqual(T.toggleMultiSelect(step, ['saturday'], 'saturday'), []);
    const subj = T.STEPS.find((s) => s.key === 'subjects');
    assert.deepStrictEqual(T.toggleMultiSelect(subj, ['Physics'], 'Other'), ['Physics', 'Other']);
  });

  await t('stored values read back: new label list, old single labels, legacy raw values', () => {
    assert.deepStrictEqual(T.valueForStoredField(step, 'Weekday evenings, Saturday'), ['weekday_evenings', 'saturday']);
    assert.deepStrictEqual(T.valueForStoredField(step, 'Weekends'), ['saturday', 'sunday']);
    assert.deepStrictEqual(T.valueForStoredField(step, 'Weekday daytime'), ['weekday_afternoons']);
    assert.deepStrictEqual(T.valueForStoredField(step, 'Weekday evenings'), ['weekday_evenings']);
    assert.deepStrictEqual(T.valueForStoredField(step, 'Flexible / anytime'), ['flexible']);
    assert.deepStrictEqual(T.valueForStoredField(step, 'weekends'), ['saturday', 'sunday']);
  });

  await t('other multi-choice fields (levels/subjects arrays) read back unchanged', () => {
    const lv = T.STEPS.find((s) => s.key === 'levels');
    assert.deepStrictEqual(T.valueForStoredField(lv, ['Primary', 'JC/A-Level']), ['Primary', 'JC/A-Level']);
    assert.deepStrictEqual(T.valueForStoredField(lv, ['JC / A-Level']), ['JC/A-Level']);
  });

  await t('full registration: every answer lands on the right question, availability saved as label list', async () => {
    await text('/start');
    await tap('menu:register_tutor');
    const answers = {
      full_name: 'Test Tutor', age: '22', phone_number: '91234567', gender: 'ans:female', qualifications: 'BSc NUS',
      tutor_tier: 'ans:pt_student', tutoring_experience: '2 years', teaching_style: 'Patient', track_record: 'B to A',
      levels: ['msel:Primary', 'msel:Secondary'], subjects: ['msel:Mathematics'], rate_min: '30', rate_max: '45', tutor_location: ['msel:North-East', 'msel:East', 'msel:Online'],
      tutor_avail: ['msel:weekday_evenings', 'msel:saturday', 'msel:flexible', 'msel:saturday', 'msel:sunday'],
    };
    for (const s of T.STEPS) {
      assert.strictEqual(session().state, `registering_${T.STEPS.indexOf(s)}`, `expected to be on ${s.key}`);
      const a = answers[s.key];
      if (Array.isArray(a)) { for (const d of a) await tap(d); await tap('msel_done'); }
      else if (a.startsWith('ans:')) await tap(a);
      else await text(a);
    }
    assert.strictEqual(session().state, 'registering_confirm');
    const confirm = [...tgCalls].reverse().find((c) => String(c.body.text || '').includes('double check')).body.text;
    assert.ok(confirm.includes('*Availability*: Saturday, Sunday'), confirm);
    await tap('nav:confirm');
    const p = db.tutor_profiles.find((r) => r.telegram_user_id === UID);
    assert.strictEqual(p.tutor_avail, 'Saturday, Sunday');
    assert.strictEqual(p.tutor_location, 'North-East, East, Online');
    assert.strictEqual(p.rate_max, '45');
    assert.deepStrictEqual(p.levels, ['Primary', 'Secondary']);
    assert.strictEqual(p.tutor_tier, 'Part-time (Student)');
  });

  await t('legacy "Weekends" pre-ticks Sat+Sun on edit; Continue with nothing selected is blocked', async () => {
    db.tutor_profiles.find((r) => r.telegram_user_id === UID).tutor_avail = 'Weekends';
    await tap('menu:edit_profile');
    await tap(`editfield:14`);
    assert.ok(lastKeyboard().includes('✅ Saturday') && lastKeyboard().includes('✅ Sunday'), 'legacy "Weekends" pre-ticks Sat+Sun');
    await tap('msel:saturday'); await tap('msel:sunday');
    await tap('msel_done');
    assert.ok(tgCalls.at(-1).body.text.includes('select at least one'));
  });

  await t('editing availability on an old profile saves the new label list', async () => {
    await tap('msel:weekday_afternoons'); await tap('msel:sunday');
    await tap('msel_done');
    assert.strictEqual(db.tutor_profiles.find((r) => r.telegram_user_id === UID).tutor_avail, 'Weekday afternoons, Sunday');
  });

  await t('editing a single-choice label field (tutor category) still stores the label', async () => {
    await tap('editfield:5'); await tap('ans:ft');
    assert.strictEqual(db.tutor_profiles.find((r) => r.telegram_user_id === UID).tutor_tier, 'Full-time');
  });

  await t('a draft left mid-wizard with an old single value resumes cleanly', async () => {
    const s = session();
    s.state = 'registering_13';
    s.context = { draft: { ...s.context.draft, tutor_avail: 'weekends' }, flow: 'register' };
    await tap('msel:West'); await tap('msel_done');
    assert.strictEqual(session().state, 'registering_14');
    assert.deepStrictEqual(session().context.multiSelect, ['saturday', 'sunday']);
  });

  // ---------------- Regions ----------------
  const locStep = T.STEPS.find((s) => s.key === 'tutor_location');

  await t('tutor regions: legacy free text dropped, "anywhere" = all five, new list read back', () => {
    assert.deepStrictEqual(T.valueForStoredField(locStep, 'Punggol, Sengkang'), []);
    assert.deepStrictEqual(T.valueForStoredField(locStep, 'anywhere'), ['North', 'North-East', 'East', 'West', 'Central']);
    assert.deepStrictEqual(T.valueForStoredField(locStep, 'North-East, East, Online'), ['North-East', 'East', 'Online']);
  });

  await t('scoring: exact region match only — East does not match North-East; Online matches Online', () => {
    const tutor = { subjects: ['Mathematics'], levels: ['Secondary'], tutor_location: 'North-East, Online' };
    const base = { subjects: ['Mathematics'], student_level: 'Sec 3' };
    assert.strictEqual(T.scoreAssignmentForTutor({ ...base, region: 'North-East' }, tutor), 100);
    assert.strictEqual(T.scoreAssignmentForTutor({ ...base, region: 'East' }, tutor), 80);
    assert.strictEqual(T.scoreAssignmentForTutor({ ...base, region: 'Online' }, tutor), 100);
    assert.strictEqual(T.scoreAssignmentForTutor({ ...base, region: null, location: 'Punggol' }, tutor), 80);
    const old = { subjects: ['Mathematics'], levels: ['Secondary'], tutor_location: 'anywhere North-East' };
    assert.strictEqual(T.scoreAssignmentForTutor({ ...base, region: 'West' }, old), 80, 'old "anywhere North-East" bug gone');
  });

  await t('area display', () => {
    assert.strictEqual(T.formatArea({ location: 'Punggol', region: 'North-East' }), 'Punggol (North-East)');
    assert.strictEqual(T.formatArea({ location: 'Tampines', region: 'Online' }), 'Online (Tampines)');
    assert.strictEqual(T.formatArea({ location: 'Bishan' }), 'Bishan');
    assert.strictEqual(T.formatArea({}), '-');
  });

  const PID = 222;
  const ptext = (t) => send({ message: { from: { id: PID, first_name: 'P' }, chat: { id: PID }, text: t } });
  const ptap = (data) => send({ callback_query: { id: 'q', data, from: { id: PID }, message: { message_id: 1, chat: { id: PID } } } });
  const psession = () => db.bot_sessions.find((s) => s.telegram_user_id === PID);

  await t('parent request: 12 questions, region is a button, saved with neighbourhood; match uses region', async () => {
    assert.strictEqual(T.REQUEST_STEPS.length, 12);
    await ptext('/start'); await ptap('menu:request_tutor');
    const answers = { parent_name: 'Mrs Tan', parent_phone: '98765432', parent_email: 'ans:not_applicable', student_level: 'ans:Secondary 3–4 (O-Level)',
      school_type: 'ans:not_applicable', subjects: ['msel:Mathematics'], frequency: 'ans:1x/week', budget: 'ans:$30–50',
      region: 'ans:East', location: 'Tampines, near Tampines West MRT', mode: "ans:At student's home", concerns: 'ans:not_applicable' };
    for (const s of T.REQUEST_STEPS) {
      assert.strictEqual(psession().state, `requesting_${T.REQUEST_STEPS.indexOf(s)}`, `expected ${s.key}`);
      const a = answers[s.key];
      if (Array.isArray(a)) { for (const d of a) await ptap(d); await ptap('msel_done'); }
      else if (a.startsWith('ans:')) await ptap(a); else await ptext(a);
    }
    await ptap('nav:confirm');
    const r = db.tutor_requests.at(-1);
    assert.strictEqual(r.region, 'East');
    assert.strictEqual(r.location, 'Tampines, near Tampines West MRT');
    assert.strictEqual(r.mode, "At student's home");
    assert.strictEqual(rpcCalls.at(-1).p_location, 'East');
  });

  await t('online-only request matches on Online', () => {
    assert.strictEqual(T.regionForMatching({ region: 'West', mode: 'Online' }), 'Online');
    assert.strictEqual(T.regionForMatching({ region: 'West', mode: 'Either works' }), 'West');
  });

  const AID = 999;
  const atap = (data) => send({ callback_query: { id: 'q', data, from: { id: AID }, message: { message_id: 1, chat: { id: AID } } } });
  const asession = () => db.bot_sessions.find((s) => s.telegram_user_id === AID);

  await t('admin convert: request with region goes straight to confirm, assignment saved with region', async () => {
    await send({ message: { from: { id: AID, first_name: 'G' }, chat: { id: AID }, text: '/start' } });
    const req = db.tutor_requests.at(-1);
    await atap(`convertreq:${req.id}`.replace(/-/g, ''));
    assert.strictEqual(asession().state, 'admin_confirm_assignment');
    assert.ok(tgCalls.at(-1).body.text.includes('Area: Tampines, near Tampines West MRT (East)'));
    await atap('nav:confirm');
    assert.strictEqual(db.assignments.at(-1).region, 'East');
  });

  await t('admin convert: older request without region asks for region buttons first', async () => {
    db.tutor_requests.push({ id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', parent_name: 'Old', student_level: 'Primary 1–3', subjects: ['English'], location: 'Jurong', budget: '$30–50', converted_assignment_id: null });
    await atap('convertreq:aaaaaaaabbbbccccddddeeeeeeeeeeee');
    assert.strictEqual(asession().state, 'admin_pick_region');
    assert.ok(tgCalls.at(-1).body.text.includes('Area given: Jurong'));
    await atap('region:Bogus');
    assert.strictEqual(asession().state, 'admin_pick_region', 'invalid region re-prompts');
    await atap('region:West');
    assert.strictEqual(asession().state, 'admin_confirm_assignment');
    await atap('nav:confirm');
    assert.strictEqual(db.assignments.at(-1).region, 'West');
    assert.strictEqual(db.assignments.at(-1).location, 'Jurong');
  });

  await t('non-admin cannot use the region picker', async () => {
    db.bot_sessions.find((s) => s.telegram_user_id === PID).state = 'admin_pick_region';
    const before = (db.assignments || []).length;
    await ptap('region:West');
    assert.strictEqual(psession().state, 'idle');
    assert.strictEqual(db.assignments.length, before);
  });

  const post = require('../netlify/functions/post-assignment.js').__testables;
  await t('channel post shows neighbourhood + region', () => {
    assert.ok(post.formatAssignmentMessage({ location: 'Punggol', region: 'North-East', subjects: [] }).includes('Area: Punggol (North-East)'));
  });

  await t('assignment codes shown in bot detail, list summary, and channel post', () => {
    const a = { code: 'A012', student_level: 'Sec 3', subjects: ['Mathematics'], region: 'East', location: 'Tampines' };
    assert.ok(T.formatAssignment(a).startsWith('📋 Assignment A012'));
    assert.ok(T.formatAssignmentSummary(a).startsWith('A012 · Sec 3'));
    assert.ok(post.formatAssignmentMessage(a).startsWith('📋 New Assignment A012'));
    assert.ok(T.formatAssignmentSummary({ ...a, code: null }).startsWith('Sec 3'), 'rows without a code still render');
  });

  await t('admin gets the new code back after posting', async () => {
    const req = { id: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee', parent_name: 'X', student_level: 'Primary 4–6 (PSLE)', subjects: ['Science'], region: 'North', location: 'Yishun', converted_assignment_id: null };
    db.tutor_requests.push(req);
    const realPush = db.assignments.push.bind(db.assignments);
    db.assignments.push = (row) => realPush({ code: 'A077', ...row });
    await atap('convertreq:bbbbbbbbbbbbccccddddeeeeeeeeeeee');
    await atap('nav:confirm');
    assert.ok(tgCalls.at(-1).body.text.includes('Posted as A077'), tgCalls.at(-1).body.text);
  });

  console.log(`\n${passed} passed`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });
