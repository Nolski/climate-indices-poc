# Publishing the front end on GitHub Pages

The front end in `web/` is plain static files. It can be served in two ways from the same
source, and only one small file differs between them:

| | Container (default) | GitHub Pages |
|---|---|---|
| Page address | `/` on the API's own server | `https://<user>.github.io/<repo>/` (a sub-path) |
| API address | same server, `/api` | a separately hosted server, another origin |
| `config.js` | as in the repository: `apiBase: ''` | written at build time from `API_BASE` |
| Content-Security-Policy `connect-src` | `'self'` | `'self'` plus the API's origin, nothing wider |

Nothing in the container deployment changes: with an empty `apiBase` the page behaves exactly
as before and never looks anywhere else.

## Build and deploy

`scripts/build_pages.sh` assembles `_site/`: `web/` without tests, check scripts and READMEs,
plus `.nojekyll`, a generated `config.js`, and the API origin added to the `connect-src` part of
the meta Content-Security-Policy in `index.html`. It refuses addresses that are not plain
`http(s)://host[:port][/path]`.

```
API_BASE=https://api.example.org scripts/build_pages.sh     # page talks to that API
scripts/build_pages.sh                                      # no API: demonstration only
```

`.github/workflows/pages.yml` runs the script with `API_BASE` from the repository variable of
that name and deploys with the official Pages actions. One-time setup: Settings -> Pages ->
Source "GitHub Actions"; Settings -> Secrets and variables -> Actions -> Variables ->
`API_BASE`. Leave the variable empty to publish the demonstration only. The actions are pinned
to major versions; replace them with commit SHAs before relying on the workflow (see the comment
in the file). `_site/` is build output and should be listed in `.gitignore`.

Optional: `API_ALTERNATIVES` (comma-separated) lists further API addresses. A visitor can then
choose one with `?api=<address>`. A `?api=` value that is not in the built `config.js` is
ignored and the page says so; a link can never point the page at an arbitrary server (and the
Content-Security-Policy would block it as well).

The page also asks the API for its limits (`GET /api/limits`) and shows that server's upload
limit and retention time, because a small public server may be set lower than the defaults.

## What the page does when the API is away

On load, a page with a separately hosted API asks `GET /api/health` (6 s limit, two attempts).

- It answers: normal operation.
- It does not (down, wrong address, blocked by CORS, time-out): the page switches to its
  demonstration mode by itself and says: "The calculation server is not reachable right now. You
  are seeing the demonstration with saved results for the sample station; uploading your own
  file is unavailable until it is back." A "Try the server again" button checks at once; the
  page also checks quietly every minute and, when the server answers, offers "Use the server
  now" without pulling the page away from what the person is looking at.
- Built without `API_BASE`: always the demonstration, with a notice that says so and no retry.
- `?fixtures=1` still forces the demonstration in any deployment.

In the demonstration, uploading and editing station details are switched off with the reason
shown, a tag in the step bar stays in view on every step, results are labelled as saved
examples, and ZIP/NetCDF downloads (made by the server) are switched off. A real session and a
demonstration session are stored under different keys, so neither can be mistaken for the other.

The Pages build's first load is 16 requests, about 75 KB compressed (246 KB uncompressed): the
same files as in the container. The saved examples in `fixtures/` total about 2.1 MB, but the
first load in the demonstration fetches only two small ones (version and the list of indices,
under 2 KB compressed). The dataset (29 KB), the yearly
results (60 KB), a daily series (about 500 KB, about 100 KB compressed) and the monthly results
(about 480 KB) are each fetched only when the step that shows them is opened.

## What the API must allow (CORS)

The API has this built in: set `CLIMPOC_CORS_ORIGINS` to the Pages origin (row 20 of
`docs/CONTRACT_CHANGES.md`). The table below is what the front end needs, so the two can be
compared; they were checked against each other in a headless browser (page on one port, API on
another, every step including upload, the three exports and delete).

The front end never sends cookies or credentials, and adds exactly one request header of its
own (`Content-Type: application/json` on JSON bodies).

| Requirement | Value |
|---|---|
| Allowed origin | the Pages origin, scheme and host only: `https://<user>.github.io` (not the `/<repo>/` path); set through `CLIMPOC_CORS_ORIGINS` |
| `Access-Control-Allow-Origin` | that exact origin, with `Vary: Origin`; on **every** response, including 400, 404, 413, 422 and 500, otherwise the browser hides the error text and the page can only say "could not be reached" |
| `Access-Control-Allow-Credentials` | not needed; do not send it |
| Preflight (`OPTIONS`) | must be answered on every `/api/...` path, without running the handler |
| `Access-Control-Allow-Methods` | `GET, POST, DELETE, OPTIONS` |
| `Access-Control-Allow-Headers` | `Content-Type` |
| `Access-Control-Max-Age` | 600 or more, so each preflight is paid once (Chromium caps it at 7200) |
| `Access-Control-Expose-Headers` | `Content-Disposition`, so downloads keep the server's file name (without it the page makes up a name; nothing breaks), and `Retry-After`, which the page obeys when it is rate-limited (429) |

Which requests are preflighted:

| Request | Preflight | Why |
|---|---|---|
| `GET /api/health`, `/version`, `/limits`, `/indices`, `/datasets/{id}`, `/datasets/{id}/daily`, `/datasets/{id}/export` | no | simple GET, no added header |
| `POST /api/datasets/sample`, `/datasets/{id}/compute`, `/datasets/{id}/qc` | yes | `Content-Type: application/json` |
| `POST /api/datasets` (multipart upload) | yes | the upload reports progress, which makes the request non-simple although its content type is a simple one; the preflight asks for no extra header |
| `DELETE /api/datasets/{id}` | yes | method |

Also needed on the API side: HTTPS (a page served over HTTPS may not call an `http://` API),
and compression of JSON responses as today. With FastAPI/Starlette, add the CORS middleware
last so that it wraps the upload-size limit and the error handlers; an exception that escapes
as a bare 500 otherwise carries no CORS header.

## Testing it locally

Two ports are two origins, so this is a real cross-origin set-up:

```
OUT=/tmp/site/my-repo API_BASE=http://127.0.0.1:8001 scripts/build_pages.sh
(cd /tmp/site && python3 -m http.server 8080)            # page at http://127.0.0.1:8080/my-repo/
CLIMPOC_CORS_ORIGINS=http://127.0.0.1:8080 uv run uvicorn climpoc.api.app:app --port 8001
```

For an API build without `CLIMPOC_CORS_ORIGINS`, `web/tests/cors_proxy.mjs` can stand in: it
forwards to the API and adds exactly the headers in the table above
(`node web/tests/cors_proxy.mjs 8001 http://127.0.0.1:8000 http://127.0.0.1:8080`).

Stop the API (or build with an address where nothing listens) to see the fallback.
`web/tests/browser_walk.cjs` walks all three situations in a headless browser; see
`web/README.md`.
