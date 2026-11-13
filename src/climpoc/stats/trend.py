"""Trend statistics: Sen's slope with confidence bounds and the Mann-Kendall test.

Implemented from the published methods:

* slope: median of all pairwise slopes (Sen 1968, J. Amer. Statist. Assoc. 63, 1379-1389);
* confidence bounds: the pairwise slopes ranked ``(N - C) / 2`` and ``(N + C) / 2``, where ``N`` is
  the number of pairs and ``C`` the normal quantile times the standard deviation of Kendall's S
  (Sen 1968; Gilbert 1987, "Statistical Methods for Environmental Pollution Monitoring", 16.5);
* p-value: two-sided Mann-Kendall test with the normal approximation, tie-corrected variance and
  continuity correction (Mann 1945; Kendall 1975).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.stats import norm

MIN_VALID = 10
MIN_VALID_FRACTION = 0.7


@dataclass(frozen=True)
class Trend:
    """Slope and bounds are per time step of the series (per year for annual values)."""

    slope: float
    lower: float
    upper: float
    p_value: float
    n: int


def kendall_s(y: np.ndarray) -> tuple[float, float]:
    """Kendall's S statistic and its variance (corrected for ties) for an evenly ordered series."""
    n = len(y)
    upper = np.triu_indices(n, k=1)
    s = float(np.sign(y[upper[1]] - y[upper[0]]).sum())
    _, ties = np.unique(y, return_counts=True)
    variance = (n * (n - 1) * (2 * n + 5) - float(np.sum(ties * (ties - 1) * (2 * ties + 5)))) / 18
    return s, variance


def mann_kendall_p(y: np.ndarray) -> float:
    """Two-sided p-value of the Mann-Kendall trend test; 1.0 for a constant series."""
    s, variance = kendall_s(y)
    if variance <= 0 or s == 0:
        return 1.0
    z = (s - np.sign(s)) / np.sqrt(variance)
    return float(2 * norm.sf(abs(z)))


def pairwise_slopes(x: np.ndarray, y: np.ndarray) -> np.ndarray:
    first, second = np.triu_indices(len(x), k=1)
    return (y[second] - y[first]) / (x[second] - x[first])


def sen_trend(
    values: np.ndarray,
    x: np.ndarray | None = None,
    confidence: float = 0.95,
    min_valid: int = MIN_VALID,
    min_valid_fraction: float = MIN_VALID_FRACTION,
) -> Trend | None:
    """Sen's slope of ``values`` against ``x`` (default: position in the series), ignoring NaN.

    Returns ``None`` when fewer than ``min_valid`` values, or less than ``min_valid_fraction`` of
    the series, are valid (the R tool's rule: 10 values and 70 %).
    """
    values = np.asarray(values, dtype=float)
    x = np.arange(len(values), dtype=float) if x is None else np.asarray(x, dtype=float)
    valid = np.isfinite(values)
    n = int(valid.sum())
    if n < min_valid or n < min_valid_fraction * len(values):
        return None
    slopes = np.sort(pairwise_slopes(x[valid], values[valid]))
    _, variance = kendall_s(values[valid])
    spread = norm.ppf(1 - (1 - confidence) / 2) * np.sqrt(variance)
    count = len(slopes)
    lower_rank = int(np.clip(round((count - spread) / 2), 1, count))
    upper_rank = int(np.clip(round((count + spread) / 2), 1, count))
    return Trend(
        slope=float(np.median(slopes)),
        lower=float(slopes[lower_rank - 1]),
        upper=float(slopes[upper_rank - 1]),
        p_value=mann_kendall_p(values[valid]),
        n=n,
    )
