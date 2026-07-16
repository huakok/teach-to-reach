// ==========================================================================
// TeachToReach — shared front-end behaviour.
// Form submissions are saved directly to Supabase (Postgres). The anon key
// below is safe to expose client-side — it only has INSERT rights on the
// two tables, enforced by Row Level Security policies (see db/schema.sql).
// ==========================================================================

const SUPABASE_URL = 'https://iyfkunwywlqfgtyqouqp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5Zmt1bnd5d2xxZmd0eXFvdXFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MjM3MjksImV4cCI6MjA5OTA5OTcyOX0.MZi1hwb4G2xPo16tUBaCtd5EXbNwGE8nGG1v6mR3AC4';
const TELEGRAM_BOT_USERNAME = 'TeachToReachBot';

async function submitToSupabase(table, payload) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Submission failed (${res.status}): ${await res.text()}`);
  }
}

async function fetchTutorMatches(params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/match_tutors`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    throw new Error(`Match lookup failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

// Parent-facing level dropdown is more granular than the tutor "levels" buckets.
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

// Parents can only pick generic "Science"; tutors register specific sciences.
function expandSubjectsForMatching(subjects) {
  const expanded = new Set();
  (subjects || []).forEach((s) => {
    if (s === 'Science') {
      ['Physics', 'Chemistry', 'Biology'].forEach((sub) => expanded.add(sub));
    } else {
      expanded.add(s);
    }
  });
  return Array.from(expanded);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// Honeypot spam guard: a field named hp_website, hidden off-screen (not
// display:none — some bots skip those) and never shown to real users. Bots
// that auto-fill every field trip it; real visitors never see or touch it.
function isHoneypotTripped(form) {
  const hp = form.querySelector('#hp_website');
  return !!(hp && hp.value.trim());
}

async function showTutorMatchTeaser(form, payload) {
  const container = form.querySelector('.match-teaser');
  if (!container) return;

  const budgetRange = mapBudgetToRange(payload.budget);
  let results;
  try {
    results = await fetchTutorMatches({
      p_subjects: expandSubjectsForMatching(payload.subjects),
      p_level_bucket: mapLevelToBucket(payload.student_level),
      p_location: payload.location || null,
      p_budget_min: budgetRange.min,
      p_budget_max: budgetRange.max,
    });
  } catch (err) {
    console.error(err);
    return; // the human-reviewed fallback message already covers this
  }

  if (!results || results.length === 0) {
    container.innerHTML = '<p class="match-teaser-empty">No exact match in the pool yet — Grace will personally source one for you within 24–48 hours.</p>';
    container.style.display = 'block';
    return;
  }

  const cards = results.map((r) => {
    const scoreBand = r.score >= 80 ? 'high' : r.score >= 50 ? 'mid' : 'low';
    const rate = (r.rate_min && r.rate_max) ? `$${r.rate_min}–${r.rate_max}/hr` : '';
    const subjectsLabel = (r.subjects || []).slice(0, 3).join(', ');
    return `
      <div class="match-teaser-card">
        <div class="tile-score ${scoreBand}"><span class="num">${r.score}%</span><span class="lbl">FIT</span></div>
        <div>
          <h4>${escapeHtml(r.tutor_tier || 'Tutor')}</h4>
          <div class="tags">
            ${rate ? `<span class="tag">${escapeHtml(rate)}</span>` : ''}
            ${r.tutor_location ? `<span class="tag">${escapeHtml(r.tutor_location)}</span>` : ''}
            ${r.tutor_avail ? `<span class="tag">${escapeHtml(r.tutor_avail)}</span>` : ''}
          </div>
          <p class="meta">Teaches ${escapeHtml(subjectsLabel)}</p>
        </div>
      </div>`;
  }).join('');

  container.innerHTML = `
    <p class="match-teaser-intro">${results.length} tutor${results.length > 1 ? 's' : ''} in the pool already look like a good fit:</p>
    ${cards}
    <p class="match-teaser-note">Grace will confirm details and personally introduce you to the best fit within 24–48 hours.</p>
  `;
  container.style.display = 'block';
}

// ---------- Mobile nav ----------
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    const isOpen = () => links.style.display === 'flex';

    function openMenu() {
      const navHeight = document.querySelector('.site-nav .inner').offsetHeight;
      links.style.display = 'flex';
      links.style.cssText += `position:absolute;top:${navHeight}px;left:0;right:0;background:#0B0B0A;border-bottom:1px solid rgba(232,196,104,0.22);flex-direction:column;padding:20px 24px;gap:18px;`;
    }

    function closeMenu() {
      links.style.display = 'none';
    }

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      isOpen() ? closeMenu() : openMenu();
    });

    // Tapping a link (e.g. a same-page #anchor, which doesn't trigger a
    // full page navigation) should close the menu too, not just clicking
    // outside it.
    links.addEventListener('click', (e) => {
      if (e.target.closest('a')) closeMenu();
    });

    // Click/tap anywhere outside the open menu closes it.
    document.addEventListener('click', (e) => {
      if (isOpen() && !links.contains(e.target) && !toggle.contains(e.target)) {
        closeMenu();
      }
    });
  }

  // ---------- FAQ accordion ----------
  document.querySelectorAll('.faq-item').forEach((item) => {
    const q = item.querySelector('.faq-q');
    const a = item.querySelector('.faq-a');
    if (!q || !a) return;
    q.addEventListener('click', () => {
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach((o) => {
        o.classList.remove('open');
        o.querySelector('.faq-a').style.maxHeight = null;
      });
      if (!isOpen) {
        item.classList.add('open');
        a.style.maxHeight = a.scrollHeight + 'px';
      }
    });
  });

  initMultiStepForm('request-form', 'tutor_requests', showTutorMatchTeaser);
  initMultiStepForm('tutor-form', 'tutor_profiles');
  loadOpenAssignments();
  loadHeroMatchCard();
  initNavScrollShadow();
  initScrollReveal();
  initHeroEntrance();
  initReviewForm();
  loadApprovedReviews();
  loadAllReviews();
});

// ---------- Star rating input: keep the hidden number input in sync ----------
function initStarInput() {
  const group = document.querySelector('.star-input');
  if (!group) return;
  group.querySelectorAll('input').forEach((input) => {
    input.addEventListener('change', () => {
      group.dataset.rating = input.value;
    });
  });
}

// ---------- Review submission form (single-step, not the multi-step wizard) ----------
function initReviewForm() {
  const form = document.getElementById('review-form');
  if (!form) return;
  initStarInput();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (isHoneypotTripped(form)) {
      form.style.display = 'none';
      const successPane = document.querySelector('.review-success');
      if (successPane) successPane.style.display = 'block';
      return;
    }

    const rating = form.querySelector('.star-input input:checked')?.value;
    const errorEl = form.querySelector('.form-error');
    if (!rating) {
      if (errorEl) {
        errorEl.textContent = 'Please pick a star rating.';
        errorEl.style.display = 'block';
      }
      return;
    }

    const submitBtn = form.querySelector('[type=submit]');
    const originalLabel = submitBtn?.textContent;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
    }

    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await submitToSupabase('reviews', {
        author_name: data.author_name,
        role: data.role,
        context: data.context,
        rating: Number(rating),
        review_text: data.review_text,
        approved: false,
      });
    } catch (err) {
      console.error(err);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      }
      if (errorEl) {
        errorEl.textContent = 'Something went wrong sending this — please try again.';
        errorEl.style.display = 'block';
      }
      return;
    }

    form.style.display = 'none';
    const successPane = document.querySelector('.review-success');
    if (successPane) successPane.style.display = 'block';
  });
}

// ---------- Load approved reviews onto the homepage (falls back to the static markup on error) ----------
async function loadApprovedReviews() {
  const container = document.querySelector('.testi-grid');
  if (!container) return;

  let reviews;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/reviews?select=author_name,role,context,rating,review_text&approved=eq.true&order=created_at.desc&limit=6`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) return; // leave static fallback in place
    reviews = await res.json();
  } catch (err) {
    console.error(err);
    return; // leave static fallback in place
  }

  if (!reviews || !reviews.length) return;

  container.innerHTML = reviews.map((r) => {
    const rating = Math.max(0, Math.min(5, Number(r.rating) || 0));
    const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
    const initials = (r.author_name || '?')
      .split(' ')
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase();
    return `
      <div class="testi">
        <div class="stars">${stars}</div>
        <p>&ldquo;${escapeHtml(r.review_text)}&rdquo;</p>
        <div class="who"><span class="avatar">${escapeHtml(initials)}</span> ${escapeHtml(r.author_name)} · ${escapeHtml(r.context)}</div>
      </div>`;
  }).join('');
}

// ---------- Full reviews wall (reviews.html) — text + optional screenshot ----------
async function loadAllReviews() {
  const container = document.querySelector('.all-reviews-grid');
  if (!container) return;

  let reviews;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/reviews?select=author_name,role,context,rating,review_text,screenshot_url&approved=eq.true&order=created_at.desc`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
    reviews = await res.json();
  } catch (err) {
    console.error(err);
    container.innerHTML = '<p style="color:var(--ink-soft);">Couldn\'t load reviews right now — please refresh.</p>';
    return;
  }

  if (!reviews || !reviews.length) {
    container.innerHTML = '<p style="color:var(--ink-soft);">No reviews yet — be the first to leave one!</p>';
    return;
  }

  container.innerHTML = reviews.map((r) => {
    const rating = Math.max(0, Math.min(5, Number(r.rating) || 0));
    const stars = rating ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : '';
    const initials = (r.author_name || '?')
      .split(' ')
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join('')
      .toUpperCase();
    const photo = r.screenshot_url
      ? `<a href="${escapeHtml(r.screenshot_url)}" target="_blank" rel="noopener"><img src="${escapeHtml(r.screenshot_url)}" alt="Review screenshot from ${escapeHtml(r.context || 'a review')}" class="testi-screenshot" loading="lazy"></a>`
      : '';
    const text = r.review_text ? `<p>&ldquo;${escapeHtml(r.review_text)}&rdquo;</p>` : '';
    return `
      <div class="testi">
        ${stars ? `<div class="stars">${stars}</div>` : ''}
        ${photo}
        ${text}
        <div class="who"><span class="avatar">${escapeHtml(initials)}</span> ${escapeHtml(r.author_name)}${r.context ? ` · ${escapeHtml(r.context)}` : ''}</div>
      </div>`;
  }).join('');
}

// ---------- Hero entrance sequence (page load, once, respects reduced motion) ----------
function initHeroEntrance() {
  const els = document.querySelectorAll('.hero-enter');
  if (!els.length) return;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      els.forEach((el) => el.classList.add('in'));
    });
  });
}

// ---------- Nav shadow on scroll ----------
function initNavScrollShadow() {
  const nav = document.querySelector('.site-nav');
  if (!nav) return;
  const toggle = () => nav.classList.toggle('scrolled', window.scrollY > 8);
  toggle();
  window.addEventListener('scroll', toggle, { passive: true });
}

// ---------- Fade-up reveal on scroll ----------
function initScrollReveal() {
  const targets = document.querySelectorAll('.reveal');
  if (!targets.length) return;
  if (!('IntersectionObserver' in window)) {
    targets.forEach((t) => t.classList.add('in'));
    return;
  }
  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });
  targets.forEach((t) => observer.observe(t));
}

// ---------- Generic multi-step form controller ----------
function initMultiStepForm(formId, table, onSuccess) {
  const form = document.getElementById(formId);
  if (!form) return;

  const panes = Array.from(form.querySelectorAll('.step-pane'));
  const bars = Array.from(form.querySelectorAll('.progress .bar'));
  let current = 0;

  function render() {
    panes.forEach((p, i) => p.classList.toggle('active', i === current));
    bars.forEach((b, i) => {
      b.classList.toggle('done', i < current);
      b.classList.toggle('active', i === current);
    });
    form.querySelector('.form-shell')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function validatePane(pane) {
    const required = Array.from(pane.querySelectorAll('[required]'));
    for (const field of required) {
      if (field.type === 'checkbox' || field.type === 'radio') continue;
      if (!field.value || !field.value.trim()) {
        field.focus();
        field.style.borderColor = '#E85D75';
        return false;
      }
      field.style.borderColor = '';
    }
    // Chip-select groups: require at least one checked if marked data-require-one
    const chipGroups = pane.querySelectorAll('[data-require-one]');
    for (const group of chipGroups) {
      const checked = group.querySelectorAll('input:checked');
      if (checked.length === 0) {
        group.style.outline = '2px solid #E85D75';
        group.style.borderRadius = '8px';
        return false;
      }
      group.style.outline = '';
    }
    return true;
  }

  form.querySelectorAll('[data-next]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!validatePane(panes[current])) return;
      if (current < panes.length - 1) {
        current += 1;
        render();
      }
    });
  });

  form.querySelectorAll('[data-back]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (current > 0) {
        current -= 1;
        render();
      }
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    if (isHoneypotTripped(form)) {
      const successPane = form.querySelector('.success-pane-wrap');
      panes.forEach((p) => p.classList.remove('active'));
      bars.forEach((b) => { b.classList.add('done'); b.classList.remove('active'); });
      if (successPane) successPane.style.display = 'block';
      form.querySelector('.form-nav-wrap')?.style && (form.querySelector('.form-nav-wrap').style.display = 'none');
      return;
    }

    if (!validatePane(panes[current])) return;

    const submitBtn = form.querySelector('[type=submit]');
    const originalLabel = submitBtn?.textContent;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
    }

    const data = Object.fromEntries(new FormData(form).entries());
    const multiSelects = {};
    form.querySelectorAll('[data-multi]').forEach((group) => {
      const name = group.dataset.multi;
      multiSelects[name] = Array.from(group.querySelectorAll('input:checked')).map((i) => i.value);
    });

    const payload = { ...data, ...multiSelects };
    const errorEl = form.querySelector('.form-error');
    try {
      await submitToSupabase(table, payload);
    } catch (err) {
      console.error(err);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
      }
      if (errorEl) {
        errorEl.textContent = "Something went wrong sending this — check your connection and try again, or WhatsApp Grace directly.";
        errorEl.style.display = 'block';
      }
      return;
    }

    const successPane = form.querySelector('.success-pane-wrap');
    panes.forEach((p) => p.classList.remove('active'));
    bars.forEach((b) => { b.classList.add('done'); b.classList.remove('active'); });
    if (successPane) successPane.style.display = 'block';
    form.querySelector('.form-nav-wrap')?.style && (form.querySelector('.form-nav-wrap').style.display = 'none');

    if (typeof onSuccess === 'function') {
      onSuccess(form, payload);
    }
  });

  render();
}

// ---------- Live assignment board (assignments.html) ----------
// student_level is freeform text Grace types per-assignment (e.g. "Sec 4",
// "P6"), not a clean enum — so the level/age-range filter can't do an exact
// match against it (that would silently hide real listings whose text
// didn't happen to match exactly). This does the same best-effort bucket
// guess used server-side by the bot's own assignment-matching logic.
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

function timeAgo(dateStr) {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr${hrs > 1 ? 's' : ''} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days > 1 ? 's' : ''} ago`;
}

function renderAssignmentCards(container, list) {
  if (!list.length) {
    container.innerHTML = '<p style="color:var(--ink-soft);">📭 No open assignments right now — check back soon!</p>';
    return;
  }
  container.innerHTML = list.map((a) => {
    const subjects = a.subjects || [];
    const rate = `$${a.rate_min || '?'}–${a.rate_max || '?'}/hr`;
    return `
      <div class="assignment-card">
        <div class="body">
          <h4>${escapeHtml(a.student_level || 'Level TBC')}</h4>
          <div class="tags">
            ${subjects.map((s) => `<span class="tag">${escapeHtml(s)}</span>`).join('')}
            ${a.location ? `<span class="tag">${escapeHtml(a.location)}</span>` : ''}
            ${a.frequency ? `<span class="tag">${escapeHtml(a.frequency)}</span>` : ''}
          </div>
          ${a.notes ? `<p style="font-size:0.88rem;color:var(--ink-soft);">${escapeHtml(a.notes)}</p>` : ''}
          <div class="meta-row"><span>Posted ${timeAgo(a.created_at)}</span><span class="rate">${escapeHtml(rate)}</span></div>
          <a class="btn btn-jade btn-block" style="margin-top:14px;" href="https://t.me/${TELEGRAM_BOT_USERNAME}?start=assignment_${a.id.replace(/-/g, '')}" target="_blank" rel="noopener">Apply via Telegram</a>
        </div>
      </div>`;
  }).join('');
}

// Only a subject filter (not level) — student_level is freeform text Grace
// types per-assignment (e.g. "Sec 4", "P6"), so it can't be reliably
// bucketed for an exact-match filter without silently hiding real listings.
// subjects is a structured array, so an includes() filter is safe.
async function loadOpenAssignments() {
  const container = document.querySelector('.assignment-grid');
  if (!container) return;

  let assignments;
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/assignments?select=id,student_level,subjects,location,rate_min,rate_max,frequency,notes,created_at&status=eq.open&order=created_at.desc`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
    assignments = await res.json();
  } catch (err) {
    console.error(err);
    container.innerHTML = '<p style="color:var(--ink-soft);">Couldn\'t load assignments right now — please refresh.</p>';
    return;
  }

  renderAssignmentCards(container, assignments || []);

  const subjectSel = document.getElementById('filter-subject');
  const levelSel = document.getElementById('filter-level');

  function applyFilters() {
    const subject = subjectSel ? subjectSel.value : 'all';
    const level = levelSel ? levelSel.value : 'all';
    const filtered = assignments.filter((a) => {
      const matchesSubject = subject === 'all' || (a.subjects || []).includes(subject);
      const matchesLevel = level === 'all' || guessLevelBucket(a.student_level) === level;
      return matchesSubject && matchesLevel;
    });
    renderAssignmentCards(container, filtered);
  }

  if (subjectSel) subjectSel.addEventListener('change', applyFilters);
  if (levelSel) levelSel.addEventListener('change', applyFilters);
}

// ---------- Homepage hero card (index.html) ----------
// Used to be a hardcoded fake "93% FIT, matched to you" mockup — that's
// not something an anonymous first-time visitor can genuinely have, so
// it's replaced with a real recent open assignment (or a real review
// stat if nothing's open right now). Never fabricated, never personalized
// to a visitor we know nothing about.
async function loadHeroMatchCard() {
  const card = document.getElementById('hero-match-card');
  if (!card) return;

  const titleEl = document.getElementById('hero-card-title');
  const tagsEl = document.getElementById('hero-card-tags');
  const metaEl = document.getElementById('hero-card-meta');
  const whyEl = document.getElementById('hero-card-why');
  const badgeNum = document.getElementById('hero-card-badge-num');
  const badgeLbl = document.getElementById('hero-card-badge-lbl');

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/assignments?select=student_level,subjects,location,rate_min,rate_max,frequency,created_at&status=eq.open&order=created_at.desc&limit=1`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    const rows = res.ok ? await res.json() : [];
    if (rows && rows.length) {
      const a = rows[0];
      const subjects = (a.subjects || []).slice(0, 2).join('/');
      titleEl.textContent = [a.student_level, subjects].filter(Boolean).join(' · ') || 'Tutor needed';
      tagsEl.innerHTML = [
        a.location,
        a.rate_min && a.rate_max ? `$${a.rate_min}–${a.rate_max}/hr` : null,
        a.frequency,
      ].filter(Boolean).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
      metaEl.textContent = `Posted ${timeAgo(a.created_at)} · live on our Telegram channel`;
      whyEl.innerHTML = '<b>A real assignment</b> — posted to our Telegram channel, where registered tutors get notified and can apply directly.';
      return;
    }
  } catch (err) {
    console.error(err);
  }

  // No open assignments right now — fall back to a real trust stat instead
  // of leaving stale/fake content up.
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/reviews?select=rating&approved=eq.true`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` } }
    );
    const rows = res.ok ? await res.json() : [];
    if (rows && rows.length) {
      const avg = (rows.reduce((sum, r) => sum + (Number(r.rating) || 0), 0) / rows.length).toFixed(1);
      badgeNum.textContent = `${avg}★`;
      badgeLbl.textContent = 'RATED';
      titleEl.textContent = `${avg}★ average, from ${rows.length} real review${rows.length > 1 ? 's' : ''}`;
      tagsEl.innerHTML = '';
      metaEl.textContent = 'No open assignments right now — check back soon.';
      whyEl.innerHTML = '<b>Every review is real</b> — read them all on our reviews page.';
      return;
    }
  } catch (err) {
    console.error(err);
  }

  // Nothing real to show at all — hide rather than fabricate.
  card.style.display = 'none';
}
