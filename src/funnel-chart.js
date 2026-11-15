/**
 * FlowFunnel: a vertical, single-color "flow" funnel built with D3 v7.
 * The widest stage sits at the BOTTOM and volume narrows upward.
 *
 * Knows nothing about Sigma or filters. Input is a normalized model:
 *   model = { stages: ['Visits', 'Registrations', ...],              // first = widest (bottom)
 *             series: [{ key: 'Email', values: [18420, 4236, ...] }] } // breakdown for tooltip/table
 *   spec  = { title, subtitle, measureName, seriesLabel: 'channels', scale: 'Log' | 'Linear' }
 *
 * Layout per stage row:  [name · value · % of top]  [funnel segment]  [step conversion]
 * Stages are separated by crisp horizontal lines clipped to the funnel silhouette.
 */
(function (global) {
  'use strict';

  const fmtInt = d3.format(',');
  const fmtPct = (p) => (!Number.isFinite(p) ? '–' : p > 0 && p < 0.01 ? d3.format('.2%')(p) : d3.format('.1%')(p));
  const DURATION = 750;
  const MAX_FUNNEL_WIDTH = 540;
  let uid = 0;

  function create(root, { onStageClick } = {}) {
    const id = `fnl-${++uid}`;
    root.classList.add('fnl');
    root.innerHTML = `
      <header class="fnl-head">
        <div class="fnl-heading"><h1 class="fnl-title"></h1><p class="fnl-sub"></p></div>
        <button type="button" class="fnl-toggle" aria-pressed="false">Table view</button>
      </header>
      <section class="fnl-kpis" aria-live="polite"></section>
      <div class="fnl-stage">
        <svg class="fnl-svg" role="img"></svg>
        <div class="fnl-table" hidden></div>
        <div class="fnl-tooltip" role="tooltip"></div>
        <div class="fnl-msg"></div>
      </div>
      <p class="fnl-foot"></p>`;

    const $ = (sel) => root.querySelector(sel);
    const stageEl = $('.fnl-stage');
    const svg = d3.select($('.fnl-svg'));
    const tooltip = d3.select($('.fnl-tooltip'));
    const tableEl = $('.fnl-table');
    const toggle = $('.fnl-toggle');

    const defs = svg.append('defs');
    defs.append('filter').attr('id', `${id}-glow`).attr('x', '-30%').attr('y', '-10%').attr('width', '160%').attr('height', '120%')
      .append('feGaussianBlur').attr('stdDeviation', 16);
    const clipPath = defs.append('clipPath').attr('id', `${id}-clip`).append('path');

    const gGuides = svg.append('g').attr('class', 'fnl-guides');
    const glow = svg.append('path').attr('class', 'fnl-glow').attr('filter', `url(#${id}-glow)`);
    const body = svg.append('path').attr('class', 'fnl-body');
    const gClipped = svg.append('g').attr('clip-path', `url(#${id}-clip)`);
    const gRowHL = gClipped.append('g').attr('class', 'fnl-rowhl');
    const gSeps = gClipped.append('g').attr('class', 'fnl-seps');
    const gLabels = svg.append('g').attr('class', 'fnl-labels');
    const gSteps = svg.append('g').attr('class', 'fnl-steps');
    const gHit = svg.append('g').attr('class', 'fnl-hit');

    let model = null;
    let spec = {};
    let size = { width: 0, height: 0 };

    toggle.addEventListener('click', () => {
      const on = toggle.getAttribute('aria-pressed') !== 'true';
      toggle.setAttribute('aria-pressed', String(on));
      toggle.textContent = on ? 'Chart view' : 'Table view';
      tableEl.hidden = !on;
      svg.style('visibility', on ? 'hidden' : null);
      hideTooltip();
    });

    function view() {
      const n = model.stages.length;
      const totals = d3.range(n).map((i) => d3.sum(model.series, (s) => s.values[i]));
      const steps = d3.range(1, n).map((i) => ({
        i,
        rate: totals[i - 1] ? totals[i] / totals[i - 1] : NaN,
        dropped: totals[i - 1] - totals[i],
      }));
      const weakest = d3.least(steps.filter((s) => Number.isFinite(s.rate)), (s) => s.rate);
      return { n, totals, steps, weakest };
    }

    // ------------------------------------------------------------------ render
    function render(animate) {
      if (!model) return;
      const v = view();
      renderHeader(v);
      renderTable(v);

      const { width: W, height: H } = size;
      if (W < 200 || H < 200) return;
      const t = svg.transition('fnl').duration(animate ? DURATION : 0).ease(d3.easeCubicInOut);

      // Columns: labels (right-aligned) | funnel (centered, capped width) | conversion pills.
      const n = v.n;
      const wide = W >= 620;
      const labelW = Math.max(118, Math.min(200, W * 0.26));
      const pillW = wide ? Math.max(150, Math.min(210, W * 0.24)) : 76;
      let C0 = labelW + 16;
      let C1 = W - pillW - 16;
      if (C1 - C0 > MAX_FUNNEL_WIDTH) { const extra = (C1 - C0 - MAX_FUNNEL_WIDTH) / 2; C0 += extra; C1 -= extra; }
      const maxW = Math.max(C1 - C0, 60);
      const cc = (C0 + C1) / 2;
      const slot = (H - 8) / n;
      // Stage 0 (widest) is the bottom row; later stages stack upward.
      const along = (i) => H - 4 - slot * (i + 0.5);
      const rowTop = (i) => along(i) - slot / 2;
      const plateau = Math.min(slot * 0.2, 24);

      const positive = v.totals.filter((x) => x > 0);
      const hi = d3.max(positive) || 1;
      let w;
      if (spec.scale === 'Linear') {
        const s = d3.scaleLinear().domain([0, hi]).range([0, maxW]);
        w = (x) => (x > 0 ? Math.max(3, s(x)) : 0);
      } else {
        const lo = d3.min(positive) || 1;
        const s = d3.scaleLog().domain([Math.max(lo / 4, 0.5), hi]).range([Math.min(14, maxW / 6), maxW]).clamp(true);
        w = (x) => (x > 0 ? s(x) : 0);
      }

      // Silhouette: a plateau per stage, smooth curves between stages.
      const pts = [];
      for (let i = 0; i < n; i++) {
        const half = w(v.totals[i]) / 2;
        pts.push({ a: along(i) + plateau, c0: cc - half, c1: cc + half }, { a: along(i) - plateau, c0: cc - half, c1: cc + half });
      }
      pts[0] = { ...pts[0], a: Math.min(H - 2, along(0) + slot * 0.46) };
      pts[pts.length - 1] = { ...pts[pts.length - 1], a: Math.max(2, along(n - 1) - slot * 0.46) };
      const area = d3.area().y((d) => d.a).x0((d) => d.c0).x1((d) => d.c1).curve(d3.curveBumpY);
      const shape = area(pts);

      svg.attr('width', W).attr('height', H)
        .attr('aria-label', `${spec.title || 'Funnel'}: ${model.stages.map((s, i) => `${s} ${fmtInt(v.totals[i])}`).join(', ')}.`);
      glow.transition(t).attr('d', shape);
      body.transition(t).attr('d', shape);
      clipPath.transition(t).attr('d', shape);

      // Dashed guides at each stage's center, from the label to the pill column.
      gGuides.selectAll('line').data(model.stages, (d) => d).join('line')
        .attr('x1', C0 - 10).attr('x2', C1 + 10)
        .transition(t).attr('y1', (d, i) => along(i)).attr('y2', (d, i) => along(i));

      // Crisp horizontal separators between stages (clipped to the silhouette).
      gSeps.selectAll('line').data(d3.range(1, n), (d) => d).join('line')
        .attr('x1', 0).attr('x2', W)
        .transition(t).attr('y1', (i) => rowTop(i - 1)).attr('y2', (i) => rowTop(i - 1));

      // Row highlight (shown on hover), also clipped to the silhouette.
      gRowHL.selectAll('rect').data(model.stages, (d) => d).join('rect')
        .attr('x', 0).attr('width', W).attr('y', (d, i) => rowTop(i)).attr('height', slot);

      // Labels on the left: stage name · value · % of top.
      const lx = C0 - 18;
      const compactRows = slot < 62;
      const lbl = gLabels.selectAll('g.fnl-stage-label').data(model.stages.map((name, i) => ({ name, i, value: v.totals[i] })), (d) => d.name)
        .join(
          (enter) => {
            const g = enter.append('g').attr('class', 'fnl-stage-label').attr('transform', (d) => `translate(${lx},${along(d.i)})`).style('opacity', 0);
            g.append('text').attr('class', 'fnl-stage-name');
            g.append('text').attr('class', 'fnl-stage-value');
            g.append('text').attr('class', 'fnl-stage-share');
            return g;
          },
          (update) => update,
          (exit) => exit.remove()
        );
      lbl.transition(t).style('opacity', 1).attr('transform', (d) => `translate(${lx},${along(d.i)})`);
      lbl.select('.fnl-stage-name').attr('y', compactRows ? -6 : -13).call(wrapLabel, lx - 4);
      lbl.select('.fnl-stage-value').attr('y', compactRows ? 12 : 9)
        .transition(t).tween('text', function (d) {
          const from = this.__v ?? d.value;
          const it = d3.interpolateRound(from, d.value);
          this.__v = d.value;
          return (k) => { this.textContent = fmtInt(it(k)); };
        });
      lbl.select('.fnl-stage-share').attr('y', 26).style('display', compactRows ? 'none' : null)
        .text((d) => (d.i === 0 ? 'top of funnel' : `${fmtPct(d.value / v.totals[0])} of top`));

      // Conversion pills on the right, at the boundary between two stages.
      const px = C1 + 18;
      const pills = gSteps.selectAll('g.fnl-step').data(v.steps, (d) => d.i)
        .join(
          (enter) => {
            const g = enter.append('g').attr('class', 'fnl-step').attr('transform', (d) => `translate(${px},${rowTop(d.i - 1)})`).style('opacity', 0);
            g.append('rect').attr('rx', 11).attr('height', 22).attr('y', -11);
            g.append('text').attr('class', 'fnl-step-rate').attr('dy', '0.35em');
            g.append('text').attr('class', 'fnl-step-drop').attr('dy', '0.35em');
            return g;
          },
          (update) => update,
          (exit) => exit.remove()
        )
        .classed('is-weakest', (d) => v.weakest && d.i === v.weakest.i);
      pills.transition(t).style('opacity', 1).attr('transform', (d) => `translate(${px},${rowTop(d.i - 1)})`);
      pills.select('.fnl-step-rate').attr('x', 10).text((d) => `↑ ${fmtPct(d.rate)}`);
      pills.select('rect').each(function () {
        const wd = this.parentNode.querySelector('.fnl-step-rate').getComputedTextLength() + 20;
        d3.select(this).attr('x', 0).attr('width', wd);
        this.parentNode.__w = wd;
      });
      pills.select('.fnl-step-drop')
        .attr('x', function () { return this.parentNode.__w + 8; })
        .text((d) => (wide ? `−${fmtInt(d.dropped)} dropped` : ''));

      // Hit areas on top: hover a row → highlight + tooltip; click → callback.
      gHit.selectAll('rect').data(model.stages, (d) => d).join('rect')
        .attr('x', 0).attr('width', W).attr('y', (d, i) => rowTop(i)).attr('height', slot)
        .on('pointerenter pointermove', (event, d) => { highlight(d); stageTooltip(event, model.stages.indexOf(d), v); })
        .on('pointerleave', () => { highlight(null); hideTooltip(); })
        .on('click', (event, d) => onStageClick && onStageClick(d));
    }

    // ------------------------------------------------------------- HTML parts
    function renderHeader(v) {
      $('.fnl-title').textContent = spec.title || 'Campaign funnel';
      $('.fnl-sub').textContent = spec.subtitle || '';
      const last = v.n - 1;
      const conv = v.totals[0] ? v.totals[last] / v.totals[0] : NaN;
      const oneIn = conv > 0 ? Math.round(1 / conv) : null;
      const wk = v.weakest;
      const tiles = [
        { label: model.stages[0], value: fmtInt(v.totals[0]), note: 'top of funnel' },
        { label: model.stages[last], value: fmtInt(v.totals[last]), note: 'end of funnel' },
        { label: 'End-to-end conversion', value: fmtPct(conv), note: oneIn ? `1 in ${fmtInt(oneIn)}` : 'no conversions' },
        { label: 'Weakest step', value: wk ? fmtPct(wk.rate) : '–', note: wk ? `${model.stages[wk.i - 1]} → ${model.stages[wk.i]}` : '' },
      ];
      d3.select($('.fnl-kpis')).selectAll('div.fnl-kpi').data(tiles).join((enter) => {
        const d = enter.append('div').attr('class', 'fnl-kpi');
        d.append('div').attr('class', 'fnl-kpi-label');
        d.append('div').attr('class', 'fnl-kpi-value');
        d.append('div').attr('class', 'fnl-kpi-note');
        return d;
      })
        .call((d) => d.select('.fnl-kpi-label').text((x) => x.label))
        .call((d) => d.select('.fnl-kpi-value').text((x) => x.value))
        .call((d) => d.select('.fnl-kpi-note').text((x) => x.note).attr('title', (x) => x.note));
      $('.fnl-foot').textContent = spec.scale === 'Linear'
        ? 'Funnel width is proportional to volume. Hover a stage for the breakdown.'
        : 'Funnel width uses a log scale so late stages stay visible; numbers are exact. Hover a stage for the breakdown.';
    }

    function renderTable(v) {
      const cols = model.series.length > 1 ? model.series : [];
      const head = `<tr><th scope="col">Stage</th>${cols.map((s) => `<th scope="col">${esc(s.key)}</th>`).join('')}<th scope="col">Total</th><th scope="col">% of top</th><th scope="col">Step conv.</th></tr>`;
      const rows = model.stages.map((st, i) => `<tr><th scope="row">${esc(st)}</th>${cols.map((s) => `<td>${fmtInt(s.values[i])}</td>`).join('')}<td><b>${fmtInt(v.totals[i])}</b></td><td>${fmtPct(v.totals[i] / v.totals[0])}</td><td>${i ? fmtPct(v.totals[i] / v.totals[i - 1]) : '–'}</td></tr>`);
      tableEl.innerHTML = `<table><thead>${head}</thead><tbody>${rows.reverse().join('')}</tbody></table>`;
    }

    // ------------------------------------------------------------ interaction
    function highlight(stage) {
      gRowHL.selectAll('rect').classed('is-on', (d) => d === stage);
    }

    function place(event, html) {
      const [mx, my] = d3.pointer(event, stageEl);
      tooltip.html(html).style('opacity', 1);
      const box = tooltip.node().getBoundingClientRect();
      const x = mx + 16 + box.width > stageEl.clientWidth ? mx - box.width - 16 : mx + 16;
      tooltip.style('left', `${Math.max(4, x)}px`).style('top', `${Math.max(4, Math.min(my - box.height / 2, stageEl.clientHeight - box.height - 4))}px`);
    }
    function hideTooltip() { tooltip.style('opacity', 0); }

    function stageTooltip(event, i, v) {
      const breakdown = model.series.length > 1
        ? model.series.map((s) => ({ key: s.key, val: s.values[i] })).sort((a, b) => b.val - a.val)
          .map((r) => `<div class="fnl-tt-row"><span>${esc(r.key)}</span><b>${fmtInt(r.val)} <i>${fmtPct(v.totals[i] ? r.val / v.totals[i] : NaN)}</i></b></div>`).join('')
        : '';
      const step = i ? `<div class="fnl-tt-row"><span>From ${esc(model.stages[i - 1])}</span><b>${fmtPct(v.totals[i - 1] ? v.totals[i] / v.totals[i - 1] : NaN)}</b></div>` : '';
      place(event, `<div class="fnl-tt-title">${esc(model.stages[i])}</div>
        <div class="fnl-tt-row"><span>${esc(spec.measureName || 'Contacts')}</span><b>${fmtInt(v.totals[i])}</b></div>${step}
        ${breakdown ? `<div class="fnl-tt-sep">By ${esc(singular(spec.seriesLabel || 'series'))}</div>${breakdown}` : ''}`);
    }

    // -------------------------------------------------------------- lifecycle
    const ro = new ResizeObserver(([entry]) => {
      size = { width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) };
      render(false);
    });
    ro.observe(stageEl);

    function showMessage(text) {
      const m = $('.fnl-msg');
      m.textContent = text || '';
      m.style.display = text ? 'flex' : 'none';
      root.classList.toggle('is-empty', !!text);
    }

    return {
      update(newModel, newSpec = {}) { showMessage(null); model = newModel; spec = newSpec; render(true); },
      message(text) { showMessage(text); },
      destroy() { ro.disconnect(); root.innerHTML = ''; },
    };
  }

  // Wrap a stage name onto up to two lines within maxWidth (right-aligned labels).
  function wrapLabel(selection, maxWidth) {
    selection.each(function (d) {
      const text = d3.select(this);
      const y = +text.attr('y');
      text.text(null);
      const words = d.name.toUpperCase().split(/\s+/);
      const t1 = text.append('tspan').attr('x', 0).text(words.join(' '));
      if (this.getComputedTextLength() <= maxWidth || words.length === 1) return;
      const line = [];
      let k = 0;
      for (; k < words.length; k++) {
        t1.text([...line, words[k]].join(' '));
        if (this.getComputedTextLength() > maxWidth && line.length) break;
        line.push(words[k]);
      }
      t1.text(line.join(' '));
      text.append('tspan').attr('x', 0).attr('dy', '1.15em').text(words.slice(k).join(' '));
      text.attr('y', y - 12);
    });
  }

  const singular = (s) => (s.endsWith('ies') ? s.slice(0, -3) + 'y' : s.endsWith('s') ? s.slice(0, -1) : s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  global.FlowFunnel = { create };
})(window);
