// ==========================================================================
// TeachToReach — shared front-end behaviour.
// NOTE: There is no backend wired up yet. Every "submit" below stores the
// payload in an in-memory object (window.__ttr_demo_store) and logs
// it to the console so it's obvious what a future API call should receive.
// When the FastAPI backend exists, replace the `fakeSubmit()` calls with a
// real `fetch('/api/...', { method:'POST', body: JSON.stringify(payload) })`.
// ==========================================================================

window.__ttr_demo_store = { tutorRequests: [], tutorProfiles: [] };

function fakeSubmit(kind, payload) {
  return new Promise((resolve) => {
    console.log(`[demo submit] ${kind}`, payload);
    window.__ttr_demo_store[kind].push(payload);
    setTimeout(() => resolve({ ok: true }), 500);
  });
}

// ---------- Mobile nav ----------
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.nav-toggle');
  const links = document.querySelector('.nav-links');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      const open = links.style.display === 'flex';
      links.style.display = open ? 'none' : 'flex';
      links.style.cssText += open ? '' : 'position:absolute;top:76px;left:0;right:0;background:#12332C;flex-direction:column;padding:20px 24px;gap:18px;';
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

  initMultiStepForm('request-form', 'tutorRequests');
  initMultiStepForm('tutor-form', 'tutorProfiles');
  initAssignmentFilters();
});

// ---------- Generic multi-step form controller ----------
function initMultiStepForm(formId, storeKey) {
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

    await fakeSubmit(storeKey, { ...data, ...multiSelects, submittedAt: new Date().toISOString() });

    const successPane = form.querySelector('.success-pane-wrap');
    panes.forEach((p) => p.classList.remove('active'));
    bars.forEach((b) => { b.classList.add('done'); b.classList.remove('active'); });
    if (successPane) successPane.style.display = 'block';
    form.querySelector('.form-nav-wrap')?.style && (form.querySelector('.form-nav-wrap').style.display = 'none');
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
