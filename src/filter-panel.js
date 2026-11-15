/**
 * FilterPanel: left sidebar with multi-select dropdown filters.
 *
 *   panel.set({ dims, stages, state })
 *     dims   = [{ key, label, values: [{ value, count }] }]
 *     stages = ['Landing Page Visits', ...]
 *     state  = { filters: { [dimKey]: Set }, from, to, scale }
 *
 * Each dimension is a dropdown button that opens a checklist (select any number
 * of values, "Select all", "Clear", and an "only" shortcut per value). The list
 * stays open while you tick values; it closes on outside click or Escape.
 * Emits onChange(state). Knows nothing about D3 or Sigma.
 */
(function (global) {
  'use strict';

  const fmtCompact = (v) => (v >= 10000 ? d3.format('.3~s')(v) : d3.format(',')(v));

  function create(el, { onChange, onReset } = {}) {
    el.classList.add('fp');
    let dims = [];
    let stages = [];
    let state = null;
    let openDim = null; // which multi-select is open (kept across re-renders)
    let lastSummary = '';

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const { action, dim, value } = btn.dataset;
      if (action === 'collapse') { el.classList.toggle('is-collapsed'); syncCollapse(); return; }
      if (action === 'reset') { openDim = null; onReset && onReset(); return; }
      if (action === 'ms-toggle') { openDim = openDim === dim ? null : dim; render(); focusOpenList(); return; }
      if (action === 'scale') state.scale = value;
      if (action === 'all') state.filters[dim] = new Set(findDim(dim).values.map((v) => v.value));
      if (action === 'none') state.filters[dim] = new Set();
      if (action === 'only') state.filters[dim] = new Set([value]);
      emit();
    });

    el.addEventListener('change', (e) => {
      const input = e.target;
      if (input.matches('input[type="checkbox"][data-dim]')) {
        const set = state.filters[input.dataset.dim];
        input.checked ? set.add(input.value) : set.delete(input.value);
      }
      if (input.matches('select[data-stage]')) {
        const v = +input.value;
        if (input.dataset.stage === 'from') { state.from = v; if (state.to < v + 1) state.to = Math.min(v + 1, stages.length - 1); }
        else { state.to = v; if (state.from > v - 1) state.from = Math.max(v - 1, 0); }
      }
      emit();
    });

    // Close the open list on outside click or Escape.
    // Close in place (no re-render), so the click that closed the list still reaches its target.
    document.addEventListener('pointerdown', (e) => {
      if (openDim && !e.target.closest('.fp-ms')) closeOpen();
    });
    function closeOpen() {
      openDim = null;
      el.querySelectorAll('.fp-ms.is-open').forEach((ms) => {
        ms.classList.remove('is-open');
        ms.querySelector('.fp-ms-pop').hidden = true;
        ms.querySelector('.fp-ms-btn').setAttribute('aria-expanded', 'false');
      });
    }
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && openDim) {
        const dim = openDim;
        openDim = null;
        render();
        el.querySelector(`.fp-ms-btn[data-dim="${cssEsc(dim)}"]`)?.focus();
      }
    });

    function emit() { render(); onChange && onChange(state); }
    function findDim(key) { return dims.find((d) => d.key === key); }
    function syncCollapse() {
      const b = el.querySelector('.fp-collapse');
      if (b) b.setAttribute('aria-expanded', String(!el.classList.contains('is-collapsed')));
    }
    function focusOpenList() { el.querySelector('.fp-ms-pop:not([hidden]) input')?.focus(); }
    const isAll = (d) => state.filters[d.key].size >= d.values.length;

    function summary(d) {
      const sel = d.values.map((v) => v.value).filter((v) => state.filters[d.key].has(v));
      const many = plural(d.label);
      if (sel.length === d.values.length) return `All ${many}`;
      if (sel.length === 0) return `No ${many} selected`;
      if (sel.length === 1) return sel[0];
      const joined = sel.join(', ');
      return joined.length <= 26 ? joined : `${sel.length} of ${d.values.length} ${many}`;
    }

    function render() {
      // Keep the scroll position of an open list across re-renders.
      const prevScroll = el.querySelector('.fp-ms-pop:not([hidden]) .fp-ms-list')?.scrollTop || 0;
      const focusedValue = document.activeElement?.closest?.('.fp-ms-pop') ? document.activeElement.value : null;

      const active = dims.filter((d) => d.values.length > 1 && !isAll(d)).length
        + (state.from > 0 || state.to < stages.length - 1 ? 1 : 0);

      el.innerHTML = `
        <div class="fp-top">
          <div class="fp-title">Filters${active ? ` <span class="fp-badge">${active}</span>` : ''}</div>
          <div class="fp-top-actions">
            <button type="button" class="fp-link" data-action="reset" ${active || state.scale !== 'Log' ? '' : 'disabled'}>Reset</button>
            <button type="button" class="fp-collapse" data-action="collapse" aria-expanded="true" aria-label="Show or hide filters">▾</button>
          </div>
        </div>
        <div class="fp-body">
          ${dims.map((d) => (d.values.length === 1 ? `
          <div class="fp-field">
            <span class="fp-label">${esc(d.label)}</span>
            <button type="button" class="fp-ms-btn" disabled title="${esc(d.values[0].value)}"><span>${esc(d.values[0].value)}</span></button>
          </div>` : msField(d))).join('')}

          <div class="fp-divider"></div>

          <label class="fp-field${state.from > 0 ? ' is-active' : ''}">
            <span class="fp-label">Funnel starts at</span>
            <span class="fp-select"><select data-stage="from">${stages.map((s, i) => `<option value="${i}" ${i === state.from ? 'selected' : ''} ${i >= stages.length - 1 ? 'disabled' : ''}>${esc(s)}</option>`).join('')}</select></span>
          </label>
          <label class="fp-field${state.to < stages.length - 1 ? ' is-active' : ''}">
            <span class="fp-label">Funnel ends at</span>
            <span class="fp-select"><select data-stage="to">${stages.map((s, i) => `<option value="${i}" ${i === state.to ? 'selected' : ''} ${i === 0 ? 'disabled' : ''}>${esc(s)}</option>`).join('')}</select></span>
          </label>

          <div class="fp-divider"></div>

          <div class="fp-field">
            <span class="fp-label">Width scale</span>
            <div class="fp-seg" role="radiogroup" aria-label="Width scale">
              ${['Log', 'Linear'].map((s) => `<button type="button" role="radio" aria-checked="${state.scale === s}" data-action="scale" data-value="${s}">${s}</button>`).join('')}
            </div>
            <p class="fp-hint">${state.scale === 'Log' ? 'Keeps late stages visible when volumes differ by orders of magnitude.' : 'Width strictly proportional to volume.'}</p>
          </div>

          <p class="fp-summary">${esc(lastSummary)}</p>
        </div>`;
      syncCollapse();

      const list = el.querySelector('.fp-ms-pop:not([hidden]) .fp-ms-list');
      if (list) list.scrollTop = prevScroll;
      if (focusedValue != null) {
        el.querySelector(`.fp-ms-pop:not([hidden]) input[value="${cssEsc(focusedValue)}"]`)?.focus();
      }
    }

    function msField(d) {
      const sel = state.filters[d.key];
      const open = openDim === d.key;
      const listId = `fp-ms-${d.key.replace(/[^a-z0-9_-]/gi, '_')}`;
      return `
          <div class="fp-field${isAll(d) ? '' : ' is-active'}">
            <span class="fp-label">${esc(d.label)}${isAll(d) ? '' : ` <span class="fp-count">${sel.size}/${d.values.length}</span>`}</span>
            <div class="fp-ms${open ? ' is-open' : ''}">
              <button type="button" class="fp-ms-btn" data-action="ms-toggle" data-dim="${esc(d.key)}" aria-haspopup="true" aria-expanded="${open}" aria-controls="${listId}">
                <span>${esc(summary(d))}</span>
              </button>
              <div class="fp-ms-pop" id="${listId}" ${open ? '' : 'hidden'}>
                <div class="fp-ms-actions">
                  <button type="button" class="fp-link" data-action="all" data-dim="${esc(d.key)}" ${isAll(d) ? 'disabled' : ''}>Select all</button>
                  <button type="button" class="fp-link" data-action="none" data-dim="${esc(d.key)}" ${sel.size ? '' : 'disabled'}>Clear</button>
                </div>
                <ul class="fp-ms-list" role="group" aria-label="${esc(d.label)}">
                  ${d.values.map((v) => `
                  <li>
                    <label class="fp-check">
                      <input type="checkbox" data-dim="${esc(d.key)}" value="${esc(v.value)}" ${sel.has(v.value) ? 'checked' : ''}>
                      <span class="fp-box"></span>
                      <span class="fp-name" title="${esc(v.value)}">${esc(v.value)}</span>
                      <span class="fp-n">${fmtCompact(v.count)}</span>
                    </label>
                    <button type="button" class="fp-only" data-action="only" data-dim="${esc(d.key)}" data-value="${esc(v.value)}">only</button>
                  </li>`).join('')}
                </ul>
              </div>
            </div>
          </div>`;
    }

    return {
      set(next) { dims = next.dims; stages = next.stages; state = next.state; render(); },
      setSummary(text) { lastSummary = text || ''; const p = el.querySelector('.fp-summary'); if (p) p.textContent = lastSummary; },
    };
  }

  function plural(s) {
    const w = String(s).toLowerCase();
    return w.endsWith('s') ? w : w.endsWith('y') && !/[aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : w + 's';
  }
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cssEsc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\"'));

  global.FilterPanel = { create };
})(window);
