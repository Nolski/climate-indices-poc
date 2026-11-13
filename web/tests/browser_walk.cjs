// Walks the four steps in a real, separate headless Chromium and reports, for each step and
// viewport width, how far the page is wider than the viewport and which elements cause it.
// It launches its own throwaway browser; it never attaches to a browser that is already open.
//
// Playwright is NOT a dependency of this repository. Point the script at a copy you already have:
//   CLIMPOC_PLAYWRIGHT=/path/to/node_modules/playwright-core \
//   CLIMPOC_CHROMIUM=/path/to/chrome-headless-shell \
//   node web/tests/browser_walk.cjs http://127.0.0.1:8000 /tmp/shots 360 320 1280
// Optional: CLIMPOC_LANG=fr to walk in another language; CLIMPOC_SCHEME=dark for the dark colours.
// The base address may include a sub-path (a GitHub Pages project site lives at /<repo>/).
//   CLIMPOC_API_ORIGIN=http://127.0.0.1:8772   the page talks to a separately hosted API there
//   CLIMPOC_MODE=fallback                       that API is expected to be unreachable: the page
//                                               must show the demonstration and say why
// Exit status is 1 if any step overflows horizontally or the console shows an error.

const base = (process.argv[2] || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const out = process.argv[3] || '.';
const widths = process.argv.slice(4).map(Number).filter(Boolean);
if (!widths.length) widths.push(360, 320, 1280);
const lang = process.env.CLIMPOC_LANG || 'en';
const scheme = process.env.CLIMPOC_SCHEME === 'dark' ? 'dark' : 'light';
const apiOrigin = (process.env.CLIMPOC_API_ORIGIN || '').replace(/\/+$/, '');
const fallback = process.env.CLIMPOC_MODE === 'fallback';

if (!process.env.CLIMPOC_PLAYWRIGHT || !process.env.CLIMPOC_CHROMIUM) {
  console.log('SKIP  browser walk: set CLIMPOC_PLAYWRIGHT and CLIMPOC_CHROMIUM (see the top of web/tests/browser_walk.cjs).');
  process.exit(0);
}
const { chromium } = require(process.env.CLIMPOC_PLAYWRIGHT);

// Runs in the page: overflow in px and the elements that stick out past the right edge and are
// not inside a container that scrolls or clips on purpose.
function measure() {
  const doc = document.documentElement;
  const vw = doc.clientWidth;
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true;
    }
    return false;
  };
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[hidden]') || el.closest('.sprite') || el.closest('.visually-hidden')) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + 0.5 || clipped(el)) continue;
    offenders.push({ el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).join('.') : ''), right: Math.round(r.right), width: Math.round(r.width), depth: (function d(e) { return e.parentElement ? 1 + d(e.parentElement) : 0; })(el) });
  }
  // keep the outermost culprits first, a handful is enough to act on
  offenders.sort((a, b) => a.depth - b.depth);
  return { overflow: doc.scrollWidth - vw, viewport: vw, offenders: offenders.slice(0, 8).map((o) => o.el + ' right=' + o.right + ' w=' + o.width) };
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CLIMPOC_CHROMIUM });
  const report = [];
  let bad = 0;
  for (const width of widths) {
    const ctx = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1, colorScheme: scheme, acceptDownloads: true });
    const page = await ctx.newPage();
    const logs = [];
    const external = [];
    page.on('console', (m) => {
      if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => logs.push('pageerror: ' + String(e).slice(0, 300)));
    const api = []; // requests to a separately hosted API
    const fixtures = []; // saved examples, in the order they were fetched
    page.on('request', (r) => {
      const u = r.url();
      if (apiOrigin && u.startsWith(apiOrigin + '/')) api.push(r.method() + ' ' + u.slice(apiOrigin.length).replace(/ds_[0-9a-f]+/, 'ID').split('?')[0]);
      else if (!u.startsWith(base + '/') && !u.startsWith('blob:') && !u.startsWith('data:')) external.push(u);
      const m = /\/fixtures\/([\w.-]+)$/.exec(u.split('?')[0]);
      if (m) fixtures.push(m[1]);
    });
    // In fallback mode the browser itself logs the failed connection to the API; that line is
    // expected and is kept apart from real problems.
    const expected = (line) => fallback && /ERR_CONNECTION_REFUSED|Failed to load resource/.test(line);
    const steps = {};
    const record = async (name, full = true) => {
      await page.waitForTimeout(350);
      steps[name] = await page.evaluate(measure);
      await page.screenshot({ path: out + '/w' + width + '-' + lang + (scheme === 'dark' ? '-dark' : '') + '-' + name + '.png', fullPage: full });
    };

    await page.goto(base + '/?lang=' + lang, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !document.getElementById('btn-sample').disabled, null, { timeout: 30000 });
    await record('1-load');
    const firstLoadFixtures = fixtures.slice();
    const demoNotice = await page.evaluate(() => {
      const box = document.getElementById('notice-demo');
      return box.hidden ? '' : box.querySelector('p').textContent;
    });
    const demoState = await page.evaluate(() => ({
      tag: !document.getElementById('demo-tag').hidden,
      uploadOff: document.getElementById('btn-choose').disabled,
      retryButton: Boolean(document.getElementById('btn-server-retry')),
      conn: document.getElementById('conn-text').textContent,
    }));
    await page.click('#btn-sample');
    await page.waitForSelector('#step-2:not([hidden])', { timeout: 90000 });
    // open everything that can widen the page: every check with its table, the threshold panel, the daily chart
    await page.evaluate(() => document.querySelectorAll('#step-2 details').forEach((d) => (d.open = true)));
    await page.click('#btn-daily-load');
    await page.waitForSelector('#daily-chart svg', { timeout: 90000 });
    await record('2-qc');
    // drag across the daily chart: the shown period must shrink; double-click must restore it
    const checks = {};
    const rangeText = () => page.locator('#daily-range').textContent();
    const whole = await rangeText();
    const box = await page.locator('#daily-chart svg').boundingBox();
    await page.locator('#daily-chart').scrollIntoViewIfNeeded();
    const b2 = await page.locator('#daily-chart svg').boundingBox();
    await page.mouse.move(b2.x + b2.width * 0.45, b2.y + b2.height * 0.5);
    await page.mouse.down();
    await page.mouse.move(b2.x + b2.width * 0.7, b2.y + b2.height * 0.5, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const zoomed = await rangeText();
    checks.dragZoom = Boolean(box) && zoomed !== whole;
    checks.hoverReadout = /\d{4}/.test(await page.locator('#daily-readout').textContent());
    await page.locator('#daily-chart').dblclick({ position: { x: b2.width * 0.5, y: b2.height * 0.5 } });
    await page.waitForTimeout(200);
    checks.doubleClickReset = (await rangeText()) === whole;
    await page.click('#stepper [data-step="1"]');
    await record('1-loaded');
    await page.click('#stepper [data-step="3"]');
    await page.waitForSelector('#indices-groups [data-index]', { timeout: 30000 });
    await page.click('#freq-monthly');
    await record('3-indices-monthly');
    await page.click('#freq-annual');
    await page.click('#btn-select-all');
    await record('3-indices', false);
    await page.click('#btn-calculate');
    await page.waitForSelector('#step-4:not([hidden])', { timeout: 180000 });
    await page.waitForTimeout(800);
    // table view on the first card, and a comparison of two indices with different units
    await page.evaluate(() => {
      const first = document.querySelector('#results-cards .result-card:not(.result-flat) .card-actions button');
      if (first) first.click();
    });
    await record('4-results', false);
    await page.evaluate(() => {
      const el = document.getElementById('results-cards');
      if (el) el.scrollIntoView();
    });
    await record('4-cards', false);
    steps['4-results-full'] = await page.evaluate(measure);
    const part = async (name, selector) => {
      const loc = page.locator(selector).first();
      if (await loc.count()) await loc.screenshot({ path: out + '/w' + width + '-' + lang + (scheme === 'dark' ? '-dark' : '') + '-part-' + name + '.png' });
    };
    await part('compare', '#step-4 .card:has(#compare-chart)');
    await part('settings', '#step-4 .card:has(#results-settings)');
    await part('card-chart', '#results-cards .result-card:not(.result-flat) >> nth=1');
    await part('card-flat', '#results-cards .result-flat');
    await part('group-head', '#results-cards .group-head >> nth=1');
    for (const kind of ['PNG', 'SVG']) {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
        page.locator('#results-cards .result-card:not(.result-flat) .card-actions button', { hasText: kind }).first().click(),
      ]);
      let size = 0;
      if (download) {
        const file = out + '/w' + width + '-download.' + kind.toLowerCase();
        await download.saveAs(file);
        size = require('node:fs').statSync(file).size;
      }
      checks['download' + kind] = size > 500 ? size + ' bytes' : false;
    }
    if (fallback) {
      // the notice and the tag are still there on the last step, results are labelled, and a retry says "still not reachable"
      checks.noticeOnResults = await page.evaluate(() => !document.getElementById('notice-demo').hidden && !document.getElementById('demo-tag').hidden && !document.getElementById('results-demo').hidden && document.getElementById('btn-dl-zip').disabled);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.click('#btn-server-retry');
      await page.waitForFunction(() => /Still not reachable/.test(document.getElementById('notice-demo').textContent), null, { timeout: 20000 });
      checks.retrySaysStillDown = true;
      await record('5-fallback-top', false);
    } else {
      // the three server-made downloads, then a real upload and a delete (each needs the API)
      for (const [id, ext] of [['#btn-dl-zip', '.zip'], ['#btn-dl-netcdf', '.nc'], ['#btn-dl-json', '.json']]) {
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => null), page.click(id)]);
        checks['export' + ext] = download ? download.suggestedFilename() : false;
      }
      await page.click('#stepper [data-step="1"]');
      const rows = [];
      for (let d = new Date(Date.UTC(1991, 0, 1)); d.getUTCFullYear() < 2003; d.setUTCDate(d.getUTCDate() + 1)) {
        const doy = (d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5;
        const tx = 29 + 4 * Math.cos((doy / 365) * 6.283) + (doy % 5) * 0.4;
        rows.push([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), doy % 6 === 0 ? 12.5 : 0, tx.toFixed(1), (tx - 8).toFixed(1)].join(' '));
      }
      await page.setInputFiles('#file-input', { name: 'island station.txt', mimeType: 'text/plain', buffer: Buffer.from(rows.join('\n') + '\n') });
      await page.waitForFunction(() => /4,383 lines|4.383 lignes/.test(document.getElementById('file-info').textContent), null, { timeout: 10000 });
      await page.click('#btn-upload');
      await page.waitForFunction(() => !document.getElementById('step-2').hidden && /island station/.test(document.getElementById('qc-lead').textContent), null, { timeout: 60000 });
      checks.upload = true;
      await page.click('#stepper [data-step="1"]');
      await page.click('#btn-delete');
      await page.waitForFunction(() => document.getElementById('loaded-box').hidden, null, { timeout: 30000 });
      checks.deleted = true;
    }
    if (Object.values(checks).some((v) => v === false)) bad += 1;
    const problems = logs.filter((l) => !expected(l));
    checks.mode = fallback ? (demoNotice.startsWith('The calculation server is not reachable right now.') && demoState.tag && demoState.uploadOff && demoState.retryButton ? 'fallback shown' : false) : demoNotice === '' && !demoState.tag && !demoState.uploadOff ? 'normal' : false;
    if (checks.mode === false) bad += 1;
    const big = fixtures.filter((f) => /^(daily_|compute_|dataset)/.test(f));
    checks.firstLoadFixtures = firstLoadFixtures.join(',') || 'none';
    checks.largeExamplesOnFirstLoad = firstLoadFixtures.filter((f) => /^(daily_|compute_|dataset)/.test(f)).length;
    if (checks.largeExamplesOnFirstLoad) bad += 1;
    checks.examplesFetchedLater = [...new Set(big)].join(',') || 'none';
    checks.apiRequests = [...new Set(api)].join(' | ') || 'none';
    checks.conn = demoState.conn;
    const first = await page.evaluate(() => [...document.querySelectorAll('#results-cards .result-card h5')].slice(0, 4).map((h) => h.textContent));
    const compare = await page.evaluate(() => [document.getElementById('compare-a').value, document.getElementById('compare-b').value]);
    for (const k of Object.keys(steps)) if (steps[k].overflow > 0) bad += 1;
    if (problems.length || external.length) bad += 1;
    report.push({ width, lang, scheme, mode: fallback ? 'fallback' : apiOrigin ? 'cross-origin' : 'same-origin', checks, overflowPx: Object.fromEntries(Object.keys(steps).map((k) => [k, steps[k].overflow])), offenders: Object.fromEntries(Object.keys(steps).filter((k) => steps[k].offenders.length).map((k) => [k, steps[k].offenders])), firstCards: first, compare, logs: problems, expectedLogs: logs.length - problems.length, external });
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify(report, null, 1));
  process.exit(bad ? 1 : 0);
})().catch((e) => {
  console.error('FAILED ' + String(e && e.message).slice(0, 600));
  process.exit(1);
});
