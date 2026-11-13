"""Quality-control checks on small synthetic inputs, plus the documented facts of the sample."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from climpoc.qc import REGISTRY, REPORT_ORDER, QCSettings, register, run_qc
from climpoc.qc.base import findings_where
from climpoc.qc.checks.iqr_outliers import tukey_hinges
from conftest import daily_station, parse_frame


def records(frame: pd.DataFrame) -> pd.DataFrame:
    return parse_frame(frame).records


def dates(report, check: str, variable: str | None = None) -> list[str]:
    found = report.result(check).findings
    return [f"{f.date:%Y-%m-%d}" for f in found if variable is None or f.variable == variable]


@pytest.fixture
def quiet() -> pd.DataFrame:
    """Three varied but unremarkable years."""
    frame = daily_station("2000-01-01", "2002-12-31")
    rng = np.random.default_rng(1)
    frame["tasmax"] = np.round(20 + rng.normal(0, 2, len(frame)), 1)
    frame["tasmin"] = np.round(10 + rng.normal(0, 2, len(frame)), 1)
    frame["pr"] = np.round(np.where(rng.random(len(frame)) < 0.3, rng.gamma(1.0, 5.0, len(frame)), 0), 1)
    return frame


def test_registry_lists_all_checks(quiet: pd.DataFrame) -> None:
    assert set(REGISTRY) == set(REPORT_ORDER)
    assert [result.id for result in run_qc(records(quiet)).results] == list(REPORT_ORDER)


def test_a_new_check_is_one_registered_function(quiet: pd.DataFrame) -> None:
    @register("hot_days", "Hot days", "info", lambda settings: "Days above 24 degC")
    def hot_days(rows: pd.DataFrame, settings: QCSettings) -> list:
        return findings_where(rows, rows["tasmax"] > 24, "tasmax", "above 24 degC")

    try:
        report = run_qc(records(quiet))
        assert report.results[-1].id == "hot_days" and report.results[-1].count > 0
    finally:
        del REGISTRY["hot_days"]


def test_clean_data_raises_no_errors(quiet: pd.DataFrame) -> None:
    report = run_qc(records(quiet))
    assert report.summary()["errors"] == 0
    assert report.result("tmax_lt_tmin").count == 0


def test_tmax_below_tmin_and_equal(quiet: pd.DataFrame) -> None:
    quiet.loc["2000-03-02", ["tasmax", "tasmin"]] = [12.1, 14.0]
    quiet.loc["2000-03-05", ["tasmax", "tasmin"]] = [12.0, 12.0]
    assert dates(run_qc(records(quiet)), "tmax_lt_tmin") == ["2000-03-02", "2000-03-05"]
    strict = run_qc(records(quiet), QCSettings(tmax_tmin_inclusive=False))
    assert dates(strict, "tmax_lt_tmin") == ["2000-03-02"]
    assert strict.result("tmax_lt_tmin").findings[0].detail == "tmin 14.0"


def test_negative_precipitation(quiet: pd.DataFrame) -> None:
    quiet.loc["2001-06-01", "pr"] = -1.2
    report = run_qc(records(quiet))
    assert dates(report, "negative_precip") == ["2001-06-01"]
    assert report.summary()["errors"] == 1


def test_bounds_are_configurable(quiet: pd.DataFrame) -> None:
    quiet.loc["2000-02-01", "pr"] = 250.0
    quiet.loc["2000-02-02", "tasmax"] = 55.0
    quiet.loc["2000-02-03", "tasmin"] = -60.0
    report = run_qc(records(quiet))
    assert dates(report, "out_of_bounds") == ["2000-02-01", "2000-02-02", "2000-02-03"]
    relaxed = run_qc(records(quiet), QCSettings(max_precip_mm=300, max_abs_temperature=70))
    assert relaxed.result("out_of_bounds").count == 0
    assert "300 mm" in relaxed.result("out_of_bounds").description


def test_duplicate_dates_on_raw_rows(quiet: pd.DataFrame) -> None:
    rows = records(quiet)
    doubled = pd.concat([rows, rows.iloc[[10]]], ignore_index=True)
    report = run_qc(doubled, check_ids=["duplicate_dates"])
    assert dates(report, "duplicate_dates") == ["2000-01-11"]


def test_tukey_hinges_match_textbook_example() -> None:
    assert tukey_hinges(np.array([1.0, 2, 3, 4, 5, 6, 7, 8])) == (2.5, 6.5)
    assert tukey_hinges(np.array([1.0, 2, 3, 4, 5, 6, 7, 8, 9])) == (3.0, 7.0)


def test_iqr_outliers_by_calendar_month(quiet: pd.DataFrame) -> None:
    quiet.loc["2001-07-15", "tasmax"] = 45.0
    quiet.loc["2001-07-20", "pr"] = 400.0
    report = run_qc(records(quiet))
    assert "2001-07-15" in dates(report, "iqr_outliers", "tasmax")
    assert dates(report, "iqr_outliers", "pr") == ["2001-07-20"]
    assert run_qc(records(quiet), QCSettings(iqr_factor_temperature=50)).result("iqr_outliers").count == 1


def test_climatology_outliers_threshold_is_configurable() -> None:
    frame = daily_station("1991-01-01", "2000-12-31")
    frame["tasmax"] = np.round(20 + np.random.default_rng(2).normal(0, 2, len(frame)), 1)
    frame.loc["1995-07-15", "tasmax"] = 36.0
    assert dates(run_qc(records(frame)), "climatology_outliers", "tasmax") == ["1995-07-15"]
    assert run_qc(records(frame), QCSettings(climatology_sd=7)).result("climatology_outliers").count == 0
    assert run_qc(records(frame), QCSettings(climatology_sd=2.5)).result("climatology_outliers").count > 1


def test_climatology_outliers_ignore_missing_values(quiet: pd.DataFrame) -> None:
    quiet.loc["2001-03-01":"2001-03-20", "tasmax"] = np.nan
    assert run_qc(records(quiet)).result("climatology_outliers").count == 0


def test_temperature_jump_flags_first_day_and_skips_gaps(quiet: pd.DataFrame) -> None:
    quiet.loc["2000-05-10", "tasmax"] = 20.0
    quiet.loc["2000-05-11", "tasmax"] = 41.0
    quiet.loc["2000-05-12", "tasmax"] = 22.0
    quiet.loc["2000-08-01", "tasmin"] = np.nan
    report = run_qc(records(quiet))
    assert dates(report, "temperature_jump", "tasmax") == ["2000-05-10"]
    assert dates(run_qc(records(quiet), QCSettings(max_temperature_jump=15)), "temperature_jump", "tasmax") == [
        "2000-05-10", "2000-05-11",
    ]  # fmt: skip
    assert dates(report, "temperature_jump", "tasmin") == []


def test_flatline_needs_more_than_threshold_repeats(quiet: pd.DataFrame) -> None:
    quiet.loc["2000-09-01":"2000-09-06", "tasmax"] = 21.3
    quiet.loc["2000-10-01":"2000-10-05", "tasmin"] = 9.9
    report = run_qc(records(quiet))
    assert dates(report, "flatline") == ["2000-09-01"]
    assert report.result("flatline").findings[0].detail == "6 equal values in a row"
    assert dates(run_qc(records(quiet), QCSettings(flatline_min_repeats=4)), "flatline") == ["2000-09-01", "2000-10-01"]


def test_flatline_ignores_dry_days() -> None:
    assert (
        run_qc(
            records(
                daily_station("2000-01-01", "2000-03-31").assign(
                    tasmax=np.arange(91.0) % 7 + 15, tasmin=np.arange(91.0) % 5
                )
            ),
            check_ids=["flatline"],
        )
        .result("flatline")
        .count
        == 0
    )


def test_rounding_pattern_by_year(quiet: pd.DataFrame) -> None:
    quiet.loc["2001", "tasmax"] = quiet.loc["2001", "tasmax"].round(0)
    report = run_qc(records(quiet))
    findings = [f for f in report.result("rounding").findings if f.variable == "tasmax"]
    assert [f.date.year for f in findings] == [2001]
    assert "end in .0" in findings[0].detail
    assert report.result("rounding").severity == "info"


def test_missing_data_counts_by_year_and_month(quiet: pd.DataFrame) -> None:
    quiet.loc["2000-04-01":"2000-04-04", "tasmax"] = np.nan
    quiet.loc["2001-02-10":"2001-02-12", "pr"] = np.nan
    report = run_qc(records(quiet))
    assert report.missing_by_year.loc[2000, "tasmax"] == 4
    assert report.missing_by_year.loc[2001, "pr"] == 3
    assert report.missing_by_month.loc[(2000, 4), "tasmax"] == 4
    found = report.result("missing_data").findings
    assert [(f"{f.date:%Y-%m}", f.variable) for f in found] == [("2000-04", "tasmax")]
    assert run_qc(records(quiet), QCSettings(max_missing_days_per_month=2)).result("missing_data").count == 2


def test_unknown_check_is_an_error(quiet: pd.DataFrame) -> None:
    with pytest.raises(KeyError, match="Unknown QC check"):
        run_qc(records(quiet), check_ids=["nope"])


def test_sample_matches_documented_r_tool_findings(sample) -> None:
    report = run_qc(sample.records)
    assert dates(report, "tmax_lt_tmin") == ["1988-11-16"]
    assert dates(report, "out_of_bounds") == ["1942-03-28", "1984-11-09", "1986-08-06", "1990-02-03"]
    assert dates(report, "temperature_jump", "tasmax") == ["1946-11-06", "1973-02-06", "2006-01-01", "2013-01-18"]
    assert report.result("duplicate_dates").count == 0
    assert report.result("flatline").count == 0
