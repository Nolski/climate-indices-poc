// Pure data-shaping functions: API responses in, chart series / table rows / verdicts out.
// No DOM, no network, no translation: everything here is unit-tested under Node.

export const VARIABLES = ['pr', 'tasmax', 'tasmin'];
export const GROUPS = ['temperature', 'precipitation', 'duration', 'percentile'];
export const DEFAULT_MAX_MISSING_PER_YEAR = 15;
export const SIGNIFICANCE = 0.05;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------- time ----------

// "1936" -> 1936, "1936-02" -> 1936 + 1/12 (start of the month). NaN if unreadable.
export function timeKeyToX(key) {
  const s = String(key);
  const y = Number(s.slice(0, 4));
  if (!Number.isFinite(y) || s.length < 4) return NaN;
  if (s.length >= 7) {
    const m = Number(s.slice(5, 7));
    if (!(m >= 1 && m <= 12)) return NaN;
    return y + (m - 1) / 12;
  }
  return y;
}

// "1936-02-29" -> days since 1970-01-01 (UTC).
export function isoToDay(iso) {
  const s = String(iso);
  return Math.round(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10))) / 86400000);
}

export function dayToIso(day) {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

// ---------- numbers ----------

export function cleanValue(v) {
  // The contract says missing values are null. Be defensive about NaN, strings and -99.9 anyway.
  if (!isNum(v)) return null;
  if (v === -99.9) return null;
  return Object.is(v, -0) ? 0 : v;
}

export function median(values) {
  const a = values.filter(isNum).sort((p, q) => p - q);
  if (!a.length) return null;
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function extent(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!isNum(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? null : [lo, hi];
}

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * pow;
}

// A y axis: rounded domain that contains [lo, hi] plus tick values and the decimals they need.
export function niceScale(lo, hi, target = 5) {
  if (!isNum(lo) || !isNum(hi)) return { min: 0, max: 1, step: 0.5, ticks: [0, 0.5, 1], decimals: 1 };
  if (lo === hi) {
    const pad = Math.abs(lo) > 1 ? Math.abs(lo) * 0.1 : 1;
    lo -= pad;
    hi += pad;
  }
  const step = niceStep((hi - lo) / Math.max(1, target));
  const min = Math.floor(lo / step + 1e-9) * step;
  const max = Math.ceil(hi / step - 1e-9) * step;
  const ticks = [];
  for (let i = 0; i <= Math.round((max - min) / step); i++) ticks.push(Number((min + i * step).toPrecision(12)));
  let decimals = 0;
  while (decimals < 6 && Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-9) decimals += 1;
  return { min, max, step, ticks, decimals };
}

const YEAR_STEPS = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500];
const MONTH_STEPS = [1, 2, 3, 6];
const DAY_STEPS = [1, 2, 5, 7, 14];

// Ticks for a time axis. kind "year": x is a decimal year. kind "day": x is a day number.
// Returns [{ x, level: 'year'|'month'|'day', y, m, d }]; the caller formats the labels.
export function timeTicks(kind, x0, x1, maxTicks = 8) {
  const out = [];
  maxTicks = Math.max(2, maxTicks);
  if (!(x1 > x0)) return out;
  if (kind === 'year') {
    const span = x1 - x0;
    const step = YEAR_STEPS.find((s) => span / s <= maxTicks) || 1000;
    for (let y = Math.ceil(x0 / step - 1e-9) * step; y <= x1 + 1e-9; y += step) out.push({ x: y, level: 'year', y });
    return out;
  }
  const d0 = new Date(x0 * 86400000);
  const spanDays = x1 - x0;
  if (spanDays > 365.25 * 2.5) {
    const spanY = spanDays / 365.25;
    const step = YEAR_STEPS.find((s) => spanY / s <= maxTicks) || 1000;
    for (let y = Math.ceil(d0.getUTCFullYear() / step) * step; ; y += step) {
      const x = Date.UTC(y, 0, 1) / 86400000;
      if (x > x1) break;
      if (x >= x0) out.push({ x, level: 'year', y });
    }
    return out;
  }
  if (spanDays > 100) {
    const spanM = spanDays / 30.44;
    const step = MONTH_STEPS.find((s) => spanM / s <= maxTicks) || 12;
    let y = d0.getUTCFullYear();
    let m = Math.ceil(d0.getUTCMonth() / step) * step;
    for (;;) {
      if (m > 11) {
        y += Math.floor(m / 12);
        m %= 12;
      }
      const x = Date.UTC(y, m, 1) / 86400000;
      if (x > x1) break;
      if (x >= x0) out.push({ x, level: 'month', y, m: m + 1 });
      m += step;
    }
    return out;
  }
  const step = DAY_STEPS.find((s) => spanDays / s <= maxTicks) || 30;
  for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
    const d = new Date(x * 86400000);
    out.push({ x, level: 'day', y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() });
  }
  return out;
}

// ---------- series ----------

// Runs of consecutive non-null values, as [startIndex, endIndex] pairs. Nulls become gaps.
export function segments(y) {
  const out = [];
  let start = -1;
  for (let i = 0; i < y.length; i++) {
    if (y[i] == null) {
      if (start >= 0) out.push([start, i - 1]);
      start = -1;
    } else if (start < 0) start = i;
  }
  if (start >= 0) out.push([start, y.length - 1]);
  return out;
}

// Index of the value in sorted array xs nearest to x.
export function nearestIndex(xs, x) {
  let lo = 0;
  let hi = xs.length - 1;
  if (hi < 0) return -1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(xs[lo] - x) <= Math.abs(xs[hi] - x) ? lo : hi;
}

// First index with xs[i] >= x.
export function lowerBound(xs, x) {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Reduce a long series to at most 2 points per bucket (the minimum and the maximum, in time
// order), so that a 30,000-day record draws as fast as a 1,000-point one and no extreme is lost.
// Every output point is a real observation. A bucket with no valid value becomes a gap.
export function decimate(x, y, i0, i1, buckets) {
  i0 = Math.max(0, i0);
  i1 = Math.min(x.length - 1, i1);
  const n = i1 - i0 + 1;
  const ox = [];
  const oy = [];
  if (n <= 0) return { x: ox, y: oy, decimated: false };
  if (n <= buckets * 2) {
    for (let i = i0; i <= i1; i++) {
      ox.push(x[i]);
      oy.push(y[i]);
    }
    return { x: ox, y: oy, decimated: false };
  }
  const size = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = i0 + Math.floor(b * size);
    const e = Math.min(i1, i0 + Math.floor((b + 1) * size) - 1);
    let mn = -1;
    let mx = -1;
    for (let i = s; i <= e; i++) {
      const v = y[i];
      if (v == null) continue;
      if (mn < 0 || v < y[mn]) mn = i;
      if (mx < 0 || v > y[mx]) mx = i;
    }
    if (mn < 0) {
      ox.push(x[s]);
      oy.push(null);
      continue;
    }
    const a = Math.min(mn, mx);
    const c = Math.max(mn, mx);
    ox.push(x[a]);
    oy.push(y[a]);
    if (c !== a) {
      ox.push(x[c]);
      oy.push(y[c]);
    }
  }
  return { x: ox, y: oy, decimated: true };
}

// Sen's line through the data: slope from the API (per decade), intercept as the median of
// (y - slope * x) over the valid points, which is the usual companion estimate.
export function senLine(x, y, slopePerDecade) {
  if (!isNum(slopePerDecade)) return null;
  const slope = slopePerDecade / 10;
  const resid = [];
  let first = -1;
  let last = -1;
  for (let i = 0; i < x.length; i++) {
    if (y[i] == null || !isNum(x[i])) continue;
    resid.push(y[i] - slope * x[i]);
    if (first < 0) first = i;
    last = i;
  }
  if (resid.length < 2) return null;
  const intercept = median(resid);
  const at = (xv) => intercept + slope * xv;
  return { slope, intercept, at, x: [x[first], x[last]], y: [at(x[first]), at(x[last])] };
}

// One compute result -> everything the chart, the table and the read-out need.
export function resultSeries(result) {
  const time = Array.isArray(result.time) ? result.time : [];
  const raw = Array.isArray(result.values) ? result.values : [];
  const x = time.map(timeKeyToX);
  const y = time.map((_, i) => cleanValue(raw[i]));
  const missing = [];
  for (let i = 0; i < y.length; i++) if (y[i] == null) missing.push(i);
  const monthly = time.length > 0 && String(time[0]).length >= 7;
  const trend = result.trend && isNum(result.trend.slope_per_decade) ? senLine(x, y, result.trend.slope_per_decade) : null;
  return { time, x, y, missing, monthly, trend, nValid: y.length - missing.length };
}

// 'missing' when no period has a value, 'zero' when every value is 0, otherwise ''.
// (An index that is 0 every year, such as frost days at a tropical station, is a correct
// result but a flat line tells the reader nothing, so the page shows a sentence instead.)
export function flatKind(result) {
  let valid = 0;
  for (const raw of result.values || []) {
    const v = cleanValue(raw);
    if (v === null) continue;
    if (v !== 0) return '';
    valid += 1;
  }
  return valid ? 'zero' : 'missing';
}

// Display order for results: grouped as in the index list, API order inside a group, with the
// flat ones (all zero or all missing) moved to the end of their group.
export function orderResults(results, indices) {
  const groupOf = new Map((indices || []).map((ix) => [ix.id, ix.group]));
  const order = [...GROUPS];
  const rows = (results || []).map((result, i) => {
    const group = groupOf.get(result.id) || '';
    if (!order.includes(group)) order.push(group);
    return { result, group, flat: flatKind(result), i };
  });
  rows.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || (a.flat ? 1 : 0) - (b.flat ? 1 : 0) || a.i - b.i);
  return rows;
}

// A sensible first pair for the comparison chart: two indices that vary, preferring a familiar
// pair in the same units.
export function defaultComparePair(results) {
  const lively = (results || []).filter((r) => !flatKind(r)).map((r) => r.id);
  for (const [a, b] of [['su', 'tr'], ['txx', 'tnn'], ['txx', 'tnx'], ['rx1day', 'rx5day']]) {
    if (lively.includes(a) && lively.includes(b)) return [a, b];
  }
  const all = (results || []).map((r) => r.id);
  return [lively[0] || all[0] || '', lively[1] || lively[0] || all[1] || all[0] || ''];
}

// Two results on a shared time axis (union of their time keys, sorted).
export function alignSeries(a, b) {
  const keys = Array.from(new Set([...a.time, ...b.time])).sort();
  const ma = new Map(a.time.map((k, i) => [k, cleanValue(a.values[i])]));
  const mb = new Map(b.time.map((k, i) => [k, cleanValue(b.values[i])]));
  return {
    time: keys,
    x: keys.map(timeKeyToX),
    ya: keys.map((k) => (ma.has(k) ? ma.get(k) : null)),
    yb: keys.map((k) => (mb.has(k) ? mb.get(k) : null)),
  };
}

// ---------- trend wording ----------

// Classifies a trend so the UI can pick a plain-language sentence.
//   none        no trend object (too few values, or not calculated at this frequency)
//   untestable  slope given but no p-value (for example a series that never changes)
//   flat        slope is exactly zero
//   up / down   direction; `significant` says whether p < 0.05
export function trendVerdict(trend, alpha = SIGNIFICANCE) {
  if (!trend || !isNum(trend.slope_per_decade)) return { kind: 'none', significant: false };
  const slope = trend.slope_per_decade;
  const p = isNum(trend.p_value) ? trend.p_value : null;
  if (p === null) return { kind: 'untestable', significant: false };
  if (slope === 0) return { kind: 'flat', significant: p < alpha };
  return { kind: slope > 0 ? 'up' : 'down', significant: p < alpha };
}

// ---------- quality control ----------

export function qcVerdict(qc) {
  const s = (qc && qc.summary) || {};
  if ((s.errors || 0) > 0) return 'errors';
  if ((s.warnings || 0) > 0) return 'warnings';
  return 'clean';
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 };

// Checks that found something first (errors, then warnings, then info), then the ones that passed.
export function sortChecks(checks) {
  return [...(checks || [])].sort((a, b) => {
    const fa = a.count > 0 ? 0 : 1;
    const fb = b.count > 0 ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
  });
}

// Flagged records for one variable across all checks, sorted by date, worst severity kept per day.
export function flaggedForVariable(checks, variable) {
  const byDate = new Map();
  for (const c of checks || []) {
    for (const r of c.records || []) {
      if (r.variable !== variable || !r.date) continue;
      const prev = byDate.get(r.date);
      const item = { date: r.date, day: isoToDay(r.date), value: cleanValue(r.value), severity: c.severity, title: c.title, detail: r.detail || '' };
      if (!prev || (SEVERITY_ORDER[c.severity] ?? 3) < (SEVERITY_ORDER[prev.severity] ?? 3)) byDate.set(r.date, item);
    }
  }
  return Array.from(byDate.values()).sort((a, b) => a.day - b.day);
}

// 0 = complete, 1 = some missing but within the limit, 2 = over the limit, 3 = (nearly) the whole year.
export function missingClass(n, limit = DEFAULT_MAX_MISSING_PER_YEAR) {
  if (!(n > 0)) return 0;
  if (n <= limit) return 1;
  if (n >= 360) return 3;
  return 2;
}

export function availableVariables(dataset) {
  const vars = (dataset && dataset.variables) || {};
  const nDays = dataset && dataset.period ? dataset.period.n_days : 0;
  return VARIABLES.filter((v) => vars[v] && !(nDays > 0 && vars[v].n_missing >= nDays));
}

// Can this index be calculated from the loaded data at this frequency?
export function indexAvailability(index, dataset, frequency) {
  const have = new Set(availableVariables(dataset));
  const missingInputs = (index.inputs || []).filter((v) => !have.has(v));
  if (missingInputs.length) return { ok: false, reason: 'inputs', missingInputs };
  if (Array.isArray(index.frequencies) && !index.frequencies.includes(frequency)) {
    return { ok: false, reason: 'frequency', missingInputs: [] };
  }
  return { ok: true, reason: '', missingInputs: [] };
}

export function groupIndices(indices) {
  const groups = new Map(GROUPS.map((g) => [g, []]));
  for (const ix of indices || []) {
    if (!groups.has(ix.group)) groups.set(ix.group, []);
    groups.get(ix.group).push(ix);
  }
  return Array.from(groups, ([group, items]) => ({ group, items })).filter((g) => g.items.length);
}

// ---------- export helpers (work with no connection) ----------

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function resultToCsv(result) {
  const rows = [['index', 'time', 'value', 'units']];
  const time = result.time || [];
  for (let i = 0; i < time.length; i++) {
    const v = cleanValue(result.values[i]);
    rows.push([result.name || result.id, time[i], v == null ? '' : v, result.units || '']);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function safeFileName(name, fallback = 'station') {
  const s = String(name || '')
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

// ---------- quick look at a station file before it is uploaded ----------

const FIRST_TOKEN_NUMERIC = /^[-+]?\d+([.,]\d+)?$/;

function validDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(2000, m - 1, d));
  dt.setUTCFullYear(y, m - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function wholeNumber(token) {
  const v = Number(token);
  return token !== '' && Number.isInteger(v) ? v : null;
}

// Looks at the text of a station file in the browser and reports what a person would want to
// know before spending an upload on it. It follows the server's reading rules (spaces, tabs,
// commas or semicolons; a header line and lines starting with # are skipped; every day must be
// present once, in order) but it never blocks an upload: the server stays the authority.
//   problems: [{ line, kind, found }], kind in
//     columns | not_number | bad_date | gap | order | duplicate | binary | empty
//   notes:    [{ line, kind: 'header' }]
export function precheckStationText(text, maxProblems = 5) {
  const out = { lines: 0, rows: 0, first: null, last: null, problems: [], more: 0, notes: [] };
  if (!text || !text.trim()) {
    out.problems.push({ line: 0, kind: 'empty' });
    return out;
  }
  if (text.slice(0, 4096).includes('\u0000') || text.startsWith('PK')) {
    out.problems.push({ line: 0, kind: 'binary' });
    return out;
  }
  const add = (p) => {
    if (out.problems.length < maxProblems) out.problems.push(p);
    else out.more += 1;
  };
  const lines = text.split(/\r\n|\n|\r/);
  let delimiter = null;
  let previous = null;
  const seen = new Set();
  const split = (line, d) => (d === ' ' ? line.split(/\s+/) : line.split(d).map((t) => t.trim()));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    out.lines += 1;
    const number = i + 1;
    if (delimiter === null) {
      delimiter = line.includes(';') ? ';' : line.split(',').length === 6 ? ',' : ' ';
      if (!FIRST_TOKEN_NUMERIC.test(split(line, delimiter)[0])) {
        out.notes.push({ line: number, kind: 'header' });
        delimiter = null;
        continue;
      }
    }
    const tokens = split(line, delimiter);
    if (tokens.length !== 6) {
      add({ line: number, kind: 'columns', found: tokens.length });
      continue;
    }
    const ymd = tokens.slice(0, 3).map(wholeNumber);
    if (ymd.includes(null)) {
      add({ line: number, kind: 'not_number', found: tokens[ymd.indexOf(null)] });
      continue;
    }
    const [y, m, d] = ymd;
    if (y < 1700 || y > 2200 || !validDate(y, m, d)) {
      add({ line: number, kind: 'bad_date', found: tokens.slice(0, 3).join(' ') });
      continue;
    }
    const badValue = tokens.slice(3).find((t) => t === '' || !Number.isFinite(Number(delimiter === ',' ? t : t.replace(',', '.'))));
    if (badValue !== undefined) {
      add({ line: number, kind: 'not_number', found: badValue === '' ? ' ' : badValue });
      continue;
    }
    const iso = String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const day = isoToDay(iso);
    out.rows += 1;
    if (!out.first) out.first = iso;
    if (seen.has(day)) {
      add({ line: number, kind: 'duplicate', found: iso });
      continue;
    }
    seen.add(day);
    if (previous !== null && day < previous) {
      add({ line: number, kind: 'order', found: iso });
      continue;
    }
    if (previous !== null && day - previous > 1) add({ line: number, kind: 'gap', found: day - previous - 1 });
    previous = day;
    out.last = iso;
  }
  if (!out.rows && !out.problems.length) out.problems.push({ line: 0, kind: 'empty' });
  return out;
}
