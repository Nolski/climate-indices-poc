// Application shell: state, step navigation, language, connection status, session restore.
// The four steps live in view-*.js; each exports init(ctx) and render(ctx).

import { createClient, createConnection, ApiError, resolveApi, siteConfig, readLimits, DEFAULT_LIMITS } from './api.js';
import { createI18n, LANGUAGES, pickLanguage } from './i18n.js';
import { createFormat } from './format.js';
import { safeStorage, createStore } from './store.js';
import { $, h, replace, show } from './dom.js';
import * as viewLoad from './view-load.js';
import * as viewQc from './view-qc.js';
import * as viewIndices from './view-indices.js';
import * as viewResults from './view-results.js';

const VIEWS = { 1: viewLoad, 2: viewQc, 3: viewIndices, 4: viewResults };

async function fetchJson(url, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}

// How often the page quietly checks whether an unreachable server has come back.
const RECHECK_MS = 60000;

export async function boot(overrides = {}) {
  const params = new URLSearchParams(location.search);
  // Which API, and whether this page shows the demonstration (saved example results):
  //   'forced'       ?fixtures=1 in the address
  //   'only'         the site was published without an API (config.demoOnly)
  //   'unreachable'  a separately hosted API did not answer; the page fell back by itself
  //   ''             normal operation
  const site = resolveApi(overrides.config || siteConfig, location.search);
  const forced = params.get('fixtures') === '1';
  const simulate = forced ? params.get('simulate') || '' : '';
  const store = createStore(
    safeStorage(() => window.sessionStorage),
    safeStorage(() => window.localStorage),
  );
  const i18n = createI18n({ loadJson: fetchJson });

  const state = {
    demo: forced ? 'forced' : site.demoOnly ? 'only' : '',
    fixtures: forced || site.demoOnly,
    uploadsInDemo: simulate === 'badfile', // the one developer switch that needs a pretend upload
    probing: false, // true while the first check of a separately hosted API is under way
    serverBack: false,
    limits: { ...DEFAULT_LIMITS }, // upload size and retention of the server in use (GET /api/limits)
    version: null,
    indices: null,
    indicesError: null,
    dataset: null,
    source: null, // 'sample' | 'file'
    file: null, // the File object, kept so an expired dataset can be re-uploaded in one click
    fileName: '',
    settings: { name: '', latitude: '', longitude: '', baseStart: '1971', baseEnd: '2000' },
    loadedKey: '',
    loadedAt: 0,
    expiresAt: 0, // when the server will delete the dataset (it counts from loading, not from last use)
    qcDefaults: null, // the server's default thresholds, kept so they can be restored
    selection: new Set(),
    selectionTouched: false,
    frequency: 'annual',
    result: null,
    computedAt: 0,
    step: 1,
    visited: 1,
    expired: false,
    resume: null,
  };

  const ctx = {
    state,
    store,
    i18n,
    t: i18n.t,
    tn: i18n.tn,
    fmt: null,
    api: null,
    actions: {},
    go,
    canGo,
    refresh,
    announce,
    describeError,
    setDataset,
    clearDataset,
    markExpired,
    persist: () => store.saveSession(state),
    ensureIndices,
    stationName: () => state.settings.name || (state.dataset && state.dataset.station && state.dataset.station.name) || '',
  };

  // ---------- connection indicator ----------
  let pollTimer = 0;
  let pollDelay = 5000;
  const conn = createConnection((name) => {
    paintConnection();
    if (name === 'offline') schedulePoll();
    if (name === 'online') {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = 0;
        announce(i18n.t('conn.restored'));
      }
      pollDelay = 5000;
    }
  });

  function paintConnection() {
    const el = $('conn');
    const name = conn.state;
    let key = 'conn.' + name;
    let iconName = { online: 'check', retrying: 'retry', offline: 'error', unknown: 'info' }[name] || 'info';
    if (state.demo && (name === 'online' || name === 'unknown')) {
      key = state.demo === 'unreachable' ? 'conn.demoUnreachable' : 'conn.demo';
      iconName = state.demo === 'unreachable' ? 'warning' : 'info';
    } else if (state.probing && name === 'unknown') key = 'conn.unknown';
    el.className = 'conn conn-' + name + (state.demo === 'unreachable' ? ' conn-away' : '');
    $('conn-icon').setAttribute('href', '#i-' + iconName);
    const info = conn.info || {};
    $('conn-text').textContent = i18n.t(key, {
      attempt: info.attempt ? ctx.fmt.int(info.attempt) : '',
      of: info.of ? ctx.fmt.int(info.of) : '',
    });
  }

  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = setTimeout(async () => {
      pollTimer = 0;
      try {
        await ctx.api.health();
        announce(i18n.t('conn.restored'));
      } catch {
        pollDelay = Math.min(30000, pollDelay * 2);
        schedulePoll();
      }
    }, pollDelay);
  }

  // Two clients over the same code: the real API, and the saved examples. Requests never carry
  // cookies or credentials, so a separately hosted API needs no credentialed CORS.
  const liveApi = createClient({ base: site.base, onEvent: (ev) => conn.handle(ev) });
  let demoApi = null;
  const getDemoApi = () => demoApi || (demoApi = createClient({ fixtures: true, simulate, onEvent: (ev) => conn.handle(ev) }));
  // Quiet health checks that must not move the connection indicator.
  const probeApi = createClient({ base: site.base });
  ctx.api = state.demo ? getDemoApi() : liveApi;
  ctx.site = site;
  store.setMode(Boolean(state.demo));

  window.addEventListener('offline', () => conn.set('offline'));
  window.addEventListener('online', () => {
    ctx.api.health().catch(() => {});
  });

  // ---------- helpers shared with the views ----------
  const RETRYABLE_AFTER = new Set([408, 425, 429]);
  let liveTimer = 0;
  function announce(text) {
    const live = $('live');
    live.textContent = '';
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      live.textContent = text;
    }, 60);
  }

  // Turns any failure into words: the server's own message when there is one, otherwise a plain
  // explanation of what went wrong with the connection. Never a bare "failed".
  function describeError(err, context = '') {
    const t = i18n.t;
    if (!(err instanceof ApiError)) return { message: t('error.unexpected', { detail: String((err && err.message) || err) }), details: [], hint: '' };
    if (err.kind === 'aborted') return { message: t('error.cancelled'), details: [], hint: '' };
    if (err.kind === 'timeout') {
      return { message: t('error.timeout', { seconds: ctx.fmt.int(err.timeoutMs / 1000), attempts: ctx.fmt.int(err.attempts) }), details: [], hint: t('error.keptHint') };
    }
    if (err.kind === 'network') {
      return { message: t('error.network', { attempts: ctx.fmt.int(err.attempts) }), details: [], hint: t('error.keptHint') };
    }
    const details = err.details.map((d) => {
      if (typeof d === 'string') return d;
      if (d && typeof d === 'object') {
        if (d.message) return (d.field ? d.field + ': ' : '') + String(d.message);
        return Object.keys(d).map((k) => k + ': ' + d[k]).join(', ');
      }
      return String(d);
    });
    let message = err.serverMessage && err.message ? err.message : t('error.http', { status: err.status });
    let hint = '';
    if (err.code === 'fixture_missing') message = t('error.fixtureMissing');
    else if (err.code === 'fixtures_no_export') message = t('error.fixturesNoExport');
    else if (err.status === 413) hint = t('error.hint.tooLarge', { n: ctx.fmt.int(state.limits.maxUploadMb) });
    else if (context === 'upload' && (err.status === 400 || err.status === 422)) hint = t('error.hint.file');
    else if (err.status >= 500) hint = t('error.hint.server');
    else if (RETRYABLE_AFTER.has(err.status)) hint = t('error.keptHint');
    return { message, details, hint };
  }
  function settingsKey() {
    const s = state.settings;
    const parts = [s.latitude, s.longitude, s.baseStart, s.baseEnd];
    if (state.source !== 'sample') parts.push(s.name);
    return parts.map((v) => String(v).trim()).join('|');
  }
  ctx.settingsKey = settingsKey;

  function setDataset(ds, { source, fileName, restored = false } = {}) {
    state.dataset = ds;
    state.source = source || state.source;
    state.fileName = fileName !== undefined ? fileName : state.fileName;
    if (!restored) {
      state.loadedAt = Date.now();
      if (ds.station) {
        if (ds.station.name && (state.source !== 'sample' || !state.settings.name)) state.settings.name = ds.station.name;
        if (ds.station.latitude != null) state.settings.latitude = String(ds.station.latitude);
        if (ds.station.longitude != null) state.settings.longitude = String(ds.station.longitude);
      }
      if (ds.base_period) {
        state.settings.baseStart = String(ds.base_period.start);
        state.settings.baseEnd = String(ds.base_period.end);
      }
      // A newly loaded dataset has a new id: results calculated from the old one are dropped.
      state.result = null;
      state.computedAt = 0;
      store.saveResult(null);
    }
    state.expiresAt = Date.now() + (ds.expires_in_seconds != null ? ds.expires_in_seconds : 3600) * 1000;
    if (!restored || !state.qcDefaults) state.qcDefaults = ds.qc && ds.qc.settings ? { ...ds.qc.settings } : null;
    state.loadedKey = settingsKey();
    state.expired = false;
    show($('notice-expired'), false);
    if (!state.selectionTouched) state.selection = new Set();
    store.saveSession(state);
  }

  function clearDataset() {
    state.dataset = null;
    state.source = null;
    state.result = null;
    state.computedAt = 0;
    state.loadedAt = 0;
    state.expiresAt = 0;
    state.qcDefaults = null;
    state.loadedKey = '';
    state.expired = false;
    state.resume = null;
    state.visited = 1;
    show($('notice-expired'), false);
    show($('notice-session'), false);
    store.clearSession();
  }

  // The server no longer has the dataset (60 minutes passed, or it restarted). Say so and offer
  // the shortest way back. `resume` names what to redo afterwards ('compute').
  function markExpired(resume = null) {
    state.expired = true;
    state.resume = resume;
    paintExpired();
    announce(i18n.t('expired.title'));
  }

  function paintExpired() {
    const box = $('notice-expired');
    if (!state.expired) return show(box, false);
    const t = i18n.t;
    const actions = [];
    if (state.source === 'sample') {
      actions.push(h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => ctx.actions.reload() }, t('expired.reloadSample')));
    } else if (state.file) {
      actions.push(h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => ctx.actions.reload() }, t('expired.reupload', { name: state.file.name })));
    }
    actions.push(h('button', { type: 'button', class: 'btn btn-small', onclick: () => go(1) }, t('expired.choose')));
    replace(
      box,
      h('p', null, h('strong', { text: t('expired.title') }), ' ', state.file || state.source === 'sample' ? t('expired.bodyHeld', { minutes: ctx.fmt.int(state.limits.ttlMinutes) }) : t('expired.bodyNotHeld', { minutes: ctx.fmt.int(state.limits.ttlMinutes), name: state.fileName || t('expired.yourFile') })),
      h('div', { class: 'status-actions' }, actions),
    );
    show(box, true);
  }

  // ---------- indices list (cached) ----------
  let indicesPromise = null;
  function ensureIndices(force = false) {
    if (indicesPromise && !force) return indicesPromise;
    if (!state.indices) {
      const cached = store.loadIndices();
      if (cached) state.indices = cached.indices;
    }
    const asked = ctx.api;
    indicesPromise = asked
      .indices()
      .then((res) => {
        if (ctx.api !== asked) return state.indices || [];
        const list = (res && res.indices) || [];
        const changed = JSON.stringify(list) !== JSON.stringify(state.indices);
        state.indices = list;
        state.indicesError = null;
        store.saveIndices(list, state.version && state.version.app);
        if (changed && state.step === 3) viewIndices.render(ctx);
        if (changed && state.step === 4) viewResults.render(ctx);
        return list;
      })
      .catch((err) => {
        if (ctx.api !== asked) return state.indices || [];
        indicesPromise = null;
        state.indicesError = err;
        if (state.step === 3) viewIndices.render(ctx);
        if (!state.indices) throw err;
        return state.indices;
      });
    return indicesPromise;
  }

  // ---------- steps ----------
  function canGo(step) {
    if (step === 1) return true;
    if (step === 2 || step === 3) return Boolean(state.dataset);
    return Boolean(state.dataset && state.result);
  }

  function paintStepper() {
    const t = i18n.t;
    for (const btn of document.querySelectorAll('#stepper .step-btn')) {
      const n = Number(btn.getAttribute('data-step'));
      const current = n === state.step;
      const open = canGo(n);
      const done = !current && open && (n === 1 ? Boolean(state.dataset) : n === 3 ? Boolean(state.result) : n < state.visited);
      if (current) btn.setAttribute('aria-current', 'step');
      else btn.removeAttribute('aria-current');
      if (open) btn.removeAttribute('aria-disabled');
      else btn.setAttribute('aria-disabled', 'true');
      btn.classList.toggle('is-done', done);
      $('step-state-' + n).textContent = current ? t('steps.state.current') : !open ? t('steps.state.locked') : done ? t('steps.state.done') : t('steps.state.open');
    }
  }

  function go(step, opts = {}) {
    if (!canGo(step)) {
      announce(i18n.t(step === 4 ? 'steps.needResult' : 'steps.needData'));
      return false;
    }
    state.step = step;
    state.visited = Math.max(state.visited, step);
    for (const n of [1, 2, 3, 4]) show($('step-' + n), n === step);
    paintStepper();
    VIEWS[step].render(ctx);
    store.saveSession(state);
    if (opts.focus !== false) {
      const heading = $('h-step-' + step);
      try {
        window.scrollTo(0, 0);
      } catch {
        /* not available in every environment */
      }
      heading.focus();
    }
    return true;
  }

  function refresh() {
    paintStepper();
    paintConnection();
    paintDemo();
    paintExpired();
    paintVersions();
    VIEWS[state.step].render(ctx);
  }

  function paintVersions() {
    const v = state.version;
    const text = v ? i18n.t('footer.versions', { app: v.app || '?', xclim: v.xclim || '?', python: v.python || '?' }) : i18n.t('footer.versionsUnknown');
    $('versions').textContent = state.demo && v ? i18n.t('demo.versions', { versions: text }) : text;
  }

  // ---------- demonstration mode ----------
  let recheckTimer = 0;
  let lastCheck = '';
  let checking = false;

  // The notice above every step, and the short tag in the step bar that stays in view.
  function paintDemo() {
    const t = i18n.t;
    const box = $('notice-demo');
    const tag = $('demo-tag');
    if (!state.demo) {
      show(box, false);
      show(tag, false);
      return;
    }
    tag.textContent = t('demo.tag');
    show(tag, true);
    const parts = [h('p', { text: t(state.demo === 'unreachable' ? (state.serverBack ? 'demo.back' : 'demo.unreachable') : state.demo === 'only' ? 'demo.only' : 'notice.demo') })];
    if (state.demo === 'unreachable') {
      parts.push(
        h(
          'div',
          { class: 'status-actions' },
          h('button', { type: 'button', class: 'btn btn-small btn-primary', id: 'btn-server-retry', disabled: checking, onclick: () => retryServer(true) }, checking ? t('demo.checking') : state.serverBack ? t('demo.useServer') : t('demo.retry')),
          lastCheck && !state.serverBack ? h('span', { class: 'hint', text: lastCheck }) : null,
        ),
      );
    }
    box.className = 'notice ' + (state.demo === 'unreachable' ? 'notice-warning' : 'notice-info');
    replace(box, parts);
    show(box, true);
  }

  function forgetWork() {
    state.dataset = null;
    state.source = null;
    state.file = null;
    state.fileName = '';
    state.result = null;
    state.computedAt = 0;
    state.loadedAt = 0;
    state.expiresAt = 0;
    state.qcDefaults = null;
    state.loadedKey = '';
    state.expired = false;
    state.resume = null;
    state.visited = 1;
    state.selection = new Set();
    state.selectionTouched = false;
    state.settings = { name: '', latitude: '', longitude: '', baseStart: '1971', baseEnd: '2000' };
    state.indices = null;
    state.indicesError = null;
    state.version = null;
    indicesPromise = null;
    show($('notice-expired'), false);
    show($('notice-session'), false);
  }

  function loadBasics() {
    const asked = ctx.api;
    asked
      .version()
      .then((v) => {
        if (ctx.api !== asked) return;
        state.version = v;
        paintVersions();
      })
      .catch(() => {});
    // The limits of the server actually in use; the demonstration has no server, so it keeps the defaults.
    state.limits = { ...DEFAULT_LIMITS };
    if (!state.demo) {
      asked
        .limits()
        .then((body) => {
          if (ctx.api !== asked) return;
          state.limits = readLimits(body);
          VIEWS[state.step].render(ctx);
          paintExpired();
        })
        .catch(() => {});
    }
    ensureIndices().catch(() => {});
  }

  // Switches between the real API and the saved examples. What was on screen belongs to the
  // other mode and is put aside (a real session stays in sessionStorage for when the server is
  // back; it is never shown as if it were the demonstration, or the other way round).
  async function switchMode(demo) {
    state.demo = demo;
    state.fixtures = Boolean(demo);
    state.serverBack = false;
    ctx.api = demo ? getDemoApi() : liveApi;
    store.setMode(Boolean(demo));
    forgetWork();
    conn.set(demo ? 'unknown' : 'online');
    clearTimeout(recheckTimer);
    recheckTimer = 0;
    if (demo === 'unreachable') scheduleRecheck();
    go(1, { focus: false });
    refresh();
    loadBasics();
    await restoreSession();
  }

  function scheduleRecheck() {
    clearTimeout(recheckTimer);
    recheckTimer = setTimeout(() => retryServer(false), overrides.recheckMs || RECHECK_MS);
  }

  async function serverAnswers() {
    try {
      const res = await probeApi.health({ retries: 0, timeout: 6000 });
      return Boolean(res && res.status === 'ok');
    } catch {
      return false;
    }
  }

  // "Try the server again". A press by the person switches back as soon as the server answers;
  // the quiet background check only changes the notice, because the page must never be pulled
  // from under someone who is looking at it.
  async function retryServer(byPerson) {
    if (state.demo !== 'unreachable' || checking) return;
    if (byPerson && state.serverBack) return leaveDemo();
    checking = true;
    if (byPerson) paintDemo();
    const up = await serverAnswers();
    checking = false;
    if (state.demo !== 'unreachable') return;
    if (up && byPerson) return leaveDemo();
    state.serverBack = up;
    lastCheck = up ? '' : i18n.t('demo.stillDown', { time: ctx.fmt.clock(new Date()) });
    paintDemo();
    if (up) announce(i18n.t('demo.back'));
    else {
      if (byPerson) announce(lastCheck);
      scheduleRecheck();
    }
  }

  async function leaveDemo() {
    await switchMode('');
    announce(i18n.t('demo.left'));
  }

  // ---------- language ----------
  async function setLanguage(code, save = true) {
    const used = await i18n.use(code);
    ctx.fmt = createFormat(used, i18n.t, i18n.has);
    document.documentElement.lang = used;
    document.documentElement.dir = i18n.dir;
    document.title = i18n.t('app.title');
    i18n.apply(document);
    const select = $('lang-select');
    replace(
      select,
      LANGUAGES.map((l) => h('option', { value: l.code, lang: l.code }, l.label + (l.draft ? ' (' + i18n.t('lang.draft') + ')' : ''))),
    );
    select.value = used;
    show($('notice-draft'), i18n.draft);
    paintDemo();
    if (save) store.saveLang(used);
    return used;
  }

  // ---------- start ----------
  const wanted = pickLanguage([params.get('lang'), store.loadLang(), ...(navigator.languages || [navigator.language])]);
  try {
    await setLanguage(wanted, false);
  } catch {
    const box = $('notice-boot');
    box.textContent = 'The page could not finish loading because the connection dropped. Please reload the page to try again.';
    show(box, true);
    return ctx;
  }

  for (const n of [1, 2, 3, 4]) VIEWS[n].init(ctx);

  $('stepper').addEventListener('click', (ev) => {
    const btn = ev.target.closest('.step-btn');
    if (btn) go(Number(btn.getAttribute('data-step')));
  });
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-go]');
    if (btn) go(Number(btn.getAttribute('data-go')));
  });
  $('lang-select').addEventListener('change', async (ev) => {
    try {
      await setLanguage(ev.target.value);
      refresh();
      announce(i18n.t('lang.changed'));
    } catch {
      ev.target.value = i18n.lang;
      announce(i18n.t('lang.failed'));
    }
  });
  // Warn before closing the tab only while something is still being sent or calculated.
  window.addEventListener('beforeunload', (ev) => {
    if (state.busy) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  if (site.ignoredParam) {
    const box = $('notice-boot');
    box.textContent = i18n.t('notice.apiIgnored');
    show(box, true);
  }

  // A separately hosted API can be away while this page is not. Ask it once before anything
  // else; if it does not answer, carry on with the demonstration and say so. When the API is
  // on the same server as the page (apiBase empty) nothing is asked and nothing changes.
  if (!state.demo && site.apiBase) {
    state.probing = true;
    refresh();
    let up = await serverAnswers();
    if (!up) up = await serverAnswers();
    state.probing = false;
    if (!up) {
      await switchMode('unreachable');
      return ctx;
    }
    conn.set('online');
  }

  refresh();
  loadBasics();
  await restoreSession();
  return ctx;

  // An accidental reload should not lose the session: the dataset id and the choices made so
  // far are in sessionStorage, and the dataset itself is still in the server's memory.
  async function restoreSession() {
    const saved = store.loadSession();
    if (!saved) return;
    const t = i18n.t;
    const box = $('notice-session');
    state.source = saved.source || null;
    state.fileName = saved.fileName || '';
    if (saved.settings) state.settings = { ...state.settings, ...saved.settings };
    state.selection = new Set(saved.selection || []);
    state.selectionTouched = Boolean(saved.selectionTouched);
    state.frequency = saved.frequency === 'monthly' ? 'monthly' : 'annual';
    state.loadedAt = saved.loadedAt || 0;
    replace(box, h('p', { text: t('session.restoring') }));
    show(box, true);
    try {
      const ds = await ctx.api.getDataset(saved.datasetId);
      setDataset(ds, { restored: true });
      const cached = store.loadResult(ds.id);
      if (cached) {
        state.result = cached.result;
        state.computedAt = cached.computedAt || 0;
      }
      state.visited = Math.max(1, Math.min(4, saved.step || 1));
      let step = saved.step || 2;
      if (step === 4 && !state.result) step = 3;
      replace(
        box,
        h('p', { text: t('session.restored', { name: ctx.stationName() }) }),
      );
      go(canGo(step) ? step : 1, { focus: false });
      setTimeout(() => show(box, false), 12000);
    } catch (err) {
      if (err instanceof ApiError && err.expired) {
        show(box, false);
        VIEWS[1].render(ctx);
        markExpired();
        return;
      }
      const d = describeError(err);
      replace(
        box,
        h('p', null, h('strong', { text: t('session.failed') }), ' ', d.message),
        h(
          'div',
          { class: 'status-actions' },
          h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: restoreSession }, t('common.retry')),
          h(
            'button',
            {
              type: 'button',
              class: 'btn btn-small',
              onclick: () => {
                store.clearSession();
                show(box, false);
              },
            },
            t('session.forget'),
          ),
        ),
      );
    }
  }
}

if (typeof document !== 'undefined' && !globalThis.__CLIMPOC_NO_AUTOBOOT__) {
  boot().catch((err) => {
    const box = document.getElementById('notice-boot');
    if (box) {
      box.textContent = 'The page could not start: ' + String((err && err.message) || err) + '. Please reload the page.';
      box.hidden = false;
    }
  });
}
