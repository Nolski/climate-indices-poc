# Validation against the R tool

**Default case: 81 index outputs compared (of 112 in the reference): 80 exact, 0 within tolerance, 1 differing; 31 not yet implemented. 7 variant cases together: 567 index outputs compared (of 784 in the reference): 562 exact, 0 within tolerance, 5 differing; 217 not yet implemented.**

Generated 2026-11-13 17:07 UTC by `validate/compare.py` with climpoc 0.1.0,
xclim 1.0.0, xarray 2026.9.0, numpy 2.5.4, pandas 3.1.1,
Python 3.12.12. Do not edit by hand; run `uv run python validate/compare.py`.

## What is compared

* Reference: Climpact 3.4.4 (R 4.5.3, climdex.pcic 1.2-0), station batch mode; see baseline/README.md. One station (Sydney Observatory Hill, 1936-2015, 29,220 days;
  7 missing precipitation values, 58 missing tmax, 58 missing tmin).
* Parameters, identical on both sides: base period 1971-2000,
  latitude -10, longitude 100; missing-data policy
  climdex (15 days per year, 3 per month, a missing month makes the year missing).
* Every row of `baseline/index_inventory.csv` (one per index and frequency) appears below, either
  compared or listed as not yet implemented.
* **Tolerance.** The R files carry 15 significant digits, so two levels are reported.
  "Exact" means the absolute difference is at most 1e-09 (floating-point noise; nothing a
  user could see). "Within tolerance" means at most 0.01 in the index's own units
  (days, degC, mm, mm/day, %, degree-days). A value beyond 0.01, or a period that is
  missing on one side only, makes the index "differs". The tolerance is fixed in the script and
  was not adjusted to the results.
* **Limits of this evidence.** The default case is one station, one base period, a nearly
  complete record in a climate without frost (`fd`, `id`, `tnlt2`, `tnltm2`, `tnltm20` and `tmlt5`
  are zero in every period, so they are weak tests there). The variant cases below widen this:
  another hemisphere, another base period, a cold climate, gaps, a short record, other user
  parameters. They are all derived from the same Sydney record, so they exercise rules, not
  climates: they are not a substitute for independent stations. Still untested: a base period
  only partly covered by the record, records shorter than the base period, sub-zero
  precipitation or other invalid values, and everything about the 31 outputs not implemented.

## Results

| index | frequency | units | status | comparable values | exact | within tolerance | max abs diff | periods differing | missing masks agree | dates |
|---|---|---|---|---|---|---|---|---|---|---|
| `cdd` | annual | days | exact | 80 | 80 | 80 | 0 | none | yes | start 77/80, end 77/80 |
| `cddcold18` | annual | degree-days | exact | 79 | 79 | 79 | 5.7e-13 | none | yes |  |
| `csdi` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `csdi3` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `cwd` | annual | days | exact | 80 | 80 | 80 | 0 | none | yes | start 80/80, end 80/80 |
| `dtr` | annual | degC | exact | 79 | 79 | 79 | 6.2e-15 | none | yes |  |
| `dtr` | monthly | degC | exact | 959 | 959 | 959 | 4.8e-14 | none | yes |  |
| `fd` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `fd` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `gddgrow10` | annual | degree-days | exact | 79 | 79 | 79 | 9.1e-13 | none | yes |  |
| `gsl` | annual | days | **differs** | 78 | 78 | 78 | 0 | none | no: 1996 | start 78/78, end 78/78 |
| `hddheat18` | annual | degree-days | exact | 79 | 79 | 79 | 5.7e-13 | none | yes |  |
| `id` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `id` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `prcptot` | annual | mm | exact | 80 | 80 | 80 | 2.3e-13 | none | yes |  |
| `prcptot` | monthly | mm | exact | 960 | 960 | 960 | 1.1e-13 | none | yes |  |
| `r10mm` | annual | days | exact | 80 | 80 | 80 | 0 | none | yes |  |
| `r10mm` | monthly | days | exact | 960 | 960 | 960 | 0 | none | yes |  |
| `r20mm` | annual | days | exact | 80 | 80 | 80 | 0 | none | yes |  |
| `r20mm` | monthly | days | exact | 960 | 960 | 960 | 0 | none | yes |  |
| `r30mm` | annual | days | exact | 80 | 80 | 80 | 0 | none | yes |  |
| `r30mm` | monthly | days | exact | 960 | 960 | 960 | 0 | none | yes |  |
| `r95p` | annual | mm | exact | 80 | 80 | 80 | 1.1e-13 | none | yes |  |
| `r95ptot` | annual | % | exact | 80 | 80 | 80 | 5.3e-14 | none | yes |  |
| `r99p` | annual | mm | exact | 80 | 80 | 80 | 5.7e-14 | none | yes |  |
| `r99ptot` | annual | % | exact | 80 | 80 | 80 | 5.0e-14 | none | yes |  |
| `rx1day` | annual | mm | exact | 80 | 80 | 80 | 0 | none | yes | ymd 80/80 |
| `rx1day` | monthly | mm | exact | 960 | 960 | 960 | 0 | none | yes | ymd 960/960 |
| `rx3day` | annual | mm | exact | 80 | 80 | 80 | 1.1e-13 | none | yes | ymd 80/80 |
| `rx3day` | monthly | mm | exact | 960 | 960 | 960 | 1.2e-13 | none | yes | ymd 959/960 |
| `rx5day` | annual | mm | exact | 80 | 80 | 80 | 5.7e-14 | none | yes | ymd 80/80 |
| `rx5day` | monthly | mm | exact | 960 | 960 | 960 | 1.1e-13 | none | yes | ymd 959/960 |
| `sdii` | annual | mm/day | exact | 80 | 80 | 80 | 5.0e-14 | none | yes |  |
| `su` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `su` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `tmge10` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `tmge10` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `tmge5` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `tmge5` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `tmlt10` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `tmlt10` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `tmlt5` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `tmlt5` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `tmm` | annual | degC | exact | 79 | 79 | 79 | 9.2e-14 | none | yes |  |
| `tmm` | monthly | degC | exact | 959 | 959 | 959 | 1.6e-13 | none | yes |  |
| `tn10p` | annual | % | exact | 79 | 79 | 79 | 4.8e-14 | none | yes |  |
| `tn10p` | monthly | % | exact | 959 | 959 | 959 | 5.3e-14 | none | yes |  |
| `tn90p` | annual | % | exact | 79 | 79 | 79 | 5.0e-14 | none | yes |  |
| `tn90p` | monthly | % | exact | 959 | 959 | 959 | 5.2e-14 | none | yes |  |
| `tnlt2` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `tnlt2` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `tnltm2` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `tnltm2` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `tnltm20` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `tnltm20` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `tnm` | annual | degC | exact | 79 | 79 | 79 | 7.6e-14 | none | yes |  |
| `tnm` | monthly | degC | exact | 959 | 959 | 959 | 7.6e-14 | none | yes |  |
| `tnn` | annual | degC | exact | 79 | 79 | 79 | 2.3e-14 | none | yes | ymd 79/79 |
| `tnn` | monthly | degC | exact | 959 | 959 | 959 | 2.3e-14 | none | yes | ymd 959/959 |
| `tnx` | annual | degC | exact | 79 | 79 | 79 | 2.1e-14 | none | yes | ymd 79/79 |
| `tnx` | monthly | degC | exact | 959 | 959 | 959 | 2.3e-14 | none | yes | ymd 959/959 |
| `tr` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `tr` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `tx10p` | annual | % | exact | 79 | 79 | 79 | 5.0e-14 | none | yes |  |
| `tx10p` | monthly | % | exact | 959 | 959 | 959 | 5.2e-14 | none | yes |  |
| `tx90p` | annual | % | exact | 79 | 79 | 79 | 4.6e-14 | none | yes |  |
| `tx90p` | monthly | % | exact | 959 | 959 | 959 | 5.2e-14 | none | yes |  |
| `txge30` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `txge30` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `txge35` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `txge35` | monthly | days | exact | 959 | 959 | 959 | 0 | none | yes |  |
| `txgt50p` | annual | % | exact | 79 | 79 | 79 | 5.0e-14 | none | yes |  |
| `txgt50p` | monthly | % | exact | 959 | 959 | 959 | 5.7e-14 | none | yes |  |
| `txm` | annual | degC | exact | 79 | 79 | 79 | 7.5e-14 | none | yes |  |
| `txm` | monthly | degC | exact | 959 | 959 | 959 | 8.5e-14 | none | yes |  |
| `txn` | annual | degC | exact | 79 | 79 | 79 | 2.3e-14 | none | yes | ymd 79/79 |
| `txn` | monthly | degC | exact | 959 | 959 | 959 | 2.3e-14 | none | yes | ymd 959/959 |
| `txx` | annual | degC | exact | 79 | 79 | 79 | 2.1e-14 | none | yes | ymd 79/79 |
| `txx` | monthly | degC | exact | 959 | 959 | 959 | 2.1e-14 | none | yes | ymd 959/959 |
| `wsdi` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |
| `wsdi3` | annual | days | exact | 79 | 79 | 79 | 0 | none | yes |  |

## Differing indices and diagnosis

### `gsl` (annual)

Values beyond tolerance: none. Missing-value mask mismatches: 1996.

Missing-data rule of the southern-hemisphere growing season. Every value that both tools report is identical, and so are the season start and end dates; only the set of years reported as missing differs. The R tool withholds a July-June growing-season year only when it has more than 15 missing days; it does not apply its own second rule, that a year is missing when any of its months has more than 3 missing days (established on the `gappy` variant, where 'more than 15 missing days in the July-June year' reproduces the R tool's missing years exactly: 15 of 15). This implementation applies the whole policy to the July-June year, as it does to every other index, so it withholds a few more years and never reports a year that the R tool withholds. In the northern hemisphere the two tools agree. Setting: none; this is a deliberate difference, listed below for the science lead. Here the year is 1996: July 1996 to June 1997 contains October 1996, which has 8 missing tmax days.

## Not yet implemented

* `12month_spei`, `24month_spei`, `3month_spei`, `6month_spei`: SPEI: available in xclim, but Climpact's own fitting routine must be matched first.
* `12month_spi`, `24month_spi`, `3month_spi`, `6month_spi`: SPI: available in xclim, but Climpact's own fitting routine must be matched first.
* `ECFdaily`, `EHF-HWD`, `EHF-HWF`, `EHF-HWLI`, `EHF-HWLS`, `EHF-HWMD`, `EHF-HWN`, `EHF-HWPI`, `EHF-HWPS`, `EHFdaily`: Excess Heat Factor heatwaves: no xclim indicator; custom code planned.
* `TN90-HWA`, `TN90-HWD`, `TN90-HWF`, `TN90-HWM`, `TN90-HWN`, `TX90-HWA`, `TX90-HWD`, `TX90-HWF`, `TX90-HWM`, `TX90-HWN`: TX90/TN90 heatwave aspects (HWN, HWF, HWD, HWM, HWA): no xclim indicator; custom code planned.
* `tx2tn2`: consecutive hot days and nights: no xclim indicator; custom code planned.
* `tx95t`: a day-of-year threshold series, not a time series; its 365 values are checked in the thresholds section.
* `txb2tnb2`: consecutive cold days and nights: no xclim indicator; custom code planned.

Every index in this implementation's registry has a reference output and is in the table above.

## Variant cases

The default case alone cannot show that the two tools behave alike. Each variant below changes
one thing about the Sydney record or its parameters (fixed seed, `baseline/make_variants.py`),
is run through the ORIGINAL R tool with its documented batch command (`baseline/run_variants.sh`;
the metadata, the exact command and the R outputs are under `baseline/variants/<name>/`), and
through this implementation with the same input file and parameters. R exit status 0 means the
R tool ran to completion; it reported no error for any variant. The same tolerances apply.

In the `params` variant the user-defined outputs carry the parameter in their name on both sides
(`wsdi5`, `csdi5`, `hddheat15`, `cddcold22`, `gddgrow5`, `rx7day`, `r25mm`); its `txtn = 3` and
`SPEI = 9` settings affect only outputs that are not implemented here.

| variant | what changes | R exit status | outputs compared | exact | within tolerance | differing | not implemented |
|---|---|---|---|---|---|---|---|
| `base6190` | Same data, base period 1961-1990 | 0 | 81 | 80 | 0 | 1 | 31 |
| `cold` | tmax and tmin lowered by 15 degC: frost, ice and cold-threshold indices are non-zero | 0 | 81 | 80 | 0 | 1 | 31 |
| `coldgapnorth` | The cold and gappy changes together at latitude +40: northern growing season with real seasons and gaps | 0 | 81 | 81 | 0 | 0 | 31 |
| `gappy` | 3 % of days missing at random, four multi-week gaps (two as absent rows), 1982 missing | 0 | 81 | 80 | 0 | 1 | 31 |
| `north` | Same data, latitude +40: northern-hemisphere rules (growing season) | 0 | 81 | 81 | 0 | 0 | 31 |
| `params` | Same data, non-default user parameters | 0 | 81 | 80 | 0 | 1 | 31 |
| `short` | 1971-2000 only: the record equals the base period | 0 | 81 | 80 | 0 | 1 | 31 |
| **all variants** |  |  | 567 | 562 | 0 | 5 | 217 |

### Differing outputs in the variants

* `base6190` / `gsl` (annual): 78 of 78 comparable values exact; values beyond tolerance: none; missing on one side only: 1996. Dates: start 78/78, end 78/78.

  Diagnosis: Missing-data rule of the southern-hemisphere growing season. Every value that both tools report is identical, and so are the season start and end dates; only the set of years reported as missing differs. The R tool withholds a July-June growing-season year only when it has more than 15 missing days; it does not apply its own second rule, that a year is missing when any of its months has more than 3 missing days (established on the `gappy` variant, where 'more than 15 missing days in the July-June year' reproduces the R tool's missing years exactly: 15 of 15). This implementation applies the whole policy to the July-June year, as it does to every other index, so it withholds a few more years and never reports a year that the R tool withholds. In the northern hemisphere the two tools agree. Setting: none; this is a deliberate difference, listed below for the science lead.
* `cold` / `gsl` (annual): 78 of 78 comparable values exact; values beyond tolerance: none; missing on one side only: 1996. Dates: start 74/74, end 74/74.

  Diagnosis: Missing-data rule of the southern-hemisphere growing season. Every value that both tools report is identical, and so are the season start and end dates; only the set of years reported as missing differs. The R tool withholds a July-June growing-season year only when it has more than 15 missing days; it does not apply its own second rule, that a year is missing when any of its months has more than 3 missing days (established on the `gappy` variant, where 'more than 15 missing days in the July-June year' reproduces the R tool's missing years exactly: 15 of 15). This implementation applies the whole policy to the July-June year, as it does to every other index, so it withholds a few more years and never reports a year that the R tool withholds. In the northern hemisphere the two tools agree. Setting: none; this is a deliberate difference, listed below for the science lead.
* `gappy` / `gsl` (annual): 57 of 57 comparable values exact; values beyond tolerance: none; missing on one side only: 1940, 1955, 1959, 1983, 1986, 1989, 2004, 2009. Dates: start 57/57, end 57/57.

  Diagnosis: Missing-data rule of the southern-hemisphere growing season. Every value that both tools report is identical, and so are the season start and end dates; only the set of years reported as missing differs. The R tool withholds a July-June growing-season year only when it has more than 15 missing days; it does not apply its own second rule, that a year is missing when any of its months has more than 3 missing days (established on the `gappy` variant, where 'more than 15 missing days in the July-June year' reproduces the R tool's missing years exactly: 15 of 15). This implementation applies the whole policy to the July-June year, as it does to every other index, so it withholds a few more years and never reports a year that the R tool withholds. In the northern hemisphere the two tools agree. Setting: none; this is a deliberate difference, listed below for the science lead.
* `params` / `gsl` (annual): 78 of 78 comparable values exact; values beyond tolerance: none; missing on one side only: 1996. Dates: start 78/78, end 78/78.

  Diagnosis: Missing-data rule of the southern-hemisphere growing season. Every value that both tools report is identical, and so are the season start and end dates; only the set of years reported as missing differs. The R tool withholds a July-June growing-season year only when it has more than 15 missing days; it does not apply its own second rule, that a year is missing when any of its months has more than 3 missing days (established on the `gappy` variant, where 'more than 15 missing days in the July-June year' reproduces the R tool's missing years exactly: 15 of 15). This implementation applies the whole policy to the July-June year, as it does to every other index, so it withholds a few more years and never reports a year that the R tool withholds. In the northern hemisphere the two tools agree. Setting: none; this is a deliberate difference, listed below for the science lead.
* `short` / `gsl` (annual): 28 of 28 comparable values exact; values beyond tolerance: none; missing on one side only: 1996. Dates: start 28/28, end 28/28.

  Diagnosis: Missing-data rule of the southern-hemisphere growing season. Every value that both tools report is identical, and so are the season start and end dates; only the set of years reported as missing differs. The R tool withholds a July-June growing-season year only when it has more than 15 missing days; it does not apply its own second rule, that a year is missing when any of its months has more than 3 missing days (established on the `gappy` variant, where 'more than 15 missing days in the July-June year' reproduces the R tool's missing years exactly: 15 of 15). This implementation applies the whole policy to the July-June year, as it does to every other index, so it withholds a few more years and never reports a year that the R tool withholds. In the northern hemisphere the two tools agree. Setting: none; this is a deliberate difference, listed below for the science lead.

### What the variants found

* **A real defect on this side, now fixed.** Until the `cold` variant existed, GSL came from
  xclim's `growing_season_length` and matched only because Sydney has no cold season. On `cold`
  it differed from the R tool in 9 of 78 years, by up to 110 days (item 9 of the list for the
  science lead). GSL is now computed from the ETCCDI definition and agrees in every year and in
  every start and end date; `tests/test_variants.py` holds the regression tests.
* **A wrong diagnosis in the first version of this report, now corrected.** The default case
  suggested that the R tool does not mask the southern-hemisphere growing season at all. The
  `gappy` variant shows that it does, by the 15-day rule only (item 1 of that list).
* **User parameters were not adjustable here.** They now are (API and command line), which is
  what made the `params` variant comparable.
* Nothing else differed. Frost, ice and cold-threshold counts on a cold record; the missing-data
  masks of every calendar-year index on records with 3 % random gaps, multi-week gaps and a
  missing base-period year; percentile indices with another base period; the bootstrap when the
  record equals the base period; and the northern growing season on a cold, gappy record all
  agree with the R tool to floating-point noise.

## Percentile thresholds

Day-of-year thresholds (5-day window, base period, 365 calendar days) and the wet-day
precipitation quantiles, against `thres/<station>_thres.csv` of the R tool.

| threshold | values | max abs diff |
|---|---|---|
| `tmax_q5` | 365 | 3.6e-15 |
| `tmax_q10` | 365 | 3.6e-14 |
| `tmax_q50` | 365 | 7.1e-15 |
| `tmax_q90` | 365 | 4.3e-14 |
| `tmax_q95` | 365 | 3.6e-14 |
| `tmin_q5` | 365 | 3.6e-15 |
| `tmin_q10` | 365 | 3.6e-14 |
| `tmin_q50` | 365 | 3.6e-15 |
| `tmin_q90` | 365 | 3.9e-14 |
| `tmin_q95` | 365 | 2.5e-14 |
| `prec_q95` | 1 | 7.1e-15 |
| `prec_q99` | 1 | 1.4e-14 |

## Trends

Sen's slope with 95 % bounds, per time step, against the R tool's trend file: 81 of
83 annual and monthly rows compared, maximum absolute difference
1.5e-14, rows differing by more than 1e-09: none.
Not compared (index not implemented): tx2tn2 (annual), txb2tnb2 (annual). The R tool's seasonal rows
(DJF, MAM, JJA, SON) and SPI/SPEI rows are not compared. The R tool does not write p-values, so
the Mann-Kendall p-value is tested against hand-computed cases only (`tests/test_trend.py`).

## Quality control

Dates flagged with default thresholds, against the R tool's `qc/` tables.

| check | R tool file | flagged here | flagged by R tool | same dates |
|---|---|---|---|---|
| TX not above TN | `tmaxmin.csv` | 1 | 1 | yes |
| Too large (precipitation > 200 mm, |temperature| > 50) | `toolarge.csv` | 4 | 4 | yes |
| TX jumps of 20 degC or more | `tx_jumps.csv` | 4 | 4 | yes |
| TN jumps of 20 degC or more | `tn_jumps.csv` | 0 | 0 | yes |
| TX repeated values | `tx_flatline.csv` | 0 | 0 | yes |
| TN repeated values | `tn_flatline.csv` | 0 | 0 | yes |
| Duplicate dates | `duplicates.csv` | 0 | 0 | yes |
| Outliers: precipitation, high | `outliers.csv [Prec up]` | 275 | 275 | yes |
| Outliers: TX, high | `outliers.csv [TX up]` | 69 | 69 | yes |
| Outliers: TX, low | `outliers.csv [TX low]` | 0 | 0 | yes |
| Outliers: TN, high | `outliers.csv [TN up]` | 0 | 0 | yes |
| Outliers: TN, low | `outliers.csv [TN low]` | 0 | 0 | yes |
| Outliers: daily range, high | `outliers.csv [DTR up]` | 51 | 51 | yes |
| Outliers: daily range, low | `outliers.csv [DTR low]` | 0 | 0 | yes |
| Missing days per year (80 years x 3 variables) | `nastatistics.csv` | 123 | 123 | yes |

The climatology (standard deviation), rounding and negative-precipitation checks have no
counterpart table in the R tool and are covered by unit tests only.

## Second reference: upstream's checked-in outputs

`baseline/upstream/tests/output_compare/` holds outputs that the Climpact maintainers keep for
their own regression test (Climpact 3.4, latitude 0, base period 1971-2000). They were produced
independently of our own baseline run, so they guard against a mistake in how we ran the R tool.

79 index outputs compared (of 114 in the reference): 78 exact, 0 within tolerance, 1 differing; 35 not yet implemented.

* `gsl` (annual) differs: values beyond tolerance none; mask mismatches 1996; max abs diff 0.

Not implemented here: `12month_spei`, `12month_spi`, `24month_spei`, `24month_spi`, `3month_spei`, `3month_spi`, `6month_spei`, `6month_spi`, `ECFdaily`, `EHF-HWD`, `EHF-HWF`, `EHF-HWLI`, `EHF-HWLS`, `EHF-HWMD`, `EHF-HWN`, `EHF-HWPI`, `EHF-HWPS`, `EHFdaily`, `TN90-HWA`, `TN90-HWD`, `TN90-HWF`, `TN90-HWM`, `TN90-HWN`, `TNgt0`, `TX90-HWA`, `TX90-HWD`, `TX90-HWF`, `TX90-HWM`, `TX90-HWN`, `csdi1`, `tx2tn2`, `tx95t`, `txb2tnb2`, `wsdi1`.

## Notes on specific results

### Ties at the threshold (percentile indices)

Station values are recorded to 0.1 degC, so an observation often equals a percentile threshold
exactly. Whether such a day counts as "above the 90th percentile" then depends on the last bit
of the threshold, which depends on the order in which the quantile formula is evaluated. This
implementation evaluates the Hyndman and Fan type-8 quantile as `(1 - g) x[j] + g x[j+1]` with
the position `a + q (n + 1 - a - b)`, `a = b = 1/3`; with that order every percentile value above
matches the R tool. The table below shows what happens with the algebraically identical
`x[j] + g (x[j+1] - x[j])`: some months change by one day (about 3 percentage points for a
month, 0.3 for a year). Neither result is more correct; the tie is decided by rounding noise in
both tools. The honest statement is therefore: percentile indices reproduce the R tool exactly
*because the arithmetic order was chosen to do so*, and they are sensitive at the level shown
here. A rule that does not depend on rounding (for example comparing values rounded to the
data's precision) would be a scientific change and is listed below for the science lead.

| index | months compared | months that differ from the R tool | max abs diff (% points) |
|---|---|---|---|
| `tx90p` | 959 | 1 | 0.1232 |
| `tn90p` | 959 | 0 | 5.2e-14 |
| `tx10p` | 959 | 12 | 4.227 |
| `tn10p` | 959 | 7 | 3.226 |
| `txgt50p` | 959 | 92 | 3.448 |

### xclim's own percentile method

`percentile_method="xclim"` uses xclim's `percentile_doy` and its `bootstrap=True` option (which
xclim labels experimental) instead of the climdex-compatible implementation. It is slower and
does not reproduce the R tool: most years differ by at least one day. Known contributors are
that xclim builds thresholds on a 366-day year and interpolates, while climdex.pcic drops
29 February and wraps the 5-day window within the year, so thresholds shift slightly on most
days and ties flip. The difference has not been decomposed further here. The option remains
available and labelled; it is not the default.

| index (annual) | seconds | years compared | exact | within tolerance | max abs diff |
|---|---|---|---|---|---|
| `tx90p` | 4.1 | 79 | 15 | 15 | 1.644 |
| `tn90p` | 4.1 | 79 | 11 | 13 | 2.145 |
| `tx10p` | 4.0 | 79 | 12 | 14 | 1.37 |
| `tn10p` | 4.2 | 79 | 14 | 14 | 1.639 |
| `wsdi` | 0.1 | 79 | 76 | 76 | 12 |
| `csdi` | 0.1 | 79 | 67 | 67 | 8 |

### Dry and wet spells that cross a year boundary

Climpact credits a spell to the year in which it ends. xclim either cuts spells at 31 December
or credits them to the year in which they start, so CDD and CWD use a small custom rule
(`climpoc/indices/spells.py`). With xclim's native attribution CDD would differ as follows:

| xclim attribution | years that differ from the R tool (of 80) | max abs diff (days) |
|---|---|---|
| cut at year end | 3 | 2 |
| spanning, credited to start year | 3 | 4 |

### Dates of occurrence

Index values are what the status column judges. Dates written next to them (`ymd`, spell `start`
and `end`) are compared in the `dates` column of the main table, as agreeing / comparable.

* `rx3day` and `rx5day` (monthly), October 2006: two windows have the same total (8.2 mm). This
  implementation reports the first; the R tool reports the second, because its running sum
  carries rounding noise (it prints 8.19999999999989).
* `cdd`, 1990, 1991 and 1998: the duration agrees but the R tool's dates do not describe the
  spell that has that duration. In each case the longest spell credited to the year began in the
  previous year (for example 16 December 1989 to 5 January 1990, 21 days); the R tool prints the
  end date of a different, shorter spell and a start date obtained by subtracting the duration
  (11 to 31 December 1990, although 11 December 1990 had 1.4 mm of rain). This implementation
  reports the actual spell. Listed below for the science lead.
* `gsl`: season start and end dates agree wherever both tools report a season (see the `dates`
  column here and in the variant cases).

## Upstream behaviours to raise with the science lead

These concern indices and checks implemented here. None was silently copied or silently changed.

1. **The southern-hemisphere growing season applies only half of the missing-data rule.** For the
   July-June year the R tool withholds GSL when more than 15 days are missing, but not when a
   month has more than 3 missing days, although that second rule removes the year for every other
   index (and for GSL in the northern hemisphere). This implementation applies both rules
   (differences shown above and in the variant cases).
2. **Ties at percentile thresholds are decided by floating-point rounding** (see the note above).
   Reproduced here for continuity; a rounding-independent rule would need a scientific decision.
3. **Dates printed for dry spells that started in the previous year are inconsistent** with the
   duration printed next to them (see "Dates of occurrence"). Not reproduced.
4. **R95p and R99p are amounts in millimetres** in Climpact, while other sources (and xclim's
   indicator of the same name) define them as a number of days; Climpact's R95pTOT is the
   percentage share. Reproduced here; the naming needs a decision (upstream issue 87).
5. **"TX below TN" also flags TX equal to TN** (one day in this record). Reproduced as the
   default, with a setting (`tmax_tmin_inclusive`) to flag only TX below TN.
6. **A year is missing when any single month is missing**, even with fewer than 15 missing days
   in the year (1996 here: 10 missing days). Reproduced as the default policy; the limits are
   settings and alternative policies exist.
7. **Latitude 0 is treated as southern hemisphere** (`latitude > 0` is northern). Reproduced.
8. **Records that start or end mid-year.** Here, days outside the record count as missing, so an
   incomplete first or last year is reported as missing. The sample starts on 1 January and ends
   on 31 December, so this validation says nothing about the R tool's behaviour in that case.
9. **xclim's growing season differs from the ETCCDI definition and from the R tool.** With
   `growing_season_length` a day of exactly 5 degC counts towards the end (or the start) of the
   season, and the season may start in the second half of the year. On the `cold` variant it
   differed from the R tool in 9 of 78 years, by up to 110 days. GSL is therefore computed here
   from the definition (`climpoc/indices/seasons.py`); the finding is worth reporting to xclim.
10. **The R tool accepts files with absent days and fills them silently**, and drops impossible
    dates. This implementation reports them as errors by default; the variant comparison reads
    the files in its "repair" mode, which does what the R tool does and says so.

Known upstream quirks in indices that are *not yet implemented* here, to settle before they are:
the Excess Heat Factor uses a type-7 quantile where everything else uses type 8; TXdTNd and
TXbdTNbd require d + 1 consecutive days; the TN flat-line QC file carries a TX description.

## Performance

All indices for the 80-year station, second run in a warm process, this machine:
annual 2.87 s, monthly 4.51 s. The first run in a new process takes a few
seconds longer while xclim compiles its run-length kernels.
