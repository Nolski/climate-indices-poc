// End-to-end smoke test of the whole page in a simulated DOM (jsdom), against the fixtures.
// It clicks through all four steps, switches language, reloads, and exercises the failure paths.
//
// This is NOT a browser: jsdom has no layout, no CSS and no canvas, so it proves that the code
// runs and the right things appear in the document, not that the page looks right.
//
// jsdom is a development-only dependency and is deliberately not stored in this repository.
//   npm install --prefix /some/tmp/dir jsdom
//   CLIMPOC_NODE_MODULES=/some/tmp/dir/node_modules node web/tests/smoke_dom.mjs
// Without jsdom the script prints SKIP and exits 0.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..');
const self = fileURLToPath(import.meta.url);

function loadJsdom() {
  const bases = [];
  if (process.env.CLIMPOC_NODE_MODULES) bases.push(path.join(process.env.CLIMPOC_NODE_MODULES, '_'));
  bases.push(self);
  for (const b of bases) {
    try {
      return createRequire(b)('jsdom');
    } catch {
      /* try the next place */
    }
  }
  return null;
}

const SCENARIOS = ['happy', 'restore', 'expired', 'badfile', 'flaky', 'offline', 'sameorigin', 'crossorigin', 'fallback', 'demoonly'];
// With CLIMPOC_API=http://HOST:PORT the same page code is also driven against the real backend.
if (process.env.CLIMPOC_API) SCENARIOS.push('live');

if (!process.argv.includes('--scenario')) {
  if (!loadJsdom()) {
    console.log('SKIP  DOM smoke test: jsdom is not installed (see the top of web/tests/smoke_dom.mjs).');
    process.exit(0);
  }
  let failed = 0;
  let storage = '';
  for (const name of SCENARIOS) {
    const out = spawnSync(process.execPath, [self, '--scenario', name], { encoding: 'utf8', env: { ...process.env, CLIMPOC_STORAGE: storage } });
    const ok = out.status === 0;
    if (!ok) failed += 1;
    const lines = out.stdout.split('\n');
    const saved = lines.find((l) => l.startsWith('STORAGE '));
    if (saved) storage = saved.slice(8);
    console.log((ok ? 'ok    ' : 'FAIL  ') + 'dom: ' + name + (ok ? '  ' + lines.filter((l) => l.startsWith('  ')).join(';').trim() : ''));
    if (!ok) console.log((out.stdout + out.stderr).split('\n').slice(-25).join('\n'));
  }
  process.exit(failed ? 1 : 0);
}

// ------------------------------------------------------------------ one scenario

const scenario = process.argv[process.argv.indexOf('--scenario') + 1];
const { JSDOM, VirtualConsole } = loadJsdom();
const query = { happy: '?fixtures=1', restore: '?fixtures=1', expired: '?fixtures=1&simulate=expired', badfile: '?fixtures=1&simulate=badfile', flaky: '?fixtures=1&simulate=flaky', offline: '?fixtures=1&simulate=offline', live: '', sameorigin: '', crossorigin: '?api=https://evil.example.test', fallback: '', demoonly: '' }[scenario];
// What config.js would say in each kind of deployment (the container default is the file itself).
const REMOTE = 'https://api.example.test';
const siteConfig = { crossorigin: { apiBase: REMOTE + '/', apiAlternatives: [], demoOnly: false }, fallback: { apiBase: REMOTE, apiAlternatives: [], demoOnly: false }, demoonly: { apiBase: '', apiAlternatives: [], demoOnly: true } }[scenario];

const pageErrors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  if (!/Not implemented/.test(String(e.message))) pageErrors.push(String(e.message));
});
const dom = new JSDOM(fs.readFileSync(path.join(web, 'index.html'), 'utf8'), { url: 'http://localhost/' + query, pretendToBeVisual: true, virtualConsole: vc });
const win = dom.window;

if (process.env.CLIMPOC_STORAGE && (scenario === 'restore' || scenario === 'expired')) {
  const saved = JSON.parse(Buffer.from(process.env.CLIMPOC_STORAGE, 'base64').toString('utf8'));
  for (const k of Object.keys(saved.session)) win.sessionStorage.setItem(k, saved.session[k]);
}

const fetched = [];
const apiCalls = []; // { url, init } for every request that went to the (pretend) real API
const fakeApi = { up: scenario !== 'fallback', transport: null };
let shimmed = false;
const def = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
def('window', win);
def('document', win.document);
def('navigator', win.navigator);
def('location', win.location);
const live = scenario === 'live';
const realFetch = globalThis.fetch;
const apiBase = (process.env.CLIMPOC_API || '').replace(/\/+$/, '');
if (!live) {
  def('FormData', win.FormData);
  def('File', win.File);
  def('Blob', win.Blob);
}
def('requestAnimationFrame', (fn) => setTimeout(fn, 0));
def('cancelAnimationFrame', (id) => clearTimeout(id));
def('fetch', async (url, init) => {
  fetched.push(String(url));
  if (live && String(url).startsWith('api/')) return realFetch(apiBase + '/' + url, init);
  // A pretend real API, answering from the fixtures: at "api/..." for a same-origin deployment,
  // at REMOTE + "/api/..." for a separately hosted one. It can be switched off (fakeApi.up).
  if (String(url).startsWith('api/') || String(url).startsWith(REMOTE + '/api/')) {
    apiCalls.push({ url: String(url), init: init || {} });
    assert.equal(String(url).startsWith(REMOTE), Boolean(siteConfig && siteConfig.apiBase), 'API requests go to the configured place: ' + url);
    if (!fakeApi.up) throw new TypeError('fetch failed');
    // a small public server with its own limits (GET /api/limits); the same-origin scenario plays an older server without it
    if (String(url).endsWith('/api/limits') && scenario !== 'sameorigin') return { ok: true, status: 200, json: async () => ({ max_upload_mb: 5, max_datasets: 10, dataset_ttl_minutes: 30, rate_limit_per_minute: 60 }), headers: { get: () => null } };
    return fakeApi.transport(String(url), init || {});
  }
  assert.ok(!/^[a-z]+:\/\//i.test(String(url)), 'apart from the configured API, the app must only request relative URLs: ' + url);
  const file = path.join(web, String(url).split('?')[0]);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}), headers: { get: () => null } };
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Older fixtures predate the threshold settings the real API now returns; add them so the
  // threshold panel is exercised whichever fixture vintage is on disk.
  if (file.endsWith('dataset.json') && data.qc && !data.qc.settings) {
    data.qc.settings = { tmax_tmin_inclusive: true, max_precip_mm: 200.0, max_abs_temperature: 50.0, max_temperature_jump: 20.0, flatline_min_repeats: 5, max_missing_days_per_year: 15 };
    shimmed = true;
  }
  return { ok: true, status: 200, json: async () => data, headers: { get: () => null } };
});
URL.createObjectURL = () => 'blob:test';
URL.revokeObjectURL = () => {};
globalThis.__CLIMPOC_NO_AUTOBOOT__ = true;

const $ = (id) => win.document.getElementById(id);
const visible = (el) => Boolean(el) && !el.hidden && !el.closest('[hidden]');
const click = (el) => {
  assert.ok(el, 'element to click exists');
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }));
};
const change = (el) => el.dispatchEvent(new win.Event('change', { bubbles: true }));
async function waitFor(what, cond, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try {
      v = cond();
    } catch {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for: ' + what);
    await new Promise((r) => setTimeout(r, 15));
  }
}
const notes = [];
const note = (s) => notes.push(s);

const connSeen = new Set();
new win.MutationObserver(() => connSeen.add($('conn').className)).observe($('conn'), { attributes: true });

const { createFixtureTransport } = await import(pathToFileURL(path.join(web, 'js/api.js')).href);
fakeApi.transport = createFixtureTransport(async (rel) => {
  const file = path.join(web, rel);
  if (!fs.existsSync(file)) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(file, 'utf8')) };
});
const { boot } = await import(pathToFileURL(path.join(web, 'js/main.js')).href);
const ctx = await boot(siteConfig ? { config: siteConfig, recheckMs: 300 } : {});
const en = JSON.parse(fs.readFileSync(path.join(web, 'i18n/en.json'), 'utf8'));
const fr = JSON.parse(fs.readFileSync(path.join(web, 'i18n/fr.json'), 'utf8'));
const fx = (name) => JSON.parse(fs.readFileSync(path.join(web, 'fixtures', name + '.json'), 'utf8'));
const FX = { ds: fx('dataset'), indices: fx('indices').indices, annual: fx('compute_annual'), bad: fx('error_validation').error };
const N = FX.indices.length;
const { trendVerdict, flatKind, orderResults, defaultComparePair } = await import(pathToFileURL(path.join(web, 'js/shape.js')).href);

async function happy() {
  assert.ok(visible($('step-1')) && !visible($('step-2')));
  assert.equal($('conn-text').textContent, en['conn.demo']);
  assert.ok(visible($('notice-demo')));
  assert.equal($('lang-select').options.length, 2);
  await waitFor('versions in the footer', () => /xclim 1\./.test($('versions').textContent));
  assert.equal($('btn-upload').disabled, true);
  for (const n of [2, 3, 4]) assert.equal(win.document.querySelector('[data-step="' + n + '"]').getAttribute('aria-disabled'), 'true');
  // the demonstration is honest: says what it is, and what cannot be done here
  assert.equal($('notice-demo').textContent, en['notice.demo']);
  assert.ok(!$('btn-server-retry'), 'a forced demonstration has no server to retry');
  assert.ok(visible($('demo-tag')) && $('demo-tag').textContent === en['demo.tag']);
  assert.ok(visible($('upload-demo')) && $('upload-demo').textContent === en['demo.uploadOff']);
  assert.ok($('btn-choose').disabled && $('btn-upload').disabled && !$('btn-sample').disabled);
  assert.ok($('f-lat').disabled && $('f-base-start').disabled && visible($('settings-demo')));
  assert.equal($('sample-hint').textContent, en['demo.sampleHint']);
  const dropped = new win.Event('drop', { bubbles: true, cancelable: true });
  dropped.dataTransfer = { files: [new win.File(['1936 1 1 0 1 2\n'], 'mine.txt')] };
  $('drop').dispatchEvent(dropped);
  assert.ok(!ctx.state.file && !visible($('file-info')), 'a dropped file is not taken in the demonstration');
  assert.ok(!fetched.some((u) => /daily_|compute_|dataset\.json/.test(u)), 'first load fetches none of the large saved examples: ' + fetched.join(' '));

  // step 1 -> 2
  click($('btn-sample'));
  await waitFor('quality control', () => visible($('step-2')));
  assert.equal(win.document.activeElement, $('h-step-2'), 'focus moves to the new step heading');
  assert.equal(win.document.querySelectorAll('#qc-tiles .tile').length, 4);
  const sum = FX.ds.qc.summary;
  const verdict = sum.errors ? 'errors' : sum.warnings ? 'warnings' : 'clean';
  assert.ok($('qc-verdict').className.includes('verdict-' + verdict));
  assert.equal($('btn-to-indices-text').textContent, en[{ errors: 'qc.continueErrors', warnings: 'qc.continueWarnings', clean: 'qc.continue' }[verdict]]);
  assert.equal(win.document.querySelectorAll('#qc-strip .strip-cells .cell').length, FX.ds.qc.missing_by_year.length * 3);
  assert.equal(win.document.querySelectorAll('#qc-checks details.check').length, FX.ds.qc.checks.length);
  assert.equal(win.document.querySelectorAll('#qc-checks table tbody tr').length, FX.ds.qc.checks.reduce((n, c) => n + c.records.length, 0));
  assert.ok(win.document.querySelectorAll('#qc-strip-table tbody tr').length > 5);
  assert.equal($('f-lat').value, String(FX.ds.station.latitude), 'form shows what the server used');
  assert.match(win.document.querySelectorAll('#qc-tiles .tile')[2].textContent, /flagged record/);

  // thresholds: change a limit and run the checks again without re-sending the data
  assert.ok(visible($('qc-thresholds')), 'threshold panel is offered when the server reports its settings');
  const limit = $('qcs-max_precip_mm');
  assert.ok(limit && win.document.querySelector('label[for="qcs-max_precip_mm"]').textContent.includes(en['qc.setting.max_precip_mm']));
  limit.value = '';
  $('qc-thresholds-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  assert.ok($('qc-thresholds-status').textContent.includes('needs a number'));
  assert.ok(!fetched.some((u) => u.includes('/qc')));
  limit.value = '350';
  $('qc-thresholds-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor('checks re-run', () => $('qc-thresholds-status').textContent.includes(en['demo.thresholds']));
  assert.ok(fetched.some((u) => u.includes('qc_rerun')), 'the saved re-run example was used');
  const defaultLimit = String(FX.ds.qc.settings ? FX.ds.qc.settings.max_precip_mm : 200);
  assert.match(win.document.querySelector('label[for="qcs-max_precip_mm"]').textContent, new RegExp('default ' + defaultLimit));
  click($('btn-qc-defaults'));
  await waitFor('defaults restored', () => $('qcs-max_precip_mm').value === defaultLimit);
  note('qc ok' + (shimmed ? ' (threshold settings shimmed into an older fixture)' : ''));

  // daily chart, loaded on demand
  assert.ok(!fetched.some((u) => u.includes('daily')), 'daily data is not fetched before it is asked for');
  click($('btn-daily-load'));
  await waitFor('daily chart', () => $('daily-chart').querySelector('svg'));
  assert.ok(fetched.some((u) => u.includes('daily_tasmax')));
  const whole = $('daily-range').textContent;
  assert.ok(whole.includes('29,220 days'));
  click($('btn-zoom-in'));
  assert.notEqual($('daily-range').textContent, whole);
  const showBtn = [...win.document.querySelectorAll('#qc-checks tbody button')].find((b) => /1988/.test(b.getAttribute('aria-label')));
  click(showBtn);
  await waitFor('zoom to flagged day', () => /1988/.test($('daily-range').textContent) && /361 days/.test($('daily-range').textContent));
  assert.ok($('daily-chart').innerHTML.includes('ch-fill-flagError'), 'flagged point is drawn');
  $('daily-chart').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.match($('daily-readout').textContent, /1988.*°C/);
  note('daily ok');

  // step 3
  click(win.document.querySelector('#step-2 [data-go="3"]'));
  await waitFor('indices', () => visible($('step-3')) && win.document.querySelectorAll('#indices-groups [data-index]').length === N);
  const boxes = () => [...win.document.querySelectorAll('#indices-groups [data-index]')];
  assert.ok(boxes().every((b) => b.checked));
  assert.equal(win.document.querySelectorAll('#indices-groups fieldset').length, 4);
  assert.equal($('selection-count').textContent, N + ' of ' + N + ' selected');
  assert.equal($('btn-calculate-text').textContent, 'Calculate ' + N + ' indices');
  assert.equal(win.document.querySelectorAll('#indices-groups .badge').length, FX.indices.filter((i) => i.validated || Object.values(i.validation || {}).includes('differs')).length);
  const annualOnly = FX.indices.filter((i) => !i.frequencies.includes('monthly')).length;
  $('freq-monthly').checked = true;
  change($('freq-monthly'));
  assert.equal(boxes().filter((b) => b.disabled).length, annualOnly);
  assert.equal(win.document.querySelectorAll('.index-reason').length, annualOnly);
  assert.equal($('selection-count').textContent, N - annualOnly + ' of ' + (N - annualOnly) + ' selected');
  $('freq-annual').checked = true;
  change($('freq-annual'));
  const grp = $('grp-duration');
  grp.checked = false;
  change(grp);
  assert.equal($('selection-count').textContent, N - FX.indices.filter((i) => i.group === 'duration').length + ' of ' + N + ' selected');
  const one = $('ix-cdd');
  one.checked = true;
  change(one);
  assert.equal($('grp-duration').indeterminate, true);
  click($('btn-select-none'));
  assert.equal($('btn-calculate').getAttribute('aria-disabled'), 'true');
  click($('btn-calculate'));
  assert.ok($('compute-status').textContent.includes(en['indices.none']));
  click($('btn-select-all'));
  click($('btn-calculate'));
  await waitFor('results', () => visible($('step-4')));
  note('indices ok');

  // step 4
  const cards = [...win.document.querySelectorAll('#results-cards .result-card')];
  assert.equal(cards.length, N);
  assert.ok(visible($('results-demo')) && $('results-demo').textContent === en['demo.results'], 'results are labelled as saved examples');
  assert.ok($('btn-dl-zip').disabled && $('btn-dl-netcdf').disabled && !$('btn-dl-json').disabled && visible($('download-demo')));
  assert.ok($('results-settings').textContent.includes(en['demo.computed']));
  assert.ok(visible($('demo-tag')), 'the demonstration tag stays in the step bar on every step');
  assert.ok(!fetched.some((u) => u.includes('compute_monthly')), 'the monthly example is only fetched when monthly values are calculated');
  const flatIds = FX.annual.results.filter((r) => flatKind(r)).map((r) => r.id);
  assert.equal(win.document.querySelectorAll('#results-cards .result-flat').length, flatIds.length);
  assert.ok(cards.filter((c) => !c.classList.contains('result-flat')).every((c) => c.querySelector('.chart svg') && c.querySelector('.trend') && c.querySelector('.stats')));
  // cards follow the groups; an index that is 0 every year sinks to the end of its group with a sentence instead of a flat chart
  const expectedOrder = orderResults(FX.annual.results, FX.indices).map((row) => 'result-' + row.result.id);
  assert.deepEqual(cards.map((c) => c.id), expectedOrder);
  assert.ok(!flatKind(FX.annual.results.find((r) => 'result-' + r.id === cards[0].id)), 'the first card has something to show');
  for (const id of flatIds) {
    const card = $('result-' + id);
    assert.ok(!card.querySelector('.chart') && /every year of the record|No value could be calculated/.test(card.querySelector('.flat-note').textContent), id);
  }
  assert.equal(win.document.querySelectorAll('#results-cards h4.group-head').length, new Set(FX.indices.map((i) => i.group)).size);
  assert.deepEqual([$('compare-a').value, $('compare-b').value], defaultComparePair(FX.annual.results));
  assert.ok(!flatKind(FX.annual.results.find((r) => r.id === $('compare-a').value)) && !flatKind(FX.annual.results.find((r) => r.id === $('compare-b').value)));
  // the trend sentence follows the numbers in the fixture, whatever they are
  const sig2 = (v) => new Intl.NumberFormat('en', { maximumSignificantDigits: 2 }).format(Math.abs(v));
  const seen = new Set();
  for (const r of FX.annual.results) {
    if (flatKind(r)) continue;
    const v = trendVerdict(r.trend);
    const key = v.kind + (v.significant ? '+' : '-');
    if (seen.has(key)) continue;
    seen.add(key);
    const main = $('result-' + r.id).querySelector('.trend-main').textContent;
    const subText = ($('result-' + r.id).querySelector('.trend-sub') || { textContent: '' }).textContent;
    if (v.kind === 'up') assert.ok(main.startsWith('Rising by about ' + sig2(r.trend.slope_per_decade) + ' '), r.id + ': ' + main);
    if (v.kind === 'down') assert.ok(main.startsWith('Falling by about ' + sig2(r.trend.slope_per_decade) + ' '), r.id + ': ' + main);
    if (v.kind === 'flat') assert.ok(main.startsWith('No change'), r.id + ': ' + main);
    if (v.kind === 'none') assert.ok(main.startsWith('No trend was calculated'), r.id + ': ' + main);
    if (v.kind === 'up' || v.kind === 'down') {
      assert.match(main, /The 95% range is \S+ to \S+ per decade\./);
      assert.ok(subText.includes(v.significant ? 'is statistically significant (p' : 'is not statistically significant (p'), r.id + ': ' + subText);
    }
  }
  assert.ok(seen.size >= 2, 'fixture covers several kinds of trend: ' + [...seen].join(' '));
  const su = $('result-su');
  assert.match($('result-tx90p').querySelector('.trend-main').textContent, /percentage points per decade|No change/);
  const [cmpA, cmpB] = defaultComparePair(FX.annual.results).map((id) => FX.annual.results.find((r) => r.id === id));
  assert.ok(su.querySelector('.chart svg').innerHTML.includes('stroke-dasharray'), 'trend line drawn');
  const toggle = su.querySelector('.card-actions button');
  click(toggle);
  assert.equal(su.querySelectorAll('table tbody tr').length, 80);
  assert.equal(toggle.textContent, en['results.showChart']);
  assert.ok(!visible(su.querySelector('.chart')));
  click(toggle);
  assert.ok(visible(su.querySelector('.chart')));
  assert.equal(win.document.querySelectorAll('#results-settings dt').length, 9);
  assert.match($('results-settings').textContent, /1971–2000/);
  assert.match($('results-settings').textContent, /more than 15 missing days/);
  assert.match($('results-settings').textContent, /xclim 1\./);
  assert.equal($('compare-note').textContent, cmpA.units === cmpB.units ? en['results.compare.shared'].replace('{unit}', en['unit.' + cmpA.units] || cmpA.units) : en['results.compare.separate']);
  $('compare-b').value = 'txx';
  change($('compare-b'));
  assert.equal($('compare-note').textContent, en['results.compare.separate']);
  assert.ok($('compare-chart').innerHTML.includes('TXx (°C)'));
  su.querySelector('.chart').dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  assert.match(su.querySelector('.readout').textContent, /^1936: \d+ days( · trend line .+)?$/);
  click($('btn-dl-json'));
  assert.ok($('download-status').textContent.includes('.json'));
  const buttons = [...su.querySelectorAll('.card-actions button')];
  click(buttons.find((b) => b.textContent.includes('CSV')));
  assert.match(su.textContent, /Saved: .*su_annual\.csv/);
  click(buttons.find((b) => b.textContent.includes('SVG')));
  await waitFor('svg saved', () => /su_annual\.svg/.test(su.textContent));
  note('results ok');

  // stepper: go back to a completed step and forward again without recalculating
  click(win.document.querySelector('#stepper [data-step="2"]'));
  assert.ok(visible($('step-2')));
  click(win.document.querySelector('#stepper [data-step="4"]'));
  assert.ok(visible($('step-4')));
  assert.equal(win.document.querySelector('#stepper [data-step="4"]').getAttribute('aria-current'), 'step');

  // language switch re-renders everything, including dynamic text and number formats
  $('lang-select').value = 'fr';
  change($('lang-select'));
  await waitFor('French', () => win.document.documentElement.lang === 'fr' && $('h-step-4').textContent.includes(fr['results.heading']));
  assert.ok(visible($('notice-draft')));
  assert.match($('result-su').querySelector('.trend-main').textContent, /par décennie/);
  assert.match($('result-su').querySelector('.stats').textContent, /Moyenne\d+,\d+ jours/);
  assert.equal(win.document.title, fr['app.title']);
  assert.equal(win.document.querySelector('[data-step="1"] .step-name').textContent, fr['steps.1']);
  assert.match($('lang-select').selectedOptions[0].textContent, /à relire/);
  $('lang-select').value = 'en';
  change($('lang-select'));
  await waitFor('English', () => win.document.documentElement.lang === 'en');
  note('i18n ok');

  // back on step 1: the saved example is described as such, and there is nothing to delete
  click(win.document.querySelector('#stepper [data-step="1"]'));
  assert.ok(visible($('loaded-box')) && $('loaded-box').textContent.includes(en['demo.source']));
  assert.ok(!$('btn-delete') && !$('loaded-box').textContent.includes(en['load.loaded.kept']));

  // what a reload would find
  const session = {};
  for (let i = 0; i < win.sessionStorage.length; i++) session[win.sessionStorage.key(i)] = win.sessionStorage.getItem(win.sessionStorage.key(i));
  assert.ok(session['climpoc.session.v1.demo'] && session['climpoc.result.v1.demo'], 'a demonstration session is stored apart from a real one');
  assert.ok(!session['climpoc.session.v1'] && !session['climpoc.result.v1']);
  console.log('STORAGE ' + Buffer.from(JSON.stringify({ session })).toString('base64'));

}

async function restore() {
  // boot() has already run with the saved session in sessionStorage
  assert.ok(win.sessionStorage.getItem('climpoc.session.v1.demo'), 'session was handed over');
  await waitFor('restored view', () => visible($('step-1')) && visible($('loaded-box')));
  assert.ok(visible($('notice-session')) && $('notice-session').textContent.includes('restored'));
  assert.equal(win.document.querySelector('[data-step="4"]').hasAttribute('aria-disabled'), false, 'results survive the reload');
  click(win.document.querySelector('#stepper [data-step="4"]'));
  assert.equal(win.document.querySelectorAll('#results-cards .result-card').length, N);
  assert.ok(!fetched.some((u) => u.includes('compute')), 'results came from sessionStorage, not the network');
  note('session restored with results, no recompute');
}

async function expired() {
  await waitFor('expired notice', () => visible($('notice-expired')));
  assert.ok($('notice-expired').textContent.includes(en['expired.title']));
  const again = [...$('notice-expired').querySelectorAll('button')].find((b) => b.textContent === en['expired.reloadSample']);
  click(again);
  await waitFor('reloaded', () => visible($('step-2')));
  assert.ok(!visible($('notice-expired')));
  note('404 -> explained -> one-click reload');
}

async function badfile() {
  const text = '1936 1 1 0.0 23.7 18.4\n1936 1 2 0.0 24.1\n';
  const file = new win.File([text], 'bad station.txt', { type: 'text/plain' });
  const ev = new win.Event('drop', { bubbles: true, cancelable: true });
  ev.dataTransfer = { files: [file] };
  $('drop').dispatchEvent(ev);
  await waitFor('file listed', () => visible($('file-info')) && /bad station\.txt/.test($('file-info').textContent));
  await waitFor('quick check', () => /Line 2 has 5 values/.test($('file-info').textContent));
  assert.equal($('f-name').value, 'bad station');
  assert.equal($('btn-upload').disabled, false);
  click($('btn-upload'));
  await waitFor('server error shown', () => $('upload-status').className.includes('status-error'));
  const box = $('upload-status');
  assert.equal(box.getAttribute('role'), 'alert');
  assert.ok(box.textContent.includes(FX.bad.message), 'server message shown verbatim');
  assert.equal(box.querySelectorAll('.status-details li').length, FX.bad.details.length);
  for (const d of FX.bad.details) assert.ok(box.textContent.includes(d.message), 'detail shown: ' + d.message);
  assert.deepEqual([...box.querySelectorAll('button')].map((b) => b.textContent), [en['common.retry'], en['load.chooseOther']]);
  assert.ok(visible($('step-1')) && !ctx.state.dataset);
  note('server message + line details + retry');
}

async function flaky() {
  click($('btn-sample'));
  await waitFor('status shows a retry', () => /Trying again in about/.test($('upload-status').textContent), 8000);
  assert.ok(connSeen.has('conn conn-retrying'));
  await waitFor('load succeeds after retry', () => visible($('step-2')), 20000);
  await waitFor('connected again', () => $('conn').className === 'conn conn-online');
  note('retry visible, then success');
}

async function offline() {
  click($('btn-sample'));
  await waitFor('busy with elapsed time', () => /\(\d+ s\)/.test($('upload-status').querySelector('.status-time').textContent));
  assert.equal($('upload-status').querySelector('.status-time').getAttribute('aria-hidden'), 'true', 'the ticking seconds are not read out');
  assert.ok($('upload-status').querySelector('button'), 'a cancel button is offered while waiting');
  await waitFor('final error', () => $('upload-status').className.includes('status-error'), 30000);
  assert.ok($('upload-status').textContent.includes('could not be reached. Tried 4 times'));
  assert.ok($('upload-status').textContent.includes(en['error.keptHint']));
  assert.equal($('conn').className, 'conn conn-offline');
  assert.ok([...$('upload-status').querySelectorAll('button')].some((b) => b.textContent === en['common.retry']));
  note('gives up with an explanation and a retry button');
}

// The container deployment: page and API on one server. Nothing about it may change.
async function sameorigin() {
  await waitFor('versions', () => /xclim 1\./.test($('versions').textContent));
  assert.ok(!fetched.includes('api/health'), 'no extra health check on load when the API is on the same server');
  assert.ok(apiCalls.length >= 2 && apiCalls.every((c) => c.url.startsWith('api/')));
  assert.ok(!visible($('notice-demo')) && !visible($('demo-tag')) && !visible($('upload-demo')) && !visible($('notice-boot')));
  assert.equal($('conn-text').textContent, en['conn.online']);
  assert.ok(!$('btn-choose').disabled && !$('f-lat').disabled);
  assert.equal($('sample-hint').textContent, en['load.sample.hint']);
  assert.equal($('file-limit').textContent, 'Plain text, up to 20 MB.');
  assert.equal($('privacy-text').textContent, 'Your data stays in memory on the server for 60 minutes and is never written to disk.');
  // form validation
  $('f-lat').value = '120';
  $('f-lat').dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal($('f-lat').getAttribute('aria-invalid'), 'true');
  assert.ok(visible($('f-lat-err')) && $('f-lat-err').textContent === en['load.lat.error']);
  $('f-lat').value = '';
  $('f-lat').dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal($('f-lat').hasAttribute('aria-invalid'), false);
  click($('btn-sample'));
  await waitFor('quality control', () => visible($('step-2')));
  click(win.document.querySelector('#step-2 [data-go="3"]'));
  await waitFor('indices', () => win.document.querySelectorAll('#indices-groups [data-index]').length === N);
  click($('btn-calculate'));
  await waitFor('results', () => visible($('step-4')));
  assert.ok(!visible($('results-demo')) && !$('btn-dl-zip').disabled && !visible($('download-demo')));
  assert.ok(!$('results-settings').textContent.includes(en['demo.computed']));
  // change the base period: one press re-checks the data, no file needed
  click(win.document.querySelector('#stepper [data-step="1"]'));
  assert.ok(visible($('loaded-box')) && $('btn-delete') && $('loaded-box').textContent.includes(en['load.loaded.kept']));
  assert.equal($('btn-upload').disabled, true);
  $('f-base-start').value = '1981';
  $('f-base-start').dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal($('btn-upload').disabled, false);
  assert.equal($('btn-upload-text').textContent, en['load.apply']);
  assert.ok(win.sessionStorage.getItem('climpoc.session.v1') && !win.sessionStorage.getItem('climpoc.session.v1.demo'));
  // delete my data now
  $('f-base-start').value = '1971';
  $('f-base-start').dispatchEvent(new win.Event('input', { bubbles: true }));
  click($('btn-delete'));
  await waitFor('deleted', () => $('upload-status').textContent.includes(en['load.delete.done']));
  assert.ok(!visible($('loaded-box')));
  assert.equal(win.sessionStorage.getItem('climpoc.session.v1'), null);
  assert.equal(win.document.querySelector('[data-step="2"]').getAttribute('aria-disabled'), 'true');
  assert.ok(apiCalls.some((c) => c.init.method === 'DELETE'));
  note('same origin unchanged: no probe, no demonstration, upload, apply and delete available');
}

// What every request to a separately hosted API looks like: this is the list the API's CORS
// settings have to allow, so it is asserted here.
function crossOriginShape() {
  const methods = new Set();
  const headers = new Set();
  for (const c of apiCalls) {
    methods.add(c.init.method || 'GET');
    for (const k of Object.keys(c.init.headers || {})) headers.add(k.toLowerCase());
    assert.ok(c.init.credentials === undefined || c.init.credentials === 'omit' || c.init.credentials === 'same-origin', 'no credentials are sent');
    assert.ok(c.url.startsWith(REMOTE + '/api/'), c.url);
  }
  return { methods: [...methods].sort(), headers: [...headers].sort() };
}

// GitHub Pages with the API up: asked once on load, then normal operation.
async function crossorigin() {
  assert.equal(apiCalls[0].url, REMOTE + '/api/health', 'the separately hosted API is asked first');
  assert.ok(!visible($('notice-demo')) && !visible($('demo-tag')) && !$('btn-choose').disabled);
  assert.equal($('conn-text').textContent, en['conn.online']);
  assert.ok(visible($('notice-boot')) && $('notice-boot').textContent === en['notice.apiIgnored'], 'an ?api= value that is not on the list is ignored, and said so');
  // the page states the limits of the server it talks to
  await waitFor('limits shown', () => $('file-limit').textContent === 'Plain text, up to 5 MB.');
  assert.equal($('privacy-text').textContent, 'Your data stays in memory on the server for 30 minutes and is never written to disk.');
  click($('btn-sample'));
  await waitFor('quality control', () => visible($('step-2')));
  $('qcs-max_precip_mm').value = '120';
  $('qc-thresholds-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor('checks re-run', () => $('qc-thresholds-status').textContent.includes(en['qc.thresholds.done']));
  click($('btn-daily-load'));
  await waitFor('daily chart', () => $('daily-chart').querySelector('svg'));
  click(win.document.querySelector('#step-2 [data-go="3"]'));
  await waitFor('indices', () => win.document.querySelectorAll('#indices-groups [data-index]').length === N);
  click($('btn-calculate'));
  await waitFor('results', () => visible($('step-4')));
  click(win.document.querySelector('#stepper [data-step="1"]'));
  click($('btn-delete'));
  await waitFor('deleted', () => $('upload-status').textContent.includes(en['load.delete.done']));
  const shape = crossOriginShape();
  assert.deepEqual(shape.methods, ['DELETE', 'GET', 'POST']);
  assert.deepEqual(shape.headers, ['content-type']);
  assert.ok(!fetched.some((u) => u.startsWith('fixtures/')), 'no saved example is fetched while the API answers');
  note('API asked once on load; methods ' + shape.methods.join(', ') + '; request headers ' + shape.headers.join(', ') + '; no credentials');
}

// GitHub Pages with the API away: fall back to the demonstration, say so, offer a retry.
async function fallback() {
  assert.equal(ctx.state.demo, 'unreachable');
  assert.ok(apiCalls.length >= 1 && apiCalls.every((c) => c.url === REMOTE + '/api/health'), 'only the health check was tried');
  assert.ok(visible($('notice-demo')) && $('notice-demo').querySelector('p').textContent === 'The calculation server is not reachable right now. You are seeing the demonstration with saved results for the sample station; uploading your own file is unavailable until it is back.');
  assert.equal($('btn-server-retry').textContent, 'Try the server again');
  assert.equal($('conn-text').textContent, en['conn.demoUnreachable']);
  assert.ok($('conn').className.includes('conn-away'));
  assert.ok(visible($('demo-tag')) && $('btn-choose').disabled && $('upload-demo').textContent === en['demo.uploadOffUnreachable']);
  assert.ok(!fetched.some((u) => /daily_|compute_|dataset\.json/.test(u)), 'first load fetches none of the large saved examples');
  // the demonstration works
  click($('btn-sample'));
  await waitFor('quality control', () => visible($('step-2')));
  click(win.document.querySelector('#step-2 [data-go="3"]'));
  await waitFor('indices', () => win.document.querySelectorAll('#indices-groups [data-index]').length === N);
  click($('btn-calculate'));
  await waitFor('results', () => visible($('step-4')));
  assert.ok(visible($('results-demo')) && visible($('notice-demo')) && visible($('demo-tag')));
  assert.ok(win.sessionStorage.getItem('climpoc.session.v1.demo') && !win.sessionStorage.getItem('climpoc.session.v1'));
  // still away: a press says so and changes nothing
  click($('btn-server-retry'));
  await waitFor('still down', () => /Still not reachable/.test($('notice-demo').textContent));
  assert.ok(visible($('step-4')) && ctx.state.demo === 'unreachable');
  // the server comes back: the quiet check only changes the notice, it does not pull the page away
  fakeApi.up = true;
  await waitFor('noticed', () => $('notice-demo').querySelector('p').textContent === en['demo.back'], 5000);
  assert.equal($('btn-server-retry').textContent, en['demo.useServer']);
  assert.ok(visible($('step-4')) && ctx.state.demo === 'unreachable', 'the page stays where the person was');
  click($('btn-server-retry'));
  await waitFor('using the server', () => ctx.state.demo === '' && visible($('step-1')) && !visible($('notice-demo')));
  assert.ok(!visible($('demo-tag')) && !$('btn-choose').disabled && !$('f-lat').disabled && !visible($('upload-demo')));
  assert.ok(!ctx.state.dataset && win.document.querySelector('[data-step="2"]').getAttribute('aria-disabled') === 'true', 'the demonstration data is not carried into real use');
  await waitFor('connected', () => $('conn-text').textContent === en['conn.online']);
  const before = apiCalls.length;
  click($('btn-sample'));
  await waitFor('real load', () => visible($('step-2')));
  assert.ok(apiCalls.slice(before).some((c) => c.url === REMOTE + '/api/datasets/sample' && c.init.method === 'POST'));
  assert.ok(!visible($('results-demo')));
  crossOriginShape();
  note('unreachable -> demonstration with the notice -> retry says still down -> back: noticed, switched on request');
}

// GitHub Pages published without any API.
async function demoonly() {
  assert.equal(ctx.state.demo, 'only');
  assert.equal(apiCalls.length, 0, 'no API request is ever made');
  assert.ok(visible($('notice-demo')) && $('notice-demo').textContent === en['demo.only'] && !$('btn-server-retry'));
  assert.ok(visible($('demo-tag')) && $('btn-choose').disabled && $('upload-demo').textContent === en['demo.uploadOff']);
  click($('btn-sample'));
  await waitFor('quality control', () => visible($('step-2')));
  assert.equal(apiCalls.length, 0);
  note('demonstration only: no API request, no retry button');
}

// The same page code against the real backend: sample, thresholds, daily data, all indices,
// export, a broken upload, a good upload, changed settings, delete.
async function liveRun() {
  await waitFor('connected', () => $('conn').className === 'conn conn-online');
  assert.ok(!visible($('notice-demo')));
  click($('btn-sample'));
  await waitFor('quality control', () => visible($('step-2')), 60000);
  const nChecks = win.document.querySelectorAll('#qc-checks details').length;
  assert.ok(nChecks >= 5);
  assert.ok(visible($('qc-thresholds')), 'real API reports its QC settings');
  const before = ctx.state.dataset.qc.checks.find((c) => c.id === 'out_of_bounds').count;
  $('qcs-max_precip_mm').value = '100';
  $('qc-thresholds-form').dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }));
  await waitFor('checks re-run', () => $('qc-thresholds-status').textContent.includes(en['qc.thresholds.done']), 60000);
  const after = ctx.state.dataset.qc.checks.find((c) => c.id === 'out_of_bounds').count;
  assert.ok(after > before, 'a lower rainfall limit flags more days (' + before + ' -> ' + after + ')');
  note('qc re-run with a 100 mm limit: ' + before + ' -> ' + after + ' out-of-bounds records');
  $('daily-variable').value = 'pr';
  click($('btn-daily-load'));
  await waitFor('daily chart', () => $('daily-chart').querySelector('svg'), 60000);
  assert.match($('daily-range').textContent, /29,220 days/);
  click(win.document.querySelector('#step-2 [data-go="3"]'));
  await waitFor('indices', () => visible($('step-3')) && win.document.querySelectorAll('#indices-groups [data-index]').length > 20, 30000);
  const nIdx = win.document.querySelectorAll('#indices-groups [data-index]').length;
  assert.equal($('selection-count').textContent, nIdx + ' of ' + nIdx + ' selected');
  const badges = win.document.querySelectorAll('#indices-groups .badge').length;
  const t0 = Date.now();
  click($('btn-calculate'));
  await waitFor('elapsed time shown while calculating', () => /\(\d+ s\)/.test($('compute-status').textContent) || visible($('step-4')));
  await waitFor('results', () => visible($('step-4')), 170000);
  const cards = win.document.querySelectorAll('#results-cards .result-card');
  assert.equal(cards.length, nIdx);
  assert.ok([...cards].every((c) => (c.classList.contains('result-flat') || c.querySelector('.chart svg')) && !c.innerHTML.includes('NaN')));
  note(nIdx + ' indices (' + badges + ' badges) calculated through the page in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
  assert.match($('results-settings').textContent, /more than 15 missing days/);
  for (const [btn, ext] of [['btn-dl-zip', '.zip'], ['btn-dl-netcdf', '.nc'], ['btn-dl-json', '.json']]) {
    click($(btn));
    await waitFor('download ' + ext, () => $('download-status').className.includes('status-ok') && $('download-status').textContent.includes(ext), 60000);
  }
  note('zip, NetCDF and JSON downloaded');

  // a broken file: the server's message and line number are shown next to the file
  click(win.document.querySelector('#stepper [data-step="1"]'));
  const rows = [];
  for (let d = new Date(Date.UTC(1991, 0, 1)); d.getUTCFullYear() < 2003; d.setUTCDate(d.getUTCDate() + 1)) {
    const doy = (d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5;
    const tx = 29 + 4 * Math.cos((doy / 365) * 6.283) + (doy % 5) * 0.4;
    rows.push([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), doy % 6 === 0 ? 12.5 : 0, tx.toFixed(1), (tx - 8).toFixed(1)].join(' '));
  }
  const broken = rows.slice();
  broken[40] = broken[40].split(' ').slice(0, 5).join(' ');
  const drop = (text, name) => {
    const ev = new win.Event('drop', { bubbles: true, cancelable: true });
    ev.dataTransfer = { files: [new File([text], name, { type: 'text/plain' })] };
    $('drop').dispatchEvent(ev);
  };
  drop(broken.join('\n') + '\n', 'broken.txt');
  await waitFor('quick check', () => /Line 41 has 5 values/.test($('file-info').textContent));
  click($('btn-upload'));
  await waitFor('server error shown', () => $('upload-status').className.includes('status-error'), 60000);
  assert.match($('upload-status').textContent, /Line 41: expected 6 columns/);
  note('broken upload: "' + $('upload-status').querySelector('.status-msg').textContent + '"');

  // a good file, then a changed base period applied without choosing the file again
  drop(rows.join('\n') + '\n', 'island station.txt');
  await waitFor('file listed', () => /island station\.txt/.test($('file-info').textContent) && /4,383 lines/.test($('file-info').textContent));
  $('f-lat').value = '-17.7';
  $('f-lat').dispatchEvent(new win.Event('input', { bubbles: true }));
  $('f-lon').value = '168.3';
  $('f-lon').dispatchEvent(new win.Event('input', { bubbles: true }));
  $('f-base-start').value = '1991';
  $('f-base-start').dispatchEvent(new win.Event('input', { bubbles: true }));
  click($('btn-upload'));
  await waitFor('uploaded', () => visible($('step-2')) && ctx.state.source === 'file', 60000);
  assert.equal(ctx.state.dataset.station.latitude, -17.7);
  assert.equal(ctx.state.dataset.base_period.start, 1991);
  const firstId = ctx.state.dataset.id;
  click(win.document.querySelector('#stepper [data-step="1"]'));
  $('f-base-end').value = '2002';
  $('f-base-end').dispatchEvent(new win.Event('input', { bubbles: true }));
  assert.equal($('btn-upload-text').textContent, en['load.apply']);
  click($('btn-upload'));
  await waitFor('re-checked', () => visible($('step-2')) && ctx.state.dataset.id !== firstId, 60000);
  assert.equal(ctx.state.dataset.base_period.end, 2002);
  note('upload, then base period changed and re-checked with one press');

  // expiry: delete on the server behind the page's back, then calculate
  await realFetch(apiBase + '/api/datasets/' + ctx.state.dataset.id, { method: 'DELETE' });
  click(win.document.querySelector('#stepper [data-step="3"]'));
  await waitFor('indices again', () => visible($('step-3')));
  click($('btn-calculate'));
  await waitFor('expired notice', () => visible($('notice-expired')), 30000);
  const again = [...$('notice-expired').querySelectorAll('button')].find((b) => b.textContent.includes('island station.txt'));
  assert.ok(again, 'offers to upload the file the browser still holds');
  click(again);
  await waitFor('re-uploaded and calculation resumed', () => visible($('step-4')), 170000);
  assert.ok(!visible($('notice-expired')));
  note('dataset gone (404): one click re-uploaded the held file and resumed the calculation');

  click(win.document.querySelector('#stepper [data-step="1"]'));
  click($('btn-delete'));
  await waitFor('deleted', () => $('upload-status').textContent.includes(en['load.delete.done']), 30000);
  note('deleted');
}

try {
  await { happy, restore, expired, badfile, flaky, offline, sameorigin, crossorigin, fallback, demoonly, live: liveRun }[scenario]();
  assert.deepEqual(pageErrors, [], 'no script errors in the page');
  for (const n of notes) console.log('  ' + n);
  process.exit(0);
} catch (e) {
  console.log('scenario ' + scenario + ' failed: ' + (e && e.stack ? e.stack : e));
  if (pageErrors.length) console.log('page errors: ' + pageErrors.join(' | '));
  process.exit(1);
}
