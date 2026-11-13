"""Missing-data policies: which months and years are too incomplete to report an index.

A policy receives a daily boolean series (``True`` where every input of the index is present)
and returns, for each output period, whether the period must be reported as missing.
xclim's own missing-value checks are switched off; the chosen policy is applied to every index.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import xarray as xr


class MissingPolicy(Protocol):
    """Interface of a missing-data policy."""

    id: str

    def period_is_missing(self, present: xr.DataArray, freq: str) -> xr.DataArray:
        """Return a boolean array, one value per ``freq`` period, true where missing."""
        ...

    def describe(self) -> dict[str, object]:
        """Identifier and parameters, for reports and exports."""
        ...


def _resample_sum(daily: xr.DataArray, freq: str) -> xr.DataArray:
    """Sum a daily series per period (pandas resampling, much faster than xarray's for 1-D data)."""
    totals = daily.to_series().resample(freq).sum()
    return xr.DataArray(totals.to_numpy(), coords={"time": totals.index.to_numpy()}, dims="time")


def _missing_days(present: xr.DataArray, freq: str) -> xr.DataArray:
    return _resample_sum((~present).astype(int), freq)


@dataclass(frozen=True)
class ClimdexPolicy:
    """Rule of climdex.pcic and Climpact (default).

    A month is missing with more than ``max_missing_days_per_month`` missing days. A year is
    missing with more than ``max_missing_days_per_year`` missing days, or when any one of its
    months is missing.
    """

    max_missing_days_per_year: int = 15
    max_missing_days_per_month: int = 3
    id: str = "climdex"

    def period_is_missing(self, present: xr.DataArray, freq: str) -> xr.DataArray:
        month_missing = _missing_days(present, "MS") > self.max_missing_days_per_month
        if freq == "MS":
            return month_missing
        too_many_days = _missing_days(present, freq) > self.max_missing_days_per_year
        any_month_missing = _resample_sum(month_missing.astype(int), freq) > 0
        return too_many_days | any_month_missing

    def describe(self) -> dict[str, object]:
        return {
            "id": self.id,
            "max_missing_days_per_year": self.max_missing_days_per_year,
            "max_missing_days_per_month": self.max_missing_days_per_month,
        }


@dataclass(frozen=True)
class AnyMissingPolicy:
    """Strict rule (xclim's default): one missing day makes the whole period missing."""

    id: str = "any"

    def period_is_missing(self, present: xr.DataArray, freq: str) -> xr.DataArray:
        return _missing_days(present, freq) > 0

    def describe(self) -> dict[str, object]:
        return {"id": self.id}


@dataclass(frozen=True)
class FractionPolicy:
    """A period is missing when more than ``max_missing_fraction`` of its days are missing."""

    max_missing_fraction: float = 0.1
    id: str = "fraction"

    def period_is_missing(self, present: xr.DataArray, freq: str) -> xr.DataArray:
        days = _resample_sum(xr.ones_like(present, dtype=int), freq)
        return _missing_days(present, freq) > self.max_missing_fraction * days

    def describe(self) -> dict[str, object]:
        return {"id": self.id, "max_missing_fraction": self.max_missing_fraction}


POLICIES: dict[str, type] = {"climdex": ClimdexPolicy, "any": AnyMissingPolicy, "fraction": FractionPolicy}


def make_policy(policy_id: str = "climdex", **parameters: float) -> MissingPolicy:
    """Create a policy by identifier, e.g. ``make_policy("climdex", max_missing_days_per_month=5)``."""
    if policy_id not in POLICIES:
        raise KeyError(f"Unknown missing-data policy '{policy_id}'. Available: {', '.join(POLICIES)}.")
    return POLICIES[policy_id](**parameters)
