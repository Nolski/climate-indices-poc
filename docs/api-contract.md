# API contract

The HTTP API served by `climpoc serve` (FastAPI). The static front end in `web/` is its only
client today, but nothing in it is specific to that client. The machine-readable schema is at
`/api/openapi.json`. [CONTRACT_CHANGES.md](CONTRACT_CHANGES.md) lists what changed since the first draft.

## Conventions

* All bodies are JSON (UTF-8), except uploads (multipart) and file downloads.
* Missing numeric values are `null`, never `-99.9` or `NaN`.
* Index values are rounded to 4 decimals and daily values to 2.
* Responses to `/api/...` carry `Cache-Control: no-store`. Responses over 500 bytes are compressed
  with Brotli or gzip when the client accepts it.
* Uploaded data is held in memory only, for a limited time (60 minutes by default), and is never
  written to disk. A dataset identifier (`ds_` plus 16 hexadecimal characters) is the only key to
  a dataset: whoever knows it can read and delete that dataset until it expires.

### Errors

Every failure has the same shape:

```json
{ "error": { "code": "invalid_station_file", "message": "The station file could not be read: 2 problems found.",
             "details": [ { "line": 2, "code": "wrong_column_count", "message": "Line 2: expected 6 columns (year month day precip tmax tmin) but found 5." } ] } }
```

`message` is written for the end user. `details` depends on the code: `{line, code, message}`
objects for `invalid_station_file` (at most 50; the message gives the total),
`{field, message}` objects for `invalid_request`, the unknown identifiers for `unknown_index`,
the valid names for `unknown_qc_setting` and `unknown_missing_policy`, `{id, reason}` objects
for `nothing_to_export`, otherwise an empty list.

| HTTP | Codes |
|---|---|
| 400 | `empty_file`, `invalid_base_period`, `unknown_index`, `no_indices`, `unknown_variable`, `invalid_date`, `unknown_missing_policy`, `invalid_missing_policy`, `unknown_qc_setting`, `nothing_to_export` |
| 404 | `dataset_not_found` (unknown or expired), `sample_not_available`, `not_found` |
| 405 | `method_not_allowed` |
| 413 | `file_too_large` |
| 422 | `invalid_station_file` (the file's content), `invalid_request` (parameters or body) |
| 429 | `rate_limited` (only when a request limit is configured; `Retry-After` gives the seconds to wait) |
| 500 | `internal_error` (an unexpected failure; details are logged on the server, not sent) |

## Endpoints

### `GET /api/health`

`{ "status": "ok" }`. Never rate-limited.

### `GET /api/version`

`{ "app": "0.1.0", "xclim": "1.0.0", "python": "3.12.x" }`

### `GET /api/limits`

The limits this server enforces, so a client can show the real ones:

```json
{ "max_upload_mb": 20, "max_datasets": 50, "dataset_ttl_minutes": 60, "rate_limit_per_minute": null }
```

`rate_limit_per_minute` is `null` when there is no request limit.

### `GET /api/indices`

The indices for the default user parameters.

```json
{ "indices": [ {
    "id": "txx", "name": "TXx", "long_name": "Hottest day",
    "description": "Maximum of daily maximum temperature",
    "group": "temperature",
    "units": "degC",
    "inputs": ["tasmax"],
    "frequencies": ["annual", "monthly"],
    "needs_base_period": false,
    "validated": true,
    "validation": { "annual": "exact", "monthly": "exact" }
} ] }
```

* `group`: `temperature`, `precipitation`, `duration` or `percentile`.
* `units`: `degC`, `days`, `mm`, `mm/day`, `%` or `degree-days`.
* `inputs`: any of `pr`, `tasmax`, `tasmin`.
* `validation`: the status of each output in the default case of `VALIDATION.md` (`exact`,
  `within tolerance` or `differs`). `validated` is true only when every frequency was compared
  with the R tool and agrees.

### `POST /api/datasets`

Upload a station file. `multipart/form-data` with:

| Field | Required | Meaning |
|---|---|---|
| `file` | yes | station text file: `year month day precipitation(mm) tmax(degC) tmin(degC)`, missing `-99.9` |
| `name` | no | station name (default: the file name without extension) |
| `latitude`, `longitude` | no | degrees; latitude of zero or below selects southern-hemisphere rules |
| `base_start`, `base_end` | no | base period years (default 1971 and 2000) |

Answers `201` with the dataset object, `413` above the upload limit, `422` with line-numbered
details when the file is malformed (wrong column count, non-numeric values, impossible dates,
repeated or out-of-order dates, absent days).

```json
{ "id": "ds_6aa84d5e676cfa21",
  "station": { "name": "my_station", "latitude": -10.0, "longitude": 100.0 },
  "period": { "start": "1936-01-01", "end": "2015-12-31", "n_days": 29220 },
  "base_period": { "start": 1971, "end": 2000 },
  "expires_in_seconds": 3600,
  "variables": {
    "pr":     { "units": "mm/day", "n_missing": 7,  "min": 0.0, "max": 327.6, "mean": 3.36 },
    "tasmax": { "units": "degC",   "n_missing": 58, "min": 9.3, "max": 45.8,  "mean": 22.15 },
    "tasmin": { "units": "degC",   "n_missing": 58, "min": 2.7, "max": 27.6,  "mean": 14.13 } },
  "qc": {
    "summary": { "errors": 1, "warnings": 4, "info": 1 },
    "settings": { "max_precip_mm": 200.0, "max_temperature_jump": 20.0, "...": "..." },
    "checks": [ {
        "id": "tmax_lt_tmin", "title": "Maximum below minimum", "severity": "error",
        "description": "Days where tmax is lower than or equal to tmin",
        "count": 1,
        "records": [ { "date": "1988-11-16", "variable": "tasmax", "value": 12.6, "detail": "tmin 12.6" } ]
    } ],
    "missing_by_year": [ { "year": 1936, "pr": 0, "tasmax": 2, "tasmin": 2 } ] },
  "notes": [] }
```

* `qc.summary` counts the checks that have at least one finding, by severity (`error`,
  `warning`, `info`).
* `records` holds at most 200 findings per check; `count` is the true total.
* `qc.settings` are the thresholds that were used.
* `notes` are non-fatal remarks of the parser (for example a skipped header line), each
  `{line, code, message}`.

### `POST /api/datasets/sample`

Load the bundled sample station. Optional JSON body
`{ "latitude": -10, "longitude": 100, "base_start": 1971, "base_end": 2000 }` (those are the
defaults). Answers `201` with the dataset object, or `404 sample_not_available` when the sample
file is not installed.

### `GET /api/datasets/{id}`

The dataset object again (with the current `expires_in_seconds`).

### `DELETE /api/datasets/{id}`

Delete the dataset now. `204`.

### `POST /api/datasets/{id}/qc`

Re-run quality control with other thresholds. The body is a JSON object with any subset of the
QC settings, for example `{ "max_precip_mm": 150, "climatology_sd": 3 }`. Answers the `qc`
object; the stored dataset is updated.

Settings: `tmax_tmin_inclusive`, `max_precip_mm`, `max_abs_temperature`, `iqr_factor_temperature`,
`iqr_factor_precip`, `climatology_sd`, `climatology_window_days`, `max_temperature_jump`,
`flatline_min_repeats`, `rounding_digit_share`, `rounding_min_values`,
`max_missing_days_per_month`, `max_missing_days_per_year`.

### `GET /api/datasets/{id}/daily?variable=tasmax&start=1990-01-01&end=1999-12-31`

One daily variable (`pr`, `tasmax` or `tasmin`; default `tasmax`). `start` and `end` are optional
ISO dates; the whole record is returned without them.

```json
{ "variable": "tasmax", "units": "degC", "time": ["1990-01-01", "1990-01-02"], "values": [22.1, null] }
```

### `POST /api/datasets/{id}/compute`

```json
{ "indices": ["txx", "su"],
  "frequency": "annual",
  "missing_policy": { "id": "climdex", "max_missing_days_per_year": 15, "max_missing_days_per_month": 3 },
  "percentile_method": "climdex",
  "parameters": { "wsdi_days": 3, "csdi_days": 3, "hdd_base": 18, "cdd_base": 18, "gdd_base": 10, "rx_days": 3, "rnn_mm": 30 } }
```

Every field is optional.

* `indices`: a list of identifiers, or `"all"` (default).
* `frequency`: `"annual"` (default) or `"monthly"`.
* `missing_policy`: `climdex` (default; limits adjustable), `any` (one missing day removes the
  period) or `fraction` (`max_missing_fraction`).
* `percentile_method`: `climdex` (default) or `xclim` (xclim's own thresholds and bootstrap:
  slower, and it does not reproduce the R tool).
* `parameters`: the user-defined indices. The identifier carries the value: `wsdi_days: 5` gives
  `wsdi5`, `hdd_base: 15` gives `hddheat15`, `rx_days: 7` gives `rx7day`, `rnn_mm: 25` gives
  `r25mm`. The defaults give the identifiers listed by `GET /api/indices`.

```json
{ "dataset_id": "ds_6aa84d5e676cfa21", "frequency": "annual",
  "base_period": { "start": 1971, "end": 2000 },
  "missing_policy": { "id": "climdex", "max_missing_days_per_year": 15, "max_missing_days_per_month": 3 },
  "elapsed_ms": 3529,
  "results": [ {
      "id": "txx", "name": "TXx", "long_name": "Hottest day", "units": "degC",
      "time": ["1936", "1937"],
      "values": [37.7, 36.7],
      "stats": { "n": 79, "mean": 38.7165, "min": 32.5, "max": 45.8 },
      "trend": { "method": "sen", "slope_per_decade": 0.0278, "lower": -0.2203, "upper": 0.3125, "p_value": 0.819107, "n": 79 }
  } ],
  "skipped": [ { "id": "sdii", "reason": "not available at monthly frequency" } ] }
```

* `time` is `YYYY` for annual and `YYYY-MM` for monthly values.
* `trend` is Sen's slope with its 95 % bounds, all three per decade, and the Mann-Kendall
  p-value. It is `null` when fewer than 10 values, or less than 70 % of the series, are valid.
* An index that cannot be computed (not offered at this frequency, an input without data, a
  base period without data) is listed in `skipped` with a plain-language reason; the request
  still succeeds.
* Results are kept with the dataset: repeating a request answers from memory with
  `elapsed_ms: 0`. Computations are queued, one at a time per server process.

### `GET /api/datasets/{id}/export?format=zip|netcdf|json&frequency=annual|monthly&indices=txx,su`

A file download (`Content-Disposition: attachment`). `indices` is optional (default: all); the
default user parameters and missing-data policy are used.

* `zip`: one Climpact-style CSV per index, a tidy long-format CSV, a NetCDF file, a trend table,
  the QC findings, missing days per year and a `README.txt` recording settings and versions.
* `netcdf`: one NetCDF file (classic format, CF-1.11 attributes), one variable per index.
* `json`: the compute response.

`400 nothing_to_export` when none of the requested indices can be computed.

## Deployment settings

Environment variables, all optional, validated at start-up (a bad value stops the server with a
message naming the variable).

| Variable | Default | Meaning |
|---|---|---|
| `CLIMPOC_CORS_ORIGINS` | unset | Comma-separated exact origins (`https://example.github.io`) that may call the API from a browser. Unset: no cross-origin headers at all. No wildcards. |
| `CLIMPOC_MAX_UPLOAD_MB` | 20 | Largest accepted upload. |
| `CLIMPOC_MAX_DATASETS` | 50 | Datasets held at once; the oldest is evicted when a new one arrives. |
| `CLIMPOC_DATASET_TTL_MINUTES` | 60 | Minutes until a dataset is deleted. |
| `CLIMPOC_RATE_LIMIT_PER_MINUTE` | 0 (off) | Requests per client address per minute on `/api/` (burst of the same size). |
| `CLIMPOC_TRUST_PROXY` | 0 | `1`: take the client address from the last entry of `X-Forwarded-For`. Only behind a reverse proxy. |
| `CLIMPOC_WEB_DIR`, `CLIMPOC_SAMPLE_FILE` | found automatically | Location of the static front end and of the sample station file. |

### Cross-origin access

When `CLIMPOC_CORS_ORIGINS` is set, requests from a listed origin receive
`Access-Control-Allow-Origin: <that origin>` (never `*`) and `Vary: Origin`; credentials are not
allowed. Preflight requests are answered for the methods `GET`, `POST`, `DELETE`, `OPTIONS` and
the request header `Content-Type` (cached for 10 minutes). `Content-Disposition` and
`Retry-After` are exposed so that downloads keep their file names and a page can read a
rate-limit answer. Error answers, including 413 and 429, carry the same headers. Requests from
other origins receive no cross-origin header at all, so browsers refuse to hand the answers to
those pages. See [pages-hosting.md](pages-hosting.md) for the separately hosted front end.

## Static files

When a front-end directory is present it is served at `/`. HTML and `fixtures/` are
`Cache-Control: no-cache`; other assets `public, max-age=604800` with an ETag, and
`public, max-age=31536000, immutable` when the URL carries a version (`app.js?v=3`). A
Content-Security-Policy of `default-src 'self'` is sent (inline styles allowed, inline scripts not).

## Fixtures

`web/fixtures/*.json` are real responses of this API for the sample station, written by
`scripts/make_fixtures.py`; the front end uses them in its demonstration mode.
