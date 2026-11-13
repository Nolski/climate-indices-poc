# Front end

A single page, in four numbered steps, for staff at national meteorological services who work
on slow and unstable connections: load a station file, check its quality, choose climate
indices, look at the results and download them.

Independent proof of concept. Not affiliated with or endorsed by WMO or the Climpact maintainers.

- No build step. Plain HTML, CSS and ES modules; nothing to install to run it.
- No third-party code at all. The chart is `js/chart.js` (see "Why no chart library").
- No request leaves the origin. The page talks only to `/api` on the server that served it, and
  a Content-Security-Policy in `index.html` makes the browser enforce that.
- About 75 KB compressed for the whole first load (gzip; 72 KB as the backend sends it with Brotli); see `BUDGET.md`.

**How far it has been looked at in a browser.** Besides the command-line checks (unit tests,
static checks, a simulated DOM, the real API), the page was walked through all four steps in a
separate headless Chromium at 1280, 360 and 320 px wide, in English and French, and at 360 px
in dark mode: no horizontal overflow on any step, no console errors, no request to another
origin, drag-zoom and PNG/SVG download work, and the screenshots were read. Not done: Firefox
and Safari, a touch screen, a screen reader, 200% zoom, and a person using it. The list of what
to look at first is at the end.

## Structure

```
index.html          the whole page: four step sections, inline SVG icons, English text
config.js           where the API is; the only file that differs between deployments
css/app.css         one stylesheet; colour tokens for light and dark; logical properties only
js/main.js          state, step navigation, language, connection indicator, session restore
js/api.js           API client: time-outs, retry with backoff, events, fixtures mode   (no DOM)
js/shape.js         API responses -> chart series, table rows, verdicts, file pre-check (no DOM)
js/i18n.js          translation helper                                                 (no DOM)
js/format.js        numbers, dates and units through Intl                              (no DOM)
js/store.js         sessionStorage / localStorage behind try/catch                     (no DOM)
js/chart.js         SVG time-series chart: pure renderer + hover, keyboard and zoom
js/dom.js           element helper, icons, file saving, the busy/retry/error status line
js/view-load.js     step 1
js/view-qc.js       step 2
js/view-indices.js  step 3
js/view-results.js  step 4
i18n/en.json        every user-facing string
i18n/fr.json        complete French translation, machine-drafted, marked as such in the UI
fixtures/           example API responses, written by the backend (not owned by the front end)
tests/              checks; nothing in here is loaded by the page
measure.sh          page weight -> BUDGET.md
check.sh            runs every check
```

## Running it

Against the API (the backend serves `web/` at `/`):

```
uv run uvicorn climpoc.api.app:app --port 8000      # from the repository root
# open http://127.0.0.1:8000/
```

Without a backend, from saved example responses:

```
cd web && python3 -m http.server 8080
# open http://127.0.0.1:8080/?fixtures=1
```

`?fixtures=1` answers every API call from `fixtures/*.json`, through the same client code
(time-outs, retries and error handling included). It also works when the page is served by the
backend. This is the demonstration mode, and it is explicit about what it is:

- a notice above every step and a tag in the step bar that stays in view;
- uploading a file and editing the station details are switched off, with the reason shown;
- results are labelled "saved example results", ZIP and NetCDF (made by the server) are switched
  off, and JSON, per-index CSV, PNG and SVG work;
- a demonstration session is stored apart from a real one, so neither is ever shown as the other.

### Three ways to deploy the same files

| | `config.js` | Behaviour |
|---|---|---|
| Container (default) | `apiBase: ''` | Page at `/`, API at `/api` on the same server. No health check on load, no fallback: exactly as before. |
| Static site + separate API (GitHub Pages) | `apiBase: 'https://...'` | The API is asked once on load. If it answers: normal use. If not: the page falls back to the demonstration, says "The calculation server is not reachable right now...", and offers "Try the server again" (it also checks quietly every minute and then offers "Use the server now"). |
| Static site, no API | `demoOnly: true` | Always the demonstration, with a notice that says so. |

`scripts/build_pages.sh` builds the static site (`_site/`): it copies `web/` without tests,
scripts and READMEs, writes `config.js` from `API_BASE`, and adds that origin to `connect-src` in
the page's Content-Security-Policy. Nothing else differs from the container's copy, and every
URL in the page is relative, so it works under `/<repo>/`. `?api=<address>` can select another
API only if the built `config.js` lists it under `apiAlternatives`; any other value is ignored
and the page says so. What the API has to allow (CORS) and how to try it locally are in
`docs/pages-hosting.md`; the workflow is `.github/workflows/pages.yml`.

The page shows the limits of the server it talks to (upload size and how long data is kept,
from `GET /api/limits`; 20 MB and 60 minutes if the server does not say).

Other query parameters: `?lang=fr` picks the language.

It must be served over HTTP; opening `index.html` from disk does not work (browsers do not load
ES modules from `file://`). Needs a browser from 2021 or later (Chrome or Edge 88, Firefox 79,
Safari 14.1).

## Page weight

`web/measure.sh` writes `BUDGET.md`; `web/measure.sh --url http://HOST:PORT` adds what the
running server really sends and times the first load through a simulated slow link.

| | |
|---|---|
| First load, compressed | 75.5 KB with gzip in 16 requests, 50% of the 150 KB budget; 71.9 KB on the wire from the backend (Brotli) |
| First load, uncompressed | 249 KB (so compression on the server is required; the backend and GitHub Pages both compress) |
| Web fonts, images, third-party code | none |
| Slow 3G, simulated (400 kbit/s, 400 ms) | page text 0.9 s, styled 1.3 s, all scripts 2.9 s, first API data 3.3 s |
| Very slow, simulated (250 kbit/s, 600 ms) | page text 1.3 s, styled 2.1 s, all scripts 4.6 s, first API data 5.2 s |

The file-by-file table is in `BUDGET.md`. The timings come from `tests/slow_link.mjs`, a
throttling proxy and a scripted fetch sequence; no browser was involved, so script start-up and
drawing are not in them.

Things that keep it light: the page is readable as soon as the HTML and CSS arrive, because the
English text is in the HTML; all modules and the English strings are preloaded in parallel
instead of being discovered one import at a time; the daily series (about 100 KB compressed for
80 years) is only fetched if the daily chart is opened; the list of indices is cached in
`localStorage` and shown at once on the next visit while it is refreshed in the background.

## Behaviour on a bad connection

| Behaviour | Where |
|---|---|
| Every request has a time limit (8 s for health up to 180 s for a calculation). | `TIMEOUTS` in `js/api.js` |
| Uploads use an idle limit that restarts whenever bytes move, so a slow upload is not cut off. | `request()` in `js/api.js` |
| A dropped connection, a time-out, and HTTP 408, 425, 429, 502, 503, 504 are retried, with waits of about 1, 2 and 4 seconds (jittered, capped at 15 s). Other errors are not retried. | `js/api.js` |
| While retrying, the action's own status line says "trying again in about N s (attempt 2 of 4)", and the indicator in the header changes. | `createStatus` in `js/dom.js`, `paintConnection` in `js/main.js` |
| A busy state always shows elapsed seconds, a note after 15 to 20 seconds that it is still working, and a Cancel button for uploads and calculations. It always ends in a result or in a specific message with a "Try again" button. | `js/dom.js` |
| When all attempts fail the message says how often it tried and that nothing is lost; the header shows "No connection" and the page polls `/api/health` (5 s, then up to 30 s) and says when the connection is back. | `describeError`, `schedulePoll` in `js/main.js` |
| Errors show the server's own message and details (for example the line numbers of a bad file), next to the file, with "Try again" and "Choose a different file". | `failed()` in `js/view-load.js` |
| A double press does not send twice: identical requests in flight share one call, and buttons are disabled while busy. Deleting data that is already gone counts as done. | `shared()` and `remove()` in `js/api.js` |
| If the server no longer has the dataset (HTTP 404), a notice explains it and offers one button: upload the file the browser still holds, or reload the sample. If that happened during a calculation, the calculation resumes by itself afterwards. | `markExpired` in `js/main.js` |
| The dataset id, station details, selection, frequency and current step are in `sessionStorage`, and so are the results when they fit (1.5 MB of text). A reload returns to the same step; a reload on the results needs no network at all. | `js/store.js`, `restoreSession` in `js/main.js` |
| Storage is optional: every access is inside try/catch, and the page works with storage blocked. | `safeStorage` in `js/store.js` |
| The file is looked at in the browser before upload (line count, date range, wrong column counts, bad dates, missing or repeated days), so the most common mistakes cost no upload. The server remains the authority. | `precheckStationText` in `js/shape.js` |
| Per-index CSV and chart PNG/SVG are made in the browser and work with no connection. | `js/view-results.js` |

One honest limit: if the response to an upload is lost and the upload is retried, the server
ends up holding two copies until they expire. The person sees one dataset. An idempotency key
on `POST /api/datasets` would remove this.

### Trying it by hand

In fixtures mode, add `&simulate=` to the address:

| Address | What to expect |
|---|---|
| `?fixtures=1&simulate=flaky` | every other request fails once; press "Try the sample station" and watch the retry message and the header indicator, then success |
| `?fixtures=1&simulate=slow` | every answer takes 2.5 s; watch elapsed seconds and the Cancel button |
| `?fixtures=1&simulate=offline` | nothing answers; after four attempts (about 8 s) a full explanation with "Try again" |
| `?fixtures=1&simulate=badfile` | choose any file and upload: the server's message and per-line details appear next to the file |
| `?fixtures=1&simulate=expired` | load the sample, go to step 3, reload the page: the "server no longer holds your data" notice with a one-click reload |

Against the real API:

- In the browser's developer tools, Network tab, choose the "Slow 3G" throttling preset and
  reload with the cache disabled. The page should be readable in about a second and usable in
  about three.
- Start a calculation of all indices, then switch the Network tab to "Offline" for a few
  seconds and back. The status line should show the retry and the calculation should finish.
- Load the sample, stop the backend, press Calculate (message after the retries, "Try again"
  offered), start the backend again and press "Try again": the server has forgotten the dataset,
  so the "no longer holds your data" notice should offer to load it again and then calculate.
- Load data, go to the results, press F5: the same results should appear without a new
  calculation.

## Accessibility

- Semantic structure: one `h1`, a `nav` with the four steps (`aria-current="step"`, locked
  steps `aria-disabled`), one `main`, sections named by their headings, a skip link. Focus moves
  to the heading of the step that opens.
- Every control has a label; errors are tied to their fields with `aria-describedby` and
  `aria-invalid`; all actions are real buttons; no positive `tabindex`.
- Status and errors use live regions (`role="status"`, `role="alert"`). The ticking seconds are
  hidden from assistive technology so a screen reader is not interrupted every second.
- Colour is never the only signal: severity has an icon and a word; the trend line is dashed;
  compared series differ by marker shape and dash; flagged points are diamonds (errors) and
  hollow triangles (warnings); years over the missing-data limit are taller cells as well as
  darker; every chart has a table view.
- Charts: focus a chart and use the left and right arrow keys (Page Up/Down for ten steps, Home,
  End) to read values; the daily chart has zoom and pan buttons as well as drag-to-zoom.
- Contrast: `tests/check_contrast.mjs` checks 84 token pairs against WCAG 2.2 AA (4.5:1 for
  text, 3:1 for control borders, focus ring and chart marks) in light and dark.
- Follows the system light/dark preference, `prefers-reduced-motion` (the only animation is the
  busy spinner), and forced-colours mode. Sizes are in `rem`; layouts are fluid grids that fall
  to one column, intended to work at 200% zoom and at 360 px width. There is a print style.
- Not done: testing with a screen reader, and a manual pass at 200% zoom and 360 px. See the
  list at the end.

## Languages

All user-facing strings are in `i18n/en.json` (flat keys, `{placeholders}`, plural forms as
`key.one` / `key.other`). Numbers, dates and percentages go through `Intl` in the chosen
language. Messages that come from the server (error texts, check titles, index descriptions)
are shown as the server sends them, in English; translating those belongs in the backend.

To add a language:

1. Copy `i18n/en.json` to `i18n/xx.json` and translate the values. Keep the keys and the
   `{placeholders}`. Add other plural categories if the language needs them (`.few`, `.many`).
2. Add it to `LANGUAGES` in `js/i18n.js`: `{ code: 'xx', label: 'Name', dir: 'ltr' }`. Use
   `dir: 'rtl'` for a right-to-left language, and `draft: true` until a native speaker has
   reviewed it (the UI then shows a notice).
3. Run `web/check.sh`: it fails if the key sets or placeholders differ. (The key-parity check
   currently names `fr.json`; add the new file to `tests/check_static.mjs` and the unit test.)

The stylesheet uses logical properties only (`margin-inline`, `inset-inline-start`, ...), so a
right-to-left language mirrors without a second stylesheet. Charts, the missing-data strip and
the file example stay left-to-right on purpose (time runs left to right). No right-to-left
language has been tried.

The English text is also written in `index.html` so the page is readable before any script
runs; `check.sh` fails if the two copies differ.

## Why no chart library

uPlot was the first candidate. It draws on a canvas, which rules out the SVG download, so
an SVG renderer had to be written in any case. Using that one renderer for the screen as well
means the downloaded chart is the chart on screen; it is themed by CSS (dark mode with no
re-draw); its output is a string, so it is unit-tested and was rasterised from the command line
to look at it; and it is 6 KB compressed instead of about 20. The cost is roughly 350 lines of
our own code to maintain. It handles the 29,220-day sample by drawing the lowest and highest
day per pixel column and all days once zoomed in. If gridded data or much longer series arrive,
revisit this.

On the results page the cards follow the index groups. An index that is 0 in every year (frost
days at a warm station, for example) or has no value at all is moved to the end of its group and
gets one sentence instead of a flat chart; its CSV is still offered. The comparison chart opens
on two indices that vary (SU and TR when both exist).

Two indices with different units are compared in two panels above one shared time axis, not on
two y-axes: a double axis lets the reader see a relationship that only the choice of scales
created.

## Checks

```
web/check.sh
CLIMPOC_API=http://127.0.0.1:8000 web/check.sh                    # also against the running API
CLIMPOC_NODE_MODULES=/tmp/x/node_modules web/check.sh              # also the simulated-DOM test
```

1. Syntax: `node --check` on every module, JSON and shell syntax.
2. Unit tests (`tests/unit.test.mjs`, no dependencies): API client against a fake fetch
   (time-out, retry, backoff, cancel, upload progress, expiry), fixtures mode, translation
   helper, formatting, data shaping and missing values, the chart renderer, storage.
3. Static checks (`tests/check_static.mjs`): HTML parses and nests; unique ids; labels bound to
   controls; heading order; every button named; ARIA references resolve; no inline script, style
   or handler; identical key sets and placeholders in both languages; every key used in code
   exists; the module graph resolves, links, and equals the preload list; no external URL in any
   shipped file; no fonts, images, gradients, emoji or vendor code; logical CSS properties only.
4. Contrast of the colour tokens.
5. Every referenced asset returns HTTP 200 from a plain static server.
6. Page weight against the budget.
7. The GitHub Pages build (`../scripts/build_pages.sh`): with an API address only `config.js`
   and the CSP `connect-src` differ from `web/`; without one it is demonstration-only and the
   CSP is untouched; malformed addresses are refused; every file answers when the site is served
   from a sub-path.
8. The whole page in a simulated DOM (`tests/smoke_dom.mjs`, needs jsdom). Demonstration: all
   four steps, threshold re-run, language switch, reload, expired dataset, bad file, flaky and
   dead connection. Same origin: no probe, no demonstration, upload, apply and delete. Separate
   API: asked once on load, only GET/POST/DELETE and `Content-Type`, no credentials, an
   unlisted `?api=` ignored. API unreachable: fallback with the notice, retry while down, switch
   back on request when it returns. No API: demonstration only, not one API request. With
   `CLIMPOC_API` set, the same page code also runs against the real backend.
9. With `CLIMPOC_API` set: the API contract through the page's own client
   (`tests/check_api.mjs`).

jsdom is a development-only dependency and is not stored in the repository:
`npm install --prefix /tmp/x jsdom`. Without it, step 7 prints SKIP and the rest still runs.

### In a real browser

`tests/browser_walk.cjs` drives a separate headless Chromium through the four steps at the
widths you give it. For every step it reports how many pixels the page is wider than the
viewport and which elements stick out, and it checks drag-zoom on the daily chart and the PNG
and SVG downloads. It is not part of `check.sh` and Playwright is not a dependency of this
repository; point it at a copy you already have:

```
CLIMPOC_PLAYWRIGHT=/path/to/node_modules/playwright-core \
CLIMPOC_CHROMIUM=/path/to/chrome-headless-shell \
node web/tests/browser_walk.cjs http://127.0.0.1:8000 /tmp/shots 360 320 1280
```

`CLIMPOC_LANG=fr` walks in French; `CLIMPOC_SCHEME=dark` uses the dark colours. Screenshots
land in the output folder. The address may include a sub-path. For a site that talks to a
separately hosted API add `CLIMPOC_API_ORIGIN=http://HOST:PORT`; add `CLIMPOC_MODE=fallback`
when that API is expected to be away. In the two modes with a server the walk also downloads
ZIP, NetCDF and JSON, uploads a file and deletes it.

Last results, at 1280 and 360 px, all with 0 px overflow, no console message and no request to
any other origin:

| Mode | Set-up | Result |
|---|---|---|
| Same origin | page and API from the backend on one port | normal; exports, upload and delete work |
| Separate API, up | Pages build under `/climpact-poc/` on one port, API with `CLIMPOC_CORS_ORIGINS` on another | normal; health asked first; exports keep the server's file names; upload and delete work across origins |
| Separate API, away | same build, nothing listening at the API address | demonstration with the notice and the tag on every step; first load fetched only `version.json` and `indices.json`; "Try the server again" answers "Still not reachable" |

Earlier single-origin walks: 0 px overflow at 360, 320 and 1280 px (English), 360 and 320 px
(French) and 360 px (dark).

## Known gaps

- Seen only in headless Chromium (see the top of this file); not in Firefox or Safari, not on a
  touch screen, not with a screen reader.
- No service worker. After the first visit the browser's HTTP cache makes reloads cheap, but
  the page does not open with no connection at all. A cache-first worker for the shell is the
  natural next step; it was left out because an untested one can serve stale code.
- One station at a time; no batch of stations; no gridded data.
- With a separately hosted API that hangs instead of refusing the connection, the first check
  can take up to about 12 seconds before the page falls back; the load buttons wait meanwhile.
- Falling back happens on load only. If the separate API goes away in the middle of a session,
  the page behaves as on any bad connection (retries, then a message with "Try again"); it does
  not swap a person's real session for the demonstration.
- The API's optional `parameters`, `missing_policy` and `percentile_method` for a calculation are not offered
  in the page; the defaults are used and the policy that was applied is shown with the results.
- The backend caches unversioned assets for a week (`max-age=604800`). Versioned URLs do not fit
  ES-module imports without a build step, so after an update a returning visitor can run the
  old scripts for up to a week unless they force a reload. Serving `js/`, `css/` and `i18n/`
  with `no-cache` (one conditional request per file) would trade a round trip for freshness.
- Server messages are not translated.
- Session restore after a reload cannot re-upload a file by itself: browsers do not let a page
  keep a chosen file across a reload, so the person is asked to choose it again. The sample
  station reloads with one click.
- The daily chart marks at most the first 200 records per check (the API's cap) and says so.
- The trend line is drawn from the API's slope with an intercept computed in the browser (the
  median of value minus slope times year, the usual companion to Sen's slope). If the backend
  later sends its own intercept, use that.
- A trend on monthly values is shown when the API returns one. A Mann-Kendall test on a series
  with a seasonal cycle is questionable science; that is a backend decision to review.

## What a person should look at first in a real browser

Already seen in headless Chromium and fine there: first load with no console message, layout
at 1280, 360 and 320 px, the sticky step bar, the missing-days strip, the daily chart with
drag-zoom and double-click reset, the Calculate bar, the result cards, PNG and SVG download,
dark mode at 360 px, French at 360 and 320 px. Still for a person:

1. Firefox and Safari: the same walk, above all the open/close arrow drawn in front of each
   check, the sticky bars, and PNG download (it draws the SVG to a canvas).
2. Dropping a real file on the drop area, and uploading a real station file of your own.
3. A touch screen: on the daily chart a horizontal drag should zoom while a vertical drag
   still scrolls the page.
4. Step 4 with all 48 indices on a slow laptop: scrolling speed, and that charts redraw at the
   right width when the window is resized.
5. An exported SVG opened in an office program.
6. 200% zoom at 1280 px wide, and the keyboard alone: Tab order, visible focus ring
   everywhere, arrow keys on charts.
7. A screen reader on steps 1 and 2: that status messages are announced once, not repeatedly.
8. The sticky step bar on a short phone screen in landscape: it stops sticking below 34rem of
   height; check nothing is covered just above that.
