// Unit tests for the pure logic modules. No dependencies: run with `node --test web/tests/`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createClient, createConnection, createFixtureTransport, ApiError, backoffDelay, normaliseErrorBody } from '../js/api.js';
import { createI18n, interpolate, pickLanguage } from '../js/i18n.js';
import { createFormat } from '../js/format.js';
import { safeStorage, createStore } from '../js/store.js';
import * as shape from '../js/shape.js';
import { layoutChart, renderSvg, exportSvg, esc } from '../js/chart.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(web, rel), 'utf8'));

const res = (status, body, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (body === undefined) throw new SyntaxError('no body');
    return body;
  },
  blob: async () => ({ size: 3 }),
  headers: { get: (n) => headers[n.toLowerCase()] || null },
});

// A fake fetch that plays back a script of responses / errors and records what it was asked.
function scripted(steps) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (typeof step === 'function') return step(url, init);
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetchImpl, calls };
}

const quick = { sleep: async () => {}, random: () => 0.5 };

// ---------------------------------------------------------------- API client

test('api: returns JSON on success and reports events', async () => {
  const { fetchImpl, calls } = scripted([res(200, { status: 'ok' })]);
  const events = [];
  const api = createClient({ fetchImpl, ...quick, onEvent: (e) => events.push(e.type) });
  assert.deepEqual(await api.health(), { status: 'ok' });
  assert.equal(calls[0].url, 'api/health');
  assert.deepEqual(events, ['attempt', 'success']);
});

test('api: retries a dropped connection with backoff, then succeeds', async () => {
  const { fetchImpl, calls } = scripted([new TypeError('Failed to fetch'), new TypeError('Failed to fetch'), res(200, { indices: [] })]);
  const events = [];
  const waits = [];
  const api = createClient({ fetchImpl, random: () => 0.5, sleep: async (ms) => waits.push(ms), onEvent: (e) => events.push(e) });
  assert.deepEqual(await api.indices(), { indices: [] });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
  const retries = events.filter((e) => e.type === 'retry');
  assert.equal(retries.length, 2);
  assert.deepEqual([retries[0].attempt, retries[0].of, retries[0].reason], [2, 4, 'network']);
});

test('api: gives up after the retry budget with a network error that says how often it tried', async () => {
  const { fetchImpl, calls } = scripted([new TypeError('offline')]);
  const events = [];
  const api = createClient({ fetchImpl, ...quick, onEvent: (e) => events.push(e.type) });
  await assert.rejects(api.getDataset('ds_1'), (e) => e instanceof ApiError && e.kind === 'network' && e.attempts === 4);
  assert.equal(calls.length, 4);
  assert.equal(events.at(-1), 'fail');
});

test('api: a request that hangs is cut off by the time-out and retried', async () => {
  let n = 0;
  const fetchImpl = (url, init) =>
    new Promise((resolve, reject) => {
      n += 1;
      if (n >= 2) return resolve(res(200, { ok: true }));
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  const events = [];
  const api = createClient({ fetchImpl, ...quick, onEvent: (e) => events.push(e) });
  const out = await api.request('GET', 'health', { timeout: 20, retries: 1 });
  assert.deepEqual(out, { ok: true });
  assert.equal(events.find((e) => e.type === 'retry').reason, 'timeout');
});

test('api: time-out error carries the limit when every attempt hangs', async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const api = createClient({ fetchImpl, ...quick });
  await assert.rejects(api.request('GET', 'health', { timeout: 15, retries: 1 }), (e) => e.kind === 'timeout' && e.timeoutMs === 15 && e.attempts === 2);
});

test('api: a 422 is not retried and keeps the server message and line details', async () => {
  const body = readJson('fixtures/error_validation.json');
  const { fetchImpl, calls } = scripted([res(422, body)]);
  const api = createClient({ fetchImpl, ...quick, uploadTransport: null });
  await assert.rejects(api.request('POST', 'datasets', {}), (e) => {
    assert.equal(e.kind, 'http');
    assert.equal(e.status, 422);
    assert.equal(e.code, 'invalid_station_file');
    assert.equal(e.message, body.error.message);
    assert.equal(e.details[0].line, body.error.details[0].line);
    assert.equal(e.details.length, body.error.details.length);
    assert.equal(e.serverMessage, true);
    assert.equal(e.expired, false);
    return true;
  });
  assert.equal(calls.length, 1);
});

test('api: 503 is retried, 500 is not', async () => {
  const a = scripted([res(503, undefined), res(200, { ok: 1 })]);
  assert.deepEqual(await createClient({ fetchImpl: a.fetchImpl, ...quick }).request('GET', 'x'), { ok: 1 });
  assert.equal(a.calls.length, 2);
  const b = scripted([res(500, { error: { code: 'boom', message: 'Internal error', details: [] } })]);
  await assert.rejects(createClient({ fetchImpl: b.fetchImpl, ...quick }).request('GET', 'x'), (e) => e.status === 500 && e.message === 'Internal error');
  assert.equal(b.calls.length, 1);
});

test('api: 404 on a dataset path is flagged as expired; 404 elsewhere is not', async () => {
  const nf = readJson('fixtures/error_not_found.json');
  const a = scripted([res(404, nf)]);
  const api = createClient({ fetchImpl: a.fetchImpl, ...quick });
  await assert.rejects(api.compute('ds_gone', ['txx'], 'annual'), (e) => e.expired === true && e.code === 'dataset_not_found');
  await assert.rejects(api.daily('ds_gone', 'tasmax'), (e) => e.expired === true);
  await assert.rejects(api.request('GET', 'nothing'), (e) => e.expired === false && e.status === 404);
  // the sample file not being installed is a 404 too, but it is not an expired dataset
  await assert.rejects(api.createSample({}), (e) => e.expired === false && e.status === 404);
  await assert.rejects(api.request('POST', 'datasets', {}), (e) => e.expired === false);
});

test('api: a truncated JSON body counts as a connection failure and is retried', async () => {
  const { fetchImpl, calls } = scripted([res(200, undefined), res(200, { fine: true })]);
  assert.deepEqual(await createClient({ fetchImpl, ...quick }).request('GET', 'x'), { fine: true });
  assert.equal(calls.length, 2);
});

test('api: cancelling stops at once, without retrying', async () => {
  const ctl = new AbortController();
  const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const api = createClient({ fetchImpl, ...quick });
  const p = api.request('GET', 'x', { signal: ctl.signal, timeout: 5000 });
  ctl.abort();
  await assert.rejects(p, (e) => e.kind === 'aborted');
});

test('api: cancelling during the wait between attempts stops the retry loop', async () => {
  const ctl = new AbortController();
  const { fetchImpl, calls } = scripted([new TypeError('down')]);
  const api = createClient({ fetchImpl, random: () => 0.5, backoffBase: 5000 });
  const p = api.request('GET', 'x', { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(p, (e) => e.kind === 'aborted');
  assert.equal(calls.length, 1);
});

test('api: identical compute requests in flight share one call', async () => {
  let resolve;
  let n = 0;
  const fetchImpl = () => {
    n += 1;
    return new Promise((r) => (resolve = r));
  };
  const api = createClient({ fetchImpl, ...quick });
  const p1 = api.compute('ds_1', ['txx'], 'annual');
  const p2 = api.compute('ds_1', ['txx'], 'annual');
  await new Promise((r) => setTimeout(r, 5));
  resolve(res(200, { results: [] }));
  assert.deepEqual(await p1, { results: [] });
  assert.deepEqual(await p2, { results: [] });
  assert.equal(n, 1);
});

test('api: compute sends the contract body; sample sends numbers and no name', async () => {
  const { fetchImpl, calls } = scripted([res(200, {})]);
  const api = createClient({ fetchImpl, ...quick });
  await api.compute('ds 1', ['txx', 'su'], 'monthly');
  assert.equal(calls[0].url, 'api/datasets/ds%201/compute');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { indices: ['txx', 'su'], frequency: 'monthly' });
  await api.createSample({ name: 'x', latitude: '-10', longitude: '', baseStart: '1981', baseEnd: '2010' });
  assert.deepEqual(JSON.parse(calls[1].init.body), { latitude: -10, base_start: 1981, base_end: 2010 });
});

test('api: deleting a dataset that is already gone counts as success', async () => {
  const { fetchImpl } = scripted([res(404, readJson('fixtures/error_not_found.json'))]);
  assert.equal(await createClient({ fetchImpl, ...quick }).remove('ds_1'), true);
});

test('api: export returns the blob and the file name from the server', async () => {
  const { fetchImpl, calls } = scripted([res(200, {}, { 'content-disposition': 'attachment; filename="sydney_indices.zip"' })]);
  const api = createClient({ fetchImpl, ...quick });
  const out = await api.exportFile('ds_1', { format: 'zip', frequency: 'annual', indices: ['txx', 'su'] });
  assert.equal(out.filename, 'sydney_indices.zip');
  assert.equal(calls[0].url, 'api/datasets/ds_1/export?format=zip&frequency=annual&indices=txx%2Csu');
  assert.equal(api.exportUrl('ds_1', { format: 'json' }), 'api/datasets/ds_1/export?format=json');
});

test('api: upload progress restarts the idle time-out', async () => {
  const uploadTransport = (url, init) =>
    new Promise((resolve) => {
      let i = 0;
      const tick = setInterval(() => {
        i += 1;
        init.onProgress({ phase: 'upload', loaded: i, total: 5 });
        if (i === 5) {
          clearInterval(tick);
          resolve(res(201, { id: 'ds_new' }));
        }
      }, 12);
    });
  const api = createClient({ fetchImpl: async () => res(500, {}), ...quick, uploadTransport });
  const seen = [];
  // 5 progress ticks of 12 ms each take longer than the 30 ms limit; progress keeps it alive.
  const out = await api.request('POST', 'datasets', { transport: uploadTransport, timeout: 30, retries: 0, onProgress: (p) => seen.push(p.loaded) });
  assert.equal(out.id, 'ds_new');
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test('api: error bodies in other shapes are still turned into a message', () => {
  assert.equal(normaliseErrorBody({ detail: 'Not Found' }, 404).message, 'Not Found');
  const v = normaliseErrorBody({ detail: [{ loc: ['body', 'base_start'], msg: 'value is not a valid integer' }] }, 422);
  assert.equal(v.details[0].message, 'base_start: value is not a valid integer');
  assert.equal(normaliseErrorBody(null, 502).code, 'http_502');
  assert.equal(normaliseErrorBody(null, 502).serverMessage, false);
});

test('api: backoff doubles, has jitter, and is capped', () => {
  assert.equal(backoffDelay(1, { random: () => 0.5 }), 1000);
  assert.equal(backoffDelay(3, { random: () => 0.5 }), 4000);
  assert.equal(backoffDelay(10, { random: () => 0.5 }), 15000);
  assert.ok(backoffDelay(2, { random: () => 0 }) >= 1500 && backoffDelay(2, { random: () => 0.999 }) <= 2500);
});

test('connection: events map to online / retrying / offline', () => {
  const seen = [];
  const c = createConnection((s) => seen.push(s));
  c.handle({ type: 'attempt' });
  c.handle({ type: 'retry', attempt: 2, of: 4, delayMs: 1000 });
  c.handle({ type: 'fail' });
  c.handle({ type: 'error', status: 422 });
  c.handle({ type: 'success' });
  assert.deepEqual(seen, ['retrying', 'offline', 'online']);
});

// ---------------------------------------------------------------- fixtures mode

function diskFetch(dir = 'fixtures') {
  return async (url) => {
    const file = path.join(web, url);
    if (!fs.existsSync(file)) return res(404, undefined);
    return res(200, JSON.parse(fs.readFileSync(file, 'utf8')));
  };
}

test('fixtures: every endpoint the app uses is answered from web/fixtures', async () => {
  const api = createClient({ fetchImpl: diskFetch(), fixtures: true, ...quick });
  assert.equal((await api.health()).status, 'ok');
  assert.ok((await api.version()).app);
  const indices = (await api.indices()).indices;
  assert.ok(indices.length > 5);
  const ds = await api.createSample({});
  assert.ok(ds.id && ds.qc.checks.length && ds.qc.missing_by_year.length);
  assert.equal((await api.getDataset(ds.id)).id, ds.id);
  const daily = await api.daily(ds.id, 'tasmax');
  assert.equal(daily.time.length, daily.values.length);
  const annual = await api.compute(ds.id, ['txx', 'su'], 'annual');
  assert.deepEqual(annual.results.map((r) => r.id).sort(), ['su', 'txx']);
  const monthly = await api.compute(ds.id, ['txx', 'cdd'], 'monthly');
  assert.deepEqual(monthly.results.map((r) => r.id), ['txx']);
  assert.deepEqual(monthly.skipped.map((s) => s.id), ['cdd']);
  const rerun = await api.rerunQc(ds.id, { ...ds.qc.settings, max_precip_mm: 123 });
  assert.ok(Array.isArray(rerun.checks) && rerun.settings && rerun.summary);
  assert.deepEqual((await api.rerunQc(ds.id, { ...ds.qc.settings })).settings, ds.qc.settings);
  ds.qc.settings.max_precip_mm = -1; // changing what was received must not alter the saved example
  assert.notEqual((await api.getDataset(ds.id)).qc.settings.max_precip_mm, -1);
  assert.equal(await api.remove(ds.id), true);
  await assert.rejects(api.exportFile(ds.id, { format: 'zip' }), (e) => e.code === 'fixtures_no_export');
  for (const v of Object.keys(ds.variables)) assert.equal((await api.daily(ds.id, v)).variable, v);
  await assert.rejects(api.daily(ds.id, 'nope'), (e) => e.code === 'fixture_missing');
});

test('fixtures: simulate=flaky exercises the retry path, simulate=expired the 404 path', async () => {
  const events = [];
  const flaky = createClient({ fetchImpl: diskFetch(), fixtures: true, simulate: 'flaky', ...quick, onEvent: (e) => events.push(e.type) });
  assert.equal((await flaky.health({ retries: 2 })).status, 'ok');
  assert.ok(events.includes('retry'));
  const expired = createClient({ fetchImpl: diskFetch(), fixtures: true, simulate: 'expired', ...quick });
  await assert.rejects(expired.compute('ds_ab12cd', ['txx'], 'annual'), (e) => e.expired === true);
  await expired.createSample({});
  assert.ok((await expired.compute('ds_ab12cd', ['txx'], 'annual')).results.length === 1);
  const bad = createClient({ fetchImpl: diskFetch(), fixtures: true, simulate: 'badfile', ...quick, uploadTransport: null });
  const nProblems = readJson('fixtures/error_validation.json').error.details.length;
  await assert.rejects(bad.request('POST', 'datasets', {}), (e) => e.status === 422 && e.details.length === nProblems);
});

test('fixtures: shapes match what the front end reads (contract check)', () => {
  const ds = readJson('fixtures/dataset.json');
  for (const k of ['id', 'station', 'period', 'base_period', 'expires_in_seconds', 'variables', 'qc']) assert.ok(k in ds, 'dataset.' + k);
  for (const k of ['summary', 'settings', 'checks', 'missing_by_year']) assert.ok(k in ds.qc, 'qc.' + k);
  for (const c of ds.qc.checks) for (const k of ['id', 'title', 'severity', 'description', 'count', 'records']) assert.ok(k in c, 'check.' + k);
  for (const f of ['compute_annual', 'compute_monthly']) {
    const c = readJson('fixtures/' + f + '.json');
    for (const k of ['dataset_id', 'frequency', 'base_period', 'missing_policy', 'elapsed_ms', 'results', 'skipped']) assert.ok(k in c, f + '.' + k);
    for (const r of c.results) {
      assert.equal(r.time.length, r.values.length, r.id);
      assert.ok(r.values.every((v) => v === null || (typeof v === 'number' && Number.isFinite(v))), r.id + ' values');
      assert.ok(!r.values.includes(-99.9));
      for (const k of ['id', 'name', 'long_name', 'units', 'stats']) assert.ok(k in r, r.id + '.' + k);
      assert.ok('trend' in r);
    }
  }
  for (const ix of readJson('fixtures/indices.json').indices) {
    for (const k of ['id', 'name', 'long_name', 'description', 'group', 'units', 'inputs', 'frequencies', 'needs_base_period', 'validated']) assert.ok(k in ix, ix.id + '.' + k);
    assert.ok(shape.GROUPS.includes(ix.group), ix.id + ' group ' + ix.group);
  }
});

// ---------------------------------------------------------------- translation helper

test('i18n: interpolation, plural forms, fallback language, missing keys', async () => {
  const tables = { 'i18n/en.json': { hello: 'Hello {name}', 'day.one': '{n} day', 'day.other': '{n} days', only: 'English only' }, 'i18n/fr.json': { hello: 'Bonjour {name}', 'day.one': '{n} jour', 'day.other': '{n} jours' } };
  const i18n = createI18n({ loadJson: async (u) => tables[u] });
  await i18n.use('en');
  assert.equal(i18n.t('hello', { name: 'Ana' }), 'Hello Ana');
  assert.equal(i18n.tn('day', 1), '1 day');
  assert.equal(i18n.tn('day', 0), '0 days');
  assert.equal(i18n.t('nope'), 'nope');
  assert.equal(i18n.has('nope'), false);
  await i18n.use('fr');
  assert.equal(i18n.lang, 'fr');
  assert.equal(i18n.draft, true);
  assert.equal(i18n.t('hello', { name: 'Ana' }), 'Bonjour Ana');
  assert.equal(i18n.tn('day', 0), '0 jour'); // French treats 0 as singular
  assert.equal(i18n.tn('day', 2, { n: '2,0' }), '2,0 jours');
  assert.equal(i18n.t('only'), 'English only');
  assert.equal(interpolate('{a} and {b}', { a: 1 }), '1 and {b}');
});

test('i18n: a language that fails to load falls back to English', async () => {
  const i18n = createI18n({
    loadJson: async (u) => {
      if (u.includes('fr')) throw new Error('offline');
      return { k: 'v' };
    },
  });
  assert.equal(await i18n.use('fr'), 'en');
  assert.equal(i18n.t('k'), 'v');
});

test('i18n: language choice', () => {
  assert.equal(pickLanguage([null, 'fr-CA', 'en']), 'fr');
  assert.equal(pickLanguage(['pt-BR', 'es']), 'en');
  assert.equal(pickLanguage(['EN-gb']), 'en');
});

test('i18n: en.json and fr.json have identical keys and placeholders', () => {
  const en = readJson('i18n/en.json');
  const fr = readJson('i18n/fr.json');
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const k of Object.keys(en)) {
    assert.equal(ph(fr[k]), ph(en[k]), 'placeholders in ' + k);
    assert.ok(fr[k].trim().length > 0, 'empty French string ' + k);
  }
});

// ---------------------------------------------------------------- formatting

test('format: numbers, trends, p-values, dates and units', async () => {
  const i18n = createI18n({ loadJson: async (u) => readJson(u) });
  await i18n.use('en');
  const f = createFormat('en', i18n.t, i18n.has);
  assert.equal(f.num(1234.567, 1), '1,234.6');
  assert.equal(f.num(null), 'no value');
  assert.equal(f.num(NaN), 'no value');
  assert.equal(f.num(-0, 1), '0');
  assert.equal(f.sig(5.1515), '5.2');
  assert.equal(f.sig(0.0278), '0.028');
  assert.equal(f.signed(-28.6842), '-29');
  assert.equal(f.signed(0.3125), '+0.31');
  assert.equal(f.signed(-0), '0');
  assert.equal(f.pValue(0), 'p below 0.001');
  assert.equal(f.pValue(0.0121), 'p = 0.01');
  assert.equal(f.pValue(0.8158), 'p = 0.82');
  assert.equal(f.pValue(0.004), 'p = 0.004');
  assert.equal(f.timeKey('1936'), '1936');
  assert.equal(f.timeKey('1936-02'), 'Feb 1936');
  assert.equal(f.date('1988-11-16'), 'Nov 16, 1988');
  assert.equal(f.unit('degC'), '°C');
  assert.equal(f.unit('furlongs'), 'furlongs');
  assert.equal(f.unitChange('%'), 'percentage points');
  assert.equal(f.unitChange('mm'), 'mm');
  assert.equal(f.bytes(532000), '520 KB');
  await i18n.use('fr');
  const g = createFormat('fr', i18n.t, i18n.has);
  assert.equal(g.num(21.9, 1), '21,9');
  assert.equal(g.unit('days'), 'jours');
  assert.match(g.timeKey('1936-02'), /1936/);
});

// ---------------------------------------------------------------- data shaping

test('shape: time keys', () => {
  assert.equal(shape.timeKeyToX('1936'), 1936);
  assert.equal(shape.timeKeyToX('1936-01'), 1936);
  assert.ok(Math.abs(shape.timeKeyToX('1936-07') - 1936.5) < 1e-9);
  assert.ok(Number.isNaN(shape.timeKeyToX('x')));
  assert.equal(shape.dayToIso(shape.isoToDay('1936-02-29')), '1936-02-29');
  assert.equal(shape.isoToDay('1970-01-02'), 1);
});

test('shape: missing values become null whatever form they arrive in', () => {
  assert.equal(shape.cleanValue(null), null);
  assert.equal(shape.cleanValue(undefined), null);
  assert.equal(shape.cleanValue(NaN), null);
  assert.equal(shape.cleanValue(-99.9), null);
  assert.equal(shape.cleanValue('12'), null);
  assert.equal(shape.cleanValue(0), 0);
  assert.ok(Object.is(shape.cleanValue(-0), 0));
  const s = shape.resultSeries({ time: ['2000', '2001', '2002', '2003'], values: [1, null, NaN, 4], trend: null });
  assert.deepEqual(s.y, [1, null, null, 4]);
  assert.deepEqual(s.missing, [1, 2]);
  assert.equal(s.nValid, 2);
  assert.equal(s.trend, null);
  assert.equal(s.monthly, false);
});

test('shape: gaps split a series into segments', () => {
  assert.deepEqual(shape.segments([1, 2, null, 3, null, null, 4, 5]), [[0, 1], [3, 3], [6, 7]]);
  assert.deepEqual(shape.segments([null, null]), []);
  assert.deepEqual(shape.segments([]), []);
});

test('shape: Sen line passes through the median of the residuals', () => {
  const x = [2000, 2001, 2002, 2003, 2004];
  const y = [10, 11, null, 13, 14];
  const line = shape.senLine(x, y, 10); // 10 per decade = 1 per year
  assert.ok(Math.abs(line.slope - 1) < 1e-12);
  assert.ok(Math.abs(line.at(2002) - 12) < 1e-9);
  assert.deepEqual(line.x, [2000, 2004]);
  assert.equal(shape.senLine(x, [null, null, null, null, 1], 1), null);
  assert.equal(shape.senLine(x, y, null), null);
});

test('shape: real fixture gives a trend line inside the data range', () => {
  const c = readJson('fixtures/compute_annual.json');
  const r = c.results.find((q) => q.trend && q.trend.slope_per_decade > 0.1);
  const s = shape.resultSeries(r);
  assert.equal(s.x.length, r.time.length);
  assert.ok(s.trend.y[1] > s.trend.y[0]);
  const [lo, hi] = shape.extent(s.y);
  assert.ok(s.trend.y[0] > lo && s.trend.y[1] < hi);
  const monthly = readJson('fixtures/compute_monthly.json').results[0];
  const m = shape.resultSeries(monthly);
  assert.equal(m.monthly, true);
  assert.equal(m.trend === null, !monthly.trend, 'a trend line is drawn exactly when the API gives a trend');
  if (m.trend) assert.ok(m.trend.y.every(Number.isFinite));
});

test('shape: decimation keeps extremes, keeps gaps, and returns real observations', () => {
  const n = 10000;
  const x = Array.from({ length: n }, (_, i) => i);
  const y = x.map((i) => Math.sin(i / 50) * 10);
  y[4321] = 99;
  y[7777] = -99;
  for (let i = 2000; i < 2600; i++) y[i] = null;
  const d = shape.decimate(x, y, 0, n - 1, 200);
  assert.equal(d.decimated, true);
  assert.ok(d.x.length <= 400);
  assert.ok(d.y.includes(99) && d.y.includes(-99));
  assert.ok(d.y.includes(null), 'gap survives');
  for (let i = 0; i < d.x.length; i++) if (d.y[i] != null) assert.equal(y[d.x[i]], d.y[i]);
  for (let i = 1; i < d.x.length; i++) assert.ok(d.x[i] > d.x[i - 1], 'x stays in order');
  const small = shape.decimate(x, y, 10, 60, 200);
  assert.equal(small.decimated, false);
  assert.equal(small.x.length, 51);
  assert.deepEqual(shape.decimate(x, y, 5, 4, 100).x, []);
});

test('shape: axis scales and ticks', () => {
  const s = shape.niceScale(9.3, 45.8);
  assert.ok(s.min <= 9.3 && s.max >= 45.8);
  assert.equal(s.ticks[0], s.min);
  assert.equal(s.ticks.at(-1), s.max);
  assert.equal(shape.niceScale(0, 0).min < 0, true);
  assert.equal(shape.niceScale(7.1, 8.7).decimals, 1);
  assert.equal(shape.niceScale(0, 250).decimals, 0);
  assert.equal(shape.niceScale(0, 1.1, 5).decimals, 2);
  assert.deepEqual(shape.niceScale(null, null).ticks, [0, 0.5, 1]);
  const yt = shape.timeTicks('year', 1935.5, 2015.5, 9).map((t) => t.y);
  assert.deepEqual(yt, [1940, 1950, 1960, 1970, 1980, 1990, 2000, 2010]);
  const dt = shape.timeTicks('day', shape.isoToDay('1936-01-01'), shape.isoToDay('2015-12-31'), 9);
  assert.ok(dt.every((t) => t.level === 'year') && dt.length >= 4);
  const mt = shape.timeTicks('day', shape.isoToDay('1946-08-01'), shape.isoToDay('1947-03-01'), 8);
  assert.ok(mt.every((t) => t.level === 'month'));
  assert.equal(shape.dayToIso(mt[0].x).slice(8), '01');
  const days = shape.timeTicks('day', shape.isoToDay('1946-11-01'), shape.isoToDay('1946-12-01'), 8);
  assert.ok(days.every((t) => t.level === 'day') && days.length >= 3);
  assert.deepEqual(shape.timeTicks('year', 5, 5), []);
});

test('shape: nearest index and lower bound', () => {
  const xs = [1, 3, 5, 9];
  assert.equal(shape.nearestIndex(xs, 0), 0);
  assert.equal(shape.nearestIndex(xs, 3.9), 1);
  assert.equal(shape.nearestIndex(xs, 4.1), 2);
  assert.equal(shape.nearestIndex(xs, 100), 3);
  assert.equal(shape.nearestIndex([], 1), -1);
  assert.equal(shape.lowerBound(xs, 5), 2);
  assert.equal(shape.lowerBound(xs, 6), 3);
  assert.equal(shape.lowerBound(xs, 10), 4);
});

test('shape: trend wording categories', () => {
  assert.deepEqual(shape.trendVerdict(null), { kind: 'none', significant: false });
  assert.equal(shape.trendVerdict({ slope_per_decade: -0, p_value: null }).kind, 'untestable');
  assert.equal(shape.trendVerdict({ slope_per_decade: 0, p_value: 0.85 }).kind, 'flat');
  assert.deepEqual(shape.trendVerdict({ slope_per_decade: 5.15, p_value: 0 }), { kind: 'up', significant: true });
  assert.deepEqual(shape.trendVerdict({ slope_per_decade: -1.8, p_value: 0.2 }), { kind: 'down', significant: false });
  assert.equal(shape.trendVerdict({ slope_per_decade: 1, p_value: 0.05 }).significant, false);
});

test('shape: quality-control helpers', () => {
  const ds = readJson('fixtures/dataset.json');
  assert.equal(shape.qcVerdict(ds.qc), ds.qc.summary.errors ? 'errors' : ds.qc.summary.warnings ? 'warnings' : 'clean');
  assert.equal(shape.qcVerdict({ summary: { errors: 0, warnings: 2 } }), 'warnings');
  assert.equal(shape.qcVerdict({ summary: { errors: 0, warnings: 0, info: 3 } }), 'clean');
  assert.equal(shape.qcVerdict(undefined), 'clean');
  const sorted = shape.sortChecks(ds.qc.checks);
  const firstPassed = sorted.findIndex((c) => c.count === 0);
  assert.ok(sorted.slice(firstPassed).every((c) => c.count === 0), 'passed checks come last');
  const flagged = shape.flaggedForVariable(ds.qc.checks, 'tasmax');
  assert.ok(flagged.length >= 1 && flagged.every((f) => typeof f.day === 'number'));
  for (let i = 1; i < flagged.length; i++) assert.ok(flagged[i].day > flagged[i - 1].day);
  const both = shape.flaggedForVariable(
    [
      { severity: 'warning', title: 'w', records: [{ date: '2000-01-01', variable: 'pr', value: 1 }] },
      { severity: 'error', title: 'e', records: [{ date: '2000-01-01', variable: 'pr', value: 1 }] },
    ],
    'pr',
  );
  assert.equal(both.length, 1);
  assert.equal(both[0].severity, 'error');
  assert.deepEqual([0, 1, 15, 16, 200, 365].map((n) => shape.missingClass(n)), [0, 1, 1, 2, 2, 3]);
});

test('shape: an index is unavailable when its input is absent or all missing, or the frequency is not offered', () => {
  const ds = { period: { n_days: 100 }, variables: { pr: { n_missing: 0 }, tasmax: { n_missing: 100 } } };
  assert.deepEqual(shape.availableVariables(ds), ['pr']);
  assert.equal(shape.indexAvailability({ inputs: ['pr'], frequencies: ['annual'] }, ds, 'annual').ok, true);
  assert.deepEqual(shape.indexAvailability({ inputs: ['pr'], frequencies: ['annual'] }, ds, 'monthly'), { ok: false, reason: 'frequency', missingInputs: [] });
  const a = shape.indexAvailability({ inputs: ['tasmax', 'tasmin'], frequencies: ['annual'] }, ds, 'annual');
  assert.deepEqual([a.ok, a.reason, a.missingInputs], [false, 'inputs', ['tasmax', 'tasmin']]);
  const groups = shape.groupIndices(readJson('fixtures/indices.json').indices);
  assert.deepEqual(groups.map((g) => g.group), ['temperature', 'precipitation', 'duration', 'percentile']);
});

test('shape: comparing two indices aligns them on one time axis', () => {
  const al = shape.alignSeries({ time: ['2000', '2001', '2002'], values: [1, null, 3] }, { time: ['2001', '2002', '2003'], values: [10, 20, 30] });
  assert.deepEqual(al.time, ['2000', '2001', '2002', '2003']);
  assert.deepEqual(al.ya, [1, null, 3, null]);
  assert.deepEqual(al.yb, [null, 10, 20, 30]);
});

test('shape: CSV export quotes safely and leaves missing values empty', () => {
  const csv = shape.resultToCsv({ id: 'x', name: 'A,"b"', units: 'mm', time: ['2000', '2001'], values: [1.5, null] });
  assert.equal(csv, 'index,time,value,units\r\n"A,""b""",2000,1.5,mm\r\n"A,""b""",2001,,mm\r\n');
  assert.equal(shape.safeFileName('Sydney Obs. Hill / 1936–2015'), 'Sydney_Obs._Hill_1936_2015');
  assert.equal(shape.safeFileName('../../etc'), 'etc');
  assert.equal(shape.safeFileName(''), 'station');
});

test('shape: the file quick check follows the server rules and explains common mistakes', () => {
  const good = '1936 1 1 0.0 23.7 18.4\n1936 1 2 -99.9 24.1 17.9\r\n\n# a comment\n1936\t1\t3\t1.2\t25\t18\n';
  const g = shape.precheckStationText(good);
  assert.deepEqual([g.rows, g.first, g.last, g.problems.length, g.notes.length], [3, '1936-01-01', '1936-01-03', 0, 0]);
  // a header is skipped by the server, so it is a note, not a problem
  const header = shape.precheckStationText('year month day pr tx tn\n1936 1 1 0 1 2\n');
  assert.deepEqual(header.notes, [{ line: 1, kind: 'header' }]);
  assert.deepEqual([header.rows, header.problems.length], [1, 0]);
  // commas, semicolons and decimal commas are accepted by the server
  assert.deepEqual([shape.precheckStationText('1936,1,1,0,1,2\n1936,1,2,0,1,2\n').rows, shape.precheckStationText('1936,1,1,0,1,2\n').problems.length], [2, 0]);
  assert.equal(shape.precheckStationText('1936;1;1;0,5;21,5;12\n1936;1;2;0;1;2\n').rows, 2);
  const cols = shape.precheckStationText('1936 1 1 0 1 2\n1936 1 2 0 1\n');
  assert.deepEqual(cols.problems[0], { line: 2, kind: 'columns', found: 5 });
  assert.equal(shape.precheckStationText('1936 2 30 0 1 2\n').problems[0].kind, 'bad_date');
  assert.equal(shape.precheckStationText('36 1 1 0 1 2\n').problems[0].kind, 'bad_date');
  assert.equal(shape.precheckStationText('1900 2 29 0 1 2\n').problems[0].kind, 'bad_date');
  assert.equal(shape.precheckStationText('2000 2 29 0 1 2\n').rows, 1);
  assert.deepEqual(shape.precheckStationText('1936 1 1 0 NA 2\n').problems[0], { line: 1, kind: 'not_number', found: 'NA' });
  assert.deepEqual(shape.precheckStationText('1936 1.5 1 0 1 2\n').problems[0], { line: 1, kind: 'not_number', found: '1.5' });
  // every day must be present once and in order
  assert.deepEqual(shape.precheckStationText('1936 1 1 0 1 2\n1936 1 5 0 1 2\n').problems[0], { line: 2, kind: 'gap', found: 3 });
  assert.deepEqual(shape.precheckStationText('1936 1 2 0 1 2\n1936 1 1 0 1 2\n').problems[0], { line: 2, kind: 'order', found: '1936-01-01' });
  assert.deepEqual(shape.precheckStationText('1936 1 1 0 1 2\n1936 1 1 0 1 2\n').problems[0], { line: 2, kind: 'duplicate', found: '1936-01-01' });
  assert.equal(shape.precheckStationText('PK\u0003\u0004\u0000\u0000').problems[0].kind, 'binary');
  assert.equal(shape.precheckStationText('  \n').problems[0].kind, 'empty');
  assert.equal(shape.precheckStationText('# only a comment\n').problems[0].kind, 'empty');
  const many = shape.precheckStationText(Array.from({ length: 20 }, () => '1 2').join('\n'));
  assert.deepEqual([many.problems.length, many.more], [5, 15]);
});

// ---------------------------------------------------------------- chart

function demoSpec(extra = {}) {
  return {
    kind: 'year',
    xPad: 0.5,
    cursorX: [2000, 2001, 2002, 2003, 2004],
    ariaLabel: 'Demo <chart>',
    missingLabel: 'No value',
    formatY: (v, d) => v.toFixed(d),
    panels: [
      {
        unit: '°C',
        series: [
          { type: 'line', x: [2000, 2001, 2002, 2003, 2004], y: [1, 2, null, 4, 5], color: 'c1', marker: 'circle', label: 'A & <b>', track: true },
          { type: 'line', x: [2000, 2004], y: [1, 5], color: 'trend', dash: 'trend', label: 'Trend' },
        ],
        missingX: [2002],
      },
    ],
    ...extra,
  };
}

test('chart: draws gaps as separate line pieces and escapes untrusted labels', () => {
  const spec = demoSpec();
  const L = layoutChart(spec, 640);
  const svg = renderSvg(spec, L);
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
  const data = [...svg.matchAll(/<path d="(M[^"]+)" class="ch-line ch-stroke-c1"/g)].map((m) => m[1]).find((d) => d.includes('L'));
  assert.equal((data.match(/M/g) || []).length, 2, 'two segments around the gap');
  assert.ok(svg.includes('A &amp; &lt;b&gt;'));
  assert.ok(!svg.includes('<b>'));
  assert.ok(svg.includes('aria-label="Demo &lt;chart&gt;"'));
  assert.ok(svg.includes('stroke-dasharray'), 'trend line is dashed, not colour alone');
  assert.ok(svg.includes('ch-missing'), 'missing years are marked');
  assert.ok(svg.includes('ch-cursor'));
  assert.equal((svg.match(/<svg/g) || []).length, 1);
  assert.ok(!svg.includes('<title>'), 'no hover tooltip over the whole chart on screen');
  // every tag that opens is closed or self-closed
  const opens = (svg.match(/<(g|text|svg)[ >]/g) || []).length;
  const closes = (svg.match(/<\/(g|text|svg)>/g) || []).length;
  assert.equal(opens, closes);
});

test('chart: layout maps data to pixels and back', () => {
  const spec = demoSpec();
  const L = layoutChart(spec, 640);
  assert.ok(Math.abs(L.xInv(L.xs(2003)) - 2003) < 1e-9);
  assert.ok(L.xs(2000) > L.ml && L.xs(2004) < 640);
  const P = L.panels[0];
  assert.ok(P.ys(5) < P.ys(1), 'larger values are higher up');
  assert.ok(P.scale.min <= 1 && P.scale.max >= 5);
  const two = layoutChart({ ...spec, panels: [spec.panels[0], spec.panels[0]] }, 640);
  assert.ok(two.panels[1].top > two.panels[0].bottom, 'compare panels are stacked, not overlaid');
  assert.ok(two.height > L.height);
});

test('chart: exported SVG is self-contained (own colours, title, no interactive parts)', () => {
  const svg = exportSvg({ ...demoSpec(), title: 'TXx: Hottest day', subtitle: 'Station', footer: 'Made by the tool' });
  assert.ok(svg.startsWith('<?xml'));
  assert.ok(svg.includes('<title>TXx: Hottest day</title>') && svg.includes('Made by the tool'));
  assert.ok(svg.includes('stroke="#2a78d6"'));
  assert.ok(!svg.includes('ch-cursor'));
  assert.ok(!/var\(--/.test(svg));
  assert.ok(!/href=/.test(svg));
});

test('chart: a series with no values still renders', () => {
  const spec = { kind: 'year', emptyLabel: 'Nothing', panels: [{ unit: 'mm', series: [{ type: 'line', x: [2000, 2001], y: [null, null], color: 'c1' }] }] };
  const svg = renderSvg(spec, layoutChart(spec, 400));
  assert.ok(svg.includes('Nothing'));
  assert.ok(!svg.includes('NaN'));
  assert.equal(esc('<script>"\''), '&lt;script&gt;&quot;&#39;');
});

test('chart: every fixture result renders without NaN', () => {
  for (const f of ['compute_annual', 'compute_monthly']) {
    for (const r of readJson('fixtures/' + f + '.json').results) {
      const s = shape.resultSeries(r);
      const spec = { kind: 'year', cursorX: s.x, panels: [{ unit: r.units, series: [{ type: 'line', x: s.x, y: s.y, color: 'c1', marker: 'circle', label: r.name, track: true }], missingX: s.missing.map((i) => s.x[i]) }] };
      const svg = renderSvg(spec, layoutChart(spec, 360));
      assert.ok(!svg.includes('NaN') && !svg.includes('Infinity'), f + ' ' + r.id);
    }
  }
});

// ---------------------------------------------------------------- storage

test('store: storage that throws or is missing never breaks the app', () => {
  const throwing = safeStorage(() => {
    throw new Error('SecurityError');
  });
  assert.equal(throwing.get('k'), null);
  assert.equal(throwing.set('k', 1), false);
  throwing.remove('k');
  const full = safeStorage(() => ({
    getItem: () => '{not json',
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {},
  }));
  assert.equal(full.get('k'), null);
  assert.equal(full.set('k', 1), false);
});

test('store: session and results round-trip; results for another dataset are ignored', () => {
  const mem = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  };
  const s = mem();
  const l = mem();
  const store = createStore(safeStorage(() => s), safeStorage(() => l));
  assert.equal(store.loadSession(), null);
  const state = { dataset: { id: 'ds_1' }, source: 'file', fileName: 'a.txt', settings: { baseStart: '1981' }, selection: new Set(['txx']), frequency: 'monthly', step: 3, loadedAt: 5 };
  store.saveSession(state);
  const back = store.loadSession();
  assert.deepEqual([back.datasetId, back.source, back.selection, back.frequency, back.step], ['ds_1', 'file', ['txx'], 'monthly', 3]);
  store.saveResult({ dataset_id: 'ds_1', results: [] }, 9);
  assert.equal(store.loadResult('ds_1').computedAt, 9);
  assert.equal(store.loadResult('ds_2'), null);
  store.saveSession({ dataset: null });
  assert.equal(store.loadSession(), null);
  assert.equal(store.loadResult('ds_1'), null);
  store.saveIndices([{ id: 'txx' }], '0.1.0');
  assert.equal(store.loadIndices().indices[0].id, 'txx');
});

// ---------------------------------------------------------------- upload transport (XMLHttpRequest)

test('api: the upload transport reports progress, resolves on load, and aborts on time-out', async () => {
  const { xhrTransport } = await import('../js/api.js');
  const made = [];
  class FakeXHR {
    constructor() {
      this.upload = {};
      this.headers = {};
      made.push(this);
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k, v) {
      this.headers[k] = v;
    }
    getResponseHeader() {
      return null;
    }
    send(body) {
      this.body = body;
      if (this.script) this.script(this);
    }
    abort() {
      this.aborted = true;
      if (this.onabort) this.onabort();
    }
  }
  globalThis.XMLHttpRequest = FakeXHR;
  try {
    // 1. progress then success
    const seen = [];
    FakeXHR.prototype.script = (x) =>
      setTimeout(() => {
        x.upload.onprogress({ loaded: 50, total: 200, lengthComputable: true });
        x.upload.onprogress({ loaded: 200, total: 200, lengthComputable: true });
        x.upload.onload();
        x.status = 201;
        x.responseText = '{"id":"ds_1"}';
        x.onload();
      }, 1);
    const api = createClient({ fetchImpl: async () => res(500, {}), ...quick, uploadTransport: xhrTransport });
    const out = await api.upload(new File(['1936 1 1 0 1 2\n'], 'a.txt'), { latitude: 5 }, { onProgress: (p) => seen.push(p.phase + ':' + p.loaded) });
    assert.equal(out.id, 'ds_1');
    assert.deepEqual(seen, ['upload:50', 'upload:200', 'processing:1']);
    assert.deepEqual([made[0].method, made[0].url], ['POST', 'api/datasets']);
    assert.equal(made[0].body.get('file').name, 'a.txt');
    assert.equal(made[0].body.get('latitude'), '5');
    assert.equal(made[0].headers['Content-Type'], undefined, 'the browser sets the multipart boundary itself');

    // 2. server error body is parsed from responseText
    FakeXHR.prototype.script = (x) =>
      setTimeout(() => {
        x.status = 422;
        x.responseText = JSON.stringify(readJson('fixtures/error_validation.json'));
        x.onload();
      }, 1);
    await assert.rejects(api.upload(new File(['x'], 'a.txt'), {}, {}), (e) => e.status === 422 && e.details.length === readJson('fixtures/error_validation.json').error.details.length);

    // 3. a stalled upload is aborted by the idle time-out and retried, then reported as a time-out
    made.length = 0;
    FakeXHR.prototype.script = () => {};
    await assert.rejects(api.request('POST', 'datasets', { transport: xhrTransport, timeout: 15, retries: 1 }), (e) => e.kind === 'timeout' && e.attempts === 2);
    assert.equal(made.length, 2);
    assert.ok(made.every((x) => x.aborted));

    // 4. a dropped connection is a network error
    FakeXHR.prototype.script = (x) => setTimeout(() => x.onerror(), 1);
    await assert.rejects(api.request('POST', 'datasets', { transport: xhrTransport, retries: 0 }), (e) => e.kind === 'network');
  } finally {
    delete globalThis.XMLHttpRequest;
  }
});

// ---------------------------------------------------------------- result order

test('shape: results with nothing to chart sink to the end of their group; the compare default varies', () => {
  const indices = [
    { id: 'fd', group: 'temperature' }, { id: 'su', group: 'temperature' }, { id: 'tr', group: 'temperature' },
    { id: 'rx1day', group: 'precipitation' }, { id: 'r99', group: 'precipitation' }, { id: 'cdd', group: 'duration' },
  ];
  const mk = (id, values) => ({ id, name: id.toUpperCase(), time: values.map((_, i) => String(2000 + i)), values });
  const results = [mk('fd', [0, 0, null, -0]), mk('cdd', [5, 9, 7]), mk('su', [80, 90, 85]), mk('r99', [null, null, null]), mk('tr', [1, 0, 3]), mk('rx1day', [50, 0, 70]), mk('extra', [1, 2, 3])];
  assert.equal(shape.flatKind(results[0]), 'zero');
  assert.equal(shape.flatKind(results[3]), 'missing');
  assert.equal(shape.flatKind(results[4]), '');
  assert.equal(shape.flatKind({ values: [] }), 'missing');
  const rows = shape.orderResults(results, indices);
  assert.deepEqual(rows.map((r) => r.result.id), ['su', 'tr', 'fd', 'rx1day', 'r99', 'cdd', 'extra']);
  assert.deepEqual(rows.map((r) => r.group), ['temperature', 'temperature', 'temperature', 'precipitation', 'precipitation', 'duration', '']);
  assert.deepEqual(shape.defaultComparePair(results), ['su', 'tr']);
  assert.deepEqual(shape.defaultComparePair([results[0], results[1], results[5]]), ['cdd', 'rx1day']);
  assert.deepEqual(shape.defaultComparePair([results[0]]), ['fd', 'fd']);
  assert.deepEqual(shape.defaultComparePair([]), ['', '']);
  // with the real fixture: nothing flat comes first, and the default pair is not flat
  const c = readJson('fixtures/compute_annual.json');
  const ordered = shape.orderResults(c.results, readJson('fixtures/indices.json').indices);
  assert.equal(ordered.length, c.results.length);
  assert.equal(ordered[0].flat, '');
  for (const id of shape.defaultComparePair(c.results)) assert.equal(shape.flatKind(c.results.find((r) => r.id === id)), '');
});

// ---------------------------------------------------------------- where the API is

test('config: the API address comes from config.js; ?api= only selects an address that is listed', async () => {
  const { resolveApi, normaliseApiBase, siteConfig } = await import('../js/api.js');
  assert.deepEqual(resolveApi(siteConfig, ''), { apiBase: '', base: 'api', demoOnly: false, ignoredParam: null }, 'the repository default is same origin');
  const cfg = { apiBase: 'https://api.example.org/', apiAlternatives: ['http://localhost:8000', 'https://b.example.org/climpoc/'] };
  assert.deepEqual(resolveApi(cfg, ''), { apiBase: 'https://api.example.org', base: 'https://api.example.org/api', demoOnly: false, ignoredParam: null });
  assert.equal(resolveApi(cfg, '?api=http://localhost:8000/').base, 'http://localhost:8000/api');
  assert.equal(resolveApi(cfg, '?lang=fr&api=https%3A%2F%2Fb.example.org%2Fclimpoc').base, 'https://b.example.org/climpoc/api');
  // anything not listed is ignored, never used
  for (const bad of ['https://evil.example', 'https://api.example.org.evil.example', 'https://api.example.org:444', 'http://api.example.org', '//evil.example', 'javascript:alert(1)', 'https://user:pw@api.example.org', 'https://api.example.org/?x=1']) {
    const r = resolveApi(cfg, '?api=' + encodeURIComponent(bad));
    assert.equal(r.base, 'https://api.example.org/api', bad);
    assert.equal(r.ignoredParam, bad);
  }
  // with the same-origin default, no parameter can send requests anywhere else
  assert.deepEqual(resolveApi({ apiBase: '', apiAlternatives: [] }, '?api=https://evil.example'), { apiBase: '', base: 'api', demoOnly: false, ignoredParam: 'https://evil.example' });
  assert.equal(resolveApi({ demoOnly: true }, '').demoOnly, true);
  assert.equal(resolveApi({ apiBase: 'https://api.example.org', demoOnly: true }, '').demoOnly, false, 'demo-only applies only when there is no API');
  assert.equal(resolveApi(undefined, '').base, 'api');
  assert.equal(resolveApi({ apiBase: 'not a url' }, '').base, 'api');
  assert.equal(normaliseApiBase('https://A.example.org:8443/x//'), 'https://a.example.org:8443/x');
  assert.equal(normaliseApiBase('ftp://a.example.org'), null);
  assert.equal(normaliseApiBase(''), '');
});

test('api: with a separately hosted API every request is absolute, without credentials, and adds only Content-Type', async () => {
  const { fetchImpl, calls } = scripted([res(200, {})]);
  const api = createClient({ base: 'https://api.example.org/api', fetchImpl, ...quick, uploadTransport: null });
  await api.health();
  await api.indices();
  await api.createSample({});
  await api.getDataset('ds_1');
  await api.daily('ds_1', 'pr');
  await api.rerunQc('ds_1', { max_precip_mm: 150 });
  await api.compute('ds_1', ['txx'], 'annual');
  await api.exportFile('ds_1', { format: 'zip' });
  await api.upload(new File(['1936 1 1 0 1 2\n'], 'a.txt'), { latitude: 1 });
  await api.remove('ds_1');
  const seenHeaders = new Set();
  for (const c of calls) {
    assert.ok(c.url.startsWith('https://api.example.org/api/'), c.url);
    assert.equal(c.init.credentials, undefined, 'credentials are left at the browser default (none across origins)');
    for (const k of Object.keys(c.init.headers || {})) seenHeaders.add(k);
  }
  assert.deepEqual([...seenHeaders], ['Content-Type']);
  assert.deepEqual([...new Set(calls.map((c) => c.init.method))].sort(), ['DELETE', 'GET', 'POST']);
  assert.equal(calls.find((c) => c.url.endsWith('/datasets') && c.init.method === 'POST').init.headers, undefined, 'the multipart upload sets no header itself');
  assert.equal(api.exportUrl('ds_1', { format: 'json' }), 'https://api.example.org/api/datasets/ds_1/export?format=json');
});

test('store: a demonstration session is kept apart from a real one', () => {
  const mem = () => {
    const m = new Map();
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
  };
  const s = mem();
  const store = createStore(safeStorage(() => s), safeStorage(() => mem()));
  const real = { dataset: { id: 'ds_real' }, source: 'file', fileName: 'mine.txt', settings: {}, selection: new Set(), frequency: 'annual', step: 3 };
  store.saveSession(real);
  store.saveResult({ dataset_id: 'ds_real', results: [] }, 1);
  store.setMode(true);
  assert.equal(store.loadSession(), null, 'the demonstration does not see the real session');
  store.saveSession({ ...real, dataset: { id: 'ds_demo' }, source: 'sample' });
  store.clearSession();
  assert.equal(store.loadSession(), null);
  store.setMode(false);
  assert.equal(store.loadSession().datasetId, 'ds_real', 'and the real one survives a spell in the demonstration');
  assert.ok(store.loadResult('ds_real'));
});

// ---------------------------------------------------------------- server limits and rate limiting

test('api: the server\'s limits are read with safe defaults; a 429 waits as long as the server asks', async () => {
  const { readLimits, DEFAULT_LIMITS } = await import('../js/api.js');
  assert.deepEqual(readLimits({ max_upload_mb: 5, max_datasets: 10, dataset_ttl_minutes: 30, rate_limit_per_minute: null }), { maxUploadMb: 5, ttlMinutes: 30 });
  assert.deepEqual(readLimits(null), DEFAULT_LIMITS);
  assert.deepEqual(readLimits({ max_upload_mb: 'big', dataset_ttl_minutes: -1 }), { maxUploadMb: 20, ttlMinutes: 60 });
  const { fetchImpl, calls } = scripted([res(429, { error: { code: 'rate_limited', message: 'Too many requests.', details: [] } }, { 'retry-after': '7' }), res(200, { max_upload_mb: 5, dataset_ttl_minutes: 30 })]);
  const waits = [];
  const api = createClient({ fetchImpl, random: () => 0.5, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(readLimits(await api.limits()), { maxUploadMb: 5, ttlMinutes: 30 });
  assert.deepEqual(waits, [7000], 'Retry-After replaces the usual backoff');
  assert.equal(calls[0].url, 'api/limits');
  // an older server without the endpoint: a plain 404, not treated as an expired dataset
  const old = scripted([res(404, { error: { code: 'not_found', message: 'Not Found', details: [] } })]);
  await assert.rejects(createClient({ fetchImpl: old.fetchImpl, ...quick }).limits(), (e) => e.status === 404 && e.expired === false);
});
