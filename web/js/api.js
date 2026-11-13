// API client for the same-origin /api. No DOM access in this file, so it runs under Node for tests.
//
// What it guarantees to the rest of the app:
//   - every request has a time limit (reset by upload progress, so slow uploads are not killed);
//   - network failures, time-outs and 408/425/429/502/503/504 are retried with exponential backoff;
//   - progress, retries and final failure are reported as events, never silently;
//   - a 404 on a dataset path is flagged as `expired` so the UI can offer a re-upload;
//   - with fixtures enabled, the same code path runs against web/fixtures/*.json.

import siteConfig from '../config.js';

export { siteConfig };

export const RETRY_STATUS = new Set([408, 425, 429, 502, 503, 504]);

// "scheme://host:port/path/" -> "scheme://host:port/path". Empty stays empty (same origin).
// Anything that is not a plain http(s) address gives null.
export function normaliseApiBase(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  let u;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

export const DEFAULT_LIMITS = { maxUploadMb: 20, ttlMinutes: 60 };

// GET /api/limits -> the two numbers the page shows and enforces; anything missing or odd
// falls back to the documented defaults.
export function readLimits(body) {
  const pick = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);
  const b = body || {};
  return { maxUploadMb: pick(b.max_upload_mb, DEFAULT_LIMITS.maxUploadMb), ttlMinutes: pick(b.dataset_ttl_minutes, DEFAULT_LIMITS.ttlMinutes) };
}

// Decides which API this page talks to, from the site configuration and the page's query
// string. ?api= is honoured only when it names an address the configuration already lists.
//   -> { apiBase, base, demoOnly, ignoredParam }
//      apiBase ''  = same origin;  base = what the client prefixes requests with
export function resolveApi(config = siteConfig, search = '') {
  const cfg = config || {};
  const main = normaliseApiBase(cfg.apiBase) || '';
  const allowed = [main, ...(Array.isArray(cfg.apiAlternatives) ? cfg.apiAlternatives : []).map(normaliseApiBase)].filter(Boolean);
  let apiBase = main;
  let ignoredParam = null;
  const wanted = new URLSearchParams(search).get('api');
  if (wanted !== null && wanted !== '') {
    const n = normaliseApiBase(wanted);
    if (n && allowed.includes(n)) apiBase = n;
    else ignoredParam = wanted;
  }
  return { apiBase, base: apiBase ? apiBase + '/api' : 'api', demoOnly: Boolean(cfg.demoOnly) && !apiBase, ignoredParam };
}

export const TIMEOUTS = {
  health: 8000,
  version: 10000,
  indices: 20000,
  dataset: 20000,
  sample: 60000,
  upload: 60000, // idle time-out: restarts whenever upload progress is reported
  daily: 90000,
  compute: 180000,
  export: 120000,
  remove: 15000,
};

export class ApiError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind; // 'http' | 'network' | 'timeout' | 'aborted'
    this.status = extra.status || 0;
    this.code = extra.code || kind;
    this.details = Array.isArray(extra.details) ? extra.details : [];
    this.attempts = extra.attempts || 1;
    this.timeoutMs = extra.timeoutMs || 0;
    this.expired = Boolean(extra.expired);
    this.serverMessage = Boolean(extra.serverMessage);
  }
}

// datasets/{id}... but not the collection itself and not datasets/sample
const DATASET_PATH = /^datasets\/(?!sample(?:[/?]|$))[^/?]+/;

export function backoffDelay(attempt, { base = 1000, cap = 15000, random = Math.random } = {}) {
  // attempt is the number of attempts already made (1 after the first failure).
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return Math.round(exp * (0.75 + random() * 0.5));
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new ApiError('aborted', 'Cancelled'));
    const id = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener('abort', stop);
      resolve();
    }
    function stop() {
      clearTimeout(id);
      reject(new ApiError('aborted', 'Cancelled'));
    }
    if (signal) signal.addEventListener('abort', stop, { once: true });
  });
}

// Turn any error body the server might send into one shape. The contract shape is
// { error: { code, message, details } }; FastAPI's own validation uses { detail: ... }.
export function normaliseErrorBody(body, status) {
  const out = { code: 'http_' + status, message: '', details: [], serverMessage: false };
  if (!body || typeof body !== 'object') return out;
  const e = body.error;
  if (e && typeof e === 'object') {
    out.code = String(e.code || out.code);
    out.message = String(e.message || '');
    out.details = Array.isArray(e.details) ? e.details : e.details ? [e.details] : [];
  } else if (typeof body.detail === 'string') {
    out.message = body.detail;
  } else if (Array.isArray(body.detail)) {
    out.code = 'validation';
    out.details = body.detail.map((d) => {
      if (d && typeof d === 'object' && d.msg) {
        const loc = Array.isArray(d.loc) ? d.loc.filter((p) => p !== 'body' && p !== 'query').join('.') : '';
        return { message: loc ? loc + ': ' + d.msg : String(d.msg) };
      }
      return d;
    });
  } else if (typeof body.message === 'string') {
    out.message = body.message;
  }
  out.serverMessage = Boolean(out.message || out.details.length);
  return out;
}

async function errorFromResponse(res, path) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const n = normaliseErrorBody(body, res.status);
  return new ApiError('http', n.message || 'HTTP ' + res.status, {
    status: res.status,
    code: n.code,
    details: n.details,
    serverMessage: n.serverMessage,
    expired: res.status === 404 && DATASET_PATH.test(path),
  });
}

function filenameFromResponse(res) {
  const cd = res.headers && res.headers.get ? res.headers.get('content-disposition') : null;
  if (!cd) return '';
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain ? plain[1].trim() : '';
}

// XMLHttpRequest transport: only used for uploads, because fetch cannot report upload progress.
export function xhrTransport(url, init = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(init.method || 'GET', url);
    const headers = init.headers || {};
    for (const k of Object.keys(headers)) x.setRequestHeader(k, headers[k]);
    if (x.upload && init.onProgress) {
      x.upload.onprogress = (e) =>
        init.onProgress({ phase: 'upload', loaded: e.loaded, total: e.lengthComputable ? e.total : 0 });
      x.upload.onload = () => init.onProgress({ phase: 'processing', loaded: 1, total: 1 });
    }
    x.onload = () =>
      resolve({
        ok: x.status >= 200 && x.status < 300,
        status: x.status,
        json: async () => JSON.parse(x.responseText),
        headers: { get: (n) => x.getResponseHeader(n) },
      });
    x.onerror = () => reject(new TypeError('Network error'));
    x.onabort = () => reject(new Error('Aborted'));
    if (init.signal) {
      if (init.signal.aborted) return reject(new Error('Aborted'));
      init.signal.addEventListener('abort', () => x.abort(), { once: true });
    }
    x.send(init.body || null);
  });
}

function fakeResponse(status, data) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    blob: async () => {
      throw new Error('no blob in fixtures mode');
    },
    headers: { get: () => null },
  };
}

// Answers every API call from static JSON files. `simulate` (fixtures only) lets a person try
// the resilience behaviour by hand: flaky | slow | expired | badfile | offline.
export function createFixtureTransport(fetchImpl, { dir = 'fixtures', simulate = '', slowMs = 2500 } = {}) {
  let calls = 0;
  let expiredPending = simulate === 'expired';
  const cache = new Map();

  // Small examples are kept as text and parsed afresh for every answer, exactly as a real
  // response would be, so the page can never alter a saved example by changing what it received.
  async function load(name) {
    if (cache.has(name)) return JSON.parse(cache.get(name));
    const res = await fetchImpl(dir + '/' + name + '.json');
    if (!res.ok) return null;
    const data = await res.json();
    if (!name.startsWith('daily_') && name !== 'compute_monthly') cache.set(name, JSON.stringify(data));
    return data;
  }

  function wait(ms, signal) {
    return defaultSleep(ms, signal).catch(() => {
      throw new Error('Aborted');
    });
  }

  return async function fixtureTransport(url, init = {}) {
    calls += 1;
    const method = init.method || 'GET';
    const full = String(url);
    const at = full.indexOf('api/');
    const rest = at >= 0 ? full.slice(at + 4) : full;
    const q = rest.indexOf('?');
    const path = q >= 0 ? rest.slice(0, q) : rest;
    const query = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : '');

    if (simulate === 'offline') throw new TypeError('Simulated: no connection');
    if (simulate === 'flaky' && calls % 2 === 1) {
      await wait(300, init.signal);
      throw new TypeError('Simulated: connection dropped');
    }
    if (simulate === 'slow') await wait(slowMs, init.signal);
    if (init.onProgress) {
      init.onProgress({ phase: 'upload', loaded: 1, total: 1 });
      init.onProgress({ phase: 'processing', loaded: 1, total: 1 });
    }

    if (path === 'health') return fakeResponse(200, await load('health'));
    if (path === 'version') return fakeResponse(200, await load('version'));
    if (path === 'indices') return fakeResponse(200, await load('indices'));
    if (path === 'limits') {
      const saved = await load('limits');
      return saved ? fakeResponse(200, saved) : fakeResponse(404, { error: { code: 'not_found', message: 'Not Found', details: [] } });
    }

    if (path === 'datasets' || path === 'datasets/sample') {
      if (method !== 'POST') return fakeResponse(405, null);
      if (simulate === 'badfile' && path === 'datasets') {
        return fakeResponse(422, await load('error_validation'));
      }
      expiredPending = false;
      return fakeResponse(201, await load('dataset'));
    }

    const m = /^datasets\/([^/]+)(?:\/(daily|compute|export|qc))?$/.exec(path);
    if (!m) return fakeResponse(404, { error: { code: 'not_found', message: 'Unknown path', details: [] } });
    if (method === 'DELETE') return fakeResponse(204, null);
    if (expiredPending) return fakeResponse(404, await load('error_not_found'));

    if (!m[2]) return fakeResponse(200, await load('dataset'));

    if (m[2] === 'qc') {
      // Saved examples cannot really be re-checked. Asking for the default limits gives the
      // original findings; anything else gives the one saved re-run (qc_rerun.json) as it is.
      const ds = await load('dataset');
      let wanted = {};
      try {
        wanted = JSON.parse(init.body || '{}');
      } catch {
        wanted = {};
      }
      const defaults = (ds.qc && ds.qc.settings) || {};
      const changed = Object.keys(wanted).some((k) => wanted[k] !== defaults[k]);
      const saved = changed ? await load('qc_rerun') : null;
      if (saved) return fakeResponse(200, saved);
      return fakeResponse(200, { ...ds.qc, settings: { ...defaults, ...wanted } });
    }

    if (m[2] === 'daily') {
      const variable = query.get('variable') || 'tasmax';
      const data = await load('daily_' + variable);
      if (!data) {
        return fakeResponse(501, {
          error: { code: 'fixture_missing', message: 'No saved example for this variable.', details: [] },
        });
      }
      return fakeResponse(200, data);
    }

    if (m[2] === 'compute') {
      let body = {};
      try {
        body = JSON.parse(init.body || '{}');
      } catch {
        body = {};
      }
      const frequency = body.frequency === 'monthly' ? 'monthly' : 'annual';
      const data = await load('compute_' + frequency);
      if (!data) return fakeResponse(501, { error: { code: 'fixture_missing', message: 'No saved example.', details: [] } });
      if (!Array.isArray(body.indices)) return fakeResponse(200, data);
      const want = new Set(body.indices);
      return fakeResponse(200, {
        ...data,
        results: data.results.filter((r) => want.has(r.id)),
        skipped: (data.skipped || []).filter((s) => want.has(s.id)),
      });
    }

    return fakeResponse(501, {
      error: { code: 'fixtures_no_export', message: 'File export needs the real server.', details: [] },
    });
  };
}

export function createClient(cfg = {}) {
  const base = (cfg.base || 'api').replace(/\/+$/, '');
  const fetchImpl = cfg.fetchImpl || ((...a) => globalThis.fetch(...a));
  const sleep = cfg.sleep || defaultSleep;
  const random = cfg.random || Math.random;
  const setTimer = cfg.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = cfg.clearTimer || ((id) => clearTimeout(id));
  const fixtures = Boolean(cfg.fixtures);
  const fixtureTransport = fixtures
    ? cfg.fixtureTransport || createFixtureTransport(fetchImpl, { dir: cfg.fixturesDir, simulate: cfg.simulate })
    : null;
  const uploadTransport = cfg.uploadTransport || (typeof XMLHttpRequest !== 'undefined' ? xhrTransport : null);
  const inflight = new Map();

  const fetchTransport = (url, init) =>
    fetchImpl(url, { method: init.method, body: init.body, headers: init.headers, signal: init.signal, cache: 'no-store' });

  async function request(method, path, o = {}) {
    const timeout = o.timeout || 20000;
    const retries = o.retries == null ? 3 : o.retries;
    const expect = o.expect || 'json';
    const label = o.label || path;
    const transport = fixtureTransport || o.transport || fetchTransport;
    const emit = (type, extra) => {
      const ev = { type, label, method, path, ...extra };
      for (const fn of [o.onEvent, cfg.onEvent]) {
        if (!fn) continue;
        try {
          fn(ev);
        } catch {
          /* a listener must never break a request */
        }
      }
    };

    let attempt = 0;
    for (;;) {
      attempt += 1;
      if (o.signal && o.signal.aborted) {
        emit('aborted', { attempt });
        throw new ApiError('aborted', 'Cancelled');
      }
      emit('attempt', { attempt, of: retries + 1 });

      const ctl = new AbortController();
      let timedOut = false;
      const arm = () =>
        setTimer(() => {
          timedOut = true;
          ctl.abort();
        }, timeout);
      let timer = arm();
      const touch = () => {
        clearTimer(timer);
        timer = arm();
      };
      const onAbort = () => ctl.abort();
      if (o.signal) o.signal.addEventListener('abort', onAbort, { once: true });

      let outcome;
      try {
        const res = await transport(base + '/' + path, {
          method,
          body: o.body,
          headers: o.headers,
          signal: ctl.signal,
          onProgress: o.onProgress
            ? (p) => {
                touch();
                o.onProgress(p);
              }
            : undefined,
        });
        if (res.ok) {
          let data = null;
          if (expect === 'json') data = await res.json();
          else if (expect === 'blob') data = { blob: await res.blob(), filename: filenameFromResponse(res) };
          outcome = { data };
        } else {
          const err = await errorFromResponse(res, path);
          // A rate-limited or busy server may say how long to wait; that beats our own guess.
          const wait = Number(res.headers && res.headers.get ? res.headers.get('retry-after') : NaN);
          if (Number.isFinite(wait) && wait > 0) err.retryAfterMs = Math.min(60000, Math.round(wait * 1000));
          outcome = RETRY_STATUS.has(res.status) ? { retry: err } : { fatal: err };
        }
      } catch (e) {
        if (o.signal && o.signal.aborted) outcome = { fatal: new ApiError('aborted', 'Cancelled') };
        else if (timedOut) outcome = { retry: new ApiError('timeout', 'Timed out', { timeoutMs: timeout }) };
        else outcome = { retry: new ApiError('network', String((e && e.message) || e)) };
      } finally {
        clearTimer(timer);
        if (o.signal) o.signal.removeEventListener('abort', onAbort);
      }

      if ('data' in outcome) {
        emit('success', { attempt });
        return outcome.data;
      }
      if (outcome.fatal) {
        outcome.fatal.attempts = attempt;
        emit(outcome.fatal.kind === 'aborted' ? 'aborted' : 'error', { attempt, status: outcome.fatal.status });
        throw outcome.fatal;
      }
      const err = outcome.retry;
      err.attempts = attempt;
      if (attempt > retries) {
        emit('fail', { attempt, reason: err.kind, status: err.status });
        throw err;
      }
      const delayMs = err.retryAfterMs || backoffDelay(attempt, { random, base: cfg.backoffBase, cap: cfg.backoffCap });
      emit('retry', { attempt: attempt + 1, of: retries + 1, delayMs, reason: err.kind, status: err.status });
      try {
        await sleep(delayMs, o.signal);
      } catch {
        emit('aborted', { attempt });
        throw new ApiError('aborted', 'Cancelled');
      }
    }
  }

  // Identical requests that are already in flight share one promise, so a double click or an
  // impatient second press never doubles the work.
  function shared(key, run) {
    if (inflight.has(key)) return inflight.get(key);
    const p = run().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function settingsFields(s = {}) {
    const out = {};
    if (s.name) out.name = String(s.name);
    for (const [from, to] of [
      ['latitude', 'latitude'],
      ['longitude', 'longitude'],
      ['baseStart', 'base_start'],
      ['baseEnd', 'base_end'],
    ]) {
      if (s[from] !== undefined && s[from] !== null && s[from] !== '') out[to] = Number(s[from]);
    }
    return out;
  }

  function exportQuery({ format, frequency, indices }) {
    const p = new URLSearchParams();
    p.set('format', format);
    if (frequency) p.set('frequency', frequency);
    if (indices && indices.length) p.set('indices', indices.join(','));
    return p.toString();
  }

  const id = (v) => encodeURIComponent(v);

  return {
    fixtures,
    request,
    health: (o) => request('GET', 'health', { timeout: TIMEOUTS.health, retries: 0, label: 'health', ...o }),
    version: (o) => request('GET', 'version', { timeout: TIMEOUTS.version, retries: 2, label: 'version', ...o }),
    // The server's own limits (upload size, how long data is kept). Older servers answer 404.
    limits: (o) => request('GET', 'limits', { timeout: TIMEOUTS.version, retries: 1, label: 'limits', ...o }),
    indices: (o) =>
      shared('indices', () => request('GET', 'indices', { timeout: TIMEOUTS.indices, label: 'indices', ...o })),
    getDataset: (dsId, o) =>
      request('GET', 'datasets/' + id(dsId), { timeout: TIMEOUTS.dataset, label: 'dataset', ...o }),
    createSample: (settings, o) => {
      const fields = settingsFields(settings);
      delete fields.name;
      return request('POST', 'datasets/sample', {
        timeout: TIMEOUTS.sample,
        label: 'sample',
        body: JSON.stringify(fields),
        headers: { 'Content-Type': 'application/json' },
        ...o,
      });
    },
    upload: (file, settings, o) => {
      const form = typeof FormData !== 'undefined' ? new FormData() : null;
      if (form) {
        form.append('file', file, file.name);
        const fields = settingsFields(settings);
        for (const k of Object.keys(fields)) form.append(k, String(fields[k]));
      }
      return request('POST', 'datasets', {
        timeout: TIMEOUTS.upload,
        label: 'upload',
        body: form,
        transport: uploadTransport || undefined,
        ...o,
      });
    },
    daily: (dsId, variable, o) =>
      shared('daily:' + dsId + ':' + variable, () =>
        request('GET', 'datasets/' + id(dsId) + '/daily?variable=' + id(variable), {
          timeout: TIMEOUTS.daily,
          label: 'daily',
          ...o,
        }),
      ),
    compute: (dsId, indices, frequency, o) => {
      const body = JSON.stringify({ indices, frequency });
      return shared('compute:' + dsId + ':' + body, () =>
        request('POST', 'datasets/' + id(dsId) + '/compute', {
          timeout: TIMEOUTS.compute,
          retries: 2,
          label: 'compute',
          body,
          headers: { 'Content-Type': 'application/json' },
          ...o,
        }),
      );
    },
    // Runs quality control again with changed thresholds; answers with the new qc object.
    rerunQc: (dsId, thresholds, o) =>
      request('POST', 'datasets/' + id(dsId) + '/qc', {
        timeout: TIMEOUTS.sample,
        label: 'qc',
        body: JSON.stringify(thresholds),
        headers: { 'Content-Type': 'application/json' },
        ...o,
      }),
    exportUrl: (dsId, params) => base + '/datasets/' + id(dsId) + '/export?' + exportQuery(params),
    exportFile: (dsId, params, o) =>
      request('GET', 'datasets/' + id(dsId) + '/export?' + exportQuery(params), {
        timeout: TIMEOUTS.export,
        label: 'export',
        expect: 'blob',
        ...o,
      }),
    // Deleting something that is already gone counts as success.
    remove: async (dsId, o) => {
      try {
        await request('DELETE', 'datasets/' + id(dsId), {
          timeout: TIMEOUTS.remove,
          label: 'remove',
          expect: 'none',
          ...o,
        });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 404)) throw e;
      }
      return true;
    },
  };
}

// Reduces the stream of request events to one of four connection states.
export function createConnection(onChange) {
  let state = 'unknown';
  let info = null;
  const set = (next, extra = null) => {
    if (next === state && next !== 'retrying') return;
    state = next;
    info = extra;
    if (onChange) onChange(state, info);
  };
  return {
    get state() {
      return state;
    },
    get info() {
      return info;
    },
    set,
    handle(ev) {
      // An HTTP error reply still proves the link works, so it counts as "online".
      if (ev.type === 'success' || ev.type === 'error') set('online');
      else if (ev.type === 'retry') set('retrying', { attempt: ev.attempt, of: ev.of, delayMs: ev.delayMs });
      else if (ev.type === 'fail') set('offline');
    },
  };
}
