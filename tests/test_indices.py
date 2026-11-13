"""Index engine: hand-checkable synthetic cases and values of the R baseline."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from climpoc.export.climpact_csv import read_index_csv
from climpoc.indices import thresholds
from climpoc.indices.engine import compute_indices
from climpoc.indices.registry import REGISTRY, all_indices, get
from climpoc.indices.settings import ComputeSettings, is_southern, settings_for
from climpoc.indices.spells import find_spells, longest_spell_by_end_year
from conftest import STATION, daily_station, parse_frame


def one(frame: pd.DataFrame, index: str, frequency: str = "annual", **settings: object) -> pd.Series:
    dataset = parse_frame(frame, settings.pop("latitude", 10.0)).dataset  # type: ignore[arg-type]
    chosen = settings_for(dataset, **settings)  # type: ignore[arg-type]
    return compute_indices(dataset, [index], frequency, chosen).results[0].to_series()  # type: ignore[arg-type]


def reference(baseline_dir: Path, index: str, suffix: str = "ANN") -> pd.Series:
    return read_index_csv(baseline_dir / "indices" / f"{STATION}_{index}_{suffix}.csv").values()


@pytest.fixture
def year() -> pd.DataFrame:
    return daily_station("2001-01-01", "2001-12-31")


def test_registry_is_consistent() -> None:
    assert len(REGISTRY) == len(all_indices())
    for definition in all_indices():
        assert definition.id == definition.id.lower()
        assert set(definition.inputs) <= {"pr", "tasmax", "tasmin"}
        assert "annual" in definition.frequencies
    assert get("TXx").id == "txx"
    with pytest.raises(KeyError, match="Unknown index 'nope'"):
        get("nope")


def test_threshold_counts_use_strict_and_inclusive_comparisons(year: pd.DataFrame) -> None:
    year.loc["2001-01-01":"2001-01-10", "tasmax"] = 25.0  # not above 25
    year.loc["2001-02-01":"2001-02-05", "tasmax"] = 25.1
    year.loc["2001-03-01":"2001-03-03", "tasmax"] = 30.0  # at least 30
    year.loc["2001-07-01":"2001-07-04", "tasmin"] = -0.1
    year.loc["2001-08-01":"2001-08-02", "tasmin"] = 0.0  # not below 0
    assert one(year, "su")["2001"] == 8
    assert one(year, "txge30")["2001"] == 3
    assert one(year, "fd")["2001"] == 4
    assert one(year, "su", "monthly")["2001-02"] == 5


def test_extremes_means_and_dates(year: pd.DataFrame) -> None:
    year.loc["2001-06-15", "tasmax"] = 31.5
    year.loc["2001-06-20", "tasmax"] = 31.5
    year.loc["2001-12-03", "tasmin"] = -4.0
    dataset = parse_frame(year).dataset
    output = compute_indices(dataset, ["txx", "tnn", "dtr", "tmm"], "annual")
    assert output.result("txx").to_series()["2001"] == 31.5
    assert str(output.result("txx").aux["ymd"].to_numpy()[0])[:10] == "2001-06-15", "first of tied dates"
    assert output.result("tnn").to_series()["2001"] == -4.0
    assert str(output.result("tnn").aux["ymd"].to_numpy()[0])[:10] == "2001-12-03"
    assert output.result("dtr").to_series()["2001"] == pytest.approx((365 * 10 + 23 + 14) / 365)
    assert output.result("txx").values.attrs["units"] == "degC"


def test_precipitation_indices(year: pd.DataFrame) -> None:
    year.loc["2001-01-01":"2001-01-04", "pr"] = [0.9, 10.0, 20.0, 5.0]
    year.loc["2001-01-31", "pr"] = 6.0
    year.loc["2001-02-01", "pr"] = 7.0
    assert one(year, "prcptot")["2001"] == pytest.approx(48.0), "days below 1 mm are not counted"
    assert one(year, "r10mm")["2001"] == 2
    assert one(year, "r20mm")["2001"] == 1
    assert one(year, "rx1day")["2001"] == 20.0
    assert one(year, "sdii")["2001"] == pytest.approx(48.0 / 5)
    assert one(year, "rx5day")["2001"] == pytest.approx(35.9)
    months = one(year, "rx5day", "monthly")
    assert months["2001-01"] == pytest.approx(35.9)
    assert months["2001-02"] == pytest.approx(13.0), "centred window: 31 Jan and 1 Feb fall in the window of 1 Feb"


def test_sdii_is_zero_without_wet_days(year: pd.DataFrame) -> None:
    assert one(year, "sdii")["2001"] == 0.0


def test_spells_helper() -> None:
    assert [(s.start, s.end) for s in find_spells(np.array([True, True, False, True]))] == [(0, 1), (3, 3)]


def test_dry_spell_is_credited_to_the_year_it_ends_in() -> None:
    frame = daily_station("2001-01-01", "2003-12-31", pr=5.0)
    frame.loc["2001-12-22":"2002-01-10", "pr"] = 0.0  # 20 dry days across the year end
    frame.loc["2002-06-01":"2002-06-05", "pr"] = 0.0
    dataset = parse_frame(frame).dataset
    result = compute_indices(dataset, ["cdd"], "annual").results[0]
    assert result.to_series().tolist() == [0.0, 20.0, 0.0]
    assert str(result.aux["start"].to_numpy()[1])[:10] == "2001-12-22"
    assert str(result.aux["end"].to_numpy()[1])[:10] == "2002-01-10"
    assert compute_indices(dataset, ["cwd"], "annual").results[0].to_series()["2001"] == 355.0


def test_year_wholly_inside_a_spell_has_no_value() -> None:
    time = pd.date_range("2001-01-01", "2003-12-31", freq="D")
    condition = np.ones(len(time), dtype=bool)
    condition[:10] = False
    condition[-10:] = False
    table = longest_spell_by_end_year(condition, time)
    assert table["length"].tolist()[0] == 0.0
    assert np.isnan(table["length"].tolist()[1])
    assert table["length"].tolist()[2] == len(time) - 20


def test_missing_precipitation_breaks_a_spell() -> None:
    frame = daily_station("2001-01-01", "2001-12-31", pr=5.0)
    frame.loc["2001-03-01":"2001-03-21", "pr"] = 0.0
    frame.loc["2001-03-11", "pr"] = np.nan
    assert one(frame, "cdd")["2001"] == 10.0


def test_calendar_day_index_maps_29_february_to_28() -> None:
    time = pd.DatetimeIndex(["2000-02-28", "2000-02-29", "2000-03-01", "2001-03-01", "2000-12-31"])
    assert thresholds.calendar_day_index(time).tolist() == [58, 58, 59, 59, 364]


def test_quantile_matches_numpy_median_unbiased() -> None:
    sample = np.random.default_rng(3).normal(size=(150, 40))
    sample[sample > 1.2] = np.nan
    ours = thresholds.quantile_type8(sample, 0.9)
    np.testing.assert_allclose(ours, np.nanquantile(sample, 0.9, axis=0, method="median_unbiased"), rtol=0, atol=1e-12)
    assert np.isnan(thresholds.quantile_type8(sample, 0.9, min_fraction=0.99)).all()


def test_bootstrap_matches_a_direct_implementation() -> None:
    """Zhang et al. (2005) written out naively: drop each base year, duplicate each other year in turn."""
    time = pd.date_range("1998-01-01", "2003-12-31", freq="D")
    values = np.random.default_rng(5).normal(size=len(time))  # continuous: no ties at the threshold
    base = (1999, 2002)
    day = thresholds.calendar_day_index(time)
    matrix = thresholds.year_matrix(values, time, *base)
    expected = np.where(values > thresholds.doy_thresholds(matrix, 0.9)[day], 1.0, 0.0)
    for left_out in range(4):
        hits = []
        for duplicated in (year for year in range(4) if year != left_out):
            block = matrix.copy()
            block[left_out] = matrix[duplicated]
            padded = np.concatenate([block[:, -2:], block, block[:, :2]], axis=1)
            limit = np.array([np.quantile(padded[:, d : d + 5], 0.9, method="median_unbiased") for d in range(365)])
            in_year = time.year == base[0] + left_out
            hits.append(values[in_year] > limit[day[in_year]])
        expected[time.year == base[0] + left_out] = np.mean(hits, axis=0)
    rate = thresholds.exceedance_rate(values, time, base, 0.9, ">")
    np.testing.assert_allclose(rate, expected, rtol=0, atol=1e-12)
    plain = thresholds.exceedance_rate(values, time, base, 0.9, ">", bootstrap=False)
    outside = (time.year < base[0]) | (time.year > base[1])
    np.testing.assert_array_equal(plain[outside], rate[outside])
    assert set(np.unique(plain)) == {0.0, 1.0}


def test_percentile_indices_need_base_period_data(year: pd.DataFrame) -> None:
    dataset = parse_frame(year).dataset
    output = compute_indices(dataset, ["tx90p", "r95p", "wsdi", "su"], "annual", ComputeSettings(1971, 2000))
    assert [result.definition.id for result in output.results] == ["su"]
    assert {skipped.id for skipped in output.skipped} == {"tx90p", "r95p", "wsdi"}
    assert "base period 1971-2000 contains 0 days" in output.skipped[0].reason


def test_skips_explain_themselves(year: pd.DataFrame) -> None:
    year["tasmin"] = np.nan
    dataset = parse_frame(year).dataset
    output = compute_indices(dataset, ["tnn", "txx", "sdii"], "monthly")
    reasons = {skipped.id: skipped.reason for skipped in output.skipped}
    assert reasons == {
        "tnn": "requires tasmin, which has no values in this file",
        "sdii": "not available at monthly frequency",
    }
    assert [result.definition.id for result in output.results] == ["txx"]


def test_base_period_must_be_ordered() -> None:
    with pytest.raises(ValueError, match="start year must not be later"):
        ComputeSettings(2000, 1971)


def test_hemisphere_rule() -> None:
    assert is_southern(-10.0) and is_southern(0.0)
    assert not is_southern(0.1) and not is_southern(None)


def test_growing_season_northern_and_southern() -> None:
    frame = daily_station("2001-01-01", "2003-12-31", tmax=6.0, tmin=-4.0)  # mean 1 degC
    warm_north = (frame.index.month >= 4) & (frame.index.month <= 9)
    frame.loc[warm_north, ["tasmax", "tasmin"]] = [20.0, 10.0]
    north = one(frame, "gsl", latitude=45.0)
    assert north["2002"] == 183.0, "1 April to 30 September"
    south = one(frame, "gsl", latitude=-45.0)
    assert np.isnan(south["2003"]), "the last July-June year is incomplete"
    assert south["2001"] == 184.0, "July 2001 to June 2002: the end is only looked for from 1 January"


def test_xclim_percentile_method_runs(synthetic) -> None:
    settings = settings_for(synthetic.dataset, 1991, 2000, percentile_method="xclim")
    ours = compute_indices(synthetic.dataset, ["tx90p"], "annual", settings_for(synthetic.dataset, 1991, 2000))
    theirs = compute_indices(synthetic.dataset, ["tx90p"], "annual", settings)
    difference = (ours.results[0].values - theirs.results[0].values).to_numpy()
    assert np.nanmax(np.abs(difference)) < 3.0, "same definition, different threshold details"


def test_concurrent_computation_is_safe(synthetic) -> None:
    """xclim keeps its options process-wide; simultaneous requests must not disturb each other."""
    settings = settings_for(synthetic.dataset, 1991, 2000)
    ids = ["txx", "su", "dtr", "tmm", "prcptot", "rx5day", "wsdi", "gsl"]

    def work(_: int) -> dict[str, np.ndarray]:
        output = compute_indices(synthetic.dataset, ids, "annual", settings)
        assert output.skipped == ()
        return {result.definition.id: result.values.to_numpy() for result in output.results}

    expected = work(0)
    with ThreadPoolExecutor(max_workers=8) as pool:
        for found in pool.map(work, range(24)):
            for index in ids:
                np.testing.assert_array_equal(found[index], expected[index], err_msg=index)


# --- values of the R baseline ---------------------------------------------------------------


def test_documented_baseline_values(sample) -> None:
    output = compute_indices(sample.dataset, ["su", "txx", "prcptot", "r95p"], "annual", settings_for(sample.dataset))
    assert output.result("su").to_series()["1936"] == 80
    assert output.result("txx").to_series()["1939"] == pytest.approx(45.3)
    assert str(output.result("txx").aux["ymd"].sel(time="1939").to_numpy()[0])[:10] == "1939-01-14"
    assert output.result("prcptot").to_series()["1936"] == pytest.approx(746.9)
    assert output.result("r95p").to_series()["1936"] == pytest.approx(54.9)


@pytest.mark.parametrize(
    ("index", "suffix"),
    [("txx", "ANN"), ("tnn", "MON"), ("su", "ANN"), ("tr", "MON"), ("dtr", "ANN"), ("prcptot", "MON"),
     ("rx5day", "ANN"), ("sdii", "ANN"), ("cdd", "ANN"), ("cwd", "ANN"), ("hddheat18", "ANN"),
     ("tx90p", "ANN"), ("tn10p", "MON"), ("r95p", "ANN"), ("r99ptot", "ANN"), ("wsdi", "ANN"), ("csdi", "ANN")],
)  # fmt: skip
def test_index_matches_r_baseline(sample, baseline_dir: Path, index: str, suffix: str) -> None:
    frequency = {"ANN": "annual", "MON": "monthly"}[suffix]
    ours = compute_indices(sample.dataset, [index], frequency, settings_for(sample.dataset)).results[0].to_series()
    theirs = reference(baseline_dir, index, suffix)
    assert list(ours.index) == list(theirs.index)
    np.testing.assert_array_equal(np.isnan(ours.to_numpy()), np.isnan(theirs.to_numpy()))
    np.testing.assert_allclose(ours.to_numpy(), theirs.to_numpy(), rtol=0, atol=1e-9, equal_nan=True)


def test_growing_season_differs_from_r_baseline_only_in_1996(sample, baseline_dir: Path) -> None:
    ours = compute_indices(sample.dataset, ["gsl"], "annual", settings_for(sample.dataset)).results[0].to_series()
    theirs = reference(baseline_dir, "gsl")
    assert list(ours.index[np.isnan(ours.to_numpy()) != np.isnan(theirs.to_numpy())]) == ["1996"]
    both = ours.notna() & theirs.notna()
    np.testing.assert_array_equal(ours[both].to_numpy(), theirs[both].to_numpy())


def test_all_annual_indices_within_ten_seconds(sample) -> None:
    settings = settings_for(sample.dataset)
    compute_indices(sample.dataset, ["wsdi", "gsl"], "annual", settings)  # compile xclim kernels first
    output = compute_indices(sample.dataset, None, "annual", settings)
    assert len(output.results) == len(REGISTRY)
    assert output.elapsed_seconds < 10
