"""Missing-data policies, including the climdex rule's month-to-year cascade."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from climpoc.indices.engine import compute_indices
from climpoc.indices.missing import AnyMissingPolicy, ClimdexPolicy, FractionPolicy, make_policy
from conftest import daily_station, parse_frame


def annual(frame: pd.DataFrame, index: str = "txx", policy=None) -> pd.Series:
    return compute_indices(parse_frame(frame).dataset, [index], "annual", policy=policy).results[0].to_series()


def monthly(frame: pd.DataFrame, index: str = "txx", policy=None) -> pd.Series:
    return compute_indices(parse_frame(frame).dataset, [index], "monthly", policy=policy).results[0].to_series()


@pytest.fixture
def two_years() -> pd.DataFrame:
    return daily_station("2001-01-01", "2002-12-31")


def test_three_missing_days_in_a_month_are_tolerated(two_years: pd.DataFrame) -> None:
    two_years.loc["2001-03-01":"2001-03-03", "tasmax"] = np.nan
    assert monthly(two_years).notna().all()
    assert annual(two_years).notna().all()


def test_fourth_missing_day_removes_month_and_year(two_years: pd.DataFrame) -> None:
    two_years.loc["2001-03-01":"2001-03-04", "tasmax"] = np.nan
    months = monthly(two_years)
    assert np.isnan(months["2001-03"])
    assert months.drop("2001-03").notna().all()
    years = annual(two_years)
    assert np.isnan(years["2001"]), "a year is missing when one of its months is missing"
    assert years["2002"] == 20.0


def test_fifteen_missing_days_spread_over_months_are_tolerated(two_years: pd.DataFrame) -> None:
    for month in range(1, 6):
        two_years.loc[f"2001-{month:02d}-10" : f"2001-{month:02d}-12", "tasmax"] = np.nan
    assert two_years.loc["2001", "tasmax"].isna().sum() == 15
    assert annual(two_years).notna().all()


def test_sixteen_missing_days_remove_the_year_but_no_month(two_years: pd.DataFrame) -> None:
    for month in range(1, 6):
        two_years.loc[f"2001-{month:02d}-10" : f"2001-{month:02d}-12", "tasmax"] = np.nan
    two_years.loc["2001-06-10", "tasmax"] = np.nan
    assert monthly(two_years).notna().all()
    years = annual(two_years)
    assert np.isnan(years["2001"]) and years["2002"] == 20.0


def test_mask_follows_the_inputs_of_each_index(two_years: pd.DataFrame) -> None:
    two_years.loc["2001-03-01":"2001-03-10", "tasmin"] = np.nan
    assert annual(two_years, "txx").notna().all(), "tmax index is unaffected by missing tmin"
    assert np.isnan(annual(two_years, "tnn")["2001"])
    assert np.isnan(annual(two_years, "dtr")["2001"]), "an index of both variables needs both"
    assert annual(two_years, "prcptot").notna().all()


def test_days_outside_the_record_count_as_missing() -> None:
    frame = daily_station("2001-03-01", "2002-12-31")
    years = annual(frame)
    assert np.isnan(years["2001"]) and years["2002"] == 20.0
    months = monthly(frame)
    assert months.index[0] == "2001-03" and months.notna().all()


def test_limits_are_configurable(two_years: pd.DataFrame) -> None:
    two_years.loc["2001-03-01":"2001-03-04", "tasmax"] = np.nan
    relaxed = ClimdexPolicy(max_missing_days_per_month=5)
    assert annual(two_years, policy=relaxed).notna().all()
    assert monthly(two_years, policy=relaxed).notna().all()


def test_any_missing_policy_is_strict(two_years: pd.DataFrame) -> None:
    two_years.loc["2001-03-01", "tasmax"] = np.nan
    assert annual(two_years).notna().all()
    assert np.isnan(annual(two_years, policy=AnyMissingPolicy())["2001"])


def test_fraction_policy(two_years: pd.DataFrame) -> None:
    two_years.loc["2001-01-01":"2001-02-15", "tasmax"] = np.nan  # 46 days, 12.6 % of the year
    assert np.isnan(annual(two_years, policy=FractionPolicy(0.1))["2001"])
    assert annual(two_years, policy=FractionPolicy(0.2)).notna().all()


def test_make_policy() -> None:
    assert make_policy().describe() == {
        "id": "climdex",
        "max_missing_days_per_year": 15,
        "max_missing_days_per_month": 3,
    }
    assert make_policy("fraction", max_missing_fraction=0.25).describe() == {
        "id": "fraction",
        "max_missing_fraction": 0.25,
    }
    with pytest.raises(KeyError, match="Unknown missing-data policy"):
        make_policy("nope")


def test_sample_1996_is_missing_because_of_october(sample) -> None:
    """The R tool's documented case: 8 missing tmax days in October 1996, 10 in the year."""
    tasmax = sample.dataset["tasmax"].to_series()
    assert tasmax["1996"].isna().sum() == 10
    assert tasmax["1996-10"].isna().sum() == 8
    years = compute_indices(sample.dataset, ["txx"], "annual").results[0].to_series()
    months = compute_indices(sample.dataset, ["txx"], "monthly").results[0].to_series()
    assert np.isnan(years["1996"]) and years.drop("1996").notna().all()
    assert np.isnan(months["1996-10"]) and months.drop("1996-10").notna().all()


def test_sample_november_2014_precipitation_stays_valid(sample) -> None:
    """Exactly 3 missing precipitation days: at the limit, not over it."""
    assert sample.dataset["pr"].to_series()["2014-11"].isna().sum() == 3
    months = compute_indices(sample.dataset, ["prcptot"], "monthly").results[0].to_series()
    assert np.isfinite(months["2014-11"])
    assert compute_indices(sample.dataset, ["prcptot"], "annual").results[0].to_series().notna().all()
