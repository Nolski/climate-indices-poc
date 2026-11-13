"""Validation harness: compare this implementation with reference outputs of the R tool.

Usage::

    uv run python validate/compare.py            # writes VALIDATION.md and validate/validation.json

It iterates ``baseline/index_inventory.csv`` (Climpact 3.4.4 run on the Sydney sample, base period
1971-2000, latitude -10), runs this implementation with the same parameters and reports, for
every index and frequency, how many values agree. It then does the same for every variant case
under ``baseline/variants/`` (other hemisphere, base period, climate, gaps, record length and
user parameters; see ``baseline/make_variants.py`` and ``baseline/run_variants.sh``).

Nothing here is tuned to the sample: the tolerance is fixed below, every reference output appears
in the report, and indices that are not implemented are listed as such.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import platform
import time as clock
from collections.abc import Iterator
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd
import xarray as xr
import xclim
from xclim.indicators import atmos

import climpoc
from climpoc.export.climpact_csv import read_index_csv
from climpoc.indices import thresholds
from climpoc.indices.engine import IndexResult, compute_indices
from climpoc.indices.registry import REGISTRY
from climpoc.indices.settings import UserParameters, settings_for
from climpoc.io.station import ParsedStation, StationMeta, read_station_file
from climpoc.qc import QCReport, run_qc
from climpoc.stats.trend import sen_trend

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "baseline"
STATION = "sydney_observatory_hill_1936-2015"
SAMPLE = BASELINE / "upstream" / "www" / "sample_data" / f"{STATION}.txt"
REFERENCE = BASELINE / "output" / STATION
SECOND_ORACLE = BASELINE / "upstream" / "tests" / "output_compare"
VARIANTS = BASELINE / "variants"
STATUS_FILE = ROOT / "src" / "climpoc" / "data" / "validation_status.json"
BASE_PERIOD = (1971, 2000)

EXACT = 1e-9
"""Differences up to this size are floating-point noise: the R files carry 15 significant digits."""
TOLERANCE = 0.01
"""Absolute tolerance in the index's own units (days, degC, mm, mm/day, %, degree-days)."""

NOT_IMPLEMENTED = {
    "hw": "TX90/TN90 heatwave aspects (HWN, HWF, HWD, HWM, HWA): no xclim indicator; custom code planned",
    "hwEHF": "Excess Heat Factor heatwaves: no xclim indicator; custom code planned",
    "spei": "SPEI: available in xclim, but Climpact's own fitting routine must be matched first",
    "spi": "SPI: available in xclim, but Climpact's own fitting routine must be matched first",
    "tx95t": "a day-of-year threshold series, not a time series; its 365 values are checked in the thresholds section",
    "txdtnd": "consecutive hot days and nights: no xclim indicator; custom code planned",
    "txbdtnbd": "consecutive cold days and nights: no xclim indicator; custom code planned",
}

GSL_SOUTH = (
    "Missing-data rule of the southern-hemisphere growing season. Every value that both tools report is "
    "identical, and so are the season start and end dates; only the set of years reported as missing differs. "
    "The R tool withholds a July-June growing-season year only when it has more than 15 missing days; it does "
    "not apply its own second rule, that a year is missing when any of its months has more than 3 missing days "
    "(established on the `gappy` variant, where 'more than 15 missing days in the July-June year' reproduces "
    "the R tool's missing years exactly: 15 of 15). This implementation applies the whole policy to the "
    "July-June year, as it does to every other index, so it withholds a few more years and never reports a "
    "year that the R tool withholds. In the northern hemisphere the two tools agree. Setting: none; this is a "
    "deliberate difference, listed below for the science lead."
)

DIAGNOSES = {
    ("gsl", "annual"): GSL_SOUTH
    + " Here the year is 1996: July 1996 to June 1997 contains October 1996, which has 8 missing tmax days.",
}

VARIANT_DIAGNOSES: dict[tuple[str, str, str], str] = {
    (name, "gsl", "annual"): GSL_SOUTH for name in ("base6190", "cold", "gappy", "short", "params")
}
"""Diagnosis of each differing output of a variant case, keyed by (variant, index, frequency)."""

SUMMARY_KEYS = ("reference_outputs", "compared", "exact", "within_tolerance", "differing", "not_yet_implemented")


@dataclass
class ValueComparison:
    n_reference: int = 0
    n_comparable: int = 0
    n_exact: int = 0
    n_within_tolerance: int = 0
    max_abs_diff: float = 0.0
    differing: list[str] = field(default_factory=list)
    mask_mismatches: list[str] = field(default_factory=list)

    @property
    def masks_agree(self) -> bool:
        return not self.mask_mismatches

    @property
    def status(self) -> str:
        if self.differing or self.mask_mismatches:
            return "differs"
        return "exact" if self.n_exact == self.n_comparable else "within tolerance"


@dataclass
class Row:
    index: str
    frequency: str
    units: str
    status: str
    comparison: ValueComparison | None = None
    diagnosis: str = ""
    dates: str = ""


def compare_values(ours: pd.Series, reference: pd.Series) -> ValueComparison:
    """Compare two series on the reference's labels. A label absent on our side counts as missing."""
    ours = ours.reindex(reference.index)
    a, b = ours.to_numpy(float), reference.to_numpy(float)
    both = np.isfinite(a) & np.isfinite(b)
    diff = np.abs(a - b)
    labels = reference.index.to_numpy()
    return ValueComparison(
        n_reference=int(np.isfinite(b).sum()),
        n_comparable=int(both.sum()),
        n_exact=int((both & (diff <= EXACT)).sum()),
        n_within_tolerance=int((both & (diff <= TOLERANCE)).sum()),
        max_abs_diff=float(diff[both].max()) if both.any() else 0.0,
        differing=[str(label) for label in labels[both & (diff > TOLERANCE)]],
        mask_mismatches=[str(label) for label in labels[np.isfinite(a) != np.isfinite(b)]],
    )


def load_sample(latitude: float = -10.0, longitude: float = 100.0) -> ParsedStation:
    return read_station_file(SAMPLE, StationMeta(STATION, latitude, longitude))


def compute_all(dataset: xr.Dataset, **overrides: object) -> dict[tuple[str, str], IndexResult]:
    settings = settings_for(dataset, *BASE_PERIOD, **overrides)
    results = {}
    for frequency in ("annual", "monthly"):
        output = compute_indices(dataset, frequency=frequency, settings=settings)  # type: ignore[arg-type]
        results.update({(result.definition.id, frequency): result for result in output.results})
    return results


def _compare_dates(result: IndexResult, frame: pd.DataFrame) -> str:
    """Agreement of dates of occurrence (``ymd``) or spell and season start and end dates, where both exist."""
    parts = []
    for column in ("ymd", "start", "end"):
        if column not in frame or column not in result.aux:
            continue
        reference = pd.to_datetime(frame[column], errors="coerce").to_numpy()
        ours = (
            pd.Series(result.aux[column].to_numpy(), index=result.labels).reindex(frame["time"].astype(str)).to_numpy()
        )
        both = ~np.isnat(reference) & ~np.isnat(ours)
        same = int((reference[both] == ours[both]).sum())
        parts.append(f"{column} {same}/{int(both.sum())}")
    return ", ".join(parts)


def compare_inventory(results: dict[tuple[str, str], IndexResult]) -> list[Row]:
    inventory = pd.read_csv(BASELINE / "index_inventory.csv")
    rows = []
    for item in inventory.itertuples():
        frequency = item.frequency if item.frequency in ("annual", "monthly") else "other"
        result = results.get((item.index, frequency))
        if result is None:
            reason = NOT_IMPLEMENTED.get(item.climpact_index, "not yet implemented")
            rows.append(Row(item.index, item.frequency, item.units, "not yet implemented", diagnosis=reason))
            continue
        table = read_index_csv(BASELINE / "output" / item.file)
        comparison = compare_values(result.to_series(), table.values())
        diagnosis = DIAGNOSES.get((item.index, frequency), "")
        if comparison.status == "differs" and not diagnosis:
            diagnosis = "NOT YET DIAGNOSED"
        rows.append(
            Row(item.index, frequency, result.definition.units, comparison.status, comparison, diagnosis,
                _compare_dates(result, table.frame))
        )  # fmt: skip
    return rows


def compare_folder(results: dict[tuple[str, str], IndexResult], folder: Path, station: str) -> list[Row]:
    """Compare with every index file ``<station>_<index>_<ANN|MON|...>.csv`` in ``folder``."""
    rows = []
    for path in sorted(folder.glob(f"{station}_*.csv")):
        index, _, suffix = path.stem[len(station) + 1 :].rpartition("_")
        frequency = {"ANN": "annual", "MON": "monthly"}.get(suffix, "other")
        result = results.get((index, frequency))
        if result is None:
            rows.append(Row(index or path.stem[len(station) + 1 :], frequency, "", "not yet implemented"))
            continue
        table = read_index_csv(path)
        comparison = compare_values(result.to_series(), table.values())
        dates = _compare_dates(result, table.frame)
        rows.append(Row(index, frequency, result.definition.units, comparison.status, comparison, dates=dates))
    return rows


def compare_second_oracle(results: dict[tuple[str, str], IndexResult]) -> list[Row]:
    """Upstream's own checked-in reference outputs (Climpact 3.4, latitude 0, same base period)."""
    return compare_folder(results, SECOND_ORACLE / "indices", STATION)


def compare_variant(folder: Path) -> dict[str, object]:
    """Run this implementation on one variant case and compare with the R tool's outputs for it.

    The station file is read with ``chronology="repair"`` because the R tool accepts files with
    absent days and fills them (the ``gappy`` variants have two such gaps).
    """
    case = json.loads((folder / "variant.json").read_text())
    station, metadata = case["station"], case["metadata"]
    status_file = folder / "output" / "r_exit_status.txt"
    r_status = status_file.read_text().strip() if status_file.exists() else "not run"
    reference = folder / "output" / station / "indices"
    summary: dict[str, object] = {"name": case["name"], "description": case["description"], "r_exit_status": r_status}
    if not reference.exists():
        return {**summary, "rows": [], "summary": None, "skipped_here": {}}
    meta = StationMeta(station, float(metadata["latitude"]), float(metadata["longitude"]))
    parsed = read_station_file(folder / "input" / f"{station}.txt", meta, chronology="repair")
    parameters = UserParameters.from_climpact_metadata(metadata)
    settings = settings_for(parsed.dataset, case["base_start"], case["base_end"], parameters=parameters)
    results: dict[tuple[str, str], IndexResult] = {}
    skipped: dict[str, str] = {}
    for frequency in ("annual", "monthly"):
        output = compute_indices(parsed.dataset, frequency=frequency, settings=settings)  # type: ignore[arg-type]
        results.update({(result.definition.id, frequency): result for result in output.results})
        skipped.update(
            {
                f"{item.id} ({frequency})": item.reason
                for item in output.skipped
                if not item.reason.startswith("not available")
            }
        )
    rows = compare_folder(results, reference, station)
    for row in rows:
        if row.status == "differs":
            row.diagnosis = VARIANT_DIAGNOSES.get((case["name"], row.index, row.frequency), "NOT YET DIAGNOSED")
    return {**summary, "summary": summarise(rows), "rows": [_row_dict(row) for row in rows], "skipped_here": skipped}


def compare_variants() -> list[dict[str, object]]:
    """Every variant under ``baseline/variants`` whose input files are present."""
    folders = sorted(path.parent for path in VARIANTS.glob("*/variant.json"))
    return [compare_variant(folder) for folder in folders if (folder / "input").exists()]


def variant_totals(variants: list[dict[str, object]]) -> dict[str, int]:
    """Sum of the per-variant summaries (a variant on which the R tool produced no output adds nothing)."""
    totals = dict.fromkeys(SUMMARY_KEYS, 0)
    for variant in variants:
        for key, value in (variant["summary"] or {}).items():  # type: ignore[union-attr]
            totals[key] += value
    return totals


def compare_thresholds(parsed: ParsedStation) -> list[dict[str, object]]:
    """Day-of-year percentile thresholds against the R tool's thresholds file."""
    reference = pd.read_csv(REFERENCE / "thres" / f"{STATION}_thres.csv", sep=r"\s*,\s*", engine="python")
    frame = parsed.dataset.to_dataframe()
    time = pd.DatetimeIndex(frame.index)
    rows = []
    for variable, prefix in (("tasmax", "tmax"), ("tasmin", "tmin")):
        matrix = thresholds.year_matrix(frame[variable].to_numpy(), time, *BASE_PERIOD)
        for percentile in (5, 10, 50, 90, 95):
            ours = thresholds.doy_thresholds(matrix, percentile / 100)
            diff = np.abs(ours - reference[f"{prefix}_q{percentile}"].to_numpy())
            rows.append({"threshold": f"{prefix}_q{percentile}", "n": 365, "max_abs_diff": float(diff.max())})
    for percentile in (95, 99):
        ours = thresholds.wet_day_quantile(frame["pr"].to_numpy(), time, BASE_PERIOD, percentile / 100, 1.0)
        diff = abs(ours - float(reference[f"prec_q{percentile}"].iloc[0]))
        rows.append({"threshold": f"prec_q{percentile}", "n": 1, "max_abs_diff": diff})
    return rows


def compare_trends(results: dict[tuple[str, str], IndexResult]) -> dict[str, object]:
    """Sen's slope and 95 % bounds against the R tool's trend file (annual and monthly rows)."""
    reference = pd.read_csv(REFERENCE / "trend" / f"{STATION}_trend.csv", skiprows=7)
    reference = reference[reference["Frequency"].isin(["annual", "monthly"])]
    compared, worst, unmatched, differing = 0, 0.0, [], []
    for item in reference.to_dict("records"):
        label = f"{item['Index']} ({item['Frequency']})"
        result = results.get((item["Index"], item["Frequency"]))
        trend = sen_trend(result.values.to_numpy()) if result is not None else None
        if trend is None:
            unmatched.append(label)
            continue
        ours = np.array([trend.lower, trend.slope, trend.upper])
        theirs = np.array([item["Lower bound"], item["Slope"], item["Upper bound"]], dtype=float)
        diff = float(np.abs(ours - theirs).max())
        compared += 1
        worst = max(worst, diff)
        if diff > EXACT:
            differing.append(label)
    return {
        "rows_in_reference": len(reference),
        "rows_compared": compared,
        "max_abs_diff": worst,
        "differing": differing,
        "not_compared": unmatched,
    }


def _qc_dates(name: str, section: str | None = None) -> set[str]:
    """Dates listed in one of the R tool's QC files (optionally one titled section of it)."""
    lines = (REFERENCE / "qc" / f"{STATION}_{name}.csv").read_text().splitlines()[8:]
    dates: set[str] = set()
    current = None
    for line in lines:
        if line.startswith('"'):
            current = line.strip('"')
            continue
        if section is None or current == section:
            dates.add(str(pd.Timestamp(line.split(",")[0]).date()))
    return dates


def compare_qc(report: QCReport) -> list[dict[str, object]]:
    """Dates flagged by each check against the R tool's QC tables (default thresholds)."""

    def ours(check: str, variable: str | None = None, word: str | None = None) -> set[str]:
        return {
            str(finding.date.date())
            for finding in report.result(check).findings
            if (variable is None or finding.variable == variable) and (word is None or finding.detail.startswith(word))
        }

    pairs = [
        ("TX not above TN", "tmaxmin.csv", ours("tmax_lt_tmin"), _qc_dates("tmaxmin")),
        ("Too large (precipitation > 200 mm, |temperature| > 50)", "toolarge.csv", ours("out_of_bounds") | ours("negative_precip"), _qc_dates("toolarge")),
        ("TX jumps of 20 degC or more", "tx_jumps.csv", ours("temperature_jump", "tasmax"), _qc_dates("tx_jumps")),
        ("TN jumps of 20 degC or more", "tn_jumps.csv", ours("temperature_jump", "tasmin"), _qc_dates("tn_jumps")),
        ("TX repeated values", "tx_flatline.csv", ours("flatline", "tasmax"), _qc_dates("tx_flatline")),
        ("TN repeated values", "tn_flatline.csv", ours("flatline", "tasmin"), _qc_dates("tn_flatline")),
        ("Duplicate dates", "duplicates.csv", ours("duplicate_dates"), _qc_dates("duplicates")),
        ("Outliers: precipitation, high", "outliers.csv [Prec up]", ours("iqr_outliers", "pr", "above"), _qc_dates("outliers", "Prec up")),
        ("Outliers: TX, high", "outliers.csv [TX up]", ours("iqr_outliers", "tasmax", "above"), _qc_dates("outliers", "TX up")),
        ("Outliers: TX, low", "outliers.csv [TX low]", ours("iqr_outliers", "tasmax", "below"), _qc_dates("outliers", "TX low")),
        ("Outliers: TN, high", "outliers.csv [TN up]", ours("iqr_outliers", "tasmin", "above"), _qc_dates("outliers", "TN up")),
        ("Outliers: TN, low", "outliers.csv [TN low]", ours("iqr_outliers", "tasmin", "below"), _qc_dates("outliers", "TN low")),
        ("Outliers: daily range, high", "outliers.csv [DTR up]", ours("iqr_outliers", "dtr", "above"), _qc_dates("outliers", "DTR up")),
        ("Outliers: daily range, low", "outliers.csv [DTR low]", ours("iqr_outliers", "dtr", "below"), _qc_dates("outliers", "DTR low")),
    ]  # fmt: skip
    rows = [
        {
            "check": title,
            "reference_file": file,
            "ours": len(mine),
            "reference": len(theirs),
            "same_dates": mine == theirs,
        }
        for title, file, mine, theirs in pairs
    ]
    reference = pd.read_csv(REFERENCE / "qc" / f"{STATION}_nastatistics.csv", skiprows=7).set_index("Year")
    table = report.missing_by_year
    same = bool((table[["pr", "tasmax", "tasmin"]].to_numpy() == reference[["Prec", "TX", "TN"]].to_numpy()).all())
    rows.append({
        "check": "Missing days per year (80 years x 3 variables)",
        "reference_file": "nastatistics.csv",
        "ours": int(table.to_numpy().sum()),
        "reference": int(reference.to_numpy().sum()),
        "same_dates": same,
    })  # fmt: skip
    return rows


@contextlib.contextmanager
def alternative_quantile_arithmetic() -> Iterator[None]:
    """Temporarily evaluate the type-8 quantile as ``low + g (high - low)`` (same formula, other order)."""
    original = thresholds.quantile_type8

    def quantile(sample: np.ndarray, q: float, min_fraction: float = 0.0) -> np.ndarray:
        ordered = np.sort(sample, axis=0)
        n = np.sum(np.isfinite(sample), axis=0)
        position = np.clip((n + 1 / 3) * q + 1 / 3, 1, np.maximum(n, 1)) - 1
        below = np.floor(position).astype(np.int64)
        above = np.minimum(below + 1, np.maximum(n - 1, 0))
        low = np.take_along_axis(ordered, below[None, ...], axis=0)[0]
        high = np.take_along_axis(ordered, above[None, ...], axis=0)[0]
        result = low + (position - below) * (high - low)
        return np.where((n > 0) & (n >= min_fraction * sample.shape[0]), result, np.nan)

    thresholds.quantile_type8 = quantile
    try:
        yield
    finally:
        thresholds.quantile_type8 = original


PERCENTILE_DAY_INDICES = ("tx90p", "tn90p", "tx10p", "tn10p", "txgt50p")


def _reference_series(index: str, frequency: str) -> pd.Series:
    suffix = {"annual": "ANN", "monthly": "MON"}[frequency]
    return read_index_csv(REFERENCE / "indices" / f"{STATION}_{index}_{suffix}.csv").values()


def tie_sensitivity(dataset: xr.Dataset) -> list[dict[str, object]]:
    """How many monthly percentile values change when the quantile arithmetic is reordered."""
    settings = settings_for(dataset, *BASE_PERIOD)
    with alternative_quantile_arithmetic():
        output = compute_indices(dataset, PERCENTILE_DAY_INDICES, "monthly", settings)
    rows = []
    for result in output.results:
        comparison = compare_values(result.to_series(), _reference_series(result.definition.id, "monthly"))
        rows.append({
            "index": result.definition.id,
            "months_compared": comparison.n_comparable,
            "months_differing": comparison.n_comparable - comparison.n_exact,
            "max_abs_diff": comparison.max_abs_diff,
        })  # fmt: skip
    return rows


def xclim_method(dataset: xr.Dataset) -> list[dict[str, object]]:
    """The same percentile indices with xclim's own thresholds and experimental bootstrap."""
    settings = settings_for(dataset, *BASE_PERIOD, percentile_method="xclim")
    rows = []
    for index in ("tx90p", "tn90p", "tx10p", "tn10p", "wsdi", "csdi"):
        started = clock.perf_counter()
        output = compute_indices(dataset, [index], "annual", settings)
        seconds = clock.perf_counter() - started
        comparison = compare_values(output.results[0].to_series(), _reference_series(index, "annual"))
        rows.append({
            "index": index,
            "seconds": round(seconds, 1),
            "years_compared": comparison.n_comparable,
            "years_exact": comparison.n_exact,
            "years_within_tolerance": comparison.n_within_tolerance,
            "max_abs_diff": comparison.max_abs_diff,
        })  # fmt: skip
    return rows


def xclim_spell_attribution(dataset: xr.Dataset) -> dict[str, object]:
    """CDD with xclim's native year attribution, to quantify why a custom spell rule is used."""
    reference = _reference_series("cdd", "annual")
    rows = {}
    with xclim.set_options(check_missing="skip", as_dataset=False):
        for label, before in (("cut at year end", True), ("spanning, credited to start year", False)):
            days = atmos.dry_spell_max_length(
                dataset["pr"], thresh="1 mm", window=1, freq="YS", resample_before_rl=before
            )
            ours = pd.Series(days.to_numpy(), index=days.indexes["time"].strftime("%Y"))
            comparison = compare_values(ours, reference)
            rows[label] = {
                "years_differing": comparison.n_comparable - comparison.n_exact,
                "max_abs_diff": comparison.max_abs_diff,
            }
    return rows


def timings(dataset: xr.Dataset) -> dict[str, float]:
    settings = settings_for(dataset, *BASE_PERIOD)
    return {
        frequency: round(compute_indices(dataset, frequency=frequency, settings=settings).elapsed_seconds, 2)  # type: ignore[arg-type]
        for frequency in ("annual", "monthly")
    }


def summarise(rows: list[Row]) -> dict[str, int]:
    statuses = [row.status for row in rows]
    return {
        "reference_outputs": len(rows),
        "compared": sum(status != "not yet implemented" for status in statuses),
        "exact": statuses.count("exact"),
        "within_tolerance": statuses.count("within tolerance"),
        "differing": statuses.count("differs"),
        "not_yet_implemented": statuses.count("not yet implemented"),
    }


def summary_line(summary: dict[str, int]) -> str:
    return (
        f"{summary['compared']} index outputs compared (of {summary['reference_outputs']} in the reference): "
        f"{summary['exact']} exact, {summary['within_tolerance']} within tolerance, {summary['differing']} differing; "
        f"{summary['not_yet_implemented']} not yet implemented."
    )


def headline(report: dict[str, object]) -> str:
    """The claim of the report: the default case and the variant cases, stated separately."""
    line = "Default case: " + summary_line(report["summary"])  # type: ignore[arg-type]
    variants = report.get("variants") or []
    if variants:
        totals = variant_totals(variants)  # type: ignore[arg-type]
        line += f" {len(variants)} variant cases together: " + summary_line(totals)  # type: ignore[arg-type]
    return line


def write_status(rows: list[Row]) -> None:
    """Record which index outputs were compared and agree, for the API's ``validated`` flag."""
    status: dict[str, dict[str, str]] = {}
    for row in rows:
        if row.index in REGISTRY and row.frequency in ("annual", "monthly"):
            status.setdefault(row.index, {})[row.frequency] = row.status
    STATUS_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATUS_FILE.write_text(json.dumps(status, indent=1, sort_keys=True) + "\n")


def _row_dict(row: Row) -> dict[str, object]:
    data = asdict(row)
    if row.comparison is not None:
        data["comparison"]["masks_agree"] = row.comparison.masks_agree
    return data


def run(skip_slow: bool = False) -> dict[str, object]:
    parsed = load_sample()
    compute_all(parsed.dataset)  # warm-up: xclim compiles its run-length kernels on first use
    results = compute_all(parsed.dataset)
    rows = compare_inventory(results)
    compared = {(row.index, row.frequency) for row in rows}
    report: dict[str, object] = {
        "generated": pd.Timestamp.now(tz="UTC").strftime("%Y-%m-%d %H:%M UTC"),
        "versions": {
            "climpoc": climpoc.__version__, "xclim": xclim.__version__, "xarray": xr.__version__,
            "numpy": np.__version__, "pandas": pd.__version__, "python": platform.python_version(),
        },
        "reference": "Climpact 3.4.4 (R 4.5.3, climdex.pcic 1.2-0), station batch mode; see baseline/README.md",
        "parameters": {
            "base_period": list(BASE_PERIOD), "latitude": -10, "longitude": 100,
            "missing_policy": "climdex (15 days per year, 3 per month, a missing month makes the year missing)",
        },
        "tolerance": {"exact": EXACT, "tolerance": TOLERANCE},
        "summary": summarise(rows),
        "rows": [_row_dict(row) for row in rows],
        "thresholds": compare_thresholds(parsed),
        "trends": compare_trends(results),
        "qc": compare_qc(run_qc(parsed.records)),
        "timings_seconds": timings(parsed.dataset),
        "registry_without_reference": sorted(
            f"{index} ({frequency})" for index, frequency in results if (index, frequency) not in compared
        ),
    }  # fmt: skip
    if SECOND_ORACLE.exists():
        second = compare_second_oracle(compute_all(load_sample(0.0, 0.0).dataset))
        report["second_oracle"] = {"summary": summarise(second), "rows": [_row_dict(row) for row in second]}
    variants = compare_variants()
    if variants:
        report["variants"] = variants
        report["variant_totals"] = variant_totals(variants)
    report["headline"] = headline(report)
    if not skip_slow:
        report["tie_sensitivity"] = tie_sensitivity(parsed.dataset)
        report["xclim_percentile_method"] = xclim_method(parsed.dataset)
        report["xclim_spell_attribution"] = xclim_spell_attribution(parsed.dataset)
    write_status(rows)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--skip-slow", action="store_true", help="skip the xclim-method and sensitivity sections")
    arguments = parser.parse_args()
    if not SAMPLE.exists() or not REFERENCE.exists():
        raise SystemExit(
            f"Sample or reference files are absent ({SAMPLE}, {REFERENCE}). "
            "Run scripts/fetch_sample.sh and baseline/run.sh first."
        )
    from report import render_markdown

    report = run(arguments.skip_slow)
    (ROOT / "validate" / "validation.json").write_text(json.dumps(report, indent=1) + "\n")
    (ROOT / "VALIDATION.md").write_text(render_markdown(report))
    print(report["headline"])


if __name__ == "__main__":
    main()
