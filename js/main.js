// ==========================================================================
// TeachToReach — shared front-end behaviour.
// Form submissions are saved directly to Supabase (Postgres). The anon key
// below is safe to expose client-side — it only has INSERT rights on the
// two tables, enforced by Row Level Security policies (see db/schema.sql).
// ==========================================================================

const SUPABASE_URL = 'https://iyfkunwywlqfgtyqouqp.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml5Zmt1bnd5d2xxZmd0eXFvdXFwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM1MjM3MjksImV4cCI6MjA5OTA5OTcyOX0.MZi1hwb4G2xPo16tUBaCtd5EXbNwGE8nGG1v6mR3AC4';

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
    toggle.addEventListener('click', () => {
      const open = links.style.display === 'flex';
      const navHeight = document.querySelector('.site-nav .inner').offsetHeight;
      links.style.display = open ? 'none' : 'flex';
      links.style.cssText += open ? '' : `position:absolute;top:${navHeight}px;left:0;right:0;background:#0B0B0A;border-bottom:1px solid rgba(232,196,104,0.22);flex-direction:column;padding:20px 24px;gap:18px;`;
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
  initAssignmentFilters();
  initNavScrollShadow();
  initScrollReveal();
});

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

// ---------- Assignment board filters (demo/static data already in HTML) ----------
function initAssignmentFilters() {
  const levelSel = document.getElementById('filter-level');
  const subjectSel = document.getElementById('filter-subject');
  const cards = Array.from(document.querySelectorAll('.assignment-card'));
  if (!levelSel || !subjectSel || cards.length === 0) return;

  function apply() {
    const level = levelSel.value;
    const subject = subjectSel.value;
    cards.forEach((card) => {
      const matchesLevel = level === 'all' || card.dataset.level === level;
      const matchesSubject = subject === 'all' || card.dataset.subject === subject;
      card.style.display = matchesLevel && matchesSubject ? 'flex' : 'none';
    });
  }

  levelSel.addEventListener('change', apply);
  subjectSel.addEventListener('change', apply);
}
