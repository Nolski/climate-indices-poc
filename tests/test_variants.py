"""Regression tests from the variant cases (cold climate, gaps, other base period, parameters...).

The growing-season tests are hand-checkable versions of what the ``cold`` variant exposed; the
last test compares against the R tool's outputs for every variant that is present on disk
(``baseline/make_variants.py`` and ``baseline/run_variants.sh`` create them).
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from climpoc.cli import main
from climpoc.export.climpact_csv import index_csv, read_index_csv
from climpoc.export.station import StationInfo
from climpoc.indices.engine import compute_indices
from climpoc.indices.registry import definitions_for
from climpoc.indices.seasons import growing_seasons
from climpoc.indices.settings import UserParameters, settings_for
from climpoc.io.station import StationMeta, read_station_file
from conftest import ROOT, daily_station, parse_frame, synthetic_text

VARIANTS = ROOT / "baseline" / "variants"
VARIANT_NAMES = ["north", "base6190", "cold", "gappy", "short", "coldgapnorth", "params"]


def season(frame: pd.DataFrame, southern: bool = False) -> pd.DataFrame:
    mean = ((frame["tasmax"] + frame["tasmin"]) / 2).to_numpy()
    return growing_seasons(mean, pd.DatetimeIndex(frame.index), southern)


@pytest.fixture
def cold_year() -> pd.DataFrame:
    """2001 at a mean of 0 degC, to be warmed up in places."""
    return daily_station("2001-01-01", "2001-12-31", tmax=5.0, tmin=-5.0)


def warm(frame: pd.DataFrame, start: str, end: str, mean: float = 10.0) -> None:
    frame.loc[start:end, ["tasmax", "tasmin"]] = [mean + 5, mean - 5]


def test_season_runs_from_first_warm_span_to_first_cold_span_after_mid_year(cold_year: pd.DataFrame) -> None:
    warm(cold_year, "2001-04-10", "2001-10-19")
    row = season(cold_year).iloc[0]
    assert (str(row["start"])[:10], str(row["end"])[:10]) == ("2001-04-10", "2001-10-20")
    assert row["length"] == 193, "20 October minus 10 April: the first cold day is not counted"


def test_days_at_exactly_the_threshold_belong_to_neither_span(cold_year: pd.DataFrame) -> None:
    """A day of exactly 5 degC inside a cold spell must not end the season early or late."""
    warm(cold_year, "2001-04-10", "2001-12-31")
    cold_year.loc["2001-09-01":"2001-09-05", ["tasmax", "tasmin"]] = [5.0, -5.0]  # 5 cold days
    cold_year.loc["2001-09-06", ["tasmax", "tasmin"]] = [10.0, 0.0]  # exactly 5 degC
    cold_year.loc["2001-09-07":"2001-09-10", ["tasmax", "tasmin"]] = [5.0, -5.0]  # 4 cold days
    cold_year.loc["2001-11-01":"2001-11-06", ["tasmax", "tasmin"]] = [5.0, -5.0]  # a real 6-day cold span
    row = season(cold_year).iloc[0]
    assert str(row["end"])[:10] == "2001-11-01", "the 5 + 1 + 4 days in September are not a 6-day cold span"
    assert row["length"] == 205
    cold_year.loc["2001-05-01", ["tasmax", "tasmin"]] = [10.0, 0.0]
    assert season(cold_year).iloc[0]["length"] == 205, "nor does such a day interrupt anything else"


def test_no_season_when_it_does_not_start_in_the_first_half(cold_year: pd.DataFrame) -> None:
    warm(cold_year, "2001-07-05", "2001-09-30")
    row = season(cold_year).iloc[0]
    assert row["length"] == 0 and pd.isna(row["start"]) and pd.isna(row["end"])


def test_season_that_does_not_end_lasts_to_the_end_of_the_year(cold_year: pd.DataFrame) -> None:
    warm(cold_year, "2001-03-01", "2001-12-31")
    row = season(cold_year).iloc[0]
    assert (row["length"], str(row["end"])[:10]) == (306.0, "2001-12-31")


def test_short_warm_spells_do_not_start_a_season(cold_year: pd.DataFrame) -> None:
    warm(cold_year, "2001-02-01", "2001-02-05")  # 5 days: too short
    warm(cold_year, "2001-05-01", "2001-05-06")  # 6 days: starts the season
    assert str(season(cold_year).iloc[0]["start"])[:10] == "2001-05-01"


def test_southern_year_runs_july_to_june() -> None:
    frame = daily_station("2000-07-01", "2002-06-30", tmax=5.0, tmin=-5.0)
    warm(frame, "2000-10-01", "2001-03-31")
    warm(frame, "2002-02-01", "2002-04-30")  # starts in the second half of the 2001 year: no season
    table = season(frame, southern=True)
    assert [str(index)[:10] for index in table.index] == ["2000-07-01", "2001-07-01"]
    assert table["length"].tolist() == [182.0, 0.0]
    assert str(table["end"].iloc[0])[:10] == "2001-04-01"


def test_growing_season_csv_has_start_and_end_columns(cold_year: pd.DataFrame) -> None:
    warm(cold_year, "2001-04-10", "2001-10-19")
    dataset = parse_frame(cold_year).dataset
    output = compute_indices(dataset, ["gsl"], "annual")
    lines = index_csv(output.results[0], StationInfo.from_dataset(dataset), output.settings).splitlines()
    assert lines[7:9] == ["time, start, sl, end", "2001, 2001-04-10, 193, 2001-10-20"]


def test_user_parameters_name_the_indices() -> None:
    parameters = UserParameters(wsdi_days=5, csdi_days=5, hdd_base=15, cdd_base=22, gdd_base=5.5, rx_days=7, rnn_mm=25)
    ids = set(definitions_for(parameters))
    assert {"wsdi5", "csdi5", "hddheat15", "cddcold22", "gddgrow5.5", "rx7day", "r25mm"} <= ids
    assert not {"wsdi3", "hddheat18", "rx3day", "r30mm"} & ids
    assert len(definitions_for(UserParameters(rx_days=5, rnn_mm=10))) == len(ids) - 2, "rx5day and r10mm exist already"
    with pytest.raises(ValueError, match="wsdi_days must be between 1 and 10"):
        UserParameters(wsdi_days=11)
    with pytest.raises(ValueError, match="rnn_mm must not be negative"):
        UserParameters(rnn_mm=-1)


def test_user_parameters_change_the_results() -> None:
    frame = daily_station("2001-01-01", "2001-12-31", tmax=25.0, tmin=15.0)  # mean 20 degC
    frame.loc["2001-03-01":"2001-03-07", "pr"] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 26.0]
    dataset = parse_frame(frame).dataset
    settings = settings_for(dataset, parameters=UserParameters(hdd_base=22, cdd_base=15, rx_days=7, rnn_mm=25))
    output = compute_indices(dataset, ["hddheat22", "cddcold15", "rx7day", "r25mm"], "annual", settings)
    values = {result.definition.id: result.to_series()["2001"] for result in output.results}
    assert values == {"hddheat22": 730.0, "cddcold15": 1825.0, "rx7day": 47.0, "r25mm": 1.0}
    with pytest.raises(KeyError, match="Unknown index 'rx3day'"):
        compute_indices(dataset, ["rx3day"], "annual", settings)


def test_cli_accepts_user_parameters(tmp_path: Path) -> None:
    station = tmp_path / "s.txt"
    station.write_text(synthetic_text("2000-01-01", "2001-12-31"))
    arguments = ["run", str(station), "--out", str(tmp_path / "o"), "--frequency", "annual"]
    assert main([*arguments, "--indices", "rx7day", "hddheat15", "--rx-days", "7", "--hdd-base", "15"]) == 0
    assert sorted(path.name for path in (tmp_path / "o" / "indices").iterdir()) == [
        "s_hddheat15_ANN.csv",
        "s_rx7day_ANN.csv",
    ]
    with pytest.raises(SystemExit, match="wsdi_days must be between 1 and 10"):
        main([*arguments, "--wsdi-days", "0"])
    with pytest.raises(SystemExit, match="Unknown index"):
        main([*arguments, "--indices", "rx3day", "--rx-days", "7"])


@pytest.mark.parametrize("name", VARIANT_NAMES)
def test_variant_matches_the_r_tool(name: str) -> None:
    """Every implemented annual output of the variant equals the R tool's, apart from the documented
    difference: the missing-data rule of the southern-hemisphere growing season."""
    folder = VARIANTS / name
    case_file = folder / "variant.json"
    if not case_file.exists() or not (folder / "input").exists() or not (folder / "output").exists():
        pytest.skip(f"variant '{name}' absent; run baseline/make_variants.py and baseline/run_variants.sh")
    case = json.loads(case_file.read_text())
    station, metadata = case["station"], case["metadata"]
    meta = StationMeta(station, float(metadata["latitude"]), float(metadata["longitude"]))
    parsed = read_station_file(folder / "input" / f"{station}.txt", meta, chronology="repair")
    parameters = UserParameters.from_climpact_metadata(metadata)
    settings = settings_for(parsed.dataset, case["base_start"], case["base_end"], parameters=parameters)
    output = compute_indices(parsed.dataset, None, "annual", settings)
    assert output.skipped == ()
    southern = float(metadata["latitude"]) <= 0
    for result in output.results:
        index = result.definition.id
        theirs = read_index_csv(folder / "output" / station / "indices" / f"{station}_{index}_ANN.csv").values()
        ours = result.to_series().reindex(theirs.index)
        both = ours.notna() & theirs.notna()
        np.testing.assert_allclose(ours[both].to_numpy(), theirs[both].to_numpy(), rtol=0, atol=1e-9, err_msg=index)
        mask_differs = ours.isna() != theirs.isna()
        if index == "gsl" and southern:
            assert not (mask_differs & ours.notna()).any(), "we never report a year the R tool withholds"
        else:
            assert not mask_differs.any(), f"{index}: missing-value masks differ in {list(ours.index[mask_differs])}"
