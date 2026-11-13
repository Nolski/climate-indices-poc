"""Render the validation report (``VALIDATION.md``) from the dictionary built by ``compare.run``."""

from __future__ import annotations

from compare import summary_line

NOTES = """\
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

{ties}

### xclim's own percentile method

`percentile_method="xclim"` uses xclim's `percentile_doy` and its `bootstrap=True` option (which
xclim labels experimental) instead of the climdex-compatible implementation. It is slower and
does not reproduce the R tool: most years differ by at least one day. Known contributors are
that xclim builds thresholds on a 366-day year and interpolates, while climdex.pcic drops
29 February and wraps the 5-day window within the year, so thresholds shift slightly on most
days and ties flip. The difference has not been decomposed further here. The option remains
available and labelled; it is not the default.

{xclim}

### Dry and wet spells that cross a year boundary

Climpact credits a spell to the year in which it ends. xclim either cuts spells at 31 December
or credits them to the year in which they start, so CDD and CWD use a small custom rule
(`climpoc/indices/spells.py`). With xclim's native attribution CDD would differ as follows:

{spells}

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
"""

SCIENCE_LEAD = """\
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
"""


def _number(value: float) -> str:
    if value == 0:
        return "0"
    return f"{value:.1e}" if value < 1e-3 else f"{value:.4g}"


def _labels(labels: list[str], limit: int = 8) -> str:
    if not labels:
        return "none"
    shown = ", ".join(labels[:limit])
    return shown if len(labels) <= limit else f"{shown}, ... ({len(labels)} in total)"


def _table(header: list[str], rows: list[list[object]]) -> str:
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    lines += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(lines)


def _results_table(rows: list[dict]) -> str:
    body = []
    for row in rows:
        comparison = row["comparison"]
        if comparison is None:
            continue
        body.append([
            f"`{row['index']}`", row["frequency"], row["units"], f"**{row['status']}**" if row["status"] == "differs" else row["status"],
            comparison["n_comparable"], comparison["n_exact"], comparison["n_within_tolerance"],
            _number(comparison["max_abs_diff"]), _labels(comparison["differing"]),
            "yes" if comparison["masks_agree"] else "no: " + _labels(comparison["mask_mismatches"]),
            row["dates"] or "",
        ])  # fmt: skip
    header = ["index", "frequency", "units", "status", "comparable values", "exact", "within tolerance",
              "max abs diff", "periods differing", "missing masks agree", "dates"]  # fmt: skip
    return _table(header, body)


def _differing_section(rows: list[dict]) -> str:
    differing = [row for row in rows if row["status"] == "differs"]
    if not differing:
        return "No compared index differs.\n"
    parts = []
    for row in differing:
        comparison = row["comparison"]
        parts.append(
            f"### `{row['index']}` ({row['frequency']})\n\n"
            f"Values beyond tolerance: {_labels(comparison['differing'])}. "
            f"Missing-value mask mismatches: {_labels(comparison['mask_mismatches'])}.\n\n"
            f"{row['diagnosis']}\n"
        )
    return "\n".join(parts)


def _not_implemented_section(rows: list[dict]) -> str:
    groups: dict[str, list[str]] = {}
    for row in rows:
        if row["status"] == "not yet implemented":
            groups.setdefault(row["diagnosis"], []).append(f"`{row['index']}`")
    return "\n".join(f"* {', '.join(names)}: {reason}." for reason, names in groups.items())


def _second_oracle_section(report: dict) -> str:
    second = report.get("second_oracle")
    if second is None:
        return "The upstream checkout was not present when this report was generated, so this comparison was skipped.\n"
    rows = second["rows"]
    differing = [row for row in rows if row["status"] == "differs"]
    absent = sorted({f"`{row['index']}`" for row in rows if row["status"] == "not yet implemented"})
    lines = [summary_line(second["summary"]), ""]
    for row in differing:
        comparison = row["comparison"]
        lines.append(
            f"* `{row['index']}` ({row['frequency']}) differs: values beyond tolerance {_labels(comparison['differing'])}; "
            f"mask mismatches {_labels(comparison['mask_mismatches'])}; max abs diff {_number(comparison['max_abs_diff'])}."
        )
    lines.append(f"\nNot implemented here: {', '.join(absent)}.")
    return "\n".join(lines) + "\n"


VARIANT_FINDINGS = """\
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
"""


def _variants_section(report: dict) -> str:
    variants = report.get("variants")
    if not variants:
        return "## Variant cases\n\nNo variant case was present when this report was generated (`baseline/run_variants.sh`).\n"
    table_rows, details = [], []
    for variant in variants:
        summary = variant["summary"]
        name = f"`{variant['name']}`"
        if summary is None:
            table_rows.append([name, variant["description"], variant["r_exit_status"], "no output", "", "", "", ""])
            continue
        table_rows.append([
            name, variant["description"], variant["r_exit_status"], summary["compared"], summary["exact"],
            summary["within_tolerance"], summary["differing"], summary["not_yet_implemented"],
        ])  # fmt: skip
        for row in variant["rows"]:
            if row["status"] == "differs":
                comparison = row["comparison"]
                details.append(
                    f"* {name} / `{row['index']}` ({row['frequency']}): {comparison['n_exact']} of "
                    f"{comparison['n_comparable']} comparable values exact; values beyond tolerance: "
                    f"{_labels(comparison['differing'])}; missing on one side only: "
                    f"{_labels(comparison['mask_mismatches'], 12)}. Dates: {row['dates'] or 'n/a'}.\n\n"
                    f"  Diagnosis: {row['diagnosis']}"
                )
        for index, reason in variant.get("skipped_here", {}).items():
            details.append(f"* {name} / `{index}`: not computed here ({reason}).")
    totals = report["variant_totals"]
    table_rows.append([
        "**all variants**", "", "", totals["compared"], totals["exact"], totals["within_tolerance"],
        totals["differing"], totals["not_yet_implemented"],
    ])  # fmt: skip
    header = ["variant", "what changes", "R exit status", "outputs compared", "exact", "within tolerance",
              "differing", "not implemented"]  # fmt: skip
    differing = "\n".join(details) if details else "No compared output differs in any variant."
    return f"""\
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

{_table(header, table_rows)}

### Differing outputs in the variants

{differing}

{VARIANT_FINDINGS}"""


def _optional_tables(report: dict) -> dict[str, str]:
    skipped = "_Skipped in this run (`--skip-slow`)._"
    ties = report.get("tie_sensitivity")
    xclim = report.get("xclim_percentile_method")
    spells = report.get("xclim_spell_attribution")
    return {
        "ties": _table(
            ["index", "months compared", "months that differ from the R tool", "max abs diff (% points)"],
            [[f"`{row['index']}`", row["months_compared"], row["months_differing"], _number(row["max_abs_diff"])] for row in ties],
        ) if ties else skipped,
        "xclim": _table(
            ["index (annual)", "seconds", "years compared", "exact", "within tolerance", "max abs diff"],
            [[f"`{row['index']}`", row["seconds"], row["years_compared"], row["years_exact"], row["years_within_tolerance"],
              _number(row["max_abs_diff"])] for row in xclim],
        ) if xclim else skipped,
        "spells": _table(
            ["xclim attribution", "years that differ from the R tool (of 80)", "max abs diff (days)"],
            [[label, row["years_differing"], _number(row["max_abs_diff"])] for label, row in spells.items()],
        ) if spells else skipped,
    }  # fmt: skip


def render_markdown(report: dict) -> str:
    rows = report["rows"]
    versions = report["versions"]
    trends = report["trends"]
    tolerance = report["tolerance"]
    timings = report["timings_seconds"]
    qc_rows = [
        [
            row["check"],
            f"`{row['reference_file']}`",
            row["ours"],
            row["reference"],
            "yes" if row["same_dates"] else "**no**",
        ]
        for row in report["qc"]
    ]
    threshold_rows = [[f"`{row['threshold']}`", row["n"], _number(row["max_abs_diff"])] for row in report["thresholds"]]
    extra = report["registry_without_reference"]
    return f"""\
# Validation against the R tool

**{report["headline"]}**

Generated {report["generated"]} by `validate/compare.py` with climpoc {versions["climpoc"]},
xclim {versions["xclim"]}, xarray {versions["xarray"]}, numpy {versions["numpy"]}, pandas {versions["pandas"]},
Python {versions["python"]}. Do not edit by hand; run `uv run python validate/compare.py`.

## What is compared

* Reference: {report["reference"]}. One station (Sydney Observatory Hill, 1936-2015, 29,220 days;
  7 missing precipitation values, 58 missing tmax, 58 missing tmin).
* Parameters, identical on both sides: base period {report["parameters"]["base_period"][0]}-{report["parameters"]["base_period"][1]},
  latitude {report["parameters"]["latitude"]}, longitude {report["parameters"]["longitude"]}; missing-data policy
  {report["parameters"]["missing_policy"]}.
* Every row of `baseline/index_inventory.csv` (one per index and frequency) appears below, either
  compared or listed as not yet implemented.
* **Tolerance.** The R files carry 15 significant digits, so two levels are reported.
  "Exact" means the absolute difference is at most {tolerance["exact"]:g} (floating-point noise; nothing a
  user could see). "Within tolerance" means at most {tolerance["tolerance"]:g} in the index's own units
  (days, degC, mm, mm/day, %, degree-days). A value beyond {tolerance["tolerance"]:g}, or a period that is
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

{_results_table(rows)}

## Differing indices and diagnosis

{_differing_section(rows)}
## Not yet implemented

{_not_implemented_section(rows)}

{("Indices in this implementation without a reference output: " + ", ".join(extra) + ".") if extra else "Every index in this implementation's registry has a reference output and is in the table above."}

{_variants_section(report)}
## Percentile thresholds

Day-of-year thresholds (5-day window, base period, 365 calendar days) and the wet-day
precipitation quantiles, against `thres/<station>_thres.csv` of the R tool.

{_table(["threshold", "values", "max abs diff"], threshold_rows)}

## Trends

Sen's slope with 95 % bounds, per time step, against the R tool's trend file: {trends["rows_compared"]} of
{trends["rows_in_reference"]} annual and monthly rows compared, maximum absolute difference
{_number(trends["max_abs_diff"])}, rows differing by more than {tolerance["exact"]:g}: {_labels(trends["differing"])}.
Not compared (index not implemented): {_labels(trends["not_compared"])}. The R tool's seasonal rows
(DJF, MAM, JJA, SON) and SPI/SPEI rows are not compared. The R tool does not write p-values, so
the Mann-Kendall p-value is tested against hand-computed cases only (`tests/test_trend.py`).

## Quality control

Dates flagged with default thresholds, against the R tool's `qc/` tables.

{_table(["check", "R tool file", "flagged here", "flagged by R tool", "same dates"], qc_rows)}

The climatology (standard deviation), rounding and negative-precipitation checks have no
counterpart table in the R tool and are covered by unit tests only.

## Second reference: upstream's checked-in outputs

`baseline/upstream/tests/output_compare/` holds outputs that the Climpact maintainers keep for
their own regression test (Climpact 3.4, latitude 0, base period 1971-2000). They were produced
independently of our own baseline run, so they guard against a mistake in how we ran the R tool.

{_second_oracle_section(report)}
{NOTES.format(**_optional_tables(report))}
{SCIENCE_LEAD}
## Performance

All indices for the 80-year station, second run in a warm process, this machine:
annual {timings["annual"]} s, monthly {timings["monthly"]} s. The first run in a new process takes a few
seconds longer while xclim compiles its run-length kernels.
"""
