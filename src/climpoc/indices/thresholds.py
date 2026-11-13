"""Day-of-year percentile thresholds and exceedance rates, climdex-compatible.

Implemented from the published method (Zhang, Hegerl, Zwiers and Kenyon 2005, J. Climate 18,
1641-1651) and the documented climdex.pcic rules:

* thresholds for each of 365 calendar days from a centred window of days pooled over the base
  years; 29 February is left out of the base sample and reuses the threshold of 28 February;
* the window wraps around within the same year at the ends of the year;
* quantiles are Hyndman and Fan type 8 (median-unbiased);
* inside the base period the exceedance rate of each year is the average over replicates in
  which that year is removed and each other base year is duplicated in turn, so that the
  rate is not biased relative to years outside the base period.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from typing import Literal

import numpy as np
import pandas as pd

DAYS = 365
Comparison = Literal[">", "<"]


def calendar_day_index(time: pd.DatetimeIndex) -> np.ndarray:
    """Zero-based day of a 365-day year; 29 February maps to the slot of 28 February."""
    day = time.day_of_year.to_numpy()
    shifted = time.is_leap_year & (day >= 60)
    return np.where(shifted, day - 1, day) - 1


def year_matrix(values: np.ndarray, time: pd.DatetimeIndex, start: int, end: int) -> np.ndarray:
    """Arrange the years ``start``..``end`` as rows of 365 days, dropping 29 February.

    Days outside the record are NaN, so a base period only partly covered by data still works.
    """
    matrix = np.full((end - start + 1, DAYS), np.nan)
    leap_day = (time.month == 2) & (time.day == 29)
    keep = (time.year >= start) & (time.year <= end) & ~leap_day
    matrix[time.year[keep] - start, calendar_day_index(time[keep])] = values[keep]
    return matrix


def quantile_type8(sample: np.ndarray, q: float, min_fraction: float = 0.0) -> np.ndarray:
    """Median-unbiased quantile (Hyndman and Fan type 8, a = b = 1/3) along axis 0, ignoring NaN.

    Returns NaN where the share of non-missing values is below ``min_fraction`` (or zero).

    The position is evaluated as ``a + q (n + 1 - a - b)`` and the result as
    ``(1 - g) x[j] + g x[j + 1]``. Station values are recorded to 0.1 and often equal a threshold
    exactly; whether such a tie counts as an exceedance then depends on the last bit of this
    arithmetic. This order of operations reproduces the R tool's results on such ties; see
    VALIDATION.md, "Ties at the threshold".
    """
    a = b = 1 / 3
    n = np.sum(np.isfinite(sample), axis=0)
    position = np.clip(a + q * (n + 1 - a - b), 1, np.maximum(n, 1)) - 1
    below = np.floor(position).astype(np.int64)
    above = np.minimum(below + 1, np.maximum(n - 1, 0))
    # Only the order statistics at ``below`` and ``above`` are needed; NaN sorts last.
    ordered = np.partition(sample, np.unique(np.concatenate([below.ravel(), above.ravel()])), axis=0)
    weight = position - below
    low = np.take_along_axis(ordered, below[None, ...], axis=0)[0]
    high = np.take_along_axis(ordered, above[None, ...], axis=0)[0]
    result = (1 - weight) * low + weight * high
    enough = (n > 0) & (n >= min_fraction * sample.shape[0])
    return np.where(enough, result, np.nan)


def windowed_years(matrix: np.ndarray, window: int) -> np.ndarray:
    """The ``window`` neighbouring days of each calendar day: shape (window, years, 365).

    Neighbours beyond 1 January or 31 December wrap around within the same year.
    """
    half = window // 2
    return np.stack([np.roll(matrix, -offset, axis=1) for offset in range(-half, half + 1)])


def doy_thresholds(matrix: np.ndarray, q: float, window: int = 5, min_fraction: float = 0.1) -> np.ndarray:
    """Threshold for each of the 365 calendar days from a base-period year matrix."""
    sample = windowed_years(matrix, window).reshape(-1, DAYS)
    return quantile_type8(sample, q, min_fraction)


def _compare(values: np.ndarray, threshold: np.ndarray, comparison: Comparison) -> np.ndarray:
    """Exceedance as 1.0 / 0.0, NaN where the value or the threshold is missing."""
    hit = values > threshold if comparison == ">" else values < threshold
    return np.where(np.isfinite(values) & np.isfinite(threshold), hit.astype(float), np.nan)


def _replicate_thresholds(windowed: np.ndarray, year: int, q: float, min_fraction: float) -> np.ndarray:
    """Thresholds for one in-base year: one row per replicate, shape (years - 1, 365).

    In each replicate the year is removed from the base sample and another base year is used twice.
    """
    width, years, _ = windowed.shape
    others = np.array([other for other in range(years) if other != year])
    replicates = np.repeat(windowed[:, :, None, :], len(others), axis=2)
    replicates[:, year, :, :] = windowed[:, others, :]
    return quantile_type8(replicates.reshape(width * years, len(others), DAYS), q, min_fraction)


def exceedance_rate(
    values: np.ndarray,
    time: pd.DatetimeIndex,
    base: tuple[int, int],
    q: float,
    comparison: Comparison,
    window: int = 5,
    min_fraction: float = 0.1,
    bootstrap: bool = True,
) -> np.ndarray:
    """Daily exceedance rate in [0, 1] against the day-of-year ``q`` quantile of the base period.

    Outside the base period the rate is 0 or 1. Inside it (with ``bootstrap``) it is the mean
    over the leave-one-year-out replicates. NaN where the observation or threshold is missing.
    Base years are processed in parallel threads (numpy releases the interpreter lock).
    """
    start, end = base
    matrix = year_matrix(values, time, start, end)
    day = calendar_day_index(time)
    rate = _compare(values, doy_thresholds(matrix, q, window, min_fraction)[day], comparison)
    if not bootstrap or matrix.shape[0] < 2:
        return rate
    windowed = windowed_years(matrix, window)

    def in_base_rate(row: int) -> tuple[np.ndarray, np.ndarray]:
        in_year = np.flatnonzero(time.year == start + row)
        replicate_thresholds = _replicate_thresholds(windowed, row, q, min_fraction)
        hits = _compare(values[in_year][None, :], replicate_thresholds[:, day[in_year]], comparison)
        return in_year, hits.mean(axis=0)

    with ThreadPoolExecutor(max_workers=min(8, os.cpu_count() or 1)) as pool:
        for in_year, year_rate in pool.map(in_base_rate, range(matrix.shape[0])):
            rate[in_year] = year_rate
    return rate


def daily_thresholds(
    values: np.ndarray,
    time: pd.DatetimeIndex,
    base: tuple[int, int],
    q: float,
    window: int = 5,
    min_fraction: float = 0.1,
) -> np.ndarray:
    """Plain (not bootstrapped) base-period threshold for every day of the record."""
    matrix = year_matrix(values, time, *base)
    return doy_thresholds(matrix, q, window, min_fraction)[calendar_day_index(time)]


def wet_day_quantile(pr: np.ndarray, time: pd.DatetimeIndex, base: tuple[int, int], q: float, wet_day: float) -> float:
    """Single quantile of base-period wet-day precipitation (type 8); NaN without wet days."""
    in_base = (time.year >= base[0]) & (time.year <= base[1])
    wet = pr[in_base & (pr >= wet_day)]
    return float(quantile_type8(wet[:, None], q)[0]) if wet.size else float("nan")
