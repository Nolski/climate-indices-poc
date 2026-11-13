// Step 1: choose a station file (or the sample), describe the station, send it to the server.

import { $, h, replace, icon, show, createStatus } from './dom.js';
import { precheckStationText } from './shape.js';

// The upload limit of the server in use (20 MB unless GET /api/limits says otherwise).
const maxBytes = (ctx) => ctx.state.limits.maxUploadMb * 1024 * 1024;

let status = null;
let busy = false;
let aborter = null;
let precheck = null; // result for the currently chosen file
let deleteStatus = null;

const FIELDS = { name: 'f-name', latitude: 'f-lat', longitude: 'f-lon', baseStart: 'f-base-start', baseEnd: 'f-base-end' };

export function init(ctx) {
  const { state } = ctx;
  status = createStatus($('upload-status'), ctx);
  const input = $('file-input');
  const drop = $('drop');

  $('btn-choose').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) setFile(ctx, input.files[0]);
    input.value = '';
  });

  let depth = 0;
  drop.addEventListener('dragenter', (ev) => {
    ev.preventDefault();
    depth += 1;
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragover', (ev) => ev.preventDefault());
  drop.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) drop.classList.remove('is-over');
  });
  drop.addEventListener('drop', (ev) => {
    ev.preventDefault();
    depth = 0;
    drop.classList.remove('is-over');
    const files = ev.dataTransfer && ev.dataTransfer.files;
    if (files && files[0]) setFile(ctx, files[0]);
  });
  // A file dropped beside the drop area must not make the browser leave the page.
  window.addEventListener('dragover', (ev) => ev.preventDefault());
  window.addEventListener('drop', (ev) => ev.preventDefault());

  for (const key of Object.keys(FIELDS)) {
    $(FIELDS[key]).addEventListener('input', (ev) => {
      state.settings[key] = ev.target.value;
      validate(ctx, false);
      paintActions(ctx);
      ctx.persist();
    });
  }
  $('settings-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!$('btn-upload').disabled) submit(ctx);
  });
  $('btn-upload').addEventListener('click', () => submit(ctx));
  $('btn-sample').addEventListener('click', () => loadSample(ctx));

  ctx.actions.reload = () => {
    if (state.source === 'sample') return loadSample(ctx);
    if (state.file) return upload(ctx);
    return ctx.go(1);
  };
}

function isDirty(ctx) {
  const { state } = ctx;
  return Boolean(state.dataset) && ctx.settingsKey() !== state.loadedKey;
}

// The chosen file differs from the one the loaded dataset came from.
function isNewFile(ctx) {
  const { state } = ctx;
  return Boolean(state.file) && (!state.dataset || state.source !== 'file' || state.pendingFile === true);
}

function submit(ctx) {
  const { state } = ctx;
  if (isNewFile(ctx) || (state.source === 'file' && state.file)) return upload(ctx);
  if (state.source === 'sample') return loadSample(ctx);
  return undefined;
}

// Returns true when the form can be sent. With `focus`, moves to the first field in error.
function validate(ctx, focus) {
  const { state, t } = ctx;
  const s = state.settings;
  const problems = [];
  const check = (key, errId, message, also = []) => {
    const el = $(FIELDS[key]);
    const err = $(errId);
    if (message) {
      el.setAttribute('aria-invalid', 'true');
      for (const k of also) $(FIELDS[k]).setAttribute('aria-invalid', 'true');
      err.textContent = message;
      show(err, true);
      problems.push(el);
    } else {
      el.removeAttribute('aria-invalid');
      for (const k of also) $(FIELDS[k]).removeAttribute('aria-invalid');
      err.textContent = '';
      show(err, false);
    }
  };
  const num = (v) => (String(v).trim() === '' ? null : Number(v));
  const lat = num(s.latitude);
  const lon = num(s.longitude);
  check('latitude', 'f-lat-err', lat !== null && !(lat >= -90 && lat <= 90) ? t('load.lat.error') : '');
  check('longitude', 'f-lon-err', lon !== null && !(lon >= -180 && lon <= 180) ? t('load.lon.error') : '');
  const b0 = num(s.baseStart);
  const b1 = num(s.baseEnd);
  let baseMsg = '';
  if (b0 === null || b1 === null || !Number.isInteger(b0) || !Number.isInteger(b1)) baseMsg = t('load.base.errorYears');
  else if (b0 >= b1) baseMsg = t('load.base.errorOrder');
  check('baseStart', 'f-base-err', baseMsg, ['baseEnd']);
  if (focus && problems.length && !problems[0].disabled) problems[0].focus();
  return problems.length === 0;
}

async function readText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

// In the demonstration nothing can be uploaded (there is no server to send it to).
const uploadsOff = (ctx) => Boolean(ctx.state.demo) && !ctx.state.uploadsInDemo;

async function setFile(ctx, file) {
  const { state } = ctx;
  if (uploadsOff(ctx)) return;
  state.file = file;
  state.pendingFile = true;
  precheck = null;
  status.clear();
  if (!state.settings.name || state.source === 'sample' || state.settings.name === stem(state.fileName)) {
    state.settings.name = stem(file.name);
  }
  render(ctx);
  ctx.announce(ctx.t('load.file.chosen', { name: file.name }));
  if (file.size <= maxBytes(ctx)) {
    try {
      const result = precheckStationText(await readText(file));
      if (state.file === file) {
        precheck = result;
        paintFile(ctx);
      }
    } catch {
      precheck = null;
    }
  }
}

const stem = (name) => String(name || '').replace(/\.[^.]+$/, '');

function begin(ctx, message, slowText) {
  busy = true;
  ctx.state.busy = true;
  aborter = new AbortController();
  status.busy(message, { slowAfter: 20, slowText, onCancel: () => aborter.abort() });
  paintActions(ctx);
  return {
    signal: aborter.signal,
    onEvent: (ev) => {
      if (ev.type === 'retry') status.retrying(ev);
      else if (ev.type === 'attempt') status.attempt();
    },
  };
}

function end(ctx) {
  busy = false;
  ctx.state.busy = false;
  aborter = null;
  show($('upload-progress'), false);
  paintActions(ctx);
}

function loaded(ctx, ds, source, fileName) {
  const { state, t } = ctx;
  const resume = state.resume;
  state.resume = null;
  state.pendingFile = false;
  ctx.setDataset(ds, { source, fileName });
  status.clear();
  render(ctx); // the form now shows the values the server actually used
  ctx.announce(t('load.done', { name: ctx.stationName() }));
  if (resume === 'compute' && ctx.actions.calculate) {
    ctx.go(3);
    ctx.actions.calculate();
  } else ctx.go(2);
}

function failed(ctx, err, retry, context) {
  const { t } = ctx;
  if (err && err.kind === 'aborted') {
    status.clear();
    ctx.announce(t('error.cancelled'));
    return;
  }
  const d = ctx.describeError(err, context);
  const actions = [{ label: t('common.retry'), onClick: retry, primary: true }];
  if (context === 'upload') actions.push({ label: t('load.chooseOther'), onClick: () => $('file-input').click() });
  status.error(d.message, { details: d.details, hint: d.hint, actions });
}

async function upload(ctx) {
  const { state, t, fmt, api } = ctx;
  if (busy || !state.file || uploadsOff(ctx)) return;
  if (!validate(ctx, true)) return;
  const file = state.file;
  if (file.size > maxBytes(ctx)) {
    status.error(t('load.error.tooLarge', { size: fmt.bytes(file.size), limit: fmt.bytes(maxBytes(ctx)) }), {
      actions: [{ label: t('load.chooseOther'), onClick: () => $('file-input').click(), primary: true }],
    });
    return;
  }
  if (file.size === 0) {
    status.error(t('load.error.empty'), { actions: [{ label: t('load.chooseOther'), onClick: () => $('file-input').click(), primary: true }] });
    return;
  }
  const bar = $('upload-progress');
  bar.value = 0;
  show(bar, true);
  const run = begin(ctx, t('load.status.uploading', { percent: fmt.percent(0, 0) }), t('load.status.slow'));
  try {
    const ds = await api.upload(file, state.settings, {
      signal: run.signal,
      onEvent: (ev) => {
        run.onEvent(ev);
        if (ev.type === 'attempt') bar.value = 0;
      },
      onProgress: (p) => {
        if (p.phase === 'processing') {
          bar.value = 100;
          status.note(t('load.status.checking'));
        } else if (p.total > 0) {
          const frac = Math.min(1, p.loaded / p.total);
          bar.value = Math.round(frac * 100);
          status.note(t('load.status.uploading', { percent: fmt.percent(frac, 0) }));
        }
      },
    });
    end(ctx);
    loaded(ctx, ds, 'file', file.name);
  } catch (err) {
    end(ctx);
    failed(ctx, err, () => upload(ctx), 'upload');
  }
}

async function loadSample(ctx) {
  const { state, t, api } = ctx;
  if (busy) return;
  const wasSample = state.source === 'sample' && state.dataset;
  // The sample has its own coordinates: values typed for another station are not sent with it.
  // The base period is always honoured, and so are coordinates edited after the sample loaded.
  const settings = {};
  if (validate(ctx, false)) {
    settings.baseStart = state.settings.baseStart;
    settings.baseEnd = state.settings.baseEnd;
    if (wasSample) {
      settings.latitude = state.settings.latitude;
      settings.longitude = state.settings.longitude;
    }
  }
  const run = begin(ctx, t('load.status.sample'), t('load.status.slow'));
  try {
    const ds = await api.createSample(settings, run);
    end(ctx);
    if (!wasSample) state.settings.name = '';
    state.file = null;
    precheck = null;
    loaded(ctx, ds, 'sample', '');
  } catch (err) {
    end(ctx);
    failed(ctx, err, () => loadSample(ctx), 'sample');
  }
}

async function removeData(ctx) {
  const { state, t, api, fmt } = ctx;
  if (!state.dataset || busy) return;
  const id = state.dataset.id;
  const until = state.expiresAt ? fmt.clock(new Date(state.expiresAt)) : '';
  deleteStatus.busy(t('load.delete.busy'));
  try {
    await api.remove(id, {
      onEvent: (ev) => {
        if (ev.type === 'retry') deleteStatus.retrying(ev);
        else if (ev.type === 'attempt') deleteStatus.attempt();
      },
    });
    ctx.clearDataset();
    state.file = null;
    state.pendingFile = false;
    precheck = null;
    render(ctx);
    ctx.refresh();
    status.ok(t('load.delete.done'));
    ctx.announce(t('load.delete.done'));
  } catch (err) {
    const d = ctx.describeError(err);
    deleteStatus.error(t('load.delete.failed', { reason: d.message }), {
      hint: until ? t('load.delete.auto', { time: until }) : '',
      actions: [{ label: t('common.retry'), onClick: () => removeData(ctx), primary: true }],
    });
  }
}

function paintFile(ctx) {
  const { state, t, tn, fmt } = ctx;
  const box = $('file-info');
  const file = state.file;
  if (!file) return show(box, false);
  const parts = [
    h('p', { class: 'file-name' }, icon('file'), h('span', { text: file.name }), h('span', { class: 'hint', text: fmt.bytes(file.size) })),
  ];
  if (file.size > maxBytes(ctx)) {
    parts.push(h('p', { class: 'precheck-warn', text: t('load.error.tooLarge', { size: fmt.bytes(file.size), limit: fmt.bytes(maxBytes(ctx)) }) }));
  } else if (precheck) {
    const p = precheck;
    if (p.rows > 0) {
      parts.push(h('p', { class: p.problems.length ? '' : 'precheck-ok' }, p.problems.length ? null : icon('check'), ' ', tn('load.precheck.rows', p.rows, { n: fmt.int(p.rows), first: fmt.date(p.first), last: fmt.date(p.last) })));
    }
    for (const n of p.notes || []) parts.push(h('p', { class: 'hint', text: t('load.precheck.' + n.kind, { line: fmt.int(n.line) }) }));
    if (p.problems.length) {
      parts.push(
        h('p', { class: 'precheck-warn' }, icon('warning'), ' ', t('load.precheck.problems')),
        h(
          'ul',
          { class: 'precheck-list' },
          p.problems.map((pr) => h('li', { text: t('load.precheck.' + pr.kind, { line: fmt.int(pr.line), found: pr.found === undefined ? '' : String(pr.found) }) })),
          p.more ? h('li', { text: tn('load.precheck.more', p.more, { n: fmt.int(p.more) }) }) : null,
        ),
        h('p', { class: 'hint', text: t('load.precheck.stillUpload') }),
      );
    }
  }
  replace(box, parts);
  show(box, true);
}

function paintActions(ctx) {
  const { state, t } = ctx;
  const btn = $('btn-upload');
  const hint = $('upload-hint');
  const dirty = isDirty(ctx);
  const newFile = isNewFile(ctx);
  const off = uploadsOff(ctx);
  const waiting = busy || state.probing;
  let label = t('load.upload');
  let hintText = '';
  let enabled = false;
  if (off) hintText = '';
  else if (newFile) {
    enabled = true;
    hintText = state.dataset ? t('load.upload.hintReplace') : t('load.upload.hintReady');
  } else if (state.dataset && dirty) {
    enabled = state.source === 'sample' || Boolean(state.file);
    label = t('load.apply');
    hintText = enabled ? t('load.apply.hint') : t('load.apply.needFile');
  } else if (state.dataset) {
    hintText = t('load.upload.hintLoaded');
  } else hintText = t('load.upload.hint');
  $('btn-upload-text').textContent = label;
  btn.disabled = !enabled || waiting || off;
  hint.textContent = state.probing ? t('load.probing') : hintText;
  $('btn-sample').disabled = waiting;
  $('btn-choose').disabled = waiting || off;
  $('drop').classList.toggle('is-off', off);
  // The reason is said in words, next to the controls it disables.
  const reason = $('upload-demo');
  reason.textContent = off ? t(state.demo === 'unreachable' ? 'demo.uploadOffUnreachable' : 'demo.uploadOff') : '';
  show(reason, off);
  const note = $('settings-demo');
  note.textContent = state.demo ? t('demo.settingsOff') : '';
  show(note, Boolean(state.demo));
  for (const key of Object.keys(FIELDS)) $(FIELDS[key]).disabled = Boolean(state.demo);
  $('sample-hint').textContent = t(state.demo ? 'demo.sampleHint' : 'load.sample.hint');
  $('file-limit').textContent = t('load.file.limit', { n: ctx.fmt.int(state.limits.maxUploadMb) });
  $('privacy-text').textContent = t('load.privacy', { minutes: ctx.fmt.int(state.limits.ttlMinutes) });
}

function paintLoaded(ctx) {
  const { state, t, tn, fmt } = ctx;
  const box = $('loaded-box');
  const ds = state.dataset;
  if (!ds) return show(box, false);
  const until = state.expiresAt ? fmt.clock(new Date(state.expiresAt)) : '';
  const st = ds.station || {};
  const statusEl = h('div', { class: 'status', hidden: true });
  deleteStatus = createStatus(statusEl, ctx);
  const item = (k, v) => h('div', null, h('dt', { text: k }), h('dd', { text: v }));
  replace(
    box,
    h('h3', null, icon('check', 'tone-ok'), ' ', t('load.loaded.heading', { name: ctx.stationName() })),
    h(
      'dl',
      { class: 'kv loaded-grid' },
      item(t('load.loaded.record'), t('load.loaded.recordValue', { start: fmt.date(ds.period.start), end: fmt.date(ds.period.end), days: tn('common.days', ds.period.n_days, { n: fmt.int(ds.period.n_days) }) })),
      item(t('load.loaded.base'), ds.base_period ? ds.base_period.start + '–' + ds.base_period.end : t('common.noValue')),
      item(t('load.loaded.location'), st.latitude == null ? t('common.notGiven') : t('load.loaded.locationValue', { lat: fmt.num(st.latitude, 4), lon: fmt.num(st.longitude, 4) })),
      item(t('load.loaded.source'), state.demo ? t('demo.source') : state.source === 'sample' ? t('load.loaded.sourceSample') : state.fileName || t('load.loaded.sourceFile')),
      state.demo ? null : item(t('load.loaded.kept'), until ? t('load.loaded.keptValue', { time: until }) : t('load.loaded.keptUnknown', { minutes: fmt.int(state.limits.ttlMinutes) })),
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'button', class: 'btn btn-primary btn-large', 'data-go': '2' }, h('span', { text: t('load.continue') }), icon('right')),
      // In the demonstration nothing of the person's is on a server, so there is nothing to delete.
      state.demo ? null : h('button', { type: 'button', class: 'btn btn-danger', id: 'btn-delete', onclick: () => removeData(ctx) }, icon('trash'), h('span', { text: t('load.delete') })),
    ),
    statusEl,
  );
  show(box, true);
}

export function render(ctx) {
  const { state } = ctx;
  for (const key of Object.keys(FIELDS)) {
    const el = $(FIELDS[key]);
    if (document.activeElement !== el && el.value !== String(state.settings[key] ?? '')) el.value = state.settings[key] ?? '';
  }
  validate(ctx, false);
  paintFile(ctx);
  paintActions(ctx);
  paintLoaded(ctx);
}
