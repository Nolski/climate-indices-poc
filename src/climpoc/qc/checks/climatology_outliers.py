"""Temperatures far from the day-of-year climatology, in standard deviations.

For each calendar day the mean and standard deviation are taken over all years, pooling a
centred window of days. A value is flagged when it lies more than N standard deviations away.
Missing values are ignored and never flagged.

The flagged value is part of the sample it is compared with, so a value can be at most
``(n - 1) / sqrt(n)`` standard deviations from the mean of ``n`` values. With the default
5-day window that is 3.6 for a 3-year record and 4.8 for a 5-year record: short records need a
lower N, and the interquartile-range check is the more robust of the two.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from climpoc.qc.base import TEMPERATURES, Finding, QCSettings, register


def _calendar_day(dates: pd.Series) -> np.ndarray:
    """Day of a 365-day year (1-365); 29 February shares the slot of 28 February."""
    day = dates.dt.day_of_year.to_numpy()
    leap_late = dates.dt.is_leap_year.to_numpy() & (day >= 60)
    return np.where(leap_late, day - 1, day)


def climatology(values: np.ndarray, day: np.ndarray, window: int) -> tuple[np.ndarray, np.ndarray]:
    """Mean and standard deviation per calendar day (index 0 is day 1), pooling ``window`` days."""
    half = window // 2
    mean = np.full(365, np.nan)
    spread = np.full(365, np.nan)
    for target in range(1, 366):
        offsets = (np.arange(target - half, target + half + 1) - 1) % 365 + 1
        sample = values[np.isin(day, offsets) & np.isfinite(values)]
        if len(sample) >= 2:
            mean[target - 1] = sample.mean()
            spread[target - 1] = sample.std(ddof=1)
    return mean, spread


def _describe(settings: QCSettings) -> str:
    return (
        f"Temperatures more than {settings.climatology_sd:g} standard deviations from the mean for "
        f"that calendar day ({settings.climatology_window_days}-day window, all years)"
    )


@register("climatology_outliers", "Far from the seasonal normal", "warning", _describe)
def climatology_outliers(records: pd.DataFrame, settings: QCSettings) -> list[Finding]:
    day = _calendar_day(records["date"])
    findings: list[Finding] = []
    for variable in TEMPERATURES:
        values = records[variable].to_numpy(float)
        mean, spread = climatology(values, day, settings.climatology_window_days)
        with np.errstate(invalid="ignore", divide="ignore"):
            score = (values - mean[day - 1]) / spread[day - 1]
        for position in np.flatnonzero(np.abs(score) > settings.climatology_sd):
            findings.append(
                Finding(
                    records["date"].iat[position],
                    variable,
                    float(values[position]),
                    f"{score[position]:+.1f} SD from the calendar-day mean {mean[day[position] - 1]:.1f}",
                )
            )
    return sorted(findings, key=lambda finding: (finding.date, finding.variable))
