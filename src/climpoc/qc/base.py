"""Common types for quality-control checks: settings, findings, results and the check registry."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass
from typing import Literal

import pandas as pd

Severity = Literal["error", "warning", "info"]
TEMPERATURES: tuple[str, ...] = ("tasmax", "tasmin")


@dataclass(frozen=True)
class QCSettings:
    """Thresholds for every check. Defaults follow the R tool where it has the same check."""

    tmax_tmin_inclusive: bool = True
    """Flag days with tmax equal to tmin as well as tmax below tmin (the R tool flags both)."""
    max_precip_mm: float = 200.0
    max_abs_temperature: float = 50.0
    iqr_factor_temperature: float = 3.0
    iqr_factor_precip: float = 5.0
    climatology_sd: float = 4.0
    """N: flag temperatures further than N standard deviations from the day-of-year mean."""
    climatology_window_days: int = 5
    max_temperature_jump: float = 20.0
    flatline_min_repeats: int = 5
    """Flag a value repeated on at least this many following days (so N + 1 equal values)."""
    rounding_digit_share: float = 0.4
    """Flag a year when one final decimal digit holds more than this share of its values."""
    rounding_min_values: int = 60
    max_missing_days_per_month: int = 3
    max_missing_days_per_year: int = 15

    def as_dict(self) -> dict[str, float | int | bool]:
        return asdict(self)


@dataclass(frozen=True)
class Finding:
    """One flagged value. ``date`` is the day concerned (first day of the period for summaries)."""

    date: pd.Timestamp
    variable: str
    value: float | None
    detail: str = ""


@dataclass(frozen=True)
class CheckResult:
    id: str
    title: str
    severity: Severity
    description: str
    findings: tuple[Finding, ...]

    @property
    def count(self) -> int:
        return len(self.findings)


CheckFunction = Callable[[pd.DataFrame, QCSettings], list[Finding]]
Describe = Callable[[QCSettings], str]


@dataclass(frozen=True)
class QCCheck:
    """A registered check. ``run`` receives the rows as written (columns date, pr, tasmax, tasmin)."""

    id: str
    title: str
    severity: Severity
    describe: Describe
    run: CheckFunction

    def __call__(self, records: pd.DataFrame, settings: QCSettings) -> CheckResult:
        findings = tuple(self.run(records, settings))
        return CheckResult(self.id, self.title, self.severity, self.describe(settings), findings)


REGISTRY: dict[str, QCCheck] = {}


def register(
    check_id: str, title: str, severity: Severity, describe: Describe
) -> Callable[[CheckFunction], CheckFunction]:
    """Decorator that adds a check function to the registry under ``check_id``."""

    def decorator(function: CheckFunction) -> CheckFunction:
        if check_id in REGISTRY:
            raise ValueError(f"QC check '{check_id}' is registered twice")
        REGISTRY[check_id] = QCCheck(check_id, title, severity, describe, function)
        return function

    return decorator


def findings_where(records: pd.DataFrame, mask: pd.Series, variable: str, detail: str = "") -> list[Finding]:
    """Build one finding per flagged row of ``variable``."""
    flagged = records.loc[mask.fillna(False).to_numpy(bool), ["date", variable]]
    return [
        Finding(date, variable, None if pd.isna(value) else float(value), detail)
        for date, value in zip(flagged["date"], flagged[variable], strict=True)
    ]


def consecutive_days(records: pd.DataFrame) -> pd.Series:
    """True where a row is exactly one day after the previous row."""
    return records["date"].diff().dt.days.eq(1)
