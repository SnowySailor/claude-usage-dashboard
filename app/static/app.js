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
const MIN_SPAN = 60_000;
const DAY = 86_400_000;
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440, 2880, 10080].map((m) => m * 60_000);

const $ = (s) => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('cud.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('cud.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const state = {
  range: store.get('range', '7d'), from: store.get('from', null), to: store.get('to', null),
  project: '', model: '', tokensMode: store.get('tokensMode', 'nocr'), theme: store.get('theme', 'auto'),
  auto: store.get('auto', true), tracked: store.get('tracked', true), sort: { key: 'last', dir: -1 }, shown: 25, data: null, session: null,
  // Session chart window. end: null follows the latest request; span: null starts at the first one.
  sid: null, bounds: null, win: { end: null, span: null },
  planPrices: store.get('planPrices', {}), subAccount: store.get('subAccount', null), // '' = all accounts
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
const times = (v) => nf({ minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(v) + '×';
const fmtDay = (s) => new Date(s + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const fmtTs = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtWeekday = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const fmtClock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDur = (ms) => {
  if (!ms) return '—';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}m`;
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shortModel = (m) => (m || '—').replace(/^claude-/, '');
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dtLocal = (ms) => { const d = new Date(ms); return `${isoLocal(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

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
    if (opts.outside) {  // past the plot's right edge, in the layout padding, where no bar can cover it
      c.textAlign = 'left';
      c.textBaseline = 'middle';
      c.fillText(opts.label, right + 6, py);
    } else {
      c.textAlign = 'right';
      c.textBaseline = 'bottom';
      c.fillText(opts.label, right - 4, py - 3);
    }
    c.restore();
  },
};

// Value at the tip of each horizontal bar (single-dataset charts), or with `above`, on the cap of each column's stack.
const valueLabelsPlugin = {
  id: 'valueLabels',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts || !opts.format) return;
    const c = chart.ctx;
    c.save();
    c.font = '12px system-ui, sans-serif';
    c.fillStyle = P.ink2;
    if (opts.above) {
      c.textBaseline = 'bottom';
      c.textAlign = 'center';
      chart.getDatasetMeta(0).data.forEach((bar, i) => {
        const total = chart.data.datasets.reduce((a, ds, j) => a + (ds.type !== 'line' && chart.isDatasetVisible(j) ? ds.data[i] || 0 : 0), 0);
        c.fillText(opts.format(total, i), bar.x, chart.scales.y.getPixelForValue(total) - 4);
      });
    } else {
      c.textBaseline = 'middle';
      c.textAlign = 'left';
      const data = chart.data.datasets[0].data;
      chart.getDatasetMeta(0).data.forEach((bar, i) => c.fillText(opts.format(data[i], i), bar.x + 6, bar.y));
    }
    c.restore();
  },
};
Chart.register(refLinePlugin, valueLabelsPlugin);

// 'index' mode with the index taken from the 'est' stack only: other series have their own x positions, so
// their indexes don't line up. Points outside the visible window don't count.
Chart.Interaction.modes.estIndex = (chart, e) => {
  const metas = chart.getSortedVisibleDatasetMetas().filter((m) => chart.data.datasets[m.index].stack === 'est');
  const pts = metas[0]?.data ?? [];
  const { left, right } = chart.chartArea;
  let i = -1;
  pts.forEach((p, j) => { if (p.x >= left && p.x <= right && (i < 0 || Math.abs(p.x - e.x) < Math.abs(pts[i].x - e.x))) i = j; });
  return i < 0 ? [] : metas.map((m) => ({ element: m.data[i], datasetIndex: m.index, index: i }));
};

// Ticks on round local times (every 5m, 1h, 1d, ...) instead of Chart.js's round millisecond counts.
function timeTicks(axis) {
  const { min, max } = axis;
  const step = TICK_STEPS.find((s) => (max - min) / s <= 6) ?? TICK_STEPS.at(-1);
  const shift = -new Date(min).getTimezoneOffset() * 60_000;
  axis.ticks = [];
  for (let t = Math.ceil((min + shift) / step) * step - shift; t <= max; t += step) axis.ticks.push({ value: t });
}

const charts = {};
const hidden = {}; // chartId -> Set of hidden dataset labels, kept across refreshes

function draw(id, config) {
  charts[id]?.destroy();
  const off = hidden[id] || new Set();
  config.data.datasets.forEach((ds) => { if (off.has(ds.label)) ds.hidden = true; });
  charts[id] = new Chart(document.getElementById(id), config);
  return charts[id];
}

// One button per label: datasets that share a label show and hide together.
function legend(elId, chartId) {
  const chart = charts[chartId];
  const el = document.getElementById(elId);
  el.innerHTML = '';
  [...new Set(chart.data.datasets.map((ds) => ds.label))].forEach((label) => {
    const idx = chart.data.datasets.flatMap((ds, i) => (ds.label === label ? [i] : []));
    const ds = chart.data.datasets[idx[0]];
    const on = chart.isDatasetVisible(idx[0]);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'flex items-center gap-1.5 hover:text-(--ink)';
    b.style.opacity = on ? 1 : 0.45;
    b.title = on ? 'Hide series' : 'Show series';
    const fill = ds.swatch ?? ds.backgroundColor;
    const sw = ds.type === 'line' && ds.borderDash
      ? `<span class="swatch" style="height:0;width:14px;border-radius:0;border-top:2px dashed ${ds.borderColor}"></span>`
      : ds.type === 'line' && !ds.fill
        ? `<span class="swatch" style="height:2px;width:14px;border-radius:1px;background:${ds.borderColor}"></span>`
        : ds.type === 'scatter'
          ? `<span class="swatch" style="border-radius:50%;background:${fill}"></span>`
          : `<span class="swatch" style="background:${fill}"></span>`;
    b.innerHTML = sw + esc(ds.label);
    b.onclick = () => {
      idx.forEach((i) => chart.setDatasetVisibility(i, !on));
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

function options({ stacked = false, yFmt = compact, tip = {}, x = {}, y = {}, plugins = {}, horizontal = false, padRight = 0, padTop = 0 } = {}) {
  const valueAxis = {
    stacked, beginAtZero: true, grid: { color: P.grid, drawTicks: false }, border: { display: false },
    ticks: { color: P.muted, callback: yFmt, maxTicksLimit: 6, padding: 6 }, ...y,
  };
  const catAxis = {
    stacked, grid: { display: false }, border: { color: P.axis },
    ticks: { color: P.muted, maxRotation: 0, autoSkip: true, autoSkipPadding: 12 }, ...x,
  };
  return {
    responsive: true, maintainAspectRatio: false, animation: false, layout: { padding: { right: padRight, top: padTop } },
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
  renderSubscription(d);
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

// ---------- subscription value (Pro/Max plan limits; null for API accounts) ----------
function weekRange(w) {
  const a = new Date(w.start), b = new Date(w.end);
  const range = a.getMonth() === b.getMonth() ? `${fmtDate(a)}–${b.getDate()}` : `${fmtDate(a)} – ${fmtDate(b)}`;
  return range + (w.current ? ', so far' : w.partial ? ', partial' : '');
}

// Axis label: the week's start date, which fits under a bar.
const weekTick = (w) => (w.current ? [fmtDate(Date.parse(w.start)), 'so far'] : w.partial ? [fmtDate(Date.parse(w.start)), 'partial'] : fmtDate(Date.parse(w.start)));

const DEFAULT_PRICE = 200;
const priceOf = (id) => state.planPrices[id] ?? DEFAULT_PRICE;
const weeklyCost = (monthly) => (monthly * 12) / 52;
// What the plan cost from the account's first reading until now (or its last, once its weekly window ended).
const paidFor = (a) => (priceOf(a.id) * 12 * Math.max(7, (Date.parse(a.paid_until) - Date.parse(a.since)) / DAY)) / 365;
// Fixed color per account, in order of first use. P.s[1] stays with "Over a limit".
const accountColor = (i) => (i === 0 ? P.s[0] : P.s[i + 1] ?? P.muted);

function setSubTiles(tiles) {
  const el = $('#sub-tiles');
  el.classList.toggle('sm:grid-cols-3', tiles.length === 6);
  el.classList.toggle('lg:grid-cols-6', tiles.length === 6);
  el.classList.toggle('lg:grid-cols-4', tiles.length === 4);
  el.innerHTML = tiles.join('');
}

function renderSubscription(d) {
  const s = d.subscription;
  $('#sub').hidden = !s;
  if (!s) return;
  const all = state.subAccount === '' && s.combined;
  const a = !all && (s.accounts.find((x) => x.id === state.subAccount) ?? s.accounts.find((x) => x.id === s.active));
  const sel = $('#sub-account');
  sel.hidden = s.accounts.length < 2;
  fillSelect(sel, s.accounts.map((x) => x.id), a ? a.id : '', 'All accounts', (id) => s.accounts.find((x) => x.id === id).label);
  sel.value = a ? a.id : '';
  $('#plan-price-label').hidden = !a;
  if (a && document.activeElement !== $('#plan-price')) $('#plan-price').value = priceOf(a.id);
  $('#plans-total').hidden = !all;
  $('#plans-total').textContent = `Plans: ${usd(s.accounts.reduce((t, x) => t + priceOf(x.id), 0))}/month`;
  $('#sub-note').textContent = `${all ? 'All accounts' : 'Whole account'}, last 12 weeks. The filters above don't apply. Dollars are the reported cost at API list prices.`;
  if (all) renderCombined(s);
  else renderAccount(a);
}

function renderAccount(s) {
  const now = Date.now();
  const perWeek = weeklyCost(priceOf(s.id));
  const weeks = s.weeks;
  const cur = weeks.find((w) => w.current);

  const week = s.current.seven_day;
  let weekSub = week ? `resets ${fmtWeekday(week.resets_at)}` : 'no use this week';
  if (week) {
    const begun = Date.parse(week.resets_at) - 7 * 86_400_000;
    const elapsed = now - begun;
    if (elapsed >= 86_400_000 && week.pct > 0) {
      const pace = (week.pct * 7 * 86_400_000) / elapsed;
      weekSub += pace >= 100 ? ` · on pace to reach it ${fmtWeekday(begun + (elapsed * 100) / week.pct)}` : ` · on pace for ${pace.toFixed(0)}%`;
    }
  }
  const five = s.current.five_hour;
  const hits = `limit reached in ${int(s.five_hour.hits)} of ${int(s.five_hour.windows)} windows`;
  const share = s.five_hour.week_share;
  const paid = paidFor(s);
  setSubTiles([
    tile('This week', cur ? usd(cur.within) : '—', cur ? `${times(cur.within / perWeek)} the plan's weekly cost` : 'no use this week'),
    tile('Weekly limit', week ? `${week.pct.toFixed(0)}%` : '—', weekSub),
    tile('5-hour limit', five ? `${five.pct.toFixed(0)}%` : '—', five ? `resets ${fmtClock(five.resets_at)} · ${hits}` : hits),
    tile('Per 1% of weekly limit', s.per_pct ? usd(s.per_pct) : '—',
      s.per_pct ? `a full week ≈ $${int(100 * s.per_pct)}, ${times((100 * s.per_pct) / perWeek)} the plan's weekly cost` : 'needs a week with 10% or more used'),
    tile('One 5-hour window', share ? `${share.toFixed(1)}%` : '—',
      share ? `of the weekly limit · about ${Math.floor(100 / share)} full windows a week` : 'needs more 5-hour windows'),
    tile(`Since ${fmtDate(Date.parse(s.since))}`, usd(s.within_since), `${times(s.within_since / paid)} the ${usd(paid)} the plan cost`),
  ]);

  // Value per week: within the limits vs. extra usage, against the plan's weekly cost.
  $('#sub-weeks-sub').textContent = 'Reported cost in each weekly limit window, against what the plan costs per week. Over a limit is extra usage, paid apart from the plan.';
  const fade = (color) => weeks.map((w) => (w.current ? color + '80' : color));
  const datasets = [barDS('Within limits', weeks.map((w) => w.within), P.s[0], { backgroundColor: fade(P.s[0]), hoverBackgroundColor: fade(P.s[0]), swatch: P.s[0] })];
  if (weeks.some((w) => w.over > 0.005)) {
    datasets.push(barDS('Over a limit', weeks.map((w) => w.over), P.s[1], { backgroundColor: fade(P.s[1]), hoverBackgroundColor: fade(P.s[1]), swatch: P.s[1] }));
  }
  const planLabel = `Plan ${usdAxis(perWeek)}/wk`;
  draw('c-sub-weeks', {
    type: 'bar',
    data: { labels: weeks.map(weekTick), datasets },
    options: options({
      stacked: true, yFmt: usdAxis, padTop: 18, padRight: 12 + planLabel.length * 7,
      y: { suggestedMax: Math.max(perWeek * 1.15, ...weeks.map((w) => w.within + w.over)) },
      plugins: { refLine: { value: perWeek, label: planLabel, outside: true }, valueLabels: { above: true, format: (_, i) => times(weeks[i].within / perWeek) } },
      tip: {
        itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
        callbacks: {
          title: (items) => weekRange(weeks[items[0].dataIndex]),
          label: (c) => ` ${c.dataset.label}: ${usd(c.parsed.y)}`,
          footer: (items) => {
            const w = weeks[items[0].dataIndex];
            return [`${times(w.within / perWeek)} the plan's weekly cost`, `Weekly limit ${w.pct_first.toFixed(0)}% → ${w.pct_last.toFixed(0)}%`]
              .concat(w.per_pct ? [`${usd(w.per_pct)} per 1%`] : []);
          },
        },
      },
    }),
  });
  legend('legend-sub-weeks', 'c-sub-weeks');
  $('#t-sub-weeks').innerHTML =
    '<thead class="sticky top-0 bg-(--surface) text-(--muted)"><tr class="border-b border-(--grid)"><th class="py-1 pr-3 text-left font-medium">Week</th>' +
    '<th class="pr-3 font-medium">Within limits</th><th class="pr-3 font-medium">Over a limit</th><th class="pr-3 font-medium">× plan</th>' +
    '<th class="pr-3 font-medium">Weekly limit used</th><th class="font-medium">Per 1%</th></tr></thead><tbody>' +
    weeks.slice().reverse().map((w) => `<tr class="border-b border-(--grid)"><td class="py-1 pr-3 text-left">${esc(weekRange(w))}</td>` +
      `<td class="pr-3">${usd(w.within)}</td><td class="pr-3">${usd(w.over)}</td><td class="pr-3">${times(w.within / perWeek)}</td>` +
      `<td class="pr-3">${w.pct_first.toFixed(0)}% → ${w.pct_last.toFixed(0)}%</td><td>${usd(w.per_pct)}</td></tr>`).join('') + '</tbody>';

  // Dollars per 1%: this week highlighted, the five weeks before it as gray context, and the average rate.
  const shown = weeks.slice(-6).sort((a, b) => b.current - a.current);
  const lines = shown.map((w) => lineDS(w.current ? 'This week' : 'Earlier weeks', w.points.map(([x, y]) => ({ x, y })),
    w.current ? P.s[0] : P.muted, { week: w, order: w.current ? -1 : 0 }));
  if (s.per_pct) {
    const top = Math.max(...shown.flatMap((w) => w.points.map((p) => p[0])));
    lines.push(lineDS('Average rate', [{ x: 0, y: 0 }, { x: top, y: top * s.per_pct }], P.ink2,
      { borderWidth: 1.5, borderDash: [5, 4], pointHoverRadius: 0, pointHitRadius: 0, order: -2 }));
  }
  $('#sub-rate-title').textContent = 'Dollars per 1% of the weekly limit';
  $('#sub-rate-sub').textContent = s.rolling
    ? 'The weekly limit looks like a rolling window here, so week-by-week rates are hidden.'
    : 'Each line is one week. The steeper the line, the more each 1% of the limit was worth.';
  draw('c-sub-rate', {
    type: 'line',
    data: { datasets: lines },
    options: {
      ...options({
        yFmt: usdAxis,
        x: { type: 'linear', min: 0, max: 100, grid: { display: false }, border: { color: P.axis }, ticks: { color: P.muted, maxTicksLimit: 6, callback: (v) => `${v}%` } },
        tip: {
          filter: (item) => item.dataset.week,
          callbacks: {
            title: (items) => weekRange(items[0].dataset.week),
            label: (c) => ` ${c.parsed.x.toFixed(1)}% used · ${usd(c.parsed.y)}`,
            footer: (items) => (items[0].dataset.week.per_pct ? `${usd(items[0].dataset.week.per_pct)} per 1%` : ''),
          },
        },
      }),
      interaction: { mode: 'nearest', intersect: false },
    },
  });
  legend('legend-sub-rate', 'c-sub-rate');
}

// All accounts: calendar weeks, since each account's weekly windows reset at its own time.
function renderCombined(s) {
  const accounts = s.accounts;
  const first = Math.min(...accounts.map((a) => Date.parse(a.since)));
  const weeks = s.combined.weeks.map((w) => ({ ...w, partial: Date.parse(w.start) < first }));
  const within = (w) => sum(w.within);
  const planCost = (w) => w.plans.reduce((t, id) => t + weeklyCost(priceOf(id)), 0);
  const ofPlans = (w, v) => (planCost(w) ? `${times(v / planCost(w))} the ${w.plans.length === 1 ? "plan's" : "plans'"} weekly cost` : 'no plan this week');
  const cur = weeks.find((w) => w.current);
  const rated = accounts.filter((a) => a.per_pct);
  const fullWeek = rated.reduce((t, a) => t + 100 * a.per_pct, 0);
  const ratedCost = rated.reduce((t, a) => t + weeklyCost(priceOf(a.id)), 0);
  const withinSince = accounts.reduce((t, a) => t + a.within_since, 0);
  const paid = accounts.reduce((t, a) => t + paidFor(a), 0);
  setSubTiles([
    tile('This week', cur ? usd(within(cur)) : '—', cur ? ofPlans(cur, within(cur)) : 'no use this week'),
    tile('A full week of all plans', rated.length ? `$${int(fullWeek)}` : '—', rated.length
      ? `${times(fullWeek / ratedCost)} their weekly cost` + (rated.length < accounts.length ? ` · ${rated.length} of ${accounts.length} accounts` : '')
      : 'needs a week with 10% or more used'),
    tile(`Since ${fmtDate(first)}`, usd(withinSince), `${times(withinSince / paid)} the ${usd(paid)} the plans cost`),
    tile('Extra usage', usd(accounts.reduce((t, a) => t + a.over_since, 0)), 'paid apart from the plans'),
  ]);

  // Value per week: each account's spend within its limits, extra usage, and what the plans cost that week.
  $('#sub-weeks-sub').textContent = 'Reported cost in each calendar week, by account, against what the plans cost per week. Over a limit is extra usage, paid apart from the plans.';
  const fade = (color) => weeks.map((w) => (w.current ? color + '80' : color));
  const bar = (label, data, color) => barDS(label, data, color, { backgroundColor: fade(color), hoverBackgroundColor: fade(color), swatch: color });
  const datasets = accounts.map((a, i) => bar(a.label, weeks.map((w) => w.within[a.id] || 0), accountColor(i)));
  if (weeks.some((w) => w.over > 0.005)) datasets.push(bar('Over a limit', weeks.map((w) => w.over), P.s[1]));
  datasets.push(lineDS("Plans' cost", weeks.map(planCost), P.ink2,
    { stack: 'plans', stepped: 'middle', borderWidth: 1.5, borderDash: [5, 4], pointHoverRadius: 0, pointHitRadius: 0, order: -1 }));
  draw('c-sub-weeks', {
    type: 'bar',
    data: { labels: weeks.map(weekTick), datasets },
    options: options({
      stacked: true, yFmt: usdAxis, padTop: 18,
      y: { suggestedMax: Math.max(...weeks.map((w) => Math.max(planCost(w) * 1.15, within(w) + w.over))) },
      plugins: { valueLabels: { above: true, format: (_, i) => (planCost(weeks[i]) ? times(within(weeks[i]) / planCost(weeks[i])) : '') } },
      tip: {
        filter: (item) => item.dataset.type !== 'line' && item.raw > 0,
        itemSort: (a, b) => b.datasetIndex - a.datasetIndex,
        callbacks: {
          title: (items) => weekRange(weeks[items[0].dataIndex]),
          label: (c) => ` ${c.dataset.label}: ${usd(c.parsed.y)}`,
          footer: (items) => {
            const w = weeks[items[0].dataIndex];
            return [`Plans' cost ${usd(planCost(w))}`, ofPlans(w, within(w))];
          },
        },
      },
    }),
  });
  legend('legend-sub-weeks', 'c-sub-weeks');
  const th = (label) => `<th class="pr-3 font-medium">${esc(label)}</th>`;
  $('#t-sub-weeks').innerHTML =
    '<thead class="sticky top-0 bg-(--surface) text-(--muted)"><tr class="border-b border-(--grid)"><th class="py-1 pr-3 text-left font-medium">Week</th>' +
    accounts.map((a) => th(a.label)).join('') + th('Within limits') + th('Over a limit') + th("Plans' cost") +
    '<th class="font-medium">× plans</th></tr></thead><tbody>' +
    weeks.slice().reverse().map((w) => `<tr class="border-b border-(--grid)"><td class="whitespace-nowrap py-1 pr-3 text-left">${esc(weekRange(w))}</td>` +
      accounts.map((a) => `<td class="pr-3">${usd(w.within[a.id] || 0)}</td>`).join('') +
      `<td class="pr-3">${usd(within(w))}</td><td class="pr-3">${usd(w.over)}</td><td class="pr-3">${usd(planCost(w))}</td>` +
      `<td>${planCost(w) ? times(within(w) / planCost(w)) : '—'}</td></tr>`).join('') + '</tbody>';

  // A full week of each account: 100 × its average dollars per 1%. Two accounts' % can't be added up.
  const bars = accounts.flatMap((a, i) => (a.per_pct ? [{ a, color: accountColor(i), full: 100 * a.per_pct }] : []));
  $('#sub-rate-title').textContent = 'What a full week is worth';
  $('#sub-rate-sub').textContent = bars.length
    ? "100% of each account's weekly limit, at its average dollars per 1%, against its plan's weekly cost."
    : 'Needs a week with 10% or more of the weekly limit used.';
  draw('c-sub-rate', {
    type: 'bar',
    data: {
      labels: bars.map((b) => b.a.label),
      datasets: [{ label: 'A full week', data: bars.map((b) => b.full), backgroundColor: bars.map((b) => b.color), borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24 }],
    },
    options: options({
      horizontal: true, yFmt: usdAxis, padRight: 150,
      tip: { callbacks: { label: (c) => ` ${usd(c.parsed.x)} · ${usd(bars[c.dataIndex].a.per_pct)} per 1%` } },
      plugins: { valueLabels: { format: (v, i) => `$${int(v)} · ${times(v / weeklyCost(priceOf(bars[i].a.id)))} its plan` } },
    }),
  });
  $('#legend-sub-rate').innerHTML = '';
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
  if (sid !== state.sid) {
    state.win = { end: null, span: null };
    $('#s-nav').hidden = true;
  }
  state.sid = sid;
  $('#s-title').textContent = 'Loading…';
  $('#s-sub').textContent = '';
  $('#s-kpis').innerHTML = '';
  if (!dlg.open) dlg.showModal();
  await loadSession(sid);
}

async function loadSession(sid) {
  try {
    const body = await getJSON('/api/session/' + encodeURIComponent(sid) + '?tz=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone));
    if (sid !== state.sid) return;
    state.session = body;
    renderSession();
  } catch (e) {
    $('#s-title').textContent = 'Failed to load session: ' + e.message;
  }
}

function winRange() {
  const { lo, hi } = state.bounds;
  const end = state.win.end ?? hi;
  return [state.win.span == null ? lo : Math.max(lo, end - state.win.span), end];
}

function setWin(a, b, keepSpan = false) {
  const { lo, hi } = state.bounds;
  if (keepSpan) {
    const w = Math.min(b - a, hi - lo);
    if (a < lo) [a, b] = [lo, lo + w];
    if (b > hi) [a, b] = [hi - w, hi];
  }
  a = Math.max(a, lo);
  b = Math.min(b, hi);
  if (b - a < MIN_SPAN) { b = Math.min(hi, a + MIN_SPAN); a = Math.max(lo, b - MIN_SPAN); }
  state.win = { end: b >= hi ? null : b, span: a <= lo && b >= hi ? null : b - a };
  applyWin();
}

let winFrame = 0;
function applyWin() {
  syncWin();
  cancelAnimationFrame(winFrame);
  winFrame = requestAnimationFrame(() => {
    const [a, b] = winRange();
    for (const id of ['c-s-ctx', 'c-s-cost']) {
      Object.assign(charts[id].options.scales.x, { min: a, max: b });
      charts[id].update('none');
    }
  });
}

function syncWin() {
  const { lo, hi } = state.bounds;
  const [a, b] = winRange();
  const win = $('#s-win');
  win.style.setProperty('--mid', (((a + b) / 2 - lo) / (hi - lo)) * 100 + '%');
  win.style.setProperty('--span', ((b - a) / (hi - lo)) * 100 + '%');
  win.classList.toggle('full', a <= lo && b >= hi);
  for (const [el, v] of [[$('#s-from'), dtLocal(a)], [$('#s-to'), dtLocal(b)]]) if (el.value !== v) el.value = v;
  $('#s-span').textContent = fmtDur(b - a);
  document.querySelectorAll('#s-presets button').forEach((btn) => {
    const span = btn.dataset.span ? btn.dataset.span * 60_000 : null;
    btn.disabled = span != null && span >= hi - lo;
    btn.setAttribute('aria-pressed', String(state.win.end == null && state.win.span === span));
  });
}

// Drag a handle to move one edge, drag the window to slide it, drag on the track to draw a new window,
// or click the track to center the window there.
function dragWin(e) {
  if (e.button !== 0) return;
  e.preventDefault();
  const el = e.target;
  const { lo, hi } = state.bounds;
  const rect = $('#s-track').getBoundingClientRect();
  const k = (hi - lo) / rect.width;
  const at = (x) => lo + (x - rect.left) * k;
  const [a, b] = winRange();
  const x0 = e.clientX;
  const full = a <= lo && b >= hi;
  const mode = el.dataset.edge || (el.closest('#s-win') && !full ? 'move' : 'new');
  let moved = false;
  const ac = new AbortController();
  el.setPointerCapture(e.pointerId);
  el.addEventListener('pointermove', (ev) => {
    const d = (ev.clientX - x0) * k;
    moved ||= Math.abs(ev.clientX - x0) > 3;
    if (mode === 'move') setWin(a + d, b + d, true);
    else if (mode === 'start') setWin(Math.min(a + d, b - MIN_SPAN), b);
    else if (mode === 'end') setWin(a, Math.max(b + d, a + MIN_SPAN));
    else if (moved) setWin(Math.min(at(x0), at(ev.clientX)), Math.max(at(x0), at(ev.clientX)));
  }, { signal: ac.signal });
  el.addEventListener('pointerup', () => {
    if (mode === 'new' && !moved && !full) setWin(at(x0) - (b - a) / 2, at(x0) + (b - a) / 2, true);
    ac.abort();
  }, { signal: ac.signal });
  for (const type of ['pointercancel', 'lostpointercapture']) el.addEventListener(type, () => ac.abort(), { signal: ac.signal });
}

function renderNav(main) {
  const { lo, hi } = state.bounds;
  $('#s-nav').hidden = hi - lo < 2 * MIN_SPAN;
  draw('c-s-nav', {
    type: 'line',
    data: { datasets: [lineDS('Main thread', main.map((r) => ({ x: Date.parse(r.ts), y: r.ctx })), P.s[0], { borderWidth: 1, fill: 'origin', backgroundColor: P.s[0] + '33' })] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, events: [],
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { type: 'linear', display: false, min: lo, max: hi }, y: { display: false, beginAtZero: true, grace: '10%' } },
    },
  });
  syncWin();
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
  state.bounds = { lo: Math.min(...xs), hi: Math.max(...xs) };
  const { hi } = state.bounds;
  const [winStart, winEnd] = winRange();
  const timeAxis = {
    type: 'linear', min: winStart, max: winEnd, grid: { display: false }, border: { color: P.axis }, afterBuildTicks: timeTicks,
    ticks: { color: P.muted, maxRotation: 0, autoSkipPadding: 12, callback(v) { return this.max - this.min > 3 * DAY ? fmtDate(v) : fmtTs(v); } },
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
  if (reqs.length && Date.parse(reqs.at(-1).ts) < hi) {
    for (const [k] of COMPONENTS) series[k].push({ x: hi, y: running[k] });
  }
  const comps = COMPONENTS.map((c, i) => [...c, i]).filter(([k]) => running[k] > 0 || k !== 'web_search');
  const datasets = comps.map(([k, label, i], n) => lineDS(label, series[k], P.s[i], {
    fill: n === 0 ? 'origin' : '-1', backgroundColor: P.s[i], borderColor: P.s[i], borderWidth: 0, stack: 'est', pointHoverRadius: 0, stepped: 'before',
  }));
  const reported = events.map((e) => ({ x: Date.parse(e.ts), y: e.cost_usd }));
  if (events.length) {
    datasets.push(lineDS('Reported', reported, P.ink, { stack: 'billed', stepped: 'before', order: -1 }));
  }
  const lastAt = (pts, x) => { let v = null; for (const p of pts) { if (p.x <= x) v = p.y; else break; } return v; };
  const billedAt = (x) => lastAt(reported, x);
  // The totals only grow, so the window's highest value is at its end, even when no point falls inside it.
  const fitWindowEnd = (sc) => {
    const x = sc.chart.options.scales.x.max;
    sc.max = Math.max(sc.max, comps.reduce((a, [k]) => a + (lastAt(series[k], x) ?? 0), 0), billedAt(x) ?? 0);
  };
  draw('c-s-cost', {
    type: 'line',
    data: { datasets },
    options: {
      ...options({ stacked: true, yFmt: usdAxis, x: { ...timeAxis, stacked: false }, y: { afterDataLimits: fitWindowEnd },
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
  renderNav(main);
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
$('#sub-account').addEventListener('change', (e) => {
  state.subAccount = e.target.value;
  store.set('subAccount', state.subAccount);
  renderSubscription(state.data);
});
$('#plan-price').addEventListener('change', (e) => {
  const id = $('#sub-account').value;
  const v = Number(e.target.value);
  if (Number.isFinite(v) && v > 0) {
    state.planPrices[id] = v;
    store.set('planPrices', state.planPrices);
    renderSubscription(state.data);
  } else {
    e.target.value = priceOf(id);
  }
});
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
new ResizeObserver(() => { $('#s-nav').style.top = $('#s-head').offsetHeight + 'px'; }).observe($('#s-head'));
document.querySelectorAll('#s-presets button').forEach((b) => b.addEventListener('click', () => {
  state.win = { end: null, span: b.dataset.span ? b.dataset.span * 60_000 : null };
  applyWin();
}));
['s-from', 's-to'].forEach((id) => $('#' + id).addEventListener('change', () => {
  const { lo, hi } = state.bounds;
  // The inputs only show minutes; keep a window that reaches the first or last request pinned there.
  const read = (v) => (v === dtLocal(lo) ? lo : v === dtLocal(hi) ? hi : Date.parse(v));
  const [a, b] = [read($('#s-from').value), read($('#s-to').value)];
  if (Number.isNaN(a) || Number.isNaN(b)) return;
  setWin(Math.min(a, b), Math.max(a, b));
}));
$('#s-track').addEventListener('pointerdown', dragWin);
$('#s-win').addEventListener('keydown', (e) => {
  const dir = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
  if (!dir) return;
  e.preventDefault();
  const [a, b] = winRange();
  const d = dir * (b - a) * (e.shiftKey ? 1 : 0.1);
  setWin(a + d, b + d, true);
});

setInterval(() => {
  if (!state.auto || document.visibilityState !== 'visible') return;
  if ($('#session-dlg').open) loadSession(state.sid);
  else refresh();
}, REFRESH_MS);

applyTheme();
refresh();
