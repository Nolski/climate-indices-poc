# Provenance: how this code was written

This document is a factual record of what the code in this repository was written from.

## Licence

climpoc is released under the GNU General Public License, version 3 or later
(`GPL-3.0-or-later`), the same licence family as Climpact. That choice was made out of respect
for the Climpact project, and so that material from Climpact can be reused later without a
licence obstacle. It says nothing about the licence of any future WMO product: that is a decision
for WMO and the Climpact maintainers, and this proof of concept does not presume it.

## What the code was written from

The code was written independently. **No R code from Climpact or `climdex.pcic` was copied,
ported or transcribed.** The sources were:

1. published index definitions (the ETCCDI core indices; the ET-SCI sector indices as listed in
   the Climpact user guide);
2. published methods: Zhang, Hegerl, Zwiers and Kenyon (2005) for the in-base bootstrap;
   Hyndman and Fan (1996) for the type-8 quantile; Sen (1968) and Gilbert (1987) for the slope
   and its confidence bounds; Mann (1945) and Kendall (1975) for the trend test; Tukey's
   five-number summary for the boxplot outlier rule;
3. the public API and documentation of `xclim` 1.0.0, which does most of the computation;
4. the R tool's **outputs**: for the bundled sample station (`baseline/output/`) and for seven
   variants of it (`baseline/variants/`), produced by running the unmodified tool, and used as
   test expectations;
5. **prose descriptions** of the R tool's behaviour (thresholds, missing-data limits, file
   layouts): its user guide, `baseline/README.md`, and two research notes written for this
   project by people who read the R source and described what it does, with links to it.

The upstream checkout under `baseline/upstream/` (R source and sample data) is fetched when
needed and is not tracked in this repository.

## Rules learned from prose descriptions of the R tool

Each was implemented independently and then checked against the tool's outputs.

| Rule | Where it is implemented |
|---|---|
| A month is missing with more than 3 missing days; a year with more than 15, or when any month is missing | `indices/missing.py` |
| Day-of-year thresholds: 5-day window, 365 calendar days, 29 February left out of the base sample and given the threshold of 28 February, window wrapped within the same year | `indices/thresholds.py` |
| Type-8 quantiles; precipitation percentiles from base-period wet days (at least 1 mm) | `indices/thresholds.py` |
| In-base bootstrap for TX/TN 10p/90p and TXgt50p only; WSDI and CSDI use plain thresholds and spells do not cross year ends | `indices/recipes.py` |
| Dry and wet spells may cross year ends, are credited to the year in which they end, and a year wholly inside a spell has no value | `indices/spells.py` |
| Running precipitation totals use a centred window and treat missing days as zero; SDII is 0 without wet days | `indices/registry.py` (parameters of the xclim call) |
| R95p and R99p are amounts in millimetres; R95pTOT is 100 x R95p / PRCPTOT | `indices/recipes.py` |
| Hemisphere: latitude above zero is northern | `indices/settings.py` |
| The user-defined indices and their parameters (spell lengths, degree-day bases, RXdday, Rnnmm) and how the parameter appears in the output name | `indices/settings.py`, `indices/registry.py` |
| QC: boxplot rule per calendar month with Tukey hinges (precipitation on rain days, high side only); jumps as rounded difference of at least the threshold, first day listed; a flat line is more than N repeats; TX not above TN includes equality | `qc/checks/` |
| Trend needs 10 valid values and 70 % of the series | `stats/trend.py` |

## Choices made by matching outputs

Where a definition leaves a detail open, the R tool's output files decided it:

* **Quantile arithmetic.** The type-8 quantile is evaluated as `(1 - g) x[j] + g x[j+1]` with
  position `a + q (n + 1 - a - b)`. Three algebraically identical position formulas and two
  interpolation formulas were tried against the baseline percentile indices; this combination
  reproduces them all, the others differ on days where an observation equals the threshold.
  `VALIDATION.md` ("Ties at the threshold") reports the size of the effect.
* **Rank rounding in Sen's confidence bounds.** The bounds are the pairwise slopes ranked
  `round((N - C) / 2)` and `round((N + C) / 2)`; this was the first convention tried and it
  matches the baseline trend file.
* **Longest spell among equals.** The first of equally long spells is reported.
* **Growing season.** The ETCCDI definition gives the two spans and the mid-year date. That the
  season must begin in the first half of the year (otherwise its length is 0), that its end is
  looked for in the second half, and that a season without an end lasts to the last day of the
  year, were inferred from the R tool's outputs for a cold-climate variant (years reported as 0
  without dates, and the start and end dates it prints) and are consistent with the
  `climdex.pcic` manual as the implementer remembered it.
* **Missing years of the southern-hemisphere growing season.** Which rule the R tool applies was
  found by testing candidate rules against its outputs for a variant with gaps (see
  `VALIDATION.md`); this implementation deliberately does not copy it.

## Log of R-source lookups

Opening R source under `baseline/upstream/` to resolve a numerical discrepancy was permitted
during the build, provided each lookup was recorded here. **No R calculation source was opened.**
Every discrepancy met was resolved from outputs and the prose descriptions above. For
completeness, everything that was read under `baseline/upstream/`:

| What | Why | What was learned |
|---|---|---|
| `www/sample_data/sydney_observatory_hill_1936-2015.txt` (data) | test input | file format: six whitespace-separated columns, `-99.9` missing |
| `www/sample_data/climpact.sample.batch.metadata.txt` (data) | to write metadata files for the variant runs | the 12 column names and the sample values |
| directory listing of `tests/output_compare/` and the CSV files in it (outputs) | second set of reference outputs | file names and layout are those of `baseline/output/`; generated with latitude 0 by Climpact 3.4 |
| first 40 lines of `tests/output_compare/test_output.R` (shown while listing that folder) | incidental | it is a test script that compares CSV files; it contains no index calculation and nothing from it was used |
| section headings of `www/user_guide/Climpact_user_guide.md` (documentation) | feature-parity table | the list of documented features |
| `LICENSE` (first lines and line count) | choosing a licence text | it is the GNU GPL version 3 |

`baseline/run.sh` and `baseline/scripts/run_in_container.sh`, which run the unmodified R tool in
a container, were written for this project; the variant runner follows them.

One further disclosure, in the interest of accuracy: `climdex.pcic` and `zyp` are published
open-source packages and the implementer had general prior familiarity with how they behave.
That familiarity suggested which details to test against the outputs (for example that
confidence-bound ranks might be rounded). No code was reproduced from memory; each function
was written from the definitions cited in its docstring and verified against outputs.

## How it was built

The repository was built in November 2026 with AI coding agents under the author's direction.
Every number in `VALIDATION.md` is produced by `validate/compare.py` and can be regenerated.

## Sample data and reference outputs

See `NOTICE` for the attribution of the sample station file, the reference outputs under
`baseline/`, and the demonstration data under `web/fixtures/`.
