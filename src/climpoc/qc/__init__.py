"""Quality control: a registry of small, independent checks with adjustable thresholds."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

import pandas as pd

from climpoc.qc import checks  # noqa: F401  (registers the built-in checks)
from climpoc.qc.base import REGISTRY, CheckResult, Finding, QCCheck, QCSettings, register
from climpoc.qc.checks.missing import missing_counts

REPORT_ORDER: tuple[str, ...] = (
    "tmax_lt_tmin",
    "negative_precip",
    "out_of_bounds",
    "duplicate_dates",
    "iqr_outliers",
    "climatology_outliers",
    "temperature_jump",
    "flatline",
    "rounding",
    "missing_data",
)
"""Order of the built-in checks in reports; checks registered later follow in registration order."""

__all__ = [
    "REGISTRY",
    "REPORT_ORDER",
    "CheckResult",
    "Finding",
    "QCCheck",
    "QCReport",
    "QCSettings",
    "register",
    "run_qc",
]


@dataclass(frozen=True)
class QCReport:
    """All check results for one station plus missing-day counts per year and per month."""

    settings: QCSettings
    results: tuple[CheckResult, ...]
    missing_by_year: pd.DataFrame
    missing_by_month: pd.DataFrame

    def result(self, check_id: str) -> CheckResult:
        return next(result for result in self.results if result.id == check_id)

    def summary(self) -> dict[str, int]:
        """Number of checks with at least one finding, by severity."""
        counts = {"errors": 0, "warnings": 0, "info": 0}
        keys = {"error": "errors", "warning": "warnings", "info": "info"}
        for result in self.results:
            if result.count:
                counts[keys[result.severity]] += 1
        return counts


def default_checks() -> list[str]:
    """All registered checks: the built-in ones in report order, then any others."""
    return [*REPORT_ORDER, *(check_id for check_id in REGISTRY if check_id not in REPORT_ORDER)]


def run_qc(
    records: pd.DataFrame, settings: QCSettings | None = None, check_ids: Iterable[str] | None = None
) -> QCReport:
    """Run the registered checks (all by default) on station rows with the given thresholds.

    ``records`` has columns ``date``, ``pr``, ``tasmax``, ``tasmin`` (and optionally ``line``),
    one row per row of the input file, missing values as NaN. Re-run with different
    ``settings`` to change thresholds; nothing is cached.
    """
    settings = settings or QCSettings()
    selected = list(check_ids) if check_ids is not None else default_checks()
    unknown = [check_id for check_id in selected if check_id not in REGISTRY]
    if unknown:
        raise KeyError(f"Unknown QC check(s): {', '.join(unknown)}")
    results = tuple(REGISTRY[check_id](records, settings) for check_id in selected)
    return QCReport(settings, results, missing_counts(records, "year"), missing_counts(records, "month"))
