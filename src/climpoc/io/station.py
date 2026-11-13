"""Read Climpact-format station text files into a CF-compliant ``xarray.Dataset``.

Format: one row per day, no header, six columns ``year month day precip(mm) tmax(degC) tmin(degC)``,
missing values coded ``-99.9``. Whitespace, tab, comma and semicolon delimiters are accepted, and
decimal commas are accepted when the delimiter is not a comma.

Every problem is reported with its line number and a plain-language explanation of how to fix it.
"""

from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import numpy as np
import pandas as pd
import xarray as xr

MISSING_CODE = -99.9
VARIABLES: tuple[str, ...] = ("pr", "tasmax", "tasmin")
COLUMN_LABELS = {"pr": "precipitation", "tasmax": "tmax", "tasmin": "tmin"}
EXPECTED_COLUMNS = "year month day precip tmax tmin"
MAX_REPORTED_ISSUES = 50
MIN_YEAR, MAX_YEAR = 1700, 2200

Chronology = Literal["strict", "repair"]

_VARIABLE_ATTRS: dict[str, dict[str, str]] = {
    "pr": {
        "units": "mm/day",
        "standard_name": "precipitation_flux",
        "long_name": "Daily precipitation",
        "cell_methods": "time: mean",
    },
    "tasmax": {
        "units": "degC",
        "standard_name": "air_temperature",
        "long_name": "Daily maximum temperature",
        "cell_methods": "time: maximum",
    },
    "tasmin": {
        "units": "degC",
        "standard_name": "air_temperature",
        "long_name": "Daily minimum temperature",
        "cell_methods": "time: minimum",
    },
}


@dataclass(frozen=True)
class ParseIssue:
    """One problem found in a station file. ``line`` is 1-based; ``None`` for whole-file problems."""

    code: str
    message: str
    line: int | None = None

    def as_dict(self) -> dict[str, object]:
        return {"line": self.line, "code": self.code, "message": self.message}


class StationFileError(ValueError):
    """The station file cannot be used. ``issues`` holds up to 50 problems; ``total`` counts all."""

    def __init__(self, issues: list[ParseIssue], total: int | None = None) -> None:
        self.issues = issues
        self.total = total if total is not None else len(issues)
        noun = "problem" if self.total == 1 else "problems"
        shown = "" if self.total == len(issues) else f" (first {len(issues)} shown)"
        super().__init__(f"The station file could not be read: {self.total} {noun} found{shown}.")


@dataclass(frozen=True)
class StationMeta:
    """Station description. Latitude decides hemisphere conventions (growing season year)."""

    name: str = "station"
    latitude: float | None = None
    longitude: float | None = None


@dataclass(frozen=True)
class ParsedStation:
    """Result of parsing: the gap-free dataset, the rows as written, and non-fatal notes."""

    dataset: xr.Dataset
    records: pd.DataFrame
    notes: tuple[ParseIssue, ...] = ()


@dataclass
class _Collector:
    """Accumulates issues, keeping only the first ``MAX_REPORTED_ISSUES`` but counting all."""

    issues: list[ParseIssue] = field(default_factory=list)
    total: int = 0

    def add(self, code: str, message: str, line: int | None = None) -> None:
        self.total += 1
        if len(self.issues) < MAX_REPORTED_ISSUES:
            self.issues.append(ParseIssue(code, message, line))

    def raise_if_any(self) -> None:
        if self.total:
            raise StationFileError(self.issues, self.total)


def decode_station_bytes(data: bytes) -> str:
    """Decode an uploaded file, rejecting binary content with a helpful message."""
    if b"\x00" in data[:4096] or data[:2] == b"PK":
        raise StationFileError(
            [
                ParseIssue(
                    "not_text",
                    "This looks like a binary file (for example an Excel workbook), not plain text. "
                    "Export the data as a text or CSV file with six columns: " + EXPECTED_COLUMNS + ".",
                )
            ]
        )
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return data.decode("latin-1")


def read_station_file(
    path: str | Path, meta: StationMeta | None = None, chronology: Chronology = "strict"
) -> ParsedStation:
    """Read and validate a station file from disk. The station name defaults to the file stem."""
    path = Path(path)
    meta = meta or StationMeta(name=path.stem)
    return parse_station_text(decode_station_bytes(path.read_bytes()), meta, chronology)


def parse_station_text(text: str, meta: StationMeta | None = None, chronology: Chronology = "strict") -> ParsedStation:
    """Parse station text.

    ``chronology="strict"`` (default) rejects duplicated, out-of-order and absent dates.
    ``chronology="repair"`` sorts rows, keeps the first of each duplicated date and fills absent
    days with missing values, reporting each repair in ``notes``.
    """
    meta = meta or StationMeta()
    _validate_meta(meta)
    collector = _Collector()
    notes: list[ParseIssue] = []
    records = _parse_rows(text, collector, notes)
    collector.raise_if_any()
    if records.empty:
        raise StationFileError(
            [ParseIssue("empty_file", "The file contains no data rows. Expected: " + EXPECTED_COLUMNS + ".")]
        )
    chronology_issues = _chronology_issues(records)
    if chronology == "strict":
        for issue in chronology_issues:
            collector.add(issue.code, issue.message, issue.line)
        collector.raise_if_any()
    else:
        notes.extend(chronology_issues)
    return ParsedStation(_to_dataset(_regularise(records), meta), records, tuple(notes))


def _validate_meta(meta: StationMeta) -> None:
    problems = []
    if meta.latitude is not None and not -90 <= meta.latitude <= 90:
        problems.append(ParseIssue("bad_latitude", f"Latitude {meta.latitude} is outside -90 to 90."))
    if meta.longitude is not None and not -180 <= meta.longitude <= 360:
        problems.append(ParseIssue("bad_longitude", f"Longitude {meta.longitude} is outside -180 to 360."))
    if problems:
        raise StationFileError(problems)


def _detect_delimiter(line: str) -> str:
    """Return ``","``, ``";"`` or ``" "`` (any whitespace) for the first data line."""
    if ";" in line:
        return ";"
    if len(line.split(",")) == 6:
        return ","
    return " "


def _split(line: str, delimiter: str) -> list[str]:
    if delimiter == " ":
        return line.split()
    return [token.strip() for token in line.split(delimiter)]


def _looks_like_header(tokens: list[str]) -> bool:
    return bool(tokens) and re.fullmatch(r"[-+]?\d+([.,]\d+)?", tokens[0]) is None


def _parse_rows(text: str, collector: _Collector, notes: list[ParseIssue]) -> pd.DataFrame:
    """Syntax pass: column count, numeric values and real calendar dates, line by line."""
    rows: list[tuple[int, dt.date, float, float, float]] = []
    delimiter: str | None = None
    for number, raw in enumerate(text.lstrip("\ufeff").splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if delimiter is None:
            delimiter = _detect_delimiter(line)
            if _looks_like_header(_split(line, delimiter)):
                notes.append(
                    ParseIssue("header_skipped", f"Line {number} looks like a header and was skipped.", number)
                )
                delimiter = None
                continue
        row = _parse_line(number, _split(line, delimiter), delimiter, collector)
        if row is not None:
            rows.append(row)
    frame = pd.DataFrame(rows, columns=["line", "date", *VARIABLES])
    frame["date"] = pd.to_datetime(frame["date"])
    return frame


def _parse_line(
    number: int, tokens: list[str], delimiter: str, collector: _Collector
) -> tuple[int, dt.date, float, float, float] | None:
    if len(tokens) != 6:
        collector.add(
            "wrong_column_count",
            f"Line {number}: expected 6 columns ({EXPECTED_COLUMNS}) but found {len(tokens)}.",
            number,
        )
        return None
    date = _parse_date(number, tokens[:3], collector)
    values = [
        _parse_value(number, COLUMN_LABELS[name], token, delimiter, collector)
        for name, token in zip(VARIABLES, tokens[3:], strict=True)
    ]
    if date is None or any(value is None for value in values):
        return None
    return (number, date, *values)  # type: ignore[return-value]


def _parse_int(token: str) -> int | None:
    try:
        value = float(token)
    except ValueError:
        return None
    return int(value) if value.is_integer() else None


def _parse_date(number: int, tokens: list[str], collector: _Collector) -> dt.date | None:
    parts = [_parse_int(token) for token in tokens]
    if any(part is None for part in parts):
        bad = next(token for token, part in zip(tokens, parts, strict=True) if part is None)
        collector.add(
            "non_numeric_date",
            f"Line {number}: year, month and day must be whole numbers, but found '{bad}'.",
            number,
        )
        return None
    year, month, day = (int(part) for part in parts if part is not None)
    if not MIN_YEAR <= year <= MAX_YEAR:
        collector.add(
            "bad_year",
            f"Line {number}: year {year} is not plausible; write four-digit years such as 1961.",
            number,
        )
        return None
    try:
        return dt.date(year, month, day)
    except ValueError:
        collector.add(
            "impossible_date",
            f"Line {number}: {year:04d}-{month:02d}-{day:02d} is not a valid calendar date.",
            number,
        )
        return None


def _parse_value(number: int, label: str, token: str, delimiter: str, collector: _Collector) -> float | None:
    """Return the value, NaN for the missing code, or ``None`` after recording an error."""
    text = token.replace(",", ".") if delimiter != "," else token
    try:
        value = float(text)
    except ValueError:
        value = math.nan
    if not math.isfinite(value):
        shown = token if token else "an empty field"
        collector.add(
            "non_numeric_value",
            f"Line {number}: {label} is '{shown}', which is not a number. "
            f"Write missing values as {MISSING_CODE}, not as blanks or text.",
            number,
        )
        return None
    return math.nan if math.isclose(value, MISSING_CODE, abs_tol=1e-9) else value


def _chronology_issues(records: pd.DataFrame) -> list[ParseIssue]:
    """Duplicated, out-of-order and absent dates, each tied to the line where it shows up."""
    issues: list[ParseIssue] = []
    first_line: dict[pd.Timestamp, int] = {}
    previous: pd.Timestamp | None = None
    previous_line = 0
    for line, date in zip(records["line"], records["date"], strict=True):
        if date in first_line:
            issues.append(
                ParseIssue(
                    "duplicate_date",
                    f"Line {line}: the date {date:%Y-%m-%d} already appears on line {first_line[date]}. "
                    "Each day must appear once.",
                    int(line),
                )
            )
            continue
        first_line[date] = int(line)
        if previous is not None:
            step = (date - previous).days
            if step < 0:
                issues.append(
                    ParseIssue(
                        "out_of_order",
                        f"Line {line}: {date:%Y-%m-%d} comes after {previous:%Y-%m-%d} (line {previous_line}) "
                        "but is an earlier date. Rows must be in chronological order.",
                        int(line),
                    )
                )
                continue
            if step > 1:
                issues.append(_gap_issue(int(line), previous, date, previous_line))
        previous, previous_line = date, int(line)
    return issues


def _gap_issue(line: int, previous: pd.Timestamp, date: pd.Timestamp, previous_line: int) -> ParseIssue:
    absent = (date - previous).days - 1
    noun = "day is" if absent == 1 else "days are"
    return ParseIssue(
        "date_gap",
        f"Line {line}: {absent} {noun} absent between {previous:%Y-%m-%d} (line {previous_line}) and "
        f"{date:%Y-%m-%d}. Add a row for every day, using {MISSING_CODE} where there is no observation.",
        line,
    )


def _regularise(records: pd.DataFrame) -> pd.DataFrame:
    """Sort, keep the first row of each date and reindex to a complete daily axis."""
    unique = records.drop_duplicates("date").sort_values("date").set_index("date")[list(VARIABLES)]
    axis = pd.date_range(unique.index[0], unique.index[-1], freq="D", name="time")
    return unique.reindex(axis)


def _to_dataset(daily: pd.DataFrame, meta: StationMeta) -> xr.Dataset:
    dataset = xr.Dataset(
        {name: ("time", daily[name].to_numpy(dtype=np.float64), dict(_VARIABLE_ATTRS[name])) for name in VARIABLES},
        coords={"time": ("time", daily.index.to_numpy(), {"standard_name": "time", "axis": "T"})},
        attrs={"Conventions": "CF-1.11", "featureType": "timeSeries", "station_name": meta.name},
    )
    dataset = dataset.assign_coords(
        station_name=((), meta.name, {"cf_role": "timeseries_id", "long_name": "station name"})
    )
    if meta.latitude is not None:
        dataset = dataset.assign_coords(
            lat=((), float(meta.latitude), {"units": "degrees_north", "standard_name": "latitude"})
        )
    if meta.longitude is not None:
        dataset = dataset.assign_coords(
            lon=((), float(meta.longitude), {"units": "degrees_east", "standard_name": "longitude"})
        )
    return dataset
