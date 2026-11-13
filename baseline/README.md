# Climpact (R) baseline for the bundled Sydney sample station

Reference outputs from the **original R implementation of Climpact** (v3.4.4), produced by
running upstream's own documented station batch command on its bundled sample data inside a
container. They exist so the Python/xclim reimplementation can be checked number for number.

* Code path: **true Climpact batch mode** (`climpact.batch.stations.r`), unmodified upstream code.
  No fallback to calling functions directly or to bare `climdex.pcic` was needed.
* Result: 112 index CSV files for the station (68 annual, 41 monthly, 3 other), plus thresholds,
  QC tables and the trend summary. No errors were reported by Climpact.

## Regenerate everything

```bash
./run.sh
```

Needs only `git` and `podman` (or `docker`) on the host. It takes about a minute once the image
is built (the first image build took a couple of minutes here). It

1. makes sure `upstream/` is a clean checkout of `ARCCSS-extremes/climpact` at commit
   `a8d283185907bfe6c24eda8be92ee7630e4d6a0e` (clones it if missing);
2. builds the image `localhost/climpact-baseline:r4.5.3` from `Dockerfile`;
3. deletes and recreates `output/`, then runs `scripts/run_in_container.sh` in the container with
   `upstream/` and `scripts/` mounted read-only and `output/` mounted read-write;
4. writes `index_inventory.csv`.

Environment variables: `BASE_START` (1971), `BASE_END` (2000), `CORES` (2), `KEEP_PLOTS` (0; set
to 1 to keep Climpact's PNG/PDF plots, about 15 MB per station), `CONTAINER_ENGINE`.

The run that produced the committed outputs used **podman 5.7.1** (rootless) because this host
redirects `docker` to podman. The `Dockerfile` is engine-neutral. The `docker` branch of `run.sh`
(which adds `--user $(id -u):$(id -g)`) has not been exercised. Bind mounts use
`--security-opt label=disable` instead of `:Z`, so nothing on the host gets relabelled.

The only thing that differs between two runs is the `Date_of_calculation` header line in each CSV.

## What is run

Inside the container the upstream checkout is copied to `/tmp/climpact` (batch mode writes its
output next to the metadata file and a temporary file next to each station file, so it cannot run
from a read-only tree) and this command, taken from the "ADVANCED: Batch process multiple
station files from the command line" section of upstream's README, is executed there:

```bash
Rscript climpact.batch.stations.r ./www/sample_data/ ./www/sample_data/climpact.sample.batch.metadata.txt 1971 2000 2
```

Arguments: station directory, metadata file, base period start year, base period end year, cores.
Climpact writes to `www/sample_data/climpact.sample.batch.metadata/<station>/{indices,qc,thres,trend,plots}`;
that folder is copied to `output/` with file names and layout unchanged (plots dropped by default).

### Parameters

| Parameter | Value | Where it comes from |
|---|---|---|
| Base period | **1971-2000** | Command-line arguments in upstream's README example. The sample metadata file does **not** contain a base period. |
| Latitude / longitude | **-10 / 100** | Sample metadata file. These are placeholders, not Sydney Observatory Hill's real position (about -33.86, 151.21). See "Things that look wrong or surprising". |
| `wsdin`, `csdin` | 3, 3 | Metadata: spell length for the user-defined `wsdi3` / `csdi3` |
| `Tb_HDD`, `Tb_CDD`, `Tb_GDD` | 18, 18, 10 degC | Metadata: base temperatures for `hddheat18`, `cddcold18`, `gddgrow10` |
| `rxnday` | 3 | Metadata: `rx3day` |
| `rnnmm` | 30 mm | Metadata: `r30mm` |
| `txtn` | 2 | Metadata: `tx2tn2`, `txb2tnb2` |
| `SPEI` | 24 months | Metadata: extra SPI/SPEI time scale besides 3, 6, 12 |
| Cores | 2 | README example. Irrelevant in practice: `processBatch()` loops over stations serially. |

The metadata file lists two station files, `sydney_observatory_hill_1936-2015.txt` and
`sydney_observatory_hill_batch_file_2.txt`. They are byte-identical, and all 123 CSVs of the two
output folders are identical apart from the station name. Use the first; the second is kept only
because the documented command produces it.

Input file: 29,220 daily rows, 1936-01-01 to 2015-12-31, no gaps in the date sequence. Missing
(`-99.9`) values: 7 precipitation, 58 tmax, 58 tmin.

### Defaults that matter for a reimplementation

Read from the upstream code and confirmed against the output where noted.

* **Missing data.** `-99.9` becomes `NA`. climdex.pcic's defaults apply
  (`max.missing.days = c(annual = 15, monthly = 3)`): a month is `NA` with more than 3 missing days,
  a year with more than 15, **and a year is also `NA` if any of its months is `NA`**. Confirmed:
  October 1996 has 8 missing tmax days, so 1996-10 and the whole of 1996 are `-99.9` for every
  temperature index although 1996 has only 10 missing tmax days. Precipitation indices have no
  missing years or months.
* **Daily mean temperature** is `(tmax + tmin) / 2`.
* **Percentile thresholds.** Base period 1971-2000, 5-day window centred on each calendar day
  (`n = 5`), 365 calendar days, `min.base.data.fraction.present = 0.1`. Temperature quantiles
  5, 10, 50, 90, 95; precipitation quantiles 5, 10, 50, 90, 95, 99 computed once over base-period
  wet days (>= 1 mm). Quantiles use climdex.pcic's `climdex.quantile` (R `quantile` type 8);
  the precipitation q95 = 46.75 mm and q99 = 89.3867 mm were reproduced independently that way.
* **In-base bootstrapping** (Zhang et al. 2005, via climdex.pcic's in-base quantiles) is used for
  `tx10p`, `tx90p`, `tn10p`, `tn90p`, `txgt50p`. Their means over the base period are 10.2, 10.2,
  10.4, 10.2 and 49.4 %. `wsdi`, `csdi`, `wsdi3`, `csdi3`, `tx95t`, `tx2tn2`, `txb2tnb2` use the plain
  (out-of-base) thresholds.
* **Hemisphere.** `northern.hemisphere = (latitude > 0)`, so `FALSE` here. It affects
  `gsl` (year runs 1 July to 30 June and is labelled by the starting year; 2015 is missing) and the
  TX90/TN90 heatwaves (extended summer November to March, labelled by the year of November; 2015 is
  missing). EHF heatwaves use calendar years.
* **Latitude** is also used by SPEI (Hargreaves potential evapotranspiration from monthly mean
  tmin/tmax, `SPEI::hargreaves(..., lat = -10, Pre = monthly precipitation)`).
* **Spells.** `cdd` / `cwd`: wet day is >= 1 mm, annual only, spells may span years
  (`spells.can.span.years = TRUE`). `wsdi` / `csdi` (6 days) and `wsdi3` / `csdi3` (3 days): spells
  may not span years.
* **`r95p`, `r99p`, `r95ptot`, `r99ptot`** use Climpact's own definitions in
  `server/climpact.etsci-functions.r` (`r95ptot = 100 * r95p / prcptot`), not climdex.pcic's.
* **TX90 / TN90 heatwaves** (`climdex.hw`): 90th percentile with a 15-day window, at least 3
  consecutive days, 29 February removed. `HWM`, `HWA`, `HWD` are missing in seasons without a
  heatwave; `HWN` and `HWF` are 0.
* **EHF heatwaves** (`climdex.hwEHF`, definition "NF13"): `EHF = max(1, EHI_accl) * EHI_sig`, with
  the 95th percentile of base-period daily mean temperature. The 30-day mean is computed as
  `sum(..., na.rm = TRUE) / 30`, so missing days count as zero. Severity divides by the 85th
  percentile of positive base-period EHF. The first year (1936) is missing.
* **SPI / SPEI**: Climpact's own `cspei` / `cspi` (copies of older SPEI-package code), gamma (SPI)
  and log-logistic (SPEI) fitted with unbiased probability-weighted moments, reference period =
  base period, scales 3, 6, 12 and 24 months.
* **Standardised values column**: `(x - mean) / sd` over all years of the series.
* **Trends**: Sen's slope with 95 % confidence bounds (`zyp.sen`, `confint.zyp`), per time step of
  the series. Needs at least 10 valid points and 70 % of the series valid.
* **QC thresholds** (defaults of `load_data_qc`): outliers beyond 3 IQR (temperature) and 5 IQR
  (precipitation), precipitation > 200 mm, |temperature| > 50, more than 5 repeated values,
  day-to-day temperature change > 20 degC.

## Output files

```
output/
  versions.txt                               R, OS and package versions from inside the container
  logs/batch.log                             full console output of the batch command (not tracked in git)
  sydney_observatory_hill_1936-2015/
    indices/   112 CSV   one per index and frequency
    thres/     1 CSV     daily percentile thresholds
    qc/        9 CSV     quality-control tables
    trend/     1 CSV     trend summary
  sydney_observatory_hill_batch_file_2/      identical duplicate (see above; not tracked in git)
index_inventory.csv                          one row per index output of the first station
```

File names are `<station>_<index>_<ANN|MON|DAY>.csv`. The missing value is `-99.9` everywhere,
including in date columns. Every CSV starts with 7 quoted header lines (Description, Station,
Latitude, Longitude, Base_period, Climpact_version, Date_of_calculation), then column names, then
rows separated by `", "` (comma and a space). The time column is `YYYY` for annual files and
`YYYY-MM` for monthly files.

### Index files: four layouts

**Standard** (most indices): `time, <index>, standardised values (using all years)`

```
"Description: ","Annual number of days when TX > 25 degrees_C"
"Station: ","sydney_observatory_hill_1936-2015"
"Latitude: ","-10"
"Longitude: ","100"
"Base_period: ","1971-2000"
"Climpact_version: ","3.4.4"
"Date_of_calculation: ","2026-11-13"
time, su, standardised values (using all years)
1936, 80, -0.755545132295604
1937, 80, -0.755545132295604
1938, 101, 0.439354176072753
```

**With dates of occurrence** (no standardised column):

| Indices | Columns |
|---|---|
| `txx`, `txn`, `tnx`, `tnn`, `rx1day`, `rx3day`, `rx5day` (ANN and MON) | `time, val, ymd` |
| `cdd`, `cwd` | `time, start, duration, end` |
| `gsl` | `time, start, sl, end` |

```
"Description: ","Monthly warmest daily TX"
... (6 more header lines)
time, val, ymd
1936-01, 36.9, 1936-01-16
1936-02, 27.8, 1936-02-13
```

**Heatwaves, SPI and SPEI** (two columns, no standardised column): `time, <name>`. In the ten
`TX90-*` and `TN90-*` files the two column names are on **two separate lines**, so data starts on
line 10 instead of line 9:

```
"Description: ","TX90 heatwave number (HWN)"
... (6 more header lines)
time
HWN
1936, 1
1937, 0
```

**Other**: `EHFdaily.csv` and `ECFdaily.csv` have `date,Excess Heat Factor` (comma without space)
and 29,220 daily rows. `tx95t_DAY.csv` has 365 rows, one per calendar day, whose time column is
`-99.9`.

`index_inventory.csv` records the layout of each file in its `columns`, `value_column` and
`skip_rows` (lines before the first data row) fields.

### Units

| Units | Indices |
|---|---|
| days | `fd`, `id`, `su`, `tr`, `tnlt2`, `tnltm2`, `tnltm20`, `tmge5`, `tmlt5`, `tmge10`, `tmlt10`, `txge30`, `txge35`, `gsl`, `wsdi`, `wsdi3`, `csdi`, `csdi3`, `cdd`, `cwd`, `r10mm`, `r20mm`, `r30mm`, `*-HWD`, `*-HWF`, `EHF-HWMD` |
| degrees C | `txx`, `txn`, `tnx`, `tnn`, `dtr`, `tmm`, `txm`, `tnm`, `tx95t`, `TX90-HWM`, `TX90-HWA`, `TN90-HWM`, `TN90-HWA` |
| % | `tx10p`, `tx90p`, `tn10p`, `tn90p`, `txgt50p`, `r95ptot`, `r99ptot` |
| mm | `prcptot`, `r95p`, `r99p`, `rx1day`, `rx3day`, `rx5day` |
| mm/day | `sdii` |
| degree-days | `hddheat18`, `cddcold18`, `gddgrow10` |
| events | `tx2tn2`, `txb2tnb2` |
| heatwaves | `TX90-HWN`, `TN90-HWN`, `EHF-HWN` |
| degrees C squared | `EHF-HWPI`, `EHF-HWLI`, `EHFdaily`, `ECFdaily` |
| unitless | `EHF-HWPS`, `EHF-HWLS`, SPI, SPEI |

Units come from upstream's `server/climate.indices.csv`; heatwave units come from its plotting code.
Note that `cdd` is consecutive dry days while `cddcold18` is cooling degree days.

### Thresholds: `thres/<station>_thres.csv`

No header block. One line of column names, then 365 rows (calendar days 1 to 365), separated by
`", "`. 24 columns:

`tmax_q5, tmax_q10, tmax_q50, tmax_q90, tmax_q95, tmin_q5 ... tmin_q95, tavg_q5 ... tavg_q95`
(degrees C, 5-day window), `prec_q5, prec_q10, prec_q50, prec_q90, prec_q95, prec_q99` (mm, the
same value on every row), `HW_TN90, HW_TX90, HW_TAVG90` (degrees C, 15-day window, used by the
heatwave indices).

```
tmax_q5, tmax_q10, tmax_q50, tmax_q90, tmax_q95, tmin_q5, tmin_q10, tmin_q50, tmin_q90, tmin_q95, tavg_q5, tavg_q10, tavg_q50, tavg_q90, tavg_q95, prec_q5, prec_q10, prec_q50, prec_q90, prec_q95, prec_q99, HW_TN90, HW_TX90, HW_TAVG90
21.04, 22.5266666666667, 25.4, 29.7666666666667, 31.62, 15.88, 16.46, 19.4, 21.5, 22.44, 19.19, 19.54, 22.4, 25.57, 26.37, 1.2, 1.4, 5.8, 30.4833333333333, 46.7499999999999, 89.3866666666665, 21.3, 29.8, 25.2416666666667
```

### Trend summary: `trend/<station>_trend.csv`

7 header lines, then `Index,Frequency,StartYear,EndYear,Lower bound,Slope,Upper bound` and 232
rows. `Frequency` is `annual`, `monthly`, a season (`DJF`, `MAM`, `JJA`, `SON`, computed from the
monthly series) or, for SPI/SPEI, a month name. The p-value is computed but only printed on the
plots. There are no rows for the TX90/TN90/EHF heatwave indices or the 24-month SPI/SPEI.

```
Index,Frequency,StartYear,EndYear,Lower bound,Slope,Upper bound
fd,annual,1936,2015,0,0,0
rx1day,annual,1936,2015,-0.471428571428571,-0.0899638699317543,0.3125
```

### Quality control: `qc/`

All have the 7 header lines. Dates are written unpadded (`1942-3-28`).

| File | Columns | Content for this station |
|---|---|---|
| `_nastatistics.csv` | `Year,Prec,TX,TN` | missing days per year, 80 rows |
| `_outliers.csv` | `Date,Prec,TX,TN,DTR` | IQR outliers, in sections titled `"Prec up"`, `"TX up"`, `"TX low"`, `"TN up"`, `"TN low"`, `"DTR up"`, `"DTR low"` |
| `_toolarge.csv` | `Date,Prec,TX,TN` | 4 days with precipitation > 200 mm |
| `_tmaxmin.csv` | `Date,Prec,TX,TN` | 1 day (1988-11-16, tmax = tmin = 12.6) |
| `_tx_jumps.csv`, `_tn_jumps.csv` | `Date,TX` / `Date,TN` | 4 tmax jumps > 20 degC; none for tmin |
| `_tx_flatline.csv`, `_tn_flatline.csv` | `Date,TX,Number of duplicates` | none found |
| `_duplicates.csv` | `Dates_duplicated` | none found |

When nothing is found the file holds a single quoted message such as `"NO DUPLICATE DATES FOUND"`.

### `index_inventory.csv`

One row per index output file of `sydney_observatory_hill_1936-2015` (112 rows), written by
`scripts/make_inventory.R`:

| Column | Meaning |
|---|---|
| `index` | short name as used in the file name (`su`, `rx3day`, `TX90-HWN`, `12month_spei`, ...) |
| `climpact_index` | row name in upstream's `server/climate.indices.csv` (`rxdday`, `hw`, `spei`, ...) |
| `parameter` | user parameter baked into the output, e.g. `n_days=3`, `Tb_degC=18`, `scale_months=24` |
| `file` | path relative to `output/` |
| `frequency` | `annual`, `monthly`, `daily`, or day-of-year for `tx95t` |
| `units` | see the table above |
| `value_column`, `columns`, `skip_rows` | how to read the file |
| `n_values`, `n_nonmissing` | rows, and rows whose value is not `-99.9` |
| `first_year`, `last_year` | first and last year present |
| `first_valid_year`, `last_valid_year` | first and last year with a non-missing value |
| `mean`, `min`, `max` | over all non-missing values, 1936-2015 (10 significant digits) |
| `description` | the file's own description line |

`index` plus `frequency` is unique.

## Variant cases

`output/` is the default case. To test more than one situation, `make_variants.py` derives seven
variant cases from the same sample file (fixed seed, deterministic) and `run_variants.sh` runs
the unmodified R tool on each, with the same documented batch command:

```bash
uv run python baseline/make_variants.py     # variants/<name>/input/, metadata.txt, variant.json
baseline/run_variants.sh                    # variants/<name>/output/  (about one minute, in parallel)
```

| Variant | What changes |
|---|---|
| `north` | latitude +40 (northern-hemisphere rules) |
| `base6190` | base period 1961-1990 |
| `cold` | tmax and tmin lowered by 15 degC, so frost, ice and cold-threshold indices are not zero |
| `gappy` | 3 % of days missing at random, four multi-week gaps (two as absent rows), the year 1982 missing |
| `short` | 1971-2000 only: the record equals the base period |
| `coldgapnorth` | the `cold` and `gappy` changes together at latitude +40 |
| `params` | other user parameters: `wsdin` 5, `csdin` 5, `Tb_HDD` 15, `Tb_CDD` 22, `Tb_GDD` 5, `rxnday` 7, `rnnmm` 25, `txtn` 3, `SPEI` 9 |

For each variant, `variant.json` records the base period, the metadata values and the R command;
`metadata.txt` is the batch metadata file given to the R tool; `output/r_exit_status.txt` is the
R tool's exit status (0 for all seven) and `output/<station>/` holds its results in the layout
described above. The station files under `input/` are derived from the sample data and are not
tracked; the console logs are not tracked either. `validate/compare.py` compares this
implementation with every variant (see `VALIDATION.md`, "Variant cases").

## Versions

Full list in `output/versions.txt`.

| Component | Version |
|---|---|
| Climpact | 3.4.4, commit `a8d283185907bfe6c24eda8be92ee7630e4d6a0e` (2026-11-13) |
| Base image | `docker.io/rocker/r-ver:4.5.3`, digest `sha256:993bb55823055cec07fb0a3dee0640d0695c4ab8bc596e87c883c043bd0765f9` |
| R | 4.5.3 (2026-03-11), x86_64, Ubuntu 24.04.5 LTS, OpenBLAS 0.3.26 |
| CRAN snapshot | `https://p3m.dev/cran/__linux__/noble/2026-04-23` (frozen by the image) |
| climdex.pcic | 1.2-0, GitHub `pacificclimate/climdex.pcic` commit `011cb7828dfef1722d64e2fc207d2d9975280378` |
| PCICt | 0.5-5.0, tarball vendored in that climdex.pcic commit (`.github/vendor/`) |
| SPEI | 1.8.1 |
| lmomco | 2.5.5 |
| zyp / Kendall | 0.11-1 / 2.2.2 |
| zoo | 1.8-15 |
| Rcpp | 1.1.1-1 |
| qpdf | 1.4.1 |
| foreach / iterators / doParallel / doSNOW / snow | 1.5.2 / 1.0.14 / 1.0.17 / 1.0.20 / 0.4-4 |

The image is pinned by tag, not by digest; the R packages from CRAN are pinned by the dated
snapshot; climdex.pcic and PCICt are pinned by commit.

## Dependency notes, warnings and errors

* **climdex.pcic and PCICt are no longer on CRAN.** Climpact 3.3 and later needs climdex.pcic
  1.2-0 (it calls `include.exact.dates = TRUE`). The 1.1-11 tarball bundled in
  `server/pcic_packages/` is too old and upstream's installer does not use it; it runs
  `devtools::install_github("pacificclimate/climdex.pcic")`, i.e. whatever HEAD is. The Dockerfile
  installs that repository at a fixed commit instead. Upstream's installer would fail on
  `install.packages("PCICt")`; the Dockerfile uses the PCICt tarball that the climdex.pcic
  repository vendors for its own CI. Both installed at the first attempt.
* **Only the station batch path's packages are installed.** The Shiny GUI packages and the netCDF
  stack from `server/climpact.master.installer.r` are left out, because
  `climpact.batch.stations.r` never loads them.
* **`WARNING: Error exit, tauk2. IFAULT = 12`** appears 160 times in `output/logs/batch.log`. It
  comes from `Kendall::MannKendall` when a series is constant, and only for indices that are zero
  or nearly always zero in Sydney (`fd`, `id`, `tnlt2`, `tnltm2`, `tnltm20`, `tmlt5`, some seasons
  of `tmlt10`, `tr`, `txge35`). It only affects the p-value shown on plots.
* Climpact wraps its QC step in `suppressWarnings()` and its plotting in `tryCatch()`; the log
  contains no "error occurred" or "warning occurred" message from the latter, and no
  `*.errors.txt` or `*.warnings.txt` file was written.
* The log prints `calculating custom index`, but no custom index is defined in batch mode and none
  is written.

## Things that look wrong or surprising

None of these were changed; the outputs are exactly what upstream produces.

1. **Latitude -10, longitude 100 is not Sydney.** The numbers are a faithful reference for
   "Climpact run with the sample metadata", and the Python side must use the same latitude to
   match. It matters for SPEI (through potential evapotranspiration) and it selects the southern
   hemisphere conventions; any negative latitude gives the same result for everything except SPEI.
   A baseline with Sydney's real coordinates would need a different metadata file.
2. **A year is missing when any month is missing.** 1996 is `-99.9` for all annual temperature
   indices because of 8 missing tmax days in October, well under the 15-day annual limit.
3. **Floating-point noise in rolling sums.** Monthly `rx3day` and `rx5day` contain values such as
   `-6.9e-14` and `4.1e-15` where the true value is 0. Compare with a tolerance.
4. **`tx95t_DAY.csv` has `-99.9` in its time column** and a meaningless standardised column; the
   365 values are just the `tmax_q95` column of the thresholds file. The trend file also has a
   `tx95t,NA,...` row, a "trend" across calendar days.
5. **`EHFdaily.csv` and `ECFdaily.csv` say "29th February is omitted"** but contain all 29,220
   days including 29 February. `ECFdaily.csv` is still written although the changelog says ECF
   coldwaves were removed in 3.4.
6. **EHF heatwave counts are never zero** in this record (`EHF-HWN` minimum is 1), so this baseline
   does not show whether a year without EHF heatwaves would be written as 0 or as missing.
7. **TX90/TN90 `HWM`, `HWA`, `HWD` are missing, not zero, in seasons without heatwaves.** They are
   missing in 50 of 80 years for TX90 and 40 of 80 for TN90; two of those are 1996 and 2015, where
   `HWN` and `HWF` are missing too.
8. **`gsl` is 365 or 366 every year** (mean daily temperature never drops below 5 degC), counted
   July to June, so it is a weak test of a growing-season implementation.
9. **The percentile indices drift outside the base period** as expected for a warming record
   (`tx10p` averages 10.2 % inside 1971-2000 and 14.4 % outside; `tn10p` 10.2 % and 14.8 %).
10. **The trend file carries 15 significant digits but no p-values**, and omits the heatwave
    indices.
11. The `tn_flatline.csv` description line says "TX values" (an upstream typo).

## How far to trust these numbers

Checks made on the outputs, beyond Climpact reporting no errors:

* `su` 1936 = 80, `txx` 1939 = 45.3 on 14 January and `prcptot` 1936 = 746.9 mm were recomputed
  directly from the raw station file and match.
* Precipitation thresholds q95 and q99, and `r95p` for 1936 (54.9 mm), were recomputed
  independently and match.
* Percentile indices average close to 10 % (or 50 %) inside the base period; 12-month SPI and SPEI
  have mean 0.00 and standard deviation 0.95 to 0.96 inside it.
* The two identical station files give identical outputs.

Not verified independently: the temperature percentile thresholds, the heatwave indices, SPEI and
the trend statistics. They are reference values in the sense of "what Climpact 3.4.4 with
climdex.pcic 1.2-0 produces", not values checked against a third source. Results could differ
slightly from the hosted Climpact website if it runs different package versions.

## Files in this directory

| Path | Purpose |
|---|---|
| `run.sh` | one-command regeneration |
| `Dockerfile`, `.dockerignore` | image definition |
| `scripts/run_in_container.sh` | runs the batch command and collects outputs (inside the container) |
| `scripts/versions.R` | writes `output/versions.txt` |
| `scripts/make_inventory.R` | writes `index_inventory.csv` |
| `upstream/` | untouched checkout of Climpact (GPL-3), mounted read-only |
| `output/`, `index_inventory.csv` | the baseline |
| `logs/` | image build log and container console log of the last `run.sh` |
