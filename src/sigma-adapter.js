/**
 * App controller + Sigma adapter.
 *
 * Pipeline (identical in Sigma and in the standalone preview):
 *   long rows { stage, order, value, dims: { Channel, Segment, ... } }
 *     → filter (sidebar state) → normalize(bandsBy, stage range) → FlowFunnel
 *
 * In Sigma, rows come from the source element (columnar payload, converted here)
 * and the dimensions are whatever columns the analyst maps in the editor panel.
 * Outside Sigma, rows come from the fixed dataset in data/campaign_funnel.csv
 * (loaded via data/campaign_funnel.js).
 */
(function () {
  'use strict';

  const MAX_SERIES = 7; // breakdown values beyond this fold into "Other"
  const shell = document.querySelector('.shell');
  const inIframe = window.self !== window.top;
  const preview = new URLSearchParams(location.search).has('preview') || !inIframe || !window.SigmaPlugin;

  let onStageHook = null;
  const chart = FlowFunnel.create(document.getElementById('app'), { onStageClick: (stage) => onStageHook && onStageHook(stage) });
  const panel = FilterPanel.create(document.getElementById('filters'), { onChange: apply, onReset: reset });

  let dataset = null; // { rows, dims, stages, title, measureName, defaultBands }
  let state = null;
  const known = {};   // dimKey → Set of values seen (to auto-select new values on refresh)

  // ------------------------------------------------------------ pipeline
  function setDataset(next, { keepState = true } = {}) {
    dataset = next;
    const prev = keepState ? state : null;
    state = {
      bandsBy: prev && next.dims.some((d) => d.key === prev.bandsBy) ? prev.bandsBy : next.defaultBands,
      filters: {},
      from: prev ? Math.min(prev.from, next.stages.length - 2) : 0,
      to: prev ? Math.min(prev.to, next.stages.length - 1) : next.stages.length - 1,
      scale: prev ? prev.scale : next.defaultScale || 'Log',
    };
    if (!prev || prev.to === prev.lastIndex) state.to = next.stages.length - 1;
    state.lastIndex = next.stages.length - 1;
    for (const d of next.dims) {
      const values = d.values.map((v) => v.value);
      const before = prev && prev.filters[d.key];
      const seen = known[d.key] || new Set();
      state.filters[d.key] = new Set(values.filter((v) => !before || before.has(v) || !seen.has(v)));
      known[d.key] = new Set(values);
    }
    shell.classList.toggle('no-sidebar', !next.dims.some((d) => d.values.length > 1) || next.showFilters === false);
    panel.set({ dims: next.dims, stages: next.stages, state });
    apply();
  }

  function reset() {
    Object.keys(known).forEach((k) => delete known[k]);
    setDataset(dataset, { keepState: false });
  }

  function apply() {
    if (!dataset) return;
    const { rows, dims } = dataset;
    const filtered = rows.filter((r) => dims.every((d) => state.filters[d.key].has(r.dims[d.key])));
    const stages = dataset.stages.slice(state.from, state.to + 1);
    const top = (rs) => d3.sum(rs, (r) => (r.stage === dataset.stages[0] ? r.value : 0));
    panel.setSummary(`Showing ${d3.format(',')(top(filtered))} of ${d3.format(',')(top(rows))} ${dataset.stages[0].toLowerCase()} (${d3.format('.0%')(top(filtered) / (top(rows) || 1))}).`);

    if (!filtered.length) return chart.message('No data matches the current filters. Adjust or reset the filters on the left.');
    const bandDim = dims.find((d) => d.key === state.bandsBy);
    const model = normalize(filtered, state.bandsBy, stages, bandDim ? bandDim.values.map((v) => v.value).sort(d3.ascending) : []);
    if (d3.sum(model.series, (s) => s.values[0]) === 0) return chart.message('The selected start stage has no volume for these filters.');

    chart.update(model, {
      title: dataset.title,
      subtitle: subtitle(),
      measureName: dataset.measureName,
      seriesLabel: plural(bandDim ? bandDim.label : 'series'),
      scale: state.scale,
    });
  }

  /** rows → { stages, series } for the given band dimension and stage list. */
  function normalize(rows, bandsBy, stages, colorDomain) {
    const idx = new Map(stages.map((s, i) => [s, i]));
    const bySeries = d3.rollup(rows.filter((r) => idx.has(r.stage)), (v) => {
      const values = new Array(stages.length).fill(0);
      v.forEach((r) => { values[idx.get(r.stage)] += r.value; });
      return values;
    }, (r) => (bandsBy ? r.dims[bandsBy] : 'All'));

    let series = [...bySeries].map(([key, values]) => ({ key, values })).sort((a, b) => b.values[0] - a.values[0]);
    if (series.length > MAX_SERIES + 1) {
      const rest = series.slice(MAX_SERIES);
      series = series.slice(0, MAX_SERIES);
      series.push({ key: 'Other', isOther: true, values: stages.map((_, i) => d3.sum(rest, (s) => s.values[i])) });
    }
    return { stages, series };
  }

  /** Builds dims and the stage order from long rows. */
  function describe(rows, dimDefs) {
    const totals = d3.rollup(rows, (v) => d3.sum(v, (r) => r.value), (r) => r.stage);
    const order = d3.rollup(rows, (v) => d3.min(v, (r) => (Number.isFinite(r.order) ? r.order : Infinity)), (r) => r.stage);
    const stages = [...totals.keys()].sort((a, b) => (order.get(a) - order.get(b)) || (totals.get(b) - totals.get(a)));
    const dims = dimDefs.map((d) => {
      const counts = d3.rollup(rows.filter((r) => r.stage === stages[0]), (v) => d3.sum(v, (r) => r.value), (r) => r.dims[d.key]);
      const all = [...new Set(rows.map((r) => r.dims[d.key]))];
      return { ...d, values: all.map((value) => ({ value, count: counts.get(value) || 0 })).sort((a, b) => b.count - a.count) };
    });
    return { stages, dims };
  }

  function subtitle() {
    const parts = [];
    for (const d of dataset.dims) {
      if (d.values.length < 2) continue;
      const sel = state.filters[d.key];
      if (sel.size < d.values.length) parts.push(`${d.label}: ${sel.size <= 2 ? [...sel].join(', ') : `${sel.size} of ${d.values.length}`}`);
    }
    return `${dataset.measureName} by funnel stage${parts.length ? ` · ${parts.join(' · ')}` : ' · all segments'}`;
  }

  if (preview) return runPreview();

  // ------------------------------------------------------------------ Sigma
  // The UMD bundle exposes a ready-made client (SigmaPlugin.client); older docs mention initialize().
  let client;
  try {
    client = window.SigmaPlugin.client || window.SigmaPlugin.initialize();
  } catch (err) {
    console.error('[funnel-plugin] could not start the Sigma client', err);
    return chart.message('Could not connect to Sigma (plugin SDK failed to start). See the console for details.');
  }

  client.config.configureEditorPanel([
    { name: 'source', type: 'element', label: 'Data source' },
    { name: 'stage', type: 'column', source: 'source', allowMultiple: false, label: 'Stage' },
    { name: 'value', type: 'column', source: 'source', allowMultiple: false, allowedTypes: ['number', 'integer'], label: 'Value' },
    { name: 'order', type: 'column', source: 'source', allowMultiple: false, allowedTypes: ['number', 'integer'], label: 'Stage order (optional)' },
    { name: 'dimensions', type: 'column', source: 'source', allowMultiple: true, label: 'Dimensions (sidebar dropdown filters)' },
    { name: 'display', type: 'group', label: 'Display' },
    { name: 'title', type: 'text', source: 'display', placeholder: 'Campaign funnel', label: 'Title' },
    { name: 'scale', type: 'dropdown', source: 'display', values: ['Log', 'Linear'], defaultValue: 'Log', label: 'Default width scale' },
    { name: 'showFilters', type: 'toggle', source: 'display', defaultValue: true, label: 'Show filter sidebar' },
    { name: 'interactions', type: 'group', label: 'Interactions (optional)' },
    { name: 'selectedValue', type: 'variable', source: 'interactions', label: 'Control to receive the clicked stage' },
  ]);

  let config = {};
  let columns = {};
  let data = {};
  let subscribed = null;
  let unsubs = [];

  onStageHook = (stage) => {
    if (!config.selectedValue) return;
    try { client.config.setVariable('selectedValue', stage); } catch (e) { console.warn('[funnel-plugin]', e); }
  };

  client.config.subscribe((cfg) => {
    config = cfg || {};
    if (config.source !== subscribed) {
      unsubs.forEach((u) => u && u());
      unsubs = [];
      columns = {};
      data = {};
      subscribed = config.source;
      if (config.source) {
        unsubs.push(client.elements.subscribeToElementColumns(config.source, (c) => { columns = c || {}; refresh(); }));
        unsubs.push(client.elements.subscribeToElementData(config.source, (d) => { data = d || {}; refresh(); }));
      }
    }
    refresh();
  });

  function refresh() {
    try {
      const stageId = first(config.stage);
      const valueId = first(config.value);
      const orderId = first(config.order);
      const dimIds = [].concat(config.dimensions || []).filter(Boolean);
      if (!config.source) return chart.message('Choose a data source in the editor panel.');
      if (!stageId || !valueId) return chart.message('Map the Stage and Value columns in the editor panel.');
      if (!Object.keys(data).length || !(stageId in data) || !(valueId in data) || dimIds.some((id) => !(id in data))) return chart.message('Loading data…');

      const dimDefs = dimIds.map((id) => ({ key: id, label: columns[id]?.name || id }));
      const rows = [];
      for (let i = 0; i < data[stageId].length; i++) {
        const value = Number(data[valueId][i]);
        if (!Number.isFinite(value)) continue;
        const dims = {};
        dimIds.forEach((id) => { dims[id] = label(data[id][i]); });
        rows.push({ stage: label(data[stageId][i]), order: orderId ? Number(data[orderId][i]) : NaN, value, dims });
      }
      if (!rows.length) return chart.message('No rows to display. Check the filters on the source element.');
      const { stages, dims } = describe(rows, dimDefs);
      if (stages.length < 2) return chart.message('A funnel needs at least two stages.');
      setDataset({
        rows, dims, stages,
        title: config.title || 'Campaign funnel',
        measureName: columns[valueId]?.name || 'Value',
        defaultBands: (dims.find((d) => d.values.length > 1) || {}).key || null,
        defaultScale: config.scale || 'Log',
        showFilters: config.showFilters !== false,
      });
    } catch (err) {
      console.error('[funnel-plugin]', err);
      chart.message('Something went wrong while drawing the funnel. See the console for details.');
    }
  }

  // ---------------------------------------------------------------- Preview
  function runPreview() {
    document.body.classList.add('is-preview');
    const raw = window.CAMPAIGN_FUNNEL;
    if (!raw) return chart.message('data/campaign_funnel.js was not found next to index.html.');
    const dimDefs = [
      { key: 'campaign', label: 'Campaign' },
      { key: 'channel', label: 'Channel' },
      { key: 'segment', label: 'Segment' },
      { key: 'region', label: 'Region' },
    ];
    const rows = raw.map((r) => ({
      stage: r.stage, order: +r.stage_order, value: +r.contacts,
      dims: Object.fromEntries(dimDefs.map((d) => [d.key, r[d.key]])),
    }));
    const { stages, dims } = describe(rows, dimDefs);
    setDataset({ rows, dims, stages, title: raw[0].campaign, measureName: 'Contacts', defaultBands: 'channel', defaultScale: 'Log' });
  }

  function plural(s) {
    const w = String(s).toLowerCase();
    return w.endsWith('s') ? w : w.endsWith('y') && !/[aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : w + 's';
  }
  function first(v) { return v == null ? null : [].concat(v)[0] || null; }
  function label(v) { return v === null || v === undefined || v === '' ? '(blank)' : String(v); }
})();
