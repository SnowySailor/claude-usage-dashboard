'use strict';

const REFRESH_MS = 30_000;
// Fixed categorical slot per billing component (index into --s1..--s8). Order = stack order.
const COMPONENTS = [
  ['input', 'Input'], ['cache_write_5m', 'Cache write 5m'], ['cache_write_1h', 'Cache write 1h'],
  ['cache_read', 'Cache read'], ['output', 'Output'], ['web_search', 'Web search'],
];
const TOKEN_KEYS = COMPONENTS.slice(0, 5);
// Reported cost with no matching transcript usage (tracked-only mode). Gray: it's the unknown remainder.
const UNLOGGED = ['unlogged', 'Not in transcripts'];
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('cud.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cud.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  range: store.get('range', '7d'), from: store.get('from', null), to: store.get('to', null),
  project: '', model: '', tokensMode: store.get('tokensMode', 'nocr'), theme: store.get('theme', 'auto'),
  auto: store.get('auto', true), tracked: store.get('tracked', true), sort: { key: 'last', dir: -1 }, shown: 25, data: null, session: null,
};

// ---------- formatting ----------
const nf = (o) => new Intl.NumberFormat(undefined, o);
const compactFmt = nf({ notation: 'compact', maximumFractionDigits: 1 });
const compact = (v) => (v == null ? '—' : compactFmt.format(v));
const int = (v) => (v == null ? '—' : nf({ maximumFractionDigits: 0 }).format(v));
const usd = (v) => {
  if (v == null) return '—';
  if (v !== 0 && Math.abs(v) < 0.01) return '<$0.01';
  return (v < 0 ? '−$' : '$') + nf({ minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
};
const usdAxis = (v) => (v >= 1000 ? '$' + compactFmt.format(v) : '$' + nf({ maximumFractionDigits: v < 10 ? 2 : 0 }).format(v));
const pct = (v, d = 0) => (v == null ? '—' : (v * 100).toFixed(d) + '%');
const fmtDay = (s) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtTs = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtDur = (ms) => {
  if (!ms) return '—';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortModel = (m) => (m || '—').replace(/^claude-/, '');
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- theme & palette ----------
let P;
function readPalette() {
  const cs = getComputedStyle(document.documentElement);
  const g = (v) => cs.getPropertyValue(v).trim();
  P = {
    ink: g('--ink'), ink2: g('--ink-2'), muted: g('--muted'), grid: g('--grid'), axis: g('--axis'),
    surface: g('--surface'), border: g('--border'), s: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => g('--s' + i)),
  };
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 12;
  Chart.defaults.color = P.muted;
}

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.theme);
  $('#theme').textContent = 'Theme: ' + state.theme;
  readPalette();
}

function modelColor(m, all) {
  const fam = MODEL_FAMILIES.findIndex((f) => m.includes(f));
  if (fam >= 0) return P.s[fam];
  const others = all.filter((x) => !MODEL_FAMILIES.some((f) => x.includes(f))).sort();
  const i = MODEL_FAMILIES.length + others.indexOf(m);
  return i < P.s.length ? P.s[i] : P.muted;
}

// ---------- chart plumbing ----------
const refLinePlugin = {
  id: 'refLine',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || opts.value == null) return;
    const y = chart.scales.y;
    if (opts.value > y.max) return;
    const py = Math.round(y.getPixelForValue(opts.value)) + 0.5;
    const { left, right } = chart.chartArea;
    const c = chart.ctx;
    c.save();
    c.strokeStyle = P.axis;
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(left, py); c.lineTo(right, py); c.stroke();
    c.fillStyle = P.ink2;
    c.font = '12px system-ui, sans-serif';
    c.textAlign = 'right';
    c.textBaseline = 'bottom';
    c.fillText(opts.label, right - 4, py - 3);
    c.restore();
  },
};

// Value at the tip of each horizontal bar (single-dataset charts).
const valueLabelsPlugin = {
  id: 'valueLabels',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.format) return;
    const c = chart.ctx;
    c.save();
    c.font = '12px system-ui, sans-serif';
    c.fillStyle = P.ink2;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    const data = chart.data.datasets[0].data;
    chart.getDatasetMeta(0).data.forEach((bar, i) => c.fillText(opts.format(data[i], i), bar.x + 6, bar.y));
    c.restore();
  },
};
Chart.register(refLinePlugin, valueLabelsPlugin);

// 'index' mode with the index taken from the 'est' stack only: other series have their own x positions, so
// their indexes don't line up.
Chart.Interaction.modes.estIndex = (chart, e) => {
  const metas = chart.getSortedVisibleDatasetMetas().filter((m) => chart.data.datasets[m.index].stack === 'est');
  const pts = metas[0]?.data ?? [];
  let i = -1;
  pts.forEach((p, j) => { if (i < 0 || Math.abs(p.x - e.x) < Math.abs(pts[i].x - e.x)) i = j; });
  return i < 0 ? [] : metas.map((m) => ({ element: m.data[i], datasetIndex: m.index, index: i }));
};

const charts = {};
const hidden = {}; // chartId -> Set of hidden dataset labels, kept across refreshes

function draw(id, config) {
  charts[id]?.destroy();
  const off = hidden[id] || new Set();
  config.data.datasets.forEach((ds) => { if (off.has(ds.label)) ds.hidden = true; });
  charts[id] = new Chart(document.getElementById(id), config);
  return charts[id];
}

function legend(elId, chartId) {
  const chart = charts[chartId];
  const el = document.getElementById(elId);
  el.innerHTML = '';
  chart.data.datasets.forEach((ds, i) => {
    const on = chart.isDatasetVisible(i);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'flex items-center gap-1.5 hover:text-(--ink)';
    b.style.opacity = on ? 1 : 0.45;
    b.title = on ? 'Hide series' : 'Show series';
    const sw = ds.type === 'line' && !ds.fill
      ? `<span class="swatch" style="height:2px;width:14px;border-radius:1px;background:${ds.borderColor}"></span>`
      : ds.type === 'scatter'
        ? `<span class="swatch" style="border-radius:50%;background:${ds.backgroundColor}"></span>`
        : `<span class="swatch" style="background:${ds.backgroundColor}"></span>`;
    b.innerHTML = sw + esc(ds.label);
    b.onclick = () => {
      chart.setDatasetVisibility(i, !on);
      const set = (hidden[chartId] ||= new Set());
      on ? set.add(ds.label) : set.delete(ds.label);
      chart.update();
      legend(elId, chartId);
    };
    el.appendChild(b);
  });
}

// Round only the data-end of the topmost visible, non-zero segment of a stack.
function topRadius(ctx) {
  const { chart, dataIndex, datasetIndex } = ctx;
  const ds = chart.data.datasets;
  for (let i = datasetIndex + 1; i < ds.length; i++) {
    if (ds[i].type !== 'line' && ds[i].stack === ds[datasetIndex].stack && chart.isDatasetVisible(i) && (ds[i].data[dataIndex] || 0) > 0) return 0;
  }
  return { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 };
}

const barDS = (label, data, color, extra = {}) => ({
  type: 'bar', label, data, backgroundColor: color, hoverBackgroundColor: color, stack: 'a',
  borderColor: P.surface, borderWidth: { top: 2 }, borderSkipped: 'start', borderRadius: topRadius,
  maxBarThickness: 24, pointStyle: 'rectRounded', ...extra,
});
const lineDS = (label, data, color, extra = {}) => ({
  type: 'line', label, data, borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0,
  pointHoverRadius: 5, pointHoverBorderColor: P.surface, pointHoverBorderWidth: 2, pointHitRadius: 8,
  tension: 0, borderJoinStyle: 'round', borderCapStyle: 'round', pointStyle: 'circle', ...extra,
});

function tooltip(extra = {}) {
  return {
    backgroundColor: P.surface, titleColor: P.ink, bodyColor: P.ink2, footerColor: P.ink,
    borderColor: P.border, borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
    titleFont: { weight: '600' }, footerFont: { weight: '600' }, ...extra,
  };
}

function options({ stacked = false, yFmt = compact, tip = {}, x = {}, y = {}, plugins = {}, horizontal = false, padRight = 0 } = {}) {
  const valueAxis = {
    stacked, beginAtZero: true, grid: { color: P.grid, drawTicks: false }, border: { display: false },
    ticks: { color: P.muted, callback: yFmt, maxTicksLimit: 6, padding: 6 }, ...y,
  };
  const catAxis = {
    stacked, grid: { display: false }, border: { color: P.axis },
    ticks: { color: P.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 }, ...x,
  };
  return {
    responsive: true, maintainAspectRatio: false, animation: false, layout: { padding: { right: padRight } },
    indexAxis: horizontal ? 'y' : 'x',
    interaction: horizontal ? { mode: 'nearest', axis: 'y', intersect: false } : { mode: 'index', intersect: false },
    plugins: { legend: { display: false }, tooltip: tooltip(tip), ...plugins },
    scales: horizontal ? { x: { ...valueAxis, ticks: { ...valueAxis.ticks, maxTicksLimit: 4 } }, y: { ...catAxis, border: { color: P.axis } } } : { x: catAxis, y: valueAxis },
  };
}

// ---------- data ----------
function rangeDates() {
  if (state.range === 'custom') return [state.from, state.to];
  if (state.range === 'all') return [null, null];
  const back = { today: 0, '7d': 6, '30d': 29, '90d': 89 }[state.range] ?? 6;
  const t = new Date();
  const f = new Date(t);
  f.setDate(t.getDate() - back);
  return [isoLocal(f), isoLocal(t)];
}

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

async function refresh() {
  const [from, to] = rangeDates();
  const q = new URLSearchParams({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone });
  if (from) q.set('from', from);
  if (to) q.set('to', to);
  if (state.project) q.set('project', state.project);
  if (state.model) q.set('model', state.model);
  if (state.tracked) q.set('tracked', '1');
  try {
    state.data = await getJSON('/api/dashboard?' + q);
    $('#error').textContent = '';
    render();
  } catch (e) {
    $('#error').textContent = 'Failed to load: ' + e.message;
  }
}

// ---------- rendering ----------
function render() {
  const d = state.data;
  if (!d) return;
  syncControls(d);
  renderKpis(d);
  renderDailyCost(d);
  renderComponents(d);
  renderModels(d);
  renderProjects(d);
  renderTokens(d);
  renderContext(d);
  renderCache(d);
  renderHourly(d);
  renderSessions(d);
  const m = d.meta;
  $('#updated').textContent = `updated ${new Date().toLocaleTimeString()}` + (m.data_max ? ` · last request ${fmtTs(m.data_max)}` : '');
  $('#tracked-note').textContent = !m.tracked_since ? 'No reported cost has been recorded yet.'
    : `Cost tracking started ${fmtTs(m.tracked_since)}.` + (m.tracked_only ? ' Earlier data is hidden.' : '');
}

function syncControls(d) {
  document.querySelectorAll('#presets button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === state.range)));
  document.querySelectorAll('#tokens-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.tokensMode)));
  $('#from').value = d.range.from;
  $('#to').value = d.range.to;
  fillSelect($('#project'), d.meta.projects, state.project, 'All projects', (x) => x);
  fillSelect($('#model'), d.meta.models, state.model, 'All models', shortModel);
  $('#auto').checked = state.auto;
  $('#tracked').checked = state.tracked;
  $('#from').min = state.tracked && d.meta.tracked_since ? isoLocal(new Date(d.meta.tracked_since)) : '';
}

function fillSelect(el, values, current, allLabel, label) {
  const html = `<option value="">${allLabel}</option>` +
    values.map((v) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(label(v))}</option>`).join('');
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

function tile(label, value, sub = '') {
  return `<div class="card p-3"><div class="text-sm text-(--ink-2)">${label}</div>
    <div class="mt-1 text-2xl font-semibold">${value}</div><div class="mt-0.5 text-xs text-(--muted)">${sub}</div></div>`;
}

function renderKpis(d) {
  const k = d.kpis;
  const subShare = k.est ? k.subagent_cost / k.est : 0;
  const estSub = k.unpriced_requests ? `${int(k.unpriced_requests)} requests unpriced` : `${pct(subShare)} from subagents`;
  let cost;
  if (d.meta.split) {
    // Tracked-only: one number. The token-type split below sums to it, with the remainder shown as its own part.
    cost = [tile('Cost', usd(k.actual), k.cost.unlogged > 0.005
      ? `${usd(k.cost.unlogged)} not in transcripts (compaction)` : 'reported by Claude Code')];
  } else if (!d.meta.show_actual) {
    cost = [tile('Estimated cost', usd(k.est), 'model filter on: estimated from tokens only')];
  } else {
    let sub = 'no reported cost recorded yet';
    if (d.meta.tracked_since && k.actual > 0) sub = `${usd(k.unattributed)} more than the token estimate`;
    else if (d.meta.tracked_since) sub = `tracking started ${fmtDay(isoLocal(new Date(d.meta.tracked_since)))}`;
    cost = [tile('Reported by Claude Code', usd(k.actual), sub), tile('Estimated from tokens', usd(k.est), estSub)];
  }
  const tiles = [
    ...cost,
    tile('Cache hit rate', pct(k.cache_hit, 1), `${compact(k.tokens.cache_read)} cache-read tokens`),
    tile('Cache savings', usd(k.cache_savings), 'vs no caching, net of write premium'),
    tile('Requests', int(k.requests), `${int(k.sessions)} sessions`),
    tile('Output tokens', compact(k.tokens.output), `${compact(k.thinking)} thinking · peak ctx ${compact(k.ctx_max)}`),
  ];
  const el = $('#kpis');
  el.classList.toggle('lg:grid-cols-6', tiles.length === 6);
  el.classList.toggle('lg:grid-cols-5', tiles.length === 5);
  el.innerHTML = tiles.join('');
}

// [key, label, color] for each cost part with data; the unlogged remainder only in tracked-only mode.
function presentComponents(d) {
  const parts = COMPONENTS.map(([key, label], i) => [key, label, P.s[i]]).filter(([key]) => d.kpis.cost[key] > 0 || key !== 'web_search');
  if (d.meta.split) parts.push([...UNLOGGED, P.muted]);
  return parts;
}

function renderDailyCost(d) {
  const labels = d.daily.map((x) => fmtDay(x.day));
  const datasets = presentComponents(d).map(([key, label, color]) => barDS(label, d.daily.map((x) => x.cost[key]), color));
  $('#daily-cost-sub').textContent = d.meta.split
    ? 'Cost reported by Claude Code, split by token type. Gray is reported cost whose tokens never reach the transcript (compaction summaries).'
    : 'Bars are estimated from tokens × pricing.json. The line is the cost Claude Code reported.';
  if (!d.meta.split && d.meta.show_actual && d.daily.some((x) => x.actual != null)) {
    datasets.push(lineDS('Reported', d.daily.map((x) => x.actual), P.ink, { stack: 'billed', pointRadius: 3, pointBackgroundColor: P.ink, pointBorderColor: P.surface, pointBorderWidth: 2, order: -1 }));
  }
  draw('c-daily-cost', {
    type: 'bar',
    data: { labels, datasets },
    options: options({
      stacked: true, yFmt: usdAxis,
      tip: {
        itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
        callbacks: {
          label: (c) => ` ${c.dataset.label}: ${usd(c.parsed.y)}`,
          footer: (items) => (d.meta.split ? `Total: ${usd(d.daily[items[0].dataIndex].actual)}` : `Estimated: ${usd(d.daily[items[0].dataIndex].est)}`),
        },
      },
    }),
  });
  legend('legend-cost', 'c-daily-cost');

  const comps = presentComponents(d);
  $('#t-daily').innerHTML =
    `<thead class="sticky top-0 bg-(--surface) text-(--muted)"><tr class="border-b border-(--grid)"><th class="py-1 pr-3 text-left font-medium">Day</th><th class="pr-3 font-medium">Requests</th>` +
    comps.map(([, label]) => `<th class="pr-3 font-medium">${label}</th>`).join('') +
    `<th class="pr-3 font-medium">Estimated</th><th class="font-medium">Reported</th></tr></thead><tbody>` +
    d.daily.slice().reverse().map((x) => `<tr class="border-b border-(--grid)"><td class="py-1 pr-3 text-left">${fmtDay(x.day)}</td><td class="pr-3">${int(x.requests)}</td>` +
      comps.map(([key]) => `<td class="pr-3">${usd(x.cost[key])}</td>`).join('') +
      `<td class="pr-3 font-medium">${usd(x.est)}</td><td>${usd(x.actual)}</td></tr>`).join('') + '</tbody>';
}

function renderComponents(d) {
  const comps = presentComponents(d);
  const total = comps.reduce((a, [key]) => a + d.kpis.cost[key], 0) || 1;
  $('#components-sub').textContent = d.meta.split ? 'Reported cost for the selected range' : 'Estimated cost for the selected range';
  draw('c-components', {
    type: 'bar',
    data: {
      labels: comps.map(([, label]) => label),
      datasets: [{ label: 'Estimated cost', data: comps.map(([key]) => d.kpis.cost[key]), backgroundColor: comps.map(([, , color]) => color), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24 }],
    },
    options: options({
      horizontal: true, yFmt: usdAxis,
      tip: { callbacks: { label: (c) => ` ${usd(c.parsed.x)} (${pct(c.parsed.x / total, 1)})`, afterLabel: (c) => (comps[c.dataIndex][0] in d.kpis.tokens ? `${compact(d.kpis.tokens[comps[c.dataIndex][0]])} tokens` : 'mostly compaction summaries') } },
      plugins: { valueLabels: { format: (v) => `${usd(v)} · ${pct(v / total)}` } }, padRight: 96,
    }),
  });
}

function renderModels(d) {
  const rows = d.by_model;
  const all = rows.map((r) => r.model);
  draw('c-models', {
    type: 'bar',
    data: {
      labels: rows.map((r) => shortModel(r.model)),
      datasets: [{ label: 'Estimated cost', data: rows.map((r) => r.est), backgroundColor: rows.map((r) => modelColor(r.model, all)), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24 }],
    },
    options: options({
      horizontal: true, yFmt: usdAxis,
      tip: { callbacks: { label: (c) => ` ${usd(c.parsed.x)}`, afterLabel: (c) => `${int(rows[c.dataIndex].requests)} requests` } },
      plugins: { valueLabels: { format: (v) => usd(v) } }, padRight: 72,
    }),
  });
}

function renderProjects(d) {
  const rows = d.by_project.slice(0, 10);
  draw('c-projects', {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.project),
      datasets: [{ label: 'Estimated cost', data: rows.map((r) => r.est), backgroundColor: P.s[0], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24 }],
    },
    options: options({
      horizontal: true, yFmt: usdAxis,
      tip: { callbacks: { label: (c) => ` Estimated ${usd(c.parsed.x)}`, afterLabel: (c) => (rows[c.dataIndex].actual != null ? `Reported ${usd(rows[c.dataIndex].actual)}` : '') + ` · ${int(rows[c.dataIndex].requests)} requests` } },
      plugins: { valueLabels: { format: (v) => usd(v) } }, padRight: 72,
      x: { ticks: { color: P.muted, autoSkip: false, callback(v) { const l = this.getLabelForValue(v); return l.length > 16 ? l.slice(0, 15) + '…' : l; } } },
    }),
  });
}

function renderTokens(d) {
  const keys = TOKEN_KEYS.map((c, i) => [...c, i]).filter(([key]) => state.tokensMode === 'all' || key !== 'cache_read');
  $('#tokens-sub').textContent = state.tokensMode === 'all'
    ? 'All token types. Cache reads usually dwarf the rest.'
    : 'Cache reads hidden so the other types are readable';
  draw('c-tokens', {
    type: 'bar',
    data: { labels: d.daily.map((x) => fmtDay(x.day)), datasets: keys.map(([key, label, i]) => barDS(label, d.daily.map((x) => x.tokens[key]), P.s[i])) },
    options: options({
      stacked: true,
      tip: { itemSort: (a, b) => b.datasetIndex - a.datasetIndex, callbacks: { label: (c) => ` ${c.dataset.label}: ${int(c.parsed.y)}` } },
    }),
  });
  legend('legend-tokens', 'c-tokens');
}

function renderContext(d) {
  const max = Math.max(0, ...d.daily.map((x) => x.ctx_max || 0));
  const win = d.meta.compact_window;
  draw('c-context', {
    type: 'line',
    data: {
      labels: d.daily.map((x) => fmtDay(x.day)),
      datasets: [
        lineDS('Peak', d.daily.map((x) => x.ctx_max || null), P.s[0], { pointRadius: 3, pointBackgroundColor: P.s[0], pointBorderColor: P.surface, pointBorderWidth: 2 }),
        lineDS('Average', d.daily.map((x) => x.ctx_avg), P.s[1], { pointRadius: 3, pointBackgroundColor: P.s[1], pointBorderColor: P.surface, pointBorderWidth: 2 }),
      ],
    },
    options: options({
      y: { suggestedMax: Math.max(max, win) * 1.08 },
      tip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${int(c.parsed.y)} tokens` } },
      plugins: { refLine: { value: win, label: `Auto-compact ${compact(win)}` } },
    }),
  });
  legend('legend-ctx', 'c-context');
}

function renderCache(d) {
  draw('c-cache', {
    type: 'line',
    data: {
      labels: d.daily.map((x) => fmtDay(x.day)),
      datasets: [lineDS('Cache hit rate', d.daily.map((x) => x.cache_hit), P.s[0], { pointRadius: 3, pointBackgroundColor: P.s[0], pointBorderColor: P.surface, pointBorderWidth: 2 })],
    },
    options: options({
      yFmt: (v) => pct(v), y: { beginAtZero: false, suggestedMin: 0.8, max: 1 },
      tip: { callbacks: { label: (c) => ` ${pct(c.parsed.y, 1)}` } },
    }),
  });
}

function renderHourly(d) {
  draw('c-hourly', {
    type: 'bar',
    data: {
      labels: d.hourly.map((h) => String(h.hour).padStart(2, '0')),
      datasets: [barDS('Estimated cost', d.hourly.map((h) => h.est), P.s[0])],
    },
    options: options({
      stacked: true, yFmt: usdAxis,
      tip: { callbacks: { title: (items) => `${items[0].label}:00–${items[0].label}:59`, label: (c) => ` ${usd(c.parsed.y)} · ${int(d.hourly[c.dataIndex].requests)} requests` } },
    }),
  });
}

// ---------- sessions table ----------
const sortVal = {
  last: (s) => s.last, project: (s) => s.project.toLowerCase(), model: (s) => s.model || '',
  requests: (s) => s.requests, actual: (s) => s.actual ?? -1, est: (s) => s.est, ctx_max: (s) => s.ctx_max,
  output: (s) => s.tokens.output, cache_hit: (s) => s.cache_hit, lines: (s) => (s.lines_added || 0) + (s.lines_removed || 0),
};

function renderSessions(d) {
  const { key, dir } = state.sort;
  const rows = d.sessions.slice().sort((a, b) => {
    const x = sortVal[key](a), y = sortVal[key](b);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.textContent = th.textContent.replace(/ [▲▼]$/, '') + (th.dataset.sort === key ? (dir > 0 ? ' ▲' : ' ▼') : '');
  });
  $('#sessions').innerHTML = rows.slice(0, state.shown).map((s) => `
    <tr data-sid="${esc(s.session_id)}" class="border-b border-(--grid)">
      <td class="py-2 pr-3 whitespace-nowrap">${fmtTs(s.last)}</td>
      <td class="py-2 pr-3"><span class="font-medium">${esc(s.project)}</span> <span class="text-xs text-(--muted)">${esc(s.session_id.slice(0, 8))}</span></td>
      <td class="py-2 pr-3 text-(--ink-2)">${esc(shortModel(s.model))}</td>
      <td class="py-2 pr-3 text-right">${int(s.requests)}${s.subagent_requests ? `<span class="text-xs text-(--muted)"> (${int(s.subagent_requests)} sub)</span>` : ''}</td>
      <td class="py-2 pr-3 text-right font-medium">${usd(s.actual)}</td>
      <td class="py-2 pr-3 text-right">${usd(s.est)}</td>
      <td class="py-2 pr-3 text-right">${compact(s.ctx_max || null)}</td>
      <td class="py-2 pr-3 text-right">${compact(s.tokens.output)}</td>
      <td class="py-2 pr-3 text-right">${s.requests ? pct(s.cache_hit, 1) : '—'}</td>
      <td class="py-2 text-right whitespace-nowrap">${s.lines_added != null ? `<span class="text-(--good)">+${int(s.lines_added)}</span> <span class="text-(--critical)">−${int(s.lines_removed)}</span>` : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="10" class="py-6 text-center text-(--muted)">No sessions in this range</td></tr>';
  const more = $('#more');
  more.classList.toggle('hidden', rows.length <= state.shown);
  more.textContent = `Show more (${rows.length - state.shown} hidden)`;
}

// ---------- session drill-down ----------
async function openSession(sid) {
  const dlg = $('#session-dlg');
  $('#s-title').textContent = 'Loading…';
  $('#s-sub').textContent = '';
  $('#s-kpis').innerHTML = '';
  if (!dlg.open) dlg.showModal();
  try {
    state.session = await getJSON('/api/session/' + encodeURIComponent(sid) + '?tz=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone));
    renderSession();
  } catch (e) {
    $('#s-title').textContent = 'Failed to load session: ' + e.message;
  }
}

function renderSession() {
  const { session: s, requests: reqs, cost_events: events } = state.session;
  const est = reqs.reduce((a, r) => a + sum(r.cost), 0);
  const main = reqs.filter((r) => !r.agent_id);
  const subs = reqs.filter((r) => r.agent_id);
  $('#s-title').textContent = `${s.project} · ${s.session_id.slice(0, 8)}`;
  $('#s-sub').textContent = [shortModel(s.model), s.first_request && `${fmtTs(s.first_request)} → ${fmtTs(s.last_request)}`,
    s.duration_ms && `wall ${fmtDur(s.duration_ms)}, API ${fmtDur(s.api_duration_ms)}`,
    s.lines_added != null && `+${int(s.lines_added)} / −${int(s.lines_removed)} lines`].filter(Boolean).join(' · ');
  $('#s-kpis').innerHTML = [
    tile('Reported', usd(s.cost_usd), s.cost_usd != null ? `${usd(s.cost_usd - est)} more than estimate` : 'not tracked'),
    tile('Estimated', usd(est), `${pct(est ? subs.reduce((a, r) => a + sum(r.cost), 0) / est : 0)} from subagents`),
    tile('Requests', int(reqs.length), `${int(subs.length)} subagent`),
    tile('Peak context', compact(Math.max(0, ...main.map((r) => r.ctx))), `${compact(s.output_tokens)} output tokens`),
  ].join('');

  const xs = reqs.map((r) => Date.parse(r.ts)).concat(events.map((e) => Date.parse(e.ts)));
  const timeAxis = {
    type: 'linear', min: Math.min(...xs), max: Math.max(...xs), grid: { display: false }, border: { color: P.axis },
    ticks: { color: P.muted, maxRotation: 0, maxTicksLimit: 6, callback: (v) => fmtTs(v) },
  };
  const titleTs = (items) => fmtTs(items[0].parsed.x);
  const win = s.compact_window;

  draw('c-s-ctx', {
    type: 'line',
    data: {
      datasets: [
        lineDS('Main thread', main.map((r) => ({ x: Date.parse(r.ts), y: r.ctx })), P.s[0]),
        { type: 'scatter', label: 'Subagents', data: subs.map((r) => ({ x: Date.parse(r.ts), y: r.ctx })), backgroundColor: P.s[1], borderColor: P.surface, borderWidth: 1, pointRadius: 3, pointHoverRadius: 5 },
      ],
    },
    options: {
      ...options({ x: timeAxis, y: { suggestedMax: win * 1.05 }, plugins: { refLine: { value: win, label: `Auto-compact ${compact(win)}` } },
        tip: { callbacks: { title: titleTs, label: (c) => ` ${c.dataset.label}: ${int(c.parsed.y)} tokens` } } }),
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
    },
  });
  legend('legend-s-ctx', 'c-s-ctx');

  const running = Object.fromEntries(COMPONENTS.map(([k]) => [k, 0]));
  const series = Object.fromEntries(COMPONENTS.map(([k]) => [k, []]));
  for (const r of reqs) {
    const x = Date.parse(r.ts);
    for (const [k] of COMPONENTS) { running[k] += r.cost[k]; series[k].push({ x, y: running[k] }); }
  }
  // Cost reported after the last request is from calls the transcript doesn't log (recaps, prompt suggestions).
  if (reqs.length && Date.parse(reqs.at(-1).ts) < timeAxis.max) {
    for (const [k] of COMPONENTS) series[k].push({ x: timeAxis.max, y: running[k] });
  }
  const comps = COMPONENTS.map((c, i) => [...c, i]).filter(([k]) => running[k] > 0 || k !== 'web_search');
  const datasets = comps.map(([k, label, i], n) => lineDS(label, series[k], P.s[i], {
    fill: n === 0 ? 'origin' : '-1', backgroundColor: P.s[i], borderColor: P.s[i], borderWidth: 0, stack: 'est', pointHoverRadius: 0, stepped: 'before',
  }));
  if (events.length) {
    datasets.push(lineDS('Reported', events.map((e) => ({ x: Date.parse(e.ts), y: e.cost_usd })), P.ink, { stack: 'billed', stepped: 'before', order: -1 }));
  }
  const billedAt = (x) => { let v = null; for (const e of events) { if (Date.parse(e.ts) <= x) v = e.cost_usd; else break; } return v; };
  draw('c-s-cost', {
    type: 'line',
    data: { datasets },
    options: {
      ...options({ stacked: true, yFmt: usdAxis, x: { ...timeAxis, stacked: false },
        tip: {
          filter: (item) => item.dataset.stack === 'est',
          itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
          callbacks: {
            title: titleTs, label: (c) => ` ${c.dataset.label}: ${usd(series[comps[c.datasetIndex][0]][c.dataIndex].y)}`,
            footer: (items) => { const x = items[0].parsed.x; const b = billedAt(x); const e = comps.reduce((a, [k]) => a + series[k][items[0].dataIndex].y, 0); return `Estimated ${usd(e)}` + (b != null ? ` · reported ${usd(b)}` : ''); },
          },
        } }),
      interaction: { mode: 'estIndex', intersect: false },
    },
  });
  legend('legend-s-cost', 'c-s-cost');
}

// ---------- wiring ----------
function setRange(range) {
  state.range = range;
  store.set('range', range);
  state.shown = 25;
  refresh();
}

document.querySelectorAll('#presets button').forEach((b) => b.addEventListener('click', () => setRange(b.dataset.range)));
['from', 'to'].forEach((id) => $('#' + id).addEventListener('change', () => {
  state.from = $('#from').value || null;
  state.to = $('#to').value || null;
  if (state.from && state.to && state.from > state.to) [state.from, state.to] = [state.to, state.from];
  store.set('from', state.from);
  store.set('to', state.to);
  setRange('custom');
}));
$('#project').addEventListener('change', (e) => { state.project = e.target.value; state.shown = 25; refresh(); });
$('#model').addEventListener('change', (e) => { state.model = e.target.value; state.shown = 25; refresh(); });
document.querySelectorAll('#tokens-mode button').forEach((b) => b.addEventListener('click', () => {
  state.tokensMode = b.dataset.mode;
  store.set('tokensMode', state.tokensMode);
  render();
}));
$('#tracked').addEventListener('change', (e) => { state.tracked = e.target.checked; store.set('tracked', state.tracked); state.shown = 25; refresh(); });
$('#auto').addEventListener('change', (e) => { state.auto = e.target.checked; store.set('auto', state.auto); });
$('#refresh').addEventListener('click', refresh);
$('#theme').addEventListener('click', () => {
  state.theme = { auto: 'light', light: 'dark', dark: 'auto' }[state.theme];
  store.set('theme', state.theme);
  applyTheme();
  render();
  if ($('#session-dlg').open && state.session) renderSession();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  readPalette();
  render();
  if ($('#session-dlg').open && state.session) renderSession();
});
document.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : (['project', 'model'].includes(key) ? 1 : -1) };
  renderSessions(state.data);
}));
$('#sessions').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-sid]'); if (tr) openSession(tr.dataset.sid); });
$('#more').addEventListener('click', () => { state.shown += 50; renderSessions(state.data); });
$('#s-close').addEventListener('click', () => $('#session-dlg').close());
$('#session-dlg').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

setInterval(() => {
  if (state.auto && document.visibilityState === 'visible' && !$('#session-dlg').open) refresh();
}, REFRESH_MS);

applyTheme();
refresh();
