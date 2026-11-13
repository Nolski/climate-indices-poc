// Step 4: one card per index (chart, trend in plain words, statistics, table), a comparison
// chart, the settings used, and the downloads.

import { $, h, replace, icon, show, createStatus, saveBlob, saveText } from './dom.js';
import { attachChart, exportSvg, svgToPng } from './chart.js';
import { resultSeries, alignSeries, trendVerdict, resultToCsv, safeFileName, orderResults, defaultComparePair } from './shape.js';
import { validationBadge } from './view-indices.js';

let charts = [];
let downloadStatus = null;
let compare = { a: '', b: '', auto: true };
let downloading = false;

const EXT = { zip: 'zip', netcdf: 'nc', json: 'json' };

export function init(ctx) {
  downloadStatus = createStatus($('download-status'), ctx);
  for (const id of ['btn-dl-zip', 'btn-dl-netcdf', 'btn-dl-json']) {
    $(id).addEventListener('click', (ev) => download(ctx, ev.currentTarget.getAttribute('data-format')));
  }
  $('compare-a').addEventListener('change', (ev) => {
    compare.a = ev.target.value;
    compare.auto = false;
    paintCompare(ctx);
  });
  $('compare-b').addEventListener('change', (ev) => {
    compare.b = ev.target.value;
    compare.auto = false;
    paintCompare(ctx);
  });
  $('results-jump').addEventListener('change', (ev) => {
    const card = document.getElementById('result-' + ev.target.value);
    if (!card) return;
    const heading = card.querySelector('h5');
    if (card.scrollIntoView) card.scrollIntoView({ block: 'start' });
    if (heading) heading.focus();
  });
}

const freqLabel = (ctx) => ctx.t('frequency.' + ctx.state.frequency);

function baseName(ctx, suffix) {
  return safeFileName(ctx.stationName()) + '_' + suffix;
}

function exportMeta(ctx) {
  const { state, t, fmt } = ctx;
  const r = state.result;
  const v = state.version;
  const base = r.base_period ? t('results.settings.base') + ' ' + r.base_period.start + '–' + r.base_period.end : '';
  return {
    subtitle: [ctx.stationName(), freqLabel(ctx), base, state.demo ? t('demo.exportTag') : ''].filter(Boolean).join(' · '),
    footer: [t('app.title'), v ? t('footer.versions', { app: v.app, xclim: v.xclim, python: v.python }) : '', state.computedAt ? fmt.dateTime(new Date(state.computedAt)) : '']
      .filter(Boolean)
      .join(' · '),
  };
}

async function saveChart(ctx, spec, name, kind, statusEl) {
  const svg = exportSvg({ ...spec, ...exportMeta(ctx) });
  try {
    if (kind === 'svg') saveText(svg, name + '.svg', 'image/svg+xml');
    else saveBlob(await svgToPng(svg), name + '.png');
    statusEl.textContent = ctx.t('results.saved', { name: name + '.' + kind });
  } catch {
    statusEl.textContent = ctx.t('results.pngFailed');
  }
}

async function download(ctx, format) {
  const { state, t, fmt, api } = ctx;
  if (downloading || !state.result || !state.dataset) return;
  const ids = (state.result.results || []).map((r) => r.id);
  const name = baseName(ctx, 'indices_' + state.frequency + '.' + (EXT[format] || format));
  if (api.fixtures) {
    if (format === 'json') {
      saveText(JSON.stringify({ demonstration: true, note: t('demo.results'), station: state.dataset.station, period: state.dataset.period, ...state.result }, null, 1), name, 'application/json');
      downloadStatus.ok(t('results.download.done', { name, size: '' }).trim());
    } else downloadStatus.error(t('error.fixturesNoExport'));
    return;
  }
  downloading = true;
  downloadStatus.busy(t('results.download.preparing'), { slowAfter: 15, slowText: t('results.download.slow') });
  try {
    const file = await api.exportFile(
      state.dataset.id,
      { format, frequency: state.frequency, indices: ids },
      {
        onEvent: (ev) => {
          if (ev.type === 'retry') downloadStatus.retrying(ev);
          else if (ev.type === 'attempt') downloadStatus.attempt();
        },
      },
    );
    const finalName = file.filename || name;
    saveBlob(file.blob, finalName);
    downloadStatus.ok(t('results.download.done', { name: finalName, size: fmt.bytes(file.blob.size) }));
  } catch (err) {
    if (err && err.expired) {
      downloadStatus.clear();
      ctx.markExpired('compute');
    } else {
      const d = ctx.describeError(err);
      downloadStatus.error(d.message, { details: d.details, hint: d.hint, actions: [{ label: t('common.retry'), onClick: () => download(ctx, format), primary: true }] });
    }
  } finally {
    downloading = false;
  }
}

// The trend, said so that a reader who is not a statistician can use it.
function trendBlock(ctx, result) {
  const { t, fmt } = ctx;
  const tr = result.trend;
  const v = trendVerdict(tr);
  const unit = fmt.unitChange(result.units);
  if (v.kind === 'none') {
    return h('div', { class: 'trend' }, h('p', { class: 'trend-main', text: t('trend.none') }));
  }
  const range = tr.lower != null && tr.upper != null ? t('trend.range', { lower: fmt.signed(tr.lower), upper: fmt.signed(tr.upper) }) : '';
  let main;
  if (v.kind === 'untestable') main = t('trend.untestable', { slope: fmt.signed(tr.slope_per_decade), unit });
  else if (v.kind === 'flat') main = t('trend.flat', { unit });
  else main = t('trend.' + v.kind, { slope: fmt.sig(Math.abs(tr.slope_per_decade)), unit });
  let sub = '';
  if (v.kind !== 'untestable') sub = t(v.significant ? 'trend.significant' : 'trend.notSignificant', { p: fmt.pValue(tr.p_value) });
  return h(
    'div',
    { class: 'trend' + (v.significant ? ' is-sig' : '') },
    h('p', { class: 'trend-main', text: main + (range ? ' ' + range : '') }),
    sub ? h('p', { class: 'trend-sub', text: sub }) : null,
    h('p', { class: 'trend-method', text: t('trend.method', { n: fmt.int(tr.n) }) }),
  );
}

function statsList(ctx, result, series) {
  const { t, fmt } = ctx;
  const s = result.stats || {};
  const unit = fmt.unit(result.units);
  const val = (v) => (v == null ? t('common.noValue') : fmt.num(v, 2) + ' ' + unit);
  const item = (k, v) => h('li', null, h('span', { class: 'k', text: k }), h('span', { class: 'v', text: v }));
  return h(
    'ul',
    { class: 'stats' },
    item(t('stats.n'), t('stats.nValue', { n: fmt.int(s.n != null ? s.n : series.nValid), total: fmt.int(series.time.length) })),
    item(t('stats.mean'), val(s.mean)),
    item(t('stats.min'), val(s.min)),
    item(t('stats.max'), val(s.max)),
  );
}

function resultSpec(ctx, result, series) {
  const { t, fmt } = ctx;
  const unit = fmt.unit(result.units);
  const lines = [{ type: 'line', x: series.x, y: series.y, color: 'c1', marker: 'circle', label: result.name, track: true }];
  if (series.trend) lines.push({ type: 'line', x: series.trend.x, y: series.trend.y, color: 'trend', dash: 'trend', label: t('chart.trend') });
  return {
    kind: 'year',
    xPad: series.monthly ? 1 / 12 : 0.5,
    cursorX: series.x,
    title: result.name + ': ' + (result.long_name || ''),
    ariaLabel: t('results.chartAria', { name: result.name, long: result.long_name || '', first: series.time[0] || '', last: series.time[series.time.length - 1] || '' }),
    missingLabel: series.missing.length ? t('chart.noValueLegend') : '',
    emptyLabel: t('chart.empty'),
    formatY: (v, d) => fmt.num(v, d, d),
    formatTick: fmt.tick,
    panels: [{ unit, series: lines, missingX: series.missing.map((i) => series.x[i]) }],
  };
}

function resultTable(ctx, result, series) {
  const { t, fmt } = ctx;
  const unit = fmt.unit(result.units);
  return h(
    'div',
    { class: 'table-scroll', tabindex: '0', role: 'region', 'aria-label': t('results.tableAria', { name: result.name }) },
    h(
      'table',
      null,
      h('caption', { text: result.name + ': ' + (result.long_name || '') + ' (' + unit + ')' }),
      h('thead', null, h('tr', null, h('th', { scope: 'col', text: series.monthly ? t('common.month') : t('common.year') }), h('th', { scope: 'col', class: 'num', text: t('common.value') + ' (' + unit + ')' }), series.trend ? h('th', { scope: 'col', class: 'num', text: t('chart.trend') }) : null)),
      h(
        'tbody',
        null,
        series.time.map((key, i) =>
          h(
            'tr',
            null,
            h('th', { scope: 'row', text: fmt.timeKey(key) }),
            h('td', { class: 'num', text: series.y[i] == null ? t('chart.noValue') : fmt.num(series.y[i], 2) }),
            series.trend ? h('td', { class: 'num', text: fmt.num(series.trend.at(series.x[i]), 2) }) : null,
          ),
        ),
      ),
    ),
  );
}

// An index that is 0 (or has no value) in every period gets a sentence instead of a flat chart.
function flatCard(ctx, result, info, flat) {
  const { t, fmt } = ctx;
  const unit = fmt.unit(result.units);
  const headId = 'rh-' + result.id;
  const period = t(ctx.state.frequency === 'monthly' ? 'results.flat.month' : 'results.flat.year');
  const note = flat === 'missing' ? t('results.flat.missing', { period }) : t(result.units === 'days' ? 'results.flat.zeroDays' : 'results.flat.zero', { period });
  const name = baseName(ctx, result.id + '_' + ctx.state.frequency);
  const saved = h('span', { class: 'hint', role: 'status' });
  return h(
    'article',
    { class: 'card result-card result-flat', id: 'result-' + result.id, 'aria-labelledby': headId },
    h(
      'div',
      { class: 'result-head' },
      h('h5', { id: headId, tabindex: '-1', text: result.name || result.id }),
      h('span', { class: 'result-long', text: (result.long_name || '') + ' (' + unit + ')' }),
      info ? validationBadge(ctx, info) : null,
    ),
    h('p', { class: 'flat-note', text: note }),
    h(
      'div',
      { class: 'card-actions' },
      h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('results.csvAria', { name: result.name }), onclick: () => {
        saveText(resultToCsv(result), name + '.csv', 'text/csv');
        saved.textContent = t('results.saved', { name: name + '.csv' });
      } }, icon('download'), 'CSV'),
      saved,
    ),
  );
}

function resultCard(ctx, result, info) {
  const { t, fmt } = ctx;
  const series = resultSeries(result);
  const unit = fmt.unit(result.units);
  const headId = 'rh-' + result.id;
  const chartHost = h('div', { class: 'chart', tabindex: '0', role: 'group', 'aria-label': t('results.chartLabel', { name: result.name }) });
  const readout = h('p', { class: 'readout', 'aria-live': 'polite' });
  const tableHost = h('div', { hidden: true });
  const saved = h('span', { class: 'hint', role: 'status' });
  const spec = () => resultSpec(ctx, result, series);

  const paintReadout = (i) => {
    if (i < 0) return replace(readout, t('chart.hint'));
    const v = series.y[i];
    replace(
      readout,
      fmt.timeKey(series.time[i]) + ': ',
      h('strong', { text: v == null ? t('chart.noValue') : fmt.num(v, 2) + ' ' + unit }),
      series.trend ? ' · ' + t('chart.trendAt', { value: fmt.num(series.trend.at(series.x[i]), 2) }) : '',
    );
  };

  let tableBuilt = false;
  const toggle = h('button', { type: 'button', class: 'btn btn-small' }, icon('table'), h('span', { text: t('results.showTable') }));
  toggle.addEventListener('click', () => {
    const showTable = tableHost.hidden;
    if (showTable && !tableBuilt) {
      replace(tableHost, resultTable(ctx, result, series));
      tableBuilt = true;
    }
    show(tableHost, showTable);
    show(chartHost, !showTable);
    show(readout, !showTable);
    replace(toggle, icon(showTable ? 'chart' : 'table'), h('span', { text: t(showTable ? 'results.showChart' : 'results.showTable') }));
  });

  const name = baseName(ctx, result.id + '_' + ctx.state.frequency);
  const card = h(
    'article',
    { class: 'card result-card', id: 'result-' + result.id, 'aria-labelledby': headId },
    h(
      'div',
      { class: 'result-head' },
      h('h5', { id: headId, tabindex: '-1', text: result.name || result.id }),
      h('span', { class: 'result-long', text: (result.long_name || '') + ' (' + unit + ')' }),
      info ? validationBadge(ctx, info) : null,
    ),
    info && info.description ? h('p', { class: 'result-desc', text: info.description }) : null,
    chartHost,
    readout,
    tableHost,
    trendBlock(ctx, result),
    statsList(ctx, result, series),
    h(
      'div',
      { class: 'card-actions' },
      toggle,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('results.csvAria', { name: result.name }), onclick: () => {
        saveText(resultToCsv(result), name + '.csv', 'text/csv');
        saved.textContent = t('results.saved', { name: name + '.csv' });
      } }, icon('download'), 'CSV'),
      h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('results.pngAria', { name: result.name }), onclick: () => saveChart(ctx, spec(), name, 'png', saved) }, icon('download'), 'PNG'),
      h('button', { type: 'button', class: 'btn btn-small', 'aria-label': t('results.svgAria', { name: result.name }), onclick: () => saveChart(ctx, spec(), name, 'svg', saved) }, icon('download'), 'SVG'),
    ),
    saved,
  );
  paintReadout(-1);
  // Mounted by render() once the card is in the document, so the chart is drawn at its real width.
  return { card, mount: () => charts.push(attachChart(chartHost, spec, { onCursor: paintReadout })) };
}

let compareChart = null;
function paintCompare(ctx) {
  const { state, t, fmt } = ctx;
  const results = state.result.results || [];
  const a = results.find((r) => r.id === compare.a);
  const b = results.find((r) => r.id === compare.b);
  const host = $('compare-chart');
  const readout = $('compare-readout');
  const note = $('compare-note');
  if (compareChart) compareChart.destroy();
  compareChart = null;
  if (!a || !b) {
    replace(host);
    replace(readout);
    note.textContent = t('results.compare.needTwo');
    return;
  }
  const al = alignSeries(a, b);
  const sameUnits = a.units === b.units;
  const monthly = al.time.length > 0 && al.time[0].length >= 7;
  const sa = { type: 'line', x: al.x, y: al.ya, color: 'c1', marker: 'circle', label: a.name, track: true };
  const sb = { type: 'line', x: al.x, y: al.yb, color: 'c2', marker: 'square', dash: 'alt', label: b.name, track: true };
  note.textContent = a.id === b.id ? t('results.compare.same') : sameUnits ? t('results.compare.shared', { unit: fmt.unit(a.units) }) : t('results.compare.separate');
  const spec = () => ({
    kind: 'year',
    xPad: monthly ? 1 / 12 : 0.5,
    cursorX: al.x,
    panelHeight: sameUnits ? 220 : 150,
    exportPanelHeight: sameUnits ? 300 : 190,
    title: a.name + ' / ' + b.name,
    ariaLabel: t('results.compare.aria', { a: a.name, b: b.name }),
    emptyLabel: t('chart.empty'),
    formatY: (v, d) => fmt.num(v, d, d),
    formatTick: fmt.tick,
    panels: sameUnits
      ? [{ unit: fmt.unit(a.units), series: a.id === b.id ? [sa] : [sa, sb] }]
      : [
          { unit: a.name + ' (' + fmt.unit(a.units) + ')', series: [sa] },
          { unit: b.name + ' (' + fmt.unit(b.units) + ')', series: [sb] },
        ],
  });
  const paint = (i) => {
    if (i < 0) return replace(readout, t('chart.hint'));
    const val = (r, v) => (v == null ? t('chart.noValue') : fmt.num(v, 2) + ' ' + fmt.unit(r.units));
    replace(readout, fmt.timeKey(al.time[i]) + ': ', a.name + ' ', h('strong', { text: val(a, al.ya[i]) }), ' · ' + b.name + ' ', h('strong', { text: val(b, al.yb[i]) }));
  };
  compareChart = attachChart(host, spec, { onCursor: paint });
  paint(-1);
}

function paintSettings(ctx) {
  const { state, t, tn, fmt } = ctx;
  const r = state.result;
  const ds = state.dataset;
  const st = (ds && ds.station) || {};
  const mp = r.missing_policy || {};
  const v = state.version;
  const item = (k, val, wide) => h('div', wide ? { class: 'wide' } : null, h('dt', { text: k }), h('dd', { text: val }));
  let policy = mp.id || t('common.notGiven');
  if (mp.max_missing_days_per_year != null && mp.max_missing_days_per_month != null) {
    policy = t('results.settings.policyText', { id: mp.id || '', year: fmt.int(mp.max_missing_days_per_year), month: fmt.int(mp.max_missing_days_per_month) });
  }
  replace(
    $('results-settings'),
    item(t('results.settings.station'), ctx.stationName() || t('common.notGiven')),
    item(t('results.settings.location'), st.latitude == null ? t('common.notGiven') : t('load.loaded.locationValue', { lat: fmt.num(st.latitude, 4), lon: fmt.num(st.longitude, 4) })),
    item(t('results.settings.record'), ds ? t('load.loaded.recordValue', { start: fmt.date(ds.period.start), end: fmt.date(ds.period.end), days: tn('common.days', ds.period.n_days, { n: fmt.int(ds.period.n_days) }) }) : ''),
    item(t('results.settings.base'), r.base_period ? r.base_period.start + '–' + r.base_period.end : t('common.notGiven')),
    item(t('results.settings.frequency'), freqLabel(ctx)),
    item(t('results.settings.policy'), policy, true),
    item(t('results.settings.trend'), t('results.settings.trendText'), true),
    item(t('results.settings.computed'), state.demo ? t('demo.computed') : (state.computedAt ? fmt.dateTime(new Date(state.computedAt)) : t('common.notGiven')) + (r.elapsed_ms > 0 ? ' (' + fmt.seconds(r.elapsed_ms) + ')' : '')),
    item(t('results.settings.software'), v ? t('footer.versions', { app: v.app, xclim: v.xclim, python: v.python }) : t('footer.versionsUnknown')),
  );
}

export function render(ctx) {
  const { state, t, tn, fmt } = ctx;
  const r = state.result;
  if (!r) return;
  for (const c of charts) c.destroy();
  charts = [];
  const results = r.results || [];
  const byId = new Map((state.indices || []).map((ix) => [ix.id, ix]));

  $('results-summary').textContent = tn('results.summary', results.length, { n: fmt.int(results.length), name: ctx.stationName(), frequency: freqLabel(ctx) });
  // Demonstration: say plainly that nothing was calculated just now, and switch off the two
  // downloads that only the server can make.
  const demo = Boolean(state.demo);
  $('results-demo').textContent = demo ? t('demo.results') : '';
  show($('results-demo'), demo);
  $('download-demo').textContent = demo ? t('demo.downloads') : '';
  show($('download-demo'), demo);
  $('btn-dl-zip').disabled = demo;
  $('btn-dl-netcdf').disabled = demo;

  const skipped = r.skipped || [];
  const skipBox = $('results-skipped');
  if (skipped.length) {
    replace(
      skipBox,
      h('h3', null, icon('warning', 'tone-warn'), ' ', tn('results.skipped.heading', skipped.length, { n: fmt.int(skipped.length) })),
      h('ul', { class: 'skipped-list' }, skipped.map((s) => h('li', null, h('strong', { text: (byId.get(s.id) && byId.get(s.id).name) || s.id }), ': ' + (s.reason || '')))),
    );
  }
  show(skipBox, skipped.length > 0);

  paintSettings(ctx);

  const ordered = orderResults(results, state.indices);
  const options = () => ordered.map(({ result: x }) => h('option', { value: x.id }, x.name + ': ' + (x.long_name || '')));
  const ids = results.map((x) => x.id);
  if (!ids.includes(compare.a) || !ids.includes(compare.b) || compare.auto) {
    [compare.a, compare.b] = defaultComparePair(results);
    compare.auto = true;
  }
  replace($('compare-a'), options());
  replace($('compare-b'), options());
  $('compare-a').value = compare.a;
  $('compare-b').value = compare.b;
  paintCompare(ctx);

  const jump = $('results-jump');
  replace(jump, h('option', { value: '' }, t('results.jumpChoose')), options());
  jump.value = '';

  const cards = $('results-cards');
  if (!results.length) replace(cards, h('p', { class: 'notice notice-warning', text: t('results.none') }));
  else {
    // One heading per group; inside a group the indices with nothing to chart come last.
    const nodes = [];
    const mounts = [];
    let group = null;
    for (const row of ordered) {
      if (row.group !== group) {
        group = row.group;
        if (group) nodes.push(h('h4', { class: 'group-head', text: ctx.i18n.has('group.' + group) ? t('group.' + group) : group }));
      }
      if (row.flat) nodes.push(flatCard(ctx, row.result, byId.get(row.result.id), row.flat));
      else {
        const built = resultCard(ctx, row.result, byId.get(row.result.id));
        nodes.push(built.card);
        mounts.push(built.mount);
      }
    }
    replace(cards, nodes);
    for (const mount of mounts) mount();
  }
}
