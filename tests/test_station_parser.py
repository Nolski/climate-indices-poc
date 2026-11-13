"""Station file parser: accepted layouts and one test per error path."""

from __future__ import annotations

import warnings

import numpy as np
import pytest
import xclim
from xclim.indicators import atmos

from climpoc.io.station import (
    MAX_REPORTED_ISSUES,
    StationFileError,
    StationMeta,
    decode_station_bytes,
    parse_station_text,
    read_station_file,
)
from conftest import synthetic_text

GOOD = "1990 1 1 0.3 23.7 18.7\n1990 1 2 -99.9 24.1 17.7\n1990 1 3 0 25 -99.9\n"


def issues(text: str, **kwargs: object) -> list[tuple[str, int | None]]:
    with pytest.raises(StationFileError) as caught:
        parse_station_text(text, **kwargs)  # type: ignore[arg-type]
    return [(issue.code, issue.line) for issue in caught.value.issues]


def test_happy_path_values_and_missing_code() -> None:
    parsed = parse_station_text(GOOD, StationMeta("abc", -10.0, 100.0))
    dataset = parsed.dataset
    assert dataset.sizes["time"] == 3
    assert dataset["pr"].to_numpy()[0] == 0.3
    assert np.isnan(dataset["pr"].to_numpy()[1])
    assert np.isnan(dataset["tasmin"].to_numpy()[2])
    assert float(dataset["lat"]) == -10.0
    assert dataset.attrs["station_name"] == "abc"
    assert parsed.notes == ()


def test_cf_attributes() -> None:
    dataset = parse_station_text(GOOD).dataset
    assert dataset.attrs["Conventions"].startswith("CF-")
    assert dataset["tasmax"].attrs == {
        "units": "degC", "standard_name": "air_temperature",
        "long_name": "Daily maximum temperature", "cell_methods": "time: maximum",
    }  # fmt: skip
    assert dataset["pr"].attrs["standard_name"] == "precipitation_flux"
    assert dataset["time"].attrs["standard_name"] == "time"


def test_xclim_accepts_dataset_without_warnings() -> None:
    dataset = parse_station_text(synthetic_text("2000-01-01", "2001-12-31")).dataset
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        with xclim.set_options(check_missing="skip", as_dataset=False):
            atmos.tx_max(dataset["tasmax"], freq="YS")
            atmos.wetdays(dataset["pr"], thresh="10 mm/day", freq="YS")
            atmos.daily_temperature_range(dataset["tasmin"], dataset["tasmax"], freq="YS")


@pytest.mark.parametrize(
    "text",
    [
        "1990,1,1,0.3,23.7,18.7\n1990,1,2,0,24.1,17.7\n",
        "1990, 1, 1, 0.3, 23.7, 18.7\n1990, 1, 2, 0, 24.1, 17.7\n",
        "1990\t1\t1\t0.3\t23.7\t18.7\n1990\t1\t2\t0\t24.1\t17.7\n",
        "1990;1;1;0,3;23,7;18,7\n1990;1;2;0;24,1;17,7\n",
        "1990 1 1 0,3 23,7 18,7\n1990 1 2 0 24,1 17,7\n",
        "﻿1990 1 1 0.3 23.7 18.7\r\n\r\n1990 1 2 0 24.1 17.7\r\n",
    ],
    ids=["comma", "comma-space", "tab", "semicolon-decimal-comma", "space-decimal-comma", "bom-crlf-blank-lines"],
)
def test_delimiters_and_decimal_commas(text: str) -> None:
    dataset = parse_station_text(text).dataset
    assert dataset["pr"].to_numpy().tolist() == [0.3, 0.0]
    assert dataset["tasmin"].to_numpy().tolist() == [18.7, 17.7]


def test_header_line_is_skipped_with_a_note() -> None:
    parsed = parse_station_text("year month day prcp tmax tmin\n" + GOOD)
    assert parsed.dataset.sizes["time"] == 3
    assert [note.code for note in parsed.notes] == ["header_skipped"]


def test_wrong_column_count_names_the_line() -> None:
    with pytest.raises(StationFileError) as caught:
        parse_station_text("1990 1 1 0 20 10\n1990 1 2 0 20\n")
    issue = caught.value.issues[0]
    assert (issue.code, issue.line) == ("wrong_column_count", 2)
    assert "expected 6 columns" in issue.message and "found 5" in issue.message
    assert "1 problem found" in str(caught.value)


def test_non_numeric_value_explains_missing_code() -> None:
    with pytest.raises(StationFileError) as caught:
        parse_station_text("1990 1 1 0 20 10\n1990 1 2 NA 20 10\n")
    issue = caught.value.issues[0]
    assert (issue.code, issue.line) == ("non_numeric_value", 2)
    assert "precipitation is 'NA'" in issue.message and "-99.9" in issue.message


def test_blank_field_in_comma_file() -> None:
    assert issues("1990,1,1,0,20,10\n1990,1,2,0,20,\n") == [("non_numeric_value", 2)]


def test_non_numeric_date_part() -> None:
    assert issues("1990 1 1 0 20 10\n1990 Jan 2 0 20 10\n") == [("non_numeric_date", 2)]


def test_impossible_date() -> None:
    with pytest.raises(StationFileError) as caught:
        parse_station_text("1990 2 28 0 20 10\n1990 2 30 0 20 10\n")
    assert caught.value.issues[0].code == "impossible_date"
    assert "1990-02-30 is not a valid calendar date" in caught.value.issues[0].message


def test_29_february_only_in_leap_years() -> None:
    assert parse_station_text("1992 2 28 0 20 10\n1992 2 29 0 20 10\n").dataset.sizes["time"] == 2
    assert issues("1990 2 28 0 20 10\n1990 2 29 0 20 10\n") == [("impossible_date", 2)]


def test_two_digit_year_is_rejected() -> None:
    assert issues("90 1 1 0 20 10\n") == [("bad_year", 1)]


def test_duplicate_date_names_both_lines() -> None:
    with pytest.raises(StationFileError) as caught:
        parse_station_text("1990 1 1 0 20 10\n1990 1 2 0 20 10\n1990 1 2 1 21 11\n")
    issue = caught.value.issues[0]
    assert (issue.code, issue.line) == ("duplicate_date", 3)
    assert "already appears on line 2" in issue.message


def test_out_of_order_date() -> None:
    assert issues("1990 1 2 0 20 10\n1990 1 1 0 20 10\n") == [("out_of_order", 2)]


def test_gap_reports_number_of_absent_days() -> None:
    with pytest.raises(StationFileError) as caught:
        parse_station_text("1990 1 1 0 20 10\n1990 1 5 0 20 10\n")
    issue = caught.value.issues[0]
    assert (issue.code, issue.line) == ("date_gap", 2)
    assert "3 days are absent" in issue.message


def test_empty_file() -> None:
    assert issues("\n\n# only a comment\n") == [("empty_file", None)]


def test_binary_upload_is_rejected() -> None:
    with pytest.raises(StationFileError) as caught:
        decode_station_bytes(b"PK\x03\x04\x00\x00binary")
    assert caught.value.issues[0].code == "not_text"


def test_latin1_bytes_are_decoded() -> None:
    assert decode_station_bytes("# café\n".encode("latin-1")).startswith("# caf")


def test_many_errors_are_capped_but_counted() -> None:
    text = "\n".join("1990 1 1 0 20" for _ in range(MAX_REPORTED_ISSUES + 25))
    with pytest.raises(StationFileError) as caught:
        parse_station_text(text)
    assert len(caught.value.issues) == MAX_REPORTED_ISSUES
    assert caught.value.total == MAX_REPORTED_ISSUES + 25
    assert f"first {MAX_REPORTED_ISSUES} shown" in str(caught.value)


def test_latitude_out_of_range() -> None:
    assert issues(GOOD, meta=StationMeta("x", 123.0, 0.0)) == [("bad_latitude", None)]


def test_repair_mode_sorts_deduplicates_and_fills() -> None:
    text = "1990 1 1 0 20 10\n1990 1 3 0 22 12\n1990 1 2 0 21 11\n1990 1 2 9 99 99\n1990 1 6 0 23 13\n"
    parsed = parse_station_text(text, chronology="repair")
    dataset = parsed.dataset
    assert dataset.sizes["time"] == 6
    assert dataset["tasmax"].to_numpy()[1] == 21.0
    assert np.isnan(dataset["tasmax"].to_numpy()[3:5]).all()
    assert sorted(note.code for note in parsed.notes) == ["date_gap", "date_gap", "duplicate_date", "out_of_order"]
    assert len(parsed.records) == 5


def test_read_station_file_uses_file_name(tmp_path) -> None:
    path = tmp_path / "my_station.txt"
    path.write_text(GOOD)
    assert read_station_file(path).dataset.attrs["station_name"] == "my_station"


def test_sample_file(sample) -> None:
    dataset = sample.dataset
    assert dataset.sizes["time"] == 29220
    assert {name: int(dataset[name].isnull().sum()) for name in ("pr", "tasmax", "tasmin")} == {
        "pr": 7, "tasmax": 58, "tasmin": 58,
    }  # fmt: skip
