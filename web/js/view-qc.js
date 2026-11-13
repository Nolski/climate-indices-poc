// Step 2: is the data fit to use? Summary tiles, missing-data strip, the checks, and a
// zoomable chart of the daily values (downloaded only when asked for).

import { $, h, replace, icon, show, createStatus } from './dom.js';
import { attachChart } from './chart.js';
import {
  VARIABLES,
  DEFAULT_MAX_MISSING_PER_YEAR,
  qcVerdict,
  sortChecks,
  flaggedForVariable,
  missingClass,
  availableVariables,
  isoToDay,
  dayToIso,
  decimate,
  lowerBound,
} from './shape.js';

const SEV_ICON = { error: 'error', warning: 'warning', info: 'info', passed: 'check' };
const MIN_WINDOW = 30;

// State of the daily chart, reset when another dataset is loaded.
const daily = { datasetId: '', variable: '', cache: new Map(), x: null, y: null, units: '', win: [0, 0], chart: null, flags: [], view: null };
let dailyStatus = null;
let thresholdStatus = null;

export function init(ctx) {
  dailyStatus = createStatus($('daily-status'), ctx);
  thresholdStatus = createStatus($('qc-thresholds-status'), ctx);
  $('qc-thresholds-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const read = readThresholds(ctx);
    if (read.error) thresholdStatus.error(read.error);
    else rerunChecks(ctx, read.values);
  });
  $('btn-qc-defaults').addEventListener('click', () => {
    if (ctx.state.qcDefaults) rerunChecks(ctx, { ...ctx.state.qcDefaults });
  });
  $('btn-daily-load').addEventListener('click', () => loadDaily(ctx, $('daily-variable').value));
  $('daily-variable').addEventListener('change', (ev) => {
    if (daily.x) loadDaily(ctx, ev.target.value);
  });
  $('btn-zoom-in').addEventListener('click', () => zoomBy(ctx, 0.5));
  $('btn-zoom-out').addEventListener('click', () => zoomBy(ctx, 2));
  $('btn-pan-left').addEventListener('click', () => panBy(ctx, -0.5));
  $('btn-pan-right').addEventListener('click', () => panBy(ctx, 0.5));
  $('btn-zoom-reset').addEventListener('click', () => setWindow(ctx, 0, daily.x.length - 1));
  $('daily-chart').addEventListener('keydown', (ev) => {
    if (ev.key === '+' || ev.key === '=') zoomBy(ctx, 0.5);
    else if (ev.key === '-') zoomBy(ctx, 2);
  });
}

// The API lists at most a fixed number of records per check. If a check that concerns this
// variable was cut short, return that number so the chart can say its marks are incomplete.
function cappedAt(checks, variable) {
  let cap = 0;
  for (const c of checks || []) {
    const records = c.records || [];
    if (c.count > records.length && records.some((r) => r.variable === variable)) cap = Math.max(cap, records.length);
  }
  return cap;
}

function resetDaily() {
  if (daily.chart) daily.chart.destroy();
  daily.chart = null;
  daily.cache.clear();
  daily.x = null;
  daily.y = null;
  daily.variable = '';
  replace($('daily-chart'));
  show($('daily-panel'), false);
  if (dailyStatus) dailyStatus.clear();
  if (thresholdStatus) thresholdStatus.clear();
}

function setWindow(ctx, i0, i1) {
  if (!daily.x) return;
  const n = daily.x.length;
  let a = Math.max(0, Math.round(i0));
  let b = Math.min(n - 1, Math.round(i1));
  if (b - a < MIN_WINDOW) {
    const mid = (a + b) >> 1;
    a = Math.max(0, mid - MIN_WINDOW / 2);
    b = Math.min(n - 1, a + MIN_WINDOW);
    a = Math.max(0, b - MIN_WINDOW);
  }
  daily.win = [a, b];
  if (daily.chart) daily.chart.draw();
  paintRange(ctx);
}

function zoomBy(ctx, factor) {
  if (!daily.x) return;
  const [a, b] = daily.win;
  const mid = (a + b) / 2;
  const half = Math.max(MIN_WINDOW / 2, ((b - a) / 2) * factor);
  setWindow(ctx, mid - half, mid + half);
}

function panBy(ctx, fraction) {
  if (!daily.x) return;
  const [a, b] = daily.win;
  const span = b - a;
  let shift = Math.round(span * fraction);
  shift = Math.max(-a, Math.min(daily.x.length - 1 - b, shift));
  setWindow(ctx, a + shift, b + shift);
}

function paintRange(ctx) {
  const { t, tn, fmt } = ctx;
  if (!daily.x) return;
  const [a, b] = daily.win;
  const whole = a === 0 && b === daily.x.length - 1;
  let text = t('qc.daily.range', { from: fmt.date(dayToIso(daily.x[a])), to: fmt.date(dayToIso(daily.x[b])), days: tn('common.days', b - a + 1, { n: fmt.int(b - a + 1) }) });
  if (daily.view && daily.view.decimated) text += ' ' + t('qc.daily.decimated');
  if (daily.capped) text += ' ' + t('qc.daily.flagsCapped', { n: fmt.int(daily.capped) });
  $('daily-range').textContent = text;
  $('btn-zoom-reset').disabled = whole;
  $('btn-zoom-out').disabled = whole;
  $('btn-zoom-in').disabled = b - a <= MIN_WINDOW;
  $('btn-pan-left').disabled = a === 0;
  $('btn-pan-right').disabled = b === daily.x.length - 1;
}

function dailySpec(ctx, plotW) {
  const { t, fmt } = ctx;
  const [a, b] = daily.win;
  const view = decimate(daily.x, daily.y, a, b, Math.max(100, Math.floor(plotW)));
  daily.view = view;
  const x0 = daily.x[a];
  const x1 = daily.x[b];
  const inWin = daily.flags.filter((f) => f.day >= x0 && f.day <= x1 && f.value != null);
  const errs = inWin.filter((f) => f.severity === 'error');
  const warns = inWin.filter((f) => f.severity !== 'error');
  const series = [{ type: 'line', x: view.x, y: view.y, color: 'c1', marker: 'circle', label: fmt.variable(daily.variable), track: true }];
  if (errs.length) series.push({ type: 'points', x: errs.map((f) => f.day), y: errs.map((f) => f.value), shape: 'diamond', color: 'flagError', label: t('qc.daily.flagError') });
  if (warns.length) series.push({ type: 'points', x: warns.map((f) => f.day), y: warns.map((f) => f.value), shape: 'triangle', color: 'flagWarn', label: t('qc.daily.flagWarning') });
  return {
    kind: 'day',
    xDomain: [x0, x1],
    cursorX: view.x,
    panelHeight: 240,
    ariaLabel: t('qc.daily.chartAria', { variable: fmt.variable(daily.variable), from: fmt.date(dayToIso(x0)), to: fmt.date(dayToIso(x1)) }),
    emptyLabel: t('chart.empty'),
    formatY: (v, d) => fmt.num(v, d, d),
    formatTick: fmt.tick,
    panels: [{ unit: fmt.unit(daily.units), series }],
  };
}

function paintReadout(ctx, i) {
  const { t, fmt } = ctx;
  const el = $('daily-readout');
  if (i < 0 || !daily.view) return replace(el, t('chart.hint'));
  const day = daily.view.x[i];
  const v = daily.view.y[i];
  const iso = dayToIso(day);
  const flag = daily.flags.find((f) => f.day === day);
  replace(
    el,
    fmt.date(iso) + ': ',
    h('strong', { text: v == null ? t('chart.noValue') : fmt.num(v, 1) + ' ' + fmt.unit(daily.units) }),
    flag ? ' · ' + t('qc.daily.flagged', { title: flag.title, detail: flag.detail }) : '',
  );
}

async function loadDaily(ctx, variable, focusDay = null) {
  const { state, t, api } = ctx;
  if (!state.dataset || !variable) return;
  const ds = state.dataset;
  $('daily-variable').value = variable;
  try {
    let data = daily.cache.get(variable);
    if (!data) {
      dailyStatus.busy(t('qc.daily.loading', { variable: ctx.fmt.variable(variable) }), { slowAfter: 15, slowText: t('qc.daily.slow') });
      const res = await api.daily(ds.id, variable, {
        onEvent: (ev) => {
          if (ev.type === 'retry') dailyStatus.retrying(ev);
          else if (ev.type === 'attempt') dailyStatus.attempt();
        },
      });
      if (state.dataset !== ds) return;
      data = { x: (res.time || []).map(isoToDay), y: (res.values || []).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)), units: res.units || '' };
      daily.cache.set(variable, data);
    }
    dailyStatus.clear();
    daily.variable = variable;
    daily.x = data.x;
    daily.y = data.y;
    daily.units = data.units;
    daily.flags = flaggedForVariable(ds.qc && ds.qc.checks, variable);
    daily.capped = cappedAt(ds.qc && ds.qc.checks, variable);
    daily.win = [0, Math.max(0, data.x.length - 1)];
    show($('daily-panel'), true);
    if (daily.chart) daily.chart.destroy();
    daily.chart = attachChart($('daily-chart'), (w) => dailySpec(ctx, w), {
      onCursor: (i) => paintReadout(ctx, i),
      onZoom: (xa, xb) => setWindow(ctx, lowerBound(daily.x, xa), Math.max(0, lowerBound(daily.x, xb) - 1)),
      onReset: () => setWindow(ctx, 0, daily.x.length - 1),
    });
    paintReadout(ctx, -1);
    paintRange(ctx);
    if (focusDay !== null) {
      const i = lowerBound(daily.x, focusDay);
      setWindow(ctx, i - 180, i + 180);
      $('daily-chart').focus();
    }
  } catch (err) {
    if (err && err.expired) {
      dailyStatus.clear();
      ctx.markExpired();
      return;
    }
    const d = ctx.describeError(err);
    dailyStatus.error(d.message, { details: d.details, hint: d.hint, actions: [{ label: t('common.retry'), onClick: () => loadDaily(ctx, variable, focusDay), primary: true }] });
  }
}

// The yearly missing-day limit the server used for its checks, or the documented default.
function yearLimit(ds) {
  const s = ds && ds.qc && ds.qc.settings;
  return s && Number.isFinite(s.max_missing_days_per_year) ? s.max_missing_days_per_year : DEFAULT_MAX_MISSING_PER_YEAR;
}

function tile(label, value, sub, tone, iconName) {
  return h(
    'div',
    { class: 'tile' },
    h('p', { class: 'tile-label', text: label }),
    h('p', { class: 'tile-value' + (tone ? ' tone-' + tone : '') }, iconName ? icon(iconName) : null, h('span', { text: value })),
    typeof sub === 'string' ? h('p', { class: 'tile-sub', text: sub }) : sub,
  );
}

// qc.summary counts checks that found something; the records are counted here from the checks.
function severityTile(ctx, severity, nChecks, nInfo) {
  const { state, t, tn, fmt } = ctx;
  const checks = (state.dataset.qc && state.dataset.qc.checks) || [];
  const mine = checks.filter((c) => c.severity === severity && c.count > 0);
  const records = mine.reduce((sum, c) => sum + c.count, 0);
  const found = records > 0 || nChecks > 0;
  const n = nChecks != null ? nChecks : mine.length;
  let sub = found ? tn('qc.tile.flaggedSub', records, { checks: fmt.int(n) }) : t('qc.tile.noneSub');
  if (nInfo) sub += ' ' + tn('qc.tile.info', nInfo, { n: fmt.int(nInfo) });
  const bad = severity === 'error' ? 'err' : 'warn';
  return tile(t(severity === 'error' ? 'qc.tile.errors' : 'qc.tile.warnings'), fmt.int(records), sub, found ? bad : 'ok', found ? severity : 'check');
}

function paintTiles(ctx) {
  const { state, t, fmt } = ctx;
  const ds = state.dataset;
  const s = (ds.qc && ds.qc.summary) || {};
  const nDays = ds.period.n_days;
  const vars = ds.variables || {};
  const totalMissing = VARIABLES.reduce((sum, v) => sum + ((vars[v] && vars[v].n_missing) || 0), 0);
  replace(
    $('qc-tiles'),
    tile(t('qc.tile.days'), fmt.int(nDays), t('qc.tile.daysSub', { start: fmt.date(ds.period.start), end: fmt.date(ds.period.end) })),
    tile(
      t('qc.tile.missing'),
      fmt.int(totalMissing),
      h(
        'ul',
        { class: 'tile-list' },
        VARIABLES.filter((v) => vars[v]).map((v) =>
          h('li', null, h('span', { text: fmt.variable(v) }), h('strong', { text: fmt.int(vars[v].n_missing) + ' (' + fmt.percent(nDays ? vars[v].n_missing / nDays : 0, 1) + ')' })),
        ),
      ),
    ),
    severityTile(ctx, 'error', s.errors),
    severityTile(ctx, 'warning', s.warnings, s.info),
  );
}

function paintVerdict(ctx) {
  const { state, t } = ctx;
  const verdict = qcVerdict(state.dataset.qc);
  const box = $('qc-verdict');
  box.className = 'verdict verdict-' + verdict;
  replace(
    box,
    icon(verdict === 'clean' ? 'check' : verdict === 'warnings' ? 'warning' : 'error'),
    h('div', null, h('p', { class: 'verdict-title', text: t('qc.verdict.' + verdict + '.title') }), h('p', { text: t('qc.verdict.' + verdict + '.body') })),
  );
  $('btn-to-indices-text').textContent = t(verdict === 'clean' ? 'qc.continue' : verdict === 'warnings' ? 'qc.continueWarnings' : 'qc.continueErrors');
}

function paintStrip(ctx) {
  const { state, t, tn, fmt } = ctx;
  const rows = (state.dataset.qc && state.dataset.qc.missing_by_year) || [];
  const wrap = $('qc-strip');
  const tableBox = $('qc-strip-table');
  if (!rows.length) {
    replace(wrap, h('p', { class: 'hint', text: t('qc.strip.none') }));
    replace(tableBox);
    return;
  }
  const vars = VARIABLES.filter((v) => rows.some((r) => r[v] !== undefined));
  const limit = yearLimit(state.dataset);
  const parts = vars.map((v) =>
    h(
      'div',
      { class: 'strip-row' },
      h('span', { class: 'strip-label', text: fmt.variable(v) }),
      h(
        'div',
        { class: 'strip-cells', role: 'img', 'aria-label': t('qc.strip.rowLabel', { variable: fmt.variable(v), years: fmt.int(rows.filter((r) => r[v] > 0).length), over: fmt.int(rows.filter((r) => r[v] > limit).length) }) },
        rows.map((r) => h('span', { class: 'cell cell-' + missingClass(r[v], limit), title: r.year + ': ' + tn('qc.strip.missingDays', r[v] || 0, { n: fmt.int(r[v] || 0) }) })),
      ),
    ),
  );
  // Year labels: first, last and each decade, placed by percentage along the strip.
  const n = rows.length;
  const axis = h('div', { class: 'strip-axis', 'aria-hidden': 'true' });
  const labelAt = (i) => {
    const pos = (i + 0.5) / n;
    const el = h('span', { text: String(rows[i].year), class: i > 0 && i < n - 1 && (pos < 0.22 || pos > 0.78) ? 'near-edge' : null });
    el.style.insetInlineStart = (((i + 0.5) / n) * 100).toFixed(2) + '%';
    return el;
  };
  const step = n > 60 ? 20 : n > 25 ? 10 : 5;
  const idx = [0];
  for (let i = 1; i < n - 1; i++) {
    if (rows[i].year % step === 0 && i > n * 0.08 && i < n * 0.92) idx.push(i);
  }
  if (n > 1) idx.push(n - 1);
  idx.forEach((i) => axis.appendChild(labelAt(i)));
  parts.push(h('div', { class: 'strip-row' }, h('span'), axis));
  parts.push(
    h(
      'ul',
      { class: 'strip-legend' },
      [0, 1, 2, 3].map((c) => h('li', null, h('span', { class: 'cell cell-' + c }), t('qc.strip.legend.' + c, { limit: fmt.int(limit) }))),
    ),
  );
  replace(wrap, parts);

  const gaps = rows.filter((r) => vars.some((v) => r[v] > 0));
  if (!gaps.length) replace(tableBox, h('p', { class: 'hint', text: t('qc.strip.complete') }));
  else {
    replace(
      tableBox,
      h(
        'table',
        null,
        h('thead', null, h('tr', null, h('th', { scope: 'col', text: t('common.year') }), vars.map((v) => h('th', { scope: 'col', class: 'num', text: fmt.variable(v) })))),
        h('tbody', null, gaps.map((r) => h('tr', null, h('th', { scope: 'row', text: String(r.year) }), vars.map((v) => h('td', { class: 'num', text: fmt.int(r[v] || 0) + (r[v] > limit ? ' *' : '') }))))),
      ),
      h('p', { class: 'hint', text: t('qc.strip.tableNote', { limit: fmt.int(limit) }) }),
    );
  }
}

function paintChecks(ctx) {
  const { state, t, tn, fmt } = ctx;
  const checks = sortChecks(state.dataset.qc && state.dataset.qc.checks);
  const have = new Set(availableVariables(state.dataset));
  const box = $('qc-checks');
  if (!checks.length) return replace(box, h('p', { class: 'hint', text: t('qc.checks.none') }));
  replace(
    box,
    checks.map((c) => {
      const found = c.count > 0;
      const sev = found ? (['error', 'warning', 'info'].includes(c.severity) ? c.severity : 'info') : 'passed';
      const records = c.records || [];
      return h(
        'details',
        { class: 'check' },
        h(
          'summary',
          null,
          h('span', { class: 'sev sev-' + sev }, icon(SEV_ICON[sev]), t('qc.severity.' + sev)),
          h('span', { class: 'check-title', text: c.title || c.id }),
          h('span', { class: 'check-count', text: found ? tn('qc.records', c.count, { n: fmt.int(c.count) }) : t('qc.records.none') }),
        ),
        h(
          'div',
          { class: 'check-body' },
          h('p', { text: c.description || '' }),
          !found ? h('p', { class: 'hint', text: t('qc.check.passed', { severity: t('qc.severity.' + (c.severity || 'info')) }) }) : null,
          found && records.length
            ? h(
                'div',
                { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': t('qc.check.tableLabel', { title: c.title || c.id }) },
                h(
                  'table',
                  null,
                  h(
                    'thead',
                    null,
                    h('tr', null, h('th', { scope: 'col', text: t('common.date') }), h('th', { scope: 'col', text: t('common.variable') }), h('th', { scope: 'col', class: 'num', text: t('common.value') }), h('th', { scope: 'col', text: t('common.detail') }), h('th', { scope: 'col', text: t('qc.check.chart') })),
                  ),
                  h(
                    'tbody',
                    null,
                    records.map((r) =>
                      h(
                        'tr',
                        null,
                        h('th', { scope: 'row', text: r.date ? fmt.date(r.date) : '' }),
                        h('td', { text: r.variable ? fmt.variable(r.variable) : '' }),
                        h('td', { class: 'num', text: r.value == null ? t('common.noValue') : fmt.num(r.value, 1) }),
                        h('td', { text: r.detail || '' }),
                        h(
                          'td',
                          null,
                          r.date && have.has(r.variable)
                            ? h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('qc.check.showAria', { date: fmt.date(r.date) }), onclick: () => loadDaily(ctx, r.variable, isoToDay(r.date)) }, t('qc.check.show'))
                            : null,
                        ),
                      ),
                    ),
                  ),
                ),
              )
            : null,
          found && c.count > records.length ? h('p', { class: 'hint', text: t('qc.check.capped', { shown: fmt.int(records.length), total: fmt.int(c.count) }) }) : null,
        ),
      );
    }),
  );
}

function paintNotes(ctx) {
  const { state, t } = ctx;
  const notes = (state.dataset.notes || []).map((n) => (typeof n === 'string' ? n : n && n.message)).filter(Boolean);
  const box = $('qc-notes');
  if (notes.length) replace(box, h('p', null, h('strong', { text: t('qc.notes.heading') })), h('ul', { class: 'skipped-list' }, notes.map((n) => h('li', { text: n }))));
  show(box, notes.length > 0);
}

// ---------- thresholds: change a limit and run the checks again, without sending the data again ----------

const settingLabel = (ctx, key) => (ctx.i18n.has('qc.setting.' + key) ? ctx.t('qc.setting.' + key) : key.replace(/_/g, ' '));

function paintThresholds(ctx) {
  const { state, t, fmt } = ctx;
  const panel = $('qc-thresholds');
  const settings = state.dataset.qc && state.dataset.qc.settings;
  if (!settings || typeof settings !== 'object' || !Object.keys(settings).length) return show(panel, false);
  const defaults = state.qcDefaults || {};
  replace(
    $('qc-thresholds-fields'),
    Object.keys(settings).map((key) => {
      const id = 'qcs-' + key;
      const value = settings[key];
      if (typeof value === 'boolean') {
        const box = h('input', { type: 'checkbox', id, 'data-setting': key, 'data-kind': 'boolean' });
        box.checked = value;
        return h('div', { class: 'field field-check' }, box, h('label', { for: id, text: settingLabel(ctx, key) }));
      }
      const input = h('input', { type: 'number', id, step: 'any', inputmode: 'decimal', autocomplete: 'off', 'data-setting': key, 'data-kind': Number.isInteger(defaults[key] ?? value) ? 'integer' : 'number' });
      input.value = String(value);
      return h(
        'div',
        { class: 'field' },
        h('label', { for: id }, settingLabel(ctx, key), defaults[key] !== undefined ? h('span', { class: 'unit', text: ' (' + t('qc.thresholds.defaultValue', { value: fmt.num(defaults[key], 3) }) + ')' }) : null),
        input,
      );
    }),
  );
  $('btn-qc-defaults').disabled = !state.qcDefaults;
  show(panel, true);
}

function readThresholds(ctx) {
  const out = {};
  for (const el of $('qc-thresholds-fields').querySelectorAll('[data-setting]')) {
    const key = el.getAttribute('data-setting');
    const kind = el.getAttribute('data-kind');
    if (kind === 'boolean') out[key] = el.checked;
    else {
      const v = Number(el.value);
      if (el.value.trim() === '' || !Number.isFinite(v) || (kind === 'integer' && !Number.isInteger(v))) {
        el.setAttribute('aria-invalid', 'true');
        el.focus();
        return { error: ctx.t('qc.thresholds.invalid', { label: settingLabel(ctx, key) }) };
      }
      el.removeAttribute('aria-invalid');
      out[key] = v;
    }
  }
  return { values: out };
}

let rerunning = false;
async function rerunChecks(ctx, values) {
  const { state, t, api } = ctx;
  if (rerunning || !state.dataset) return;
  const ds = state.dataset;
  rerunning = true;
  $('btn-qc-rerun').disabled = true;
  thresholdStatus.busy(t('qc.thresholds.busy'), { slowAfter: 15, slowText: t('load.status.slow') });
  try {
    const qc = await api.rerunQc(ds.id, values, {
      onEvent: (ev) => {
        if (ev.type === 'retry') thresholdStatus.retrying(ev);
        else if (ev.type === 'attempt') thresholdStatus.attempt();
      },
    });
    if (state.dataset !== ds) return;
    ds.qc = qc;
    daily.flags = flaggedForVariable(qc.checks, daily.variable);
    daily.capped = cappedAt(qc.checks, daily.variable);
    render(ctx);
    $('qc-thresholds').open = true;
    const doneText = t(state.demo ? 'demo.thresholds' : 'qc.thresholds.done');
    thresholdStatus.ok(doneText);
    ctx.announce(doneText + ' ' + $('qc-verdict').textContent);
  } catch (err) {
    if (err && err.expired) {
      thresholdStatus.clear();
      ctx.markExpired();
    } else {
      const d = ctx.describeError(err);
      thresholdStatus.error(d.message, { details: d.details, hint: d.hint, actions: [{ label: t('common.retry'), onClick: () => rerunChecks(ctx, values), primary: true }] });
    }
  } finally {
    rerunning = false;
    $('btn-qc-rerun').disabled = false;
  }
}

export function render(ctx) {
  const { state, t, fmt } = ctx;
  const ds = state.dataset;
  if (!ds) return;
  if (daily.datasetId !== ds.id) {
    resetDaily();
    daily.datasetId = ds.id;
  }
  $('qc-lead').textContent = t('qc.lead', { name: ctx.stationName() });
  paintVerdict(ctx);
  paintTiles(ctx);
  paintStrip(ctx);
  paintChecks(ctx);
  paintNotes(ctx);
  paintThresholds(ctx);

  const select = $('daily-variable');
  const current = select.value;
  const vars = availableVariables(ds);
  replace(select, vars.map((v) => h('option', { value: v }, fmt.variable(v))));
  select.value = vars.includes(daily.variable) ? daily.variable : vars.includes(current) ? current : vars.includes('tasmax') ? 'tasmax' : vars[0] || '';
  $('btn-daily-load').disabled = !vars.length;
  if (daily.chart) {
    daily.chart.draw();
    paintReadout(ctx, -1);
    paintRange(ctx);
  }
}
