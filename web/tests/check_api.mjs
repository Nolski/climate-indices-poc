// Contract check against a running backend, through the same API client the page uses.
//   node web/tests/check_api.mjs http://127.0.0.1:8000
// It loads the sample station, uploads a small valid and a broken file, calculates, exports and
// deletes. Everything it creates lives in the server's memory and is deleted at the end.
import { createClient, ApiError } from '../js/api.js';

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) {
  console.log('usage: node web/tests/check_api.mjs BASE_URL');
  process.exit(2);
}
let failures = 0;
const ok = (m) => console.log('  ok    ' + m);
const fail = (m) => {
  failures += 1;
  console.log('  FAIL  ' + m);
};
const note = (m) => console.log('  note  ' + m);
const has = (obj, keys, what) => {
  const miss = keys.filter((k) => !(obj && k in obj));
  if (miss.length) fail(what + ' is missing: ' + miss.join(', '));
  else ok(what + ' has ' + keys.join(', '));
};
const api = createClient({ base: base + '/api', uploadTransport: null });
const created = [];

async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    fail(name + ': ' + (e instanceof ApiError ? e.kind + ' ' + e.status + ' ' + e.code + ' ' + e.message : e.stack || e));
  }
}

function stationText(years = 12, start = 1990, breakLine = 0) {
  const lines = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let d = new Date(Date.UTC(start, 0, 1)); d.getUTCFullYear() < start + years; d.setUTCDate(d.getUTCDate() + 1)) {
    const doy = (d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5;
    const tx = 28 + 5 * Math.cos((doy / 365) * 2 * Math.PI) + rnd() * 4;
    const tn = tx - 8 - rnd() * 3;
    const pr = rnd() < 0.3 ? rnd() * 40 : 0;
    lines.push([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), pr.toFixed(1), tx.toFixed(1), tn.toFixed(1)].join(' '));
  }
  if (breakLine) lines[breakLine - 1] = lines[breakLine - 1].split(' ').slice(0, 5).join(' ');
  return lines.join('\n') + '\n';
}

console.log('API contract check against ' + base);

await step('health', async () => {
  const h = await api.health();
  h.status === 'ok' ? ok('GET /api/health') : fail('health status: ' + JSON.stringify(h));
});
await step('version', async () => has(await api.version(), ['app', 'xclim', 'python'], 'GET /api/version'));

let indices = [];
await step('indices', async () => {
  indices = (await api.indices()).indices;
  has(indices[0], ['id', 'name', 'long_name', 'description', 'group', 'units', 'inputs', 'frequencies', 'needs_base_period', 'validated'], 'GET /api/indices[0]');
  const groups = [...new Set(indices.map((i) => i.group))];
  const odd = groups.filter((g) => !['temperature', 'precipitation', 'duration', 'percentile'].includes(g));
  odd.length ? fail('unknown index groups: ' + odd.join(', ')) : ok(indices.length + ' indices in groups ' + groups.join(', '));
  note(indices.filter((i) => i.validated).length + ' of ' + indices.length + ' indices are marked validated');
});

let ds = null;
await step('sample', async () => {
  ds = await api.createSample({ baseStart: 1971, baseEnd: 2000 });
  created.push(ds.id);
  has(ds, ['id', 'station', 'period', 'base_period', 'expires_in_seconds', 'variables', 'qc'], 'POST /api/datasets/sample');
  has(ds.qc, ['summary', 'checks', 'missing_by_year'], 'dataset.qc');
  has(ds.qc.checks[0], ['id', 'title', 'severity', 'description', 'count', 'records'], 'dataset.qc.checks[0]');
  has(ds.qc.missing_by_year[0], ['year'], 'dataset.qc.missing_by_year[0]');
  note('sample: ' + ds.period.n_days + ' days, qc ' + JSON.stringify(ds.qc.summary) + ', base ' + JSON.stringify(ds.base_period));
  const again = await api.getDataset(ds.id);
  again.id === ds.id ? ok('GET /api/datasets/{id} returns the same dataset') : fail('GET dataset id differs');
});

if (ds) {
  await step('daily', async () => {
    for (const v of Object.keys(ds.variables)) {
      const d = await api.daily(ds.id, v);
      const bad = d.values.filter((x) => x !== null && !(typeof x === 'number' && Number.isFinite(x))).length;
      if (d.time.length !== d.values.length || d.time.length !== ds.period.n_days || bad || d.values.includes(-99.9)) fail('daily ' + v + ': lengths ' + d.time.length + '/' + d.values.length + ', non-numeric ' + bad);
      else ok('GET daily?variable=' + v + ': ' + d.time.length + ' days, ' + d.values.filter((x) => x === null).length + ' null, units ' + d.units);
    }
  });
  for (const frequency of ['annual', 'monthly']) {
    await step('compute ' + frequency, async () => {
      const t0 = Date.now();
      const ids = indices.map((i) => i.id);
      const c = await api.compute(ds.id, ids, frequency);
      has(c, ['dataset_id', 'frequency', 'base_period', 'missing_policy', 'elapsed_ms', 'results', 'skipped'], 'POST compute (' + frequency + ')');
      const r = c.results[0];
      has(r, ['id', 'name', 'long_name', 'units', 'time', 'values', 'stats', 'trend'], 'compute.results[0]');
      const keyOk = c.results.every((x) => x.time.every((k) => (frequency === 'annual' ? /^\d{4}$/ : /^\d{4}-\d{2}$/).test(k)));
      keyOk ? ok('time keys are ' + (frequency === 'annual' ? 'YYYY' : 'YYYY-MM')) : fail('time keys have an unexpected form, e.g. ' + r.time[0]);
      const bad = c.results.filter((x) => x.values.some((v) => v !== null && !(typeof v === 'number' && Number.isFinite(v))) || x.values.length !== x.time.length);
      bad.length ? fail('non-numeric or misaligned values in: ' + bad.map((x) => x.id).join(', ')) : ok('values are numbers or null and align with time');
      const accounted = new Set([...c.results.map((x) => x.id), ...c.skipped.map((x) => x.id)]);
      const lost = ids.filter((i) => !accounted.has(i));
      lost.length ? fail('requested but neither calculated nor skipped: ' + lost.join(', ')) : ok(c.results.length + ' calculated, ' + c.skipped.length + ' skipped, in ' + (Date.now() - t0) + ' ms (server says ' + c.elapsed_ms + ' ms)');
      const expectSkip = indices.filter((i) => !i.frequencies.includes(frequency)).map((i) => i.id).sort().join();
      const gotSkip = c.skipped.map((s) => s.id).sort().join();
      expectSkip === gotSkip ? ok('skipped list matches the frequencies advertised by /api/indices') : note('skipped ' + (gotSkip || 'none') + ' but /api/indices implies ' + (expectSkip || 'none'));
      note('trend present on ' + c.results.filter((x) => x.trend).length + ' of ' + c.results.length + ' results; p_value null on ' + c.results.filter((x) => x.trend && x.trend.p_value === null).length);
      const all = await api.compute(ds.id, 'all', frequency);
      Array.isArray(all.results) ? ok('indices: "all" is accepted (' + all.results.length + ' results)') : fail('"all" not accepted');
    });
  }
  await step('export', async () => {
    for (const format of ['zip', 'netcdf', 'json']) {
      const f = await api.exportFile(ds.id, { format, frequency: 'annual', indices: ['txx', 'su'] });
      const head = new Uint8Array(await f.blob.slice(0, 4).arrayBuffer());
      const magic = format === 'zip' ? head[0] === 0x50 && head[1] === 0x4b : format === 'netcdf' ? (head[0] === 0x43 && head[1] === 0x44 && head[2] === 0x46) || (head[0] === 0x89 && head[1] === 0x48 && head[2] === 0x44 && head[3] === 0x46) : head[0] === 0x7b;
      (magic ? ok : fail)('export ' + format + ': ' + f.blob.size + ' bytes, type ' + (f.blob.type || 'none') + ', filename ' + (f.filename || '(none sent)') + (magic ? '' : ' (unexpected file signature)'));
    }
  });
}

await step('upload', async () => {
  const good = await api.upload(new File([stationText()], 'check station.txt', { type: 'text/plain' }), { name: 'Check station', latitude: 12.5, longitude: -61.4, baseStart: 1991, baseEnd: 2000 });
  created.push(good.id);
  good.station && good.station.latitude === 12.5 && good.base_period.start === 1991 ? ok('POST /api/datasets accepts file + name, latitude, longitude, base_start, base_end (station name "' + good.station.name + '")') : fail('upload did not echo the settings: ' + JSON.stringify(good.station) + ' ' + JSON.stringify(good.base_period));
  try {
    const bad = await api.upload(new File([stationText(2, 1990, 12)], 'broken.txt', { type: 'text/plain' }), {});
    created.push(bad.id);
    fail('a file with a short line 12 was accepted');
  } catch (e) {
    if (e instanceof ApiError && [400, 422].includes(e.status) && e.serverMessage) ok('broken file is rejected with HTTP ' + e.status + ', code ' + e.code + ': "' + e.message + '" + ' + e.details.length + ' detail(s): ' + JSON.stringify(e.details[0] || null));
    else fail('broken file: unexpected error ' + e.status + ' ' + e.message);
  }
  try {
    await api.upload(new File(['PK\u0003\u0004 not text at all \u0000\u0000'], 'data.xlsx'), {});
    fail('a binary file was accepted');
  } catch (e) {
    e instanceof ApiError && e.status >= 400 && e.status < 500 && e.serverMessage ? ok('binary file is rejected with HTTP ' + e.status + ': "' + e.message + '"') : fail('binary file: unexpected ' + e.status + ' ' + e.message);
  }
});

await step('not found', async () => {
  try {
    await api.getDataset('ds_does_not_exist');
    fail('unknown dataset id did not give 404');
  } catch (e) {
    e.expired && e.serverMessage ? ok('unknown dataset gives 404 with code ' + e.code + ' and a message') : fail('unknown dataset: ' + e.status + ' ' + e.message);
  }
  try {
    await api.compute('ds_does_not_exist', ['txx'], 'annual');
    fail('compute on unknown dataset did not give 404');
  } catch (e) {
    e.expired ? ok('compute on an unknown dataset gives 404') : fail('compute unknown: ' + e.status + ' ' + e.message);
  }
});

await step('delete', async () => {
  for (const id of created) await api.remove(id);
  try {
    await api.getDataset(created[0]);
    fail('dataset still present after DELETE');
  } catch (e) {
    e.expired ? ok('DELETE removes the dataset (' + created.length + ' created by this check, all deleted)') : fail('after delete: ' + e.status);
  }
});

await step('static', async () => {
  const res = await fetch(base + '/', { headers: { 'Accept-Encoding': 'gzip' } });
  const text = await res.text();
  res.ok && text.includes('id="stepper"') ? ok('GET / serves the front end') : fail('GET / does not serve web/index.html (HTTP ' + res.status + ')');
  for (const p of ['/js/main.js', '/css/app.css', '/i18n/en.json']) {
    const r = await fetch(base + p, { headers: { 'Accept-Encoding': 'gzip' } });
    await r.arrayBuffer();
    const enc = r.headers.get('content-encoding');
    (r.ok ? (enc ? ok : note) : fail)(p + ': HTTP ' + r.status + ', content-type ' + r.headers.get('content-type') + ', content-encoding ' + (enc || 'none (NOT compressed)') + ', cache-control ' + (r.headers.get('cache-control') || 'none') + ', etag ' + (r.headers.get('etag') ? 'yes' : 'no'));
  }
  const j = await fetch(base + '/api/indices', { headers: { 'Accept-Encoding': 'gzip' } });
  await j.arrayBuffer();
  (j.headers.get('content-encoding') ? ok : note)('/api/indices content-encoding ' + (j.headers.get('content-encoding') || 'none (NOT compressed)'));
});

console.log(failures ? failures + ' API check(s) FAILED' : 'API contract check passed');
process.exit(failures ? 1 : 0);
