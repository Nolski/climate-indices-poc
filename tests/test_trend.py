"""Trend statistics on series with known answers, and against the R baseline's trend file."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from scipy.stats import norm

from climpoc.indices.engine import compute_indices
from climpoc.indices.settings import settings_for
from climpoc.stats.trend import kendall_s, mann_kendall_p, sen_trend
from conftest import STATION


def test_exact_line() -> None:
    trend = sen_trend(2.0 * np.arange(20) + 3)
    assert trend is not None
    assert (trend.slope, trend.lower, trend.upper, trend.n) == (2.0, 2.0, 2.0, 20)
    assert trend.p_value < 1e-8


def test_monotonic_series_has_textbook_statistics() -> None:
    values = np.arange(10.0)
    assert kendall_s(values) == (45.0, 125.0)  # S = n(n-1)/2, Var = n(n-1)(2n+5)/18
    assert mann_kendall_p(values) == pytest.approx(2 * norm.sf(44 / np.sqrt(125)))


def test_ties_reduce_the_variance() -> None:
    values = np.array([1.0, 1, 1, 2, 2, 3, 4, 5, 6, 7])
    s, variance = kendall_s(values)
    assert s == 41.0
    assert variance == pytest.approx((10 * 9 * 25 - (3 * 2 * 11 + 2 * 1 * 9)) / 18)


def test_constant_series_has_no_trend() -> None:
    trend = sen_trend(np.zeros(30))
    assert trend is not None
    assert (trend.slope, trend.lower, trend.upper, trend.p_value) == (0.0, 0.0, 0.0, 1.0)


def test_slope_is_median_of_pairwise_slopes_and_ignores_missing() -> None:
    values = np.array([1.0, 3, 2, np.nan, 6, 5, 9, 8, 10, 12, 11, 15])
    x = np.arange(len(values), dtype=float)
    valid = np.isfinite(values)
    pairs = [
        (values[j] - values[i]) / (x[j] - x[i])
        for i in np.flatnonzero(valid) for j in np.flatnonzero(valid) if j > i
    ]  # fmt: skip
    trend = sen_trend(values)
    assert trend is not None and trend.n == 11
    assert trend.slope == pytest.approx(np.median(pairs))
    assert trend.lower <= trend.slope <= trend.upper
    assert trend.lower in pairs and trend.upper in pairs


def test_confidence_bounds_use_sen_ranks() -> None:
    values = np.array([4.0, 2, 7, 5, 9, 8, 12, 10, 15, 13])
    slopes = np.sort([(values[j] - values[i]) / (j - i) for i in range(10) for j in range(i + 1, 10)])
    spread = norm.ppf(0.975) * np.sqrt(125)
    trend = sen_trend(values)
    assert trend is not None
    assert trend.lower == slopes[round((45 - spread) / 2) - 1]
    assert trend.upper == slopes[round((45 + spread) / 2) - 1]


def test_too_few_values_give_no_trend() -> None:
    assert sen_trend(np.arange(9.0)) is None
    sparse = np.full(40, np.nan)
    sparse[:20] = np.arange(20.0)
    assert sen_trend(sparse) is None, "20 values but only half of the series"
    assert sen_trend(sparse, min_valid_fraction=0.5) is not None


def test_matches_r_baseline_trend_file(sample, baseline_dir: Path) -> None:
    reference = pd.read_csv(baseline_dir / "trend" / f"{STATION}_trend.csv", skiprows=7)
    reference = reference[reference["Frequency"] == "annual"].set_index("Index")
    indices = ["su", "txx", "dtr", "prcptot", "rx1day", "tx90p", "cdd", "r95p"]
    output = compute_indices(sample.dataset, indices, "annual", settings_for(sample.dataset))
    for result in output.results:
        trend = sen_trend(result.values.to_numpy())
        row = reference.loc[result.definition.id]
        assert trend is not None
        np.testing.assert_allclose(
            [trend.lower, trend.slope, trend.upper], [row["Lower bound"], row["Slope"], row["Upper bound"]],
            rtol=0, atol=1e-9, err_msg=result.definition.id,
        )  # fmt: skip
