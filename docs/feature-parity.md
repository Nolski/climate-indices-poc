# Feature parity with Climpact 3.4.4

A capability-by-capability comparison of this proof of concept with Climpact 3.4.4, the R tool
it explores a replacement for. It answers a different question from [VALIDATION.md](../VALIDATION.md):
not "do the numbers agree?" but "can a user do the same things?". The short answer is no, not yet.

The Climpact column comes from its user guide, from a prose review of its code and from the
outputs of running it; no R calculation source was read for this table. Status values:

* **Present**: a user can do it here, with equal or better results.
* **Partial**: part of it exists; the note says which part.
* **Absent**: not available here.
* **Different by design**: the need is met in another way, or the behaviour was deliberately not copied.

Index counts are outputs (one index at one frequency) of the default validation case and are
taken from `validate/validation.json`, so they agree with VALIDATION.md.

## Input and validation

| Capability | Climpact 3.4.4 | This proof of concept | Status | Note |
|---|---|---|---|---|
| Station text file: six columns, tab, comma or space separated, -99.9 missing, optional header line | yes | yes; also semicolons and decimal commas | Present |  |
| Files with absent days | accepted, filled silently | an error with line numbers by default; `--repair-dates` (command line) or `chronology="repair"` (library) fills them and says so | Different by design | the API has no repair option yet |
| Impossible dates (30 February) | row dropped silently | an error naming the line | Different by design |  |
| Order of rows | years must ascend | every date must follow the previous one; duplicates named with both line numbers | Present | stricter |
| Base period checks | start after end, no overlap with the data, and less than one year of data in the base period stop the run; partial coverage warns | start after end is an error; with too little base-period data the percentile indices are skipped with a reason and the rest are computed; no warning for partial coverage | Partial |  |
| Station name, latitude, longitude (range-checked) | yes | yes (API, command line, web) | Present | latitude selects the hemisphere, as in Climpact |
| Sector data file (annual CSV) | yes | no | Absent | see sector correlation |
| Batch metadata file (12 columns, one row per station) | yes | no | Absent | `UserParameters.from_climpact_metadata` reads its parameter columns; nothing reads the file |
| Gridded NetCDF input (CF-style, unit conversion) | command-line wrapper | no | Absent | designed for, not built |

## User parameters

| Capability | Climpact 3.4.4 | This proof of concept | Status | Note |
|---|---|---|---|---|
| Base period | web, batch argument | API, command line, web | Present |  |
| WSDId and CSDId spell length d | web, metadata `wsdin`, `csdin` | API (`parameters`), command line (`--wsdi-days`, `--csdi-days`); not in the web interface | Partial | added for the `params` validation variant |
| RXdday window d | web, metadata `rxnday` | API, command line (`--rx-days`); not in the web interface | Partial |  |
| Rnnmm threshold | web, metadata `rnnmm` | API, command line (`--rnn-mm`); not in the web interface | Partial |  |
| Degree-day base temperatures (HDD, CDD, GDD) | web, metadata `Tb_HDD`, `Tb_CDD`, `Tb_GDD` | API, command line (`--hdd-base`, `--cdd-base`, `--gdd-base`); not in the web interface | Partial |  |
| TXdTNd / TXbdTNbd length d | web, metadata `txtn` | no | Absent | the indices are not implemented |
| Custom SPI/SPEI time scale | web, metadata `SPEI` | no | Absent | the indices are not implemented |
| Custom day-count index (variable, operator, threshold) | web only | no | Absent | new thresholds are one registry entry in code, not a user setting |
| Plot title | web | no | Absent | charts are titled by index and station |
| Six QC thresholds (two IQR factors, maximum rain, maximum temperature, flat-line length, jump size) | web (batch uses defaults) | API and web, re-runnable; the command line uses defaults | Present | plus thresholds for the extra checks |

## Quality control

| Capability | Climpact 3.4.4 | This proof of concept | Status | Note |
|---|---|---|---|---|
| Outliers per calendar month (boxplot rule), table | yes | yes; same dates on the sample | Present |  |
| Outliers per calendar month, box plots | yes | no | Absent | table only |
| Outliers per year, box plots | yes (plot only) | no | Absent |  |
| Rounding: histograms of decimal values | yes (plot only) | years in which one final digit dominates are flagged; no histogram | Partial |  |
| TX not above TN, table | yes | yes; same date | Present | equality flagged as in Climpact, optional |
| Values too large (rain, temperature, negative rain), table | yes | yes; same dates (two checks) | Present |  |
| Duplicate dates, table | yes | yes: an upload error naming the lines, and a QC check for repaired files | Present |  |
| Temperature jumps (TX, TN), tables | yes | yes; same dates | Present |  |
| Flat lines (TX, TN), tables | yes | yes; also precipitation on rain days | Present |  |
| Missing values per year, table | yes | yes; identical on the sample; also per month | Present |  |
| Daily time-series pages with missing days marked (PDF, PNG) | yes | an interactive daily chart with zoom in the web interface; no static pages | Different by design |  |
| Precipitation histogram | yes | no | Absent |  |
| One combined QC PDF | yes | no | Absent |  |
| QC result files | nine CSV files, one per check | one CSV of all findings and one of missing days per year | Different by design | same information, tidy layout |

## Indices (outputs of the default validation case: an output is one index at one frequency)

| Capability | Climpact 3.4.4 | This proof of concept | Status | Note |
|---|---|---|---|---|
| Fixed-threshold day counts (FD, ID, SU, TR, TXge30, TXge35, TNlt2, TNltm2, TNltm20, TMge5, TMlt5, TMge10, TMlt10) | 26 outputs | 26 of 26 outputs | Present | annual and monthly |
| Extremes and means (TXx, TXn, TNx, TNn with dates of occurrence; DTR, TXm, TNm, TMm) | 16 outputs | 16 of 16 outputs | Present | annual and monthly |
| Degree days (HDDheatn, CDDcoldn, GDDgrown) | 3 outputs | 3 of 3 outputs | Present | annual; base temperatures adjustable |
| Precipitation amounts and counts (Rx1day, Rx5day, RXdday, R10mm, R20mm, Rnnmm, PRCPTOT, SDII) | 15 outputs | 15 of 15 outputs | Present | d and nn adjustable |
| Dry and wet spells (CDD, CWD) with start and end dates | 2 outputs | 2 of 2 outputs | Present | spells cross year ends as in Climpact |
| Percentile day indices with in-base bootstrap (TX10p, TX90p, TN10p, TN90p, TXgt50p) | 10 outputs | 10 of 10 outputs | Present | annual and monthly |
| Very wet days (R95p, R99p, R95pTOT, R99pTOT) | 4 outputs | 4 of 4 outputs | Present | Climpact's definitions (amounts in mm) |
| Spell duration (WSDI, CSDI, WSDId, CSDId) | 4 outputs | 4 of 4 outputs | Present | d adjustable |
| Growing season length (GSL) with start and end dates | 1 outputs | 1 of 1 outputs | Present | values and dates equal; the missing-data rule differs in the southern hemisphere (VALIDATION.md) |
| Very warm day threshold (TX95t, 365 day-of-year values) | 1 outputs | 0 of 1 outputs | Absent | computed internally and checked in validation, not offered as an output |
| Consecutive hot/cold days and nights (TXdTNd, TXbdTNbd) | 2 outputs | 0 of 2 outputs | Absent | no xclim equivalent |
| TX90 and TN90 heatwave aspects (HWN, HWF, HWD, HWM, HWA) | 10 outputs | 0 of 10 outputs | Absent | no xclim equivalent |
| Excess Heat Factor heatwaves (8 aspects, daily EHF and ECF series) | 10 outputs | 0 of 10 outputs | Absent | no xclim equivalent |
| SPI (3, 6, 12 months and a custom scale) | 4 outputs | 0 of 4 outputs | Absent | available in xclim; Climpact's fitting must be matched |
| SPEI (3, 6, 12 months and a custom scale) | 4 outputs | 0 of 4 outputs | Absent | available in xclim; Climpact's fitting must be matched |
| Annual and monthly frequencies | annual for all, monthly for 41 outputs | annual for all implemented indices, monthly for the same 33 that Climpact offers among them | Present |  |
| Missing-data rule (3 days per month, 15 per year, a missing month removes the year) | fixed | the default policy; limits adjustable, other policies selectable | Present |  |

## Thresholds, trends and plots

| Capability | Climpact 3.4.4 | This proof of concept | Status | Note |
|---|---|---|---|---|
| Thresholds file (365 rows, 24 columns) | yes | no file; the 12 columns used by implemented indices are computed and match | Absent |  |
| Trend table: Sen's slope with 95 % bounds, annual and monthly | yes | yes, with p-value and number of values added; all 81 comparable rows match | Present |  |
| Seasonal trends (DJF, MAM, JJA, SON) | yes | no | Absent |  |
| Trend line, slope and p-value on each index plot | yes | yes, on the interactive charts | Present |  |
| Index plots | PNG per index and one PDF of all, for web, batch and local runs | interactive charts in the web interface with PNG and SVG download per index; the command line makes no plots | Partial |  |
| Day-of-occurrence plots for extremes | yes | no (the dates are in the CSV files) | Absent |  |

## Outputs

| Capability | Climpact 3.4.4 | This proof of concept | Status | Note |
|---|---|---|---|---|
| Index CSV per index in the Climpact layout (7 header lines, -99.9, three column layouts) | yes | yes; the sixth header line names this software | Present | existing scripts that skip 7 lines keep working |
| Zip of all results | yes | yes | Present |  |
| Folder tree `indices/ plots/ qc/ thres/ trend/ corr/` | yes | `indices/ qc/ trend/` plus tidy CSV and NetCDF; no `plots/`, `thres/`, `corr/` | Partial |  |
| Per-station error and warning files in batch runs | yes | messages on the terminal and an exit code | Absent |  |

## Workflows and deployment

| Capability | Climpact 3.4.4 | This proof of concept | Status | Note |
|---|---|---|---|---|
| Sector-data correlation (scatter plots, correlation with each index, optional detrending) | yes (web) | no | Absent |  |
| Batch processing of many stations (web upload or command line, one metadata file) | yes | one station per `climpoc run`; a shell loop works, per-station metadata does not | Absent |  |
| Gridded NetCDF indices and thresholds (command line, Linux and macOS) | yes | no | Absent |  |
| Hosted web application | yes (Shiny) | a container image and compose file, and a public demonstration; not a production service | Partial |  |
| Local installation | R and its packages, an installer script | `uv sync` or one container; not tested on Windows, no installer | Partial |  |
| User guide | about 870 lines with background, appendices and FAQ | README, architecture and validation documents; no end-user guide | Partial |  |
| Interface language | English | English and a machine-drafted French interface; server messages in English | Present |  |
| Station data not kept after the session | stated in the guide; result folders stay on the server's disk | held in memory only, deleted after 60 minutes or on request, never written to disk | Present | stronger here |

## What this proof of concept has that Climpact lacks

Not counted in the summary below.

| Capability | Note |
|---|---|
| Index selection | Climpact computes every index on every run |
| Line-numbered, plain-language input errors, up to 50 at once | Climpact reports raw R errors or drops the connection |
| Decimal commas and semicolon-separated files |  |
| QC thresholds re-run without uploading again; three extra checks (negative rain as its own check, distance from the day-of-year climatology in standard deviations, rounding years) | re-running exists in Climpact since 3.3 |
| Interactive charts (hover, zoom, PNG and SVG download) | Climpact shows static PNG carousels |
| A documented HTTP API with structured errors |  |
| NetCDF (CF attributes), JSON and tidy long-format CSV for station results |  |
| Pluggable, configurable missing-data policy | fixed in Climpact |
| Trend p-value and sample size in the trend table | Climpact prints the p-value on plots only |
| Consistent start and end dates for year-crossing dry spells | see VALIDATION.md |
| Automated tests and a validation harness against the R tool, with variant cases | Climpact has one manual comparison script |
| A container image that runs read-only as a non-root user, with a health check |  |
| Limits and cross-origin access configurable for a public server; an optional request limit |  |
| A French interface (machine-drafted) | Climpact's interface is English only, as far as could be established |
| Explicit data retention: memory only, 60-minute expiry, delete on request |  |

## Summary

**29 of 68 Climpact capabilities are present, 11 partial, 24 absent, and 4 are met differently by design.**

Of the R tool's 112 outputs for one station, 81 are implemented and 31 are not.

The absent capabilities, in the order a national meteorological service would probably miss them:

1. **Heatwave indices** (TX90, TN90 and Excess Heat Factor): the most used sector indices for health, and with no xclim equivalent.
2. **SPI and SPEI**: the drought indices, central to agriculture and water users.
3. **Batch processing of many stations** with one metadata file: services hold tens to hundreds of stations.
4. **Gridded NetCDF processing**: needed for reanalysis and model data, and part of the planned work.
5. **Static plots and PDFs** for reports (index plots for command-line runs, the all-plots PDF, the QC plot families and the combined QC PDF).
6. **Sector-data correlation**: the workshop exercise that links indices to yields or health records.
7. **Seasonal trends** and the **thresholds file**.
8. **User-defined day-count indices** and the remaining user parameters in the web interface.
9. **TXdTNd / TXbdTNbd**, TX95t as an output, day-of-occurrence plots, per-station error files, a plot title.

A first release that could replace Climpact in a training workshop needs at least items 1 to 5.
