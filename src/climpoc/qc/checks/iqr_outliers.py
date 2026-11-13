"""Outliers per calendar month by the boxplot (interquartile range) rule.

A value is flagged when it lies further than ``k`` times the interquartile range beyond the
quartiles of all values of the same calendar month. Quartiles are Tukey's hinges, as in a
standard boxplot. Precipitation uses days with rain only and is flagged on the high side only.
Checked variables: precipitation, tmax, tmin and the daily range (tmax - tmin).
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

from climpoc.qc.base import Finding, QCSettings, register


def tukey_hinges(values: np.ndarray) -> tuple[float, float]:
    """Lower and upper hinge of Tukey's five-number summary."""
    ordered = np.sort(values)
    n = len(ordered)
    depth = math.floor((n + 3) / 2) / 2
    positions = (depth, n + 1 - depth)
    lower, upper = (0.5 * (ordered[math.floor(p) - 1] + ordered[math.ceil(p) - 1]) for p in positions)
    return float(lower), float(upper)


def fences(values: np.ndarray, factor: float) -> tuple[float, float]:
    """Lower and upper outlier limits: hinges extended by ``factor`` interquartile ranges."""
    lower, upper = tukey_hinges(values)
    spread = upper - lower
    return lower - factor * spread, upper + factor * spread


def _monthly_outliers(
    records: pd.DataFrame, series: pd.Series, name: str, factor: float, sides: tuple[str, ...]
) -> list[Finding]:
    findings: list[Finding] = []
    months = records["date"].dt.month
    for month in range(1, 13):
        sample = series[(months == month) & series.notna()]
        if len(sample) < 4:
            continue
        low, high = fences(sample.to_numpy(float), factor)
        for side, mask, limit in (("up", sample > high, high), ("low", sample < low, low)):
            if side not in sides:
                continue
            word = "above" if side == "up" else "below"
            findings += [
                Finding(records.at[index, "date"], name, float(value), f"{word} monthly limit {limit:.1f}")
                for index, value in sample[mask].items()
            ]
    return findings


def _describe(settings: QCSettings) -> str:
    return (
        "Values beyond the calendar-month quartiles by more than "
        f"{settings.iqr_factor_temperature:g} interquartile ranges (temperature, daily range) or "
        f"{settings.iqr_factor_precip:g} (precipitation on rain days, high side only)"
    )


@register("iqr_outliers", "Outliers for the calendar month", "warning", _describe)
def iqr_outliers(records: pd.DataFrame, settings: QCSettings) -> list[Finding]:
    rain = records["pr"].where(records["pr"] > 0)
    findings = _monthly_outliers(records, rain, "pr", settings.iqr_factor_precip, ("up",))
    daily_range = records["tasmax"] - records["tasmin"]
    for name, series in (("tasmax", records["tasmax"]), ("tasmin", records["tasmin"]), ("dtr", daily_range)):
        findings += _monthly_outliers(records, series, name, settings.iqr_factor_temperature, ("up", "low"))
    return sorted(findings, key=lambda finding: (finding.date, finding.variable))
