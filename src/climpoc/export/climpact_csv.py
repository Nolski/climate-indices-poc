"""Climpact-style CSV, one file per index and frequency, so existing downstream scripts keep working.

Layout (documented from the R tool's output files): seven quoted header lines, one line of column
names, then rows separated by ``", "``. The missing value is ``-99.9`` in every column, including
dates. Three column layouts exist:

* standard: ``time, <index>, standardised values (using all years)``
* dated (TXx, Rx1day, ...): ``time, val, ymd``
* spell (CDD, CWD): ``time, start, duration, end``
* season (GSL): ``time, start, sl, end``

The sixth header line names this software instead of a Climpact version.
"""

from __future__ import annotations

import datetime as dt
import io
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd
import xclim

import climpoc
from climpoc.export.station import StationInfo, format_number
from climpoc.indices.engine import IndexResult
from climpoc.indices.settings import ComputeSettings

MISSING = "-99.9"
HEADER_LINES = 7
STANDARDISED = "standardised values (using all years)"
SUFFIX = {"annual": "ANN", "monthly": "MON"}


def file_name(station: StationInfo, result: IndexResult) -> str:
    return f"{station.file_stem}_{result.definition.id}_{SUFFIX[result.frequency]}.csv"


def standardise(values: np.ndarray) -> np.ndarray:
    """``(x - mean) / sd`` over all valid values; all NaN when the spread is zero or undefined."""
    valid = values[np.isfinite(values)]
    spread = valid.std(ddof=1) if valid.size > 1 else 0.0
    if not np.isfinite(spread) or spread == 0:
        return np.full(values.shape, np.nan)
    return (values - valid.mean()) / spread


def _number(value: float) -> str:
    return format_number(value) if np.isfinite(value) else MISSING


def _date(value: np.datetime64) -> str:
    return MISSING if np.isnat(value) else str(np.datetime_as_string(value, unit="D"))


def header_lines(
    description: str, station: StationInfo, settings: ComputeSettings, today: dt.date | None = None
) -> list[str]:
    """The seven header lines shared by every file."""
    software = f"climpoc {climpoc.__version__} (xclim {xclim.__version__}); independent proof of concept"
    fields = [
        ("Description", description),
        ("Station", station.name),
        ("Latitude", format_number(station.latitude)),
        ("Longitude", format_number(station.longitude)),
        ("Base_period", f"{settings.base_start}-{settings.base_end}"),
        ("Software_version", software),
        ("Date_of_calculation", (today or dt.date.today()).isoformat()),
    ]
    return [f'"{key}: ","{value}"' for key, value in fields]


def _columns(result: IndexResult) -> tuple[list[str], list[list[str]]]:
    values = result.values.to_numpy()
    layout = result.definition.columns
    if layout == "dated" and "ymd" in result.aux:
        dates = result.aux["ymd"].to_numpy()
        return ["time", "val", "ymd"], [[_number(v), _date(d)] for v, d in zip(values, dates, strict=True)]
    if layout == "spell" and {"start", "end"} <= set(result.aux):
        starts, ends = result.aux["start"].to_numpy(), result.aux["end"].to_numpy()
        rows = [[_date(s), _number(v), _date(e)] for s, v, e in zip(starts, values, ends, strict=True)]
        return ["time", "start", "duration", "end"], rows
    if layout == "season" and {"start", "end"} <= set(result.aux):
        starts, ends = result.aux["start"].to_numpy(), result.aux["end"].to_numpy()
        rows = [[_date(s), _number(v), _date(e)] for s, v, e in zip(starts, values, ends, strict=True)]
        return ["time", "start", "sl", "end"], rows
    scores = standardise(values)
    rows = [[_number(v), _number(s)] for v, s in zip(values, scores, strict=True)]
    return ["time", result.definition.id, STANDARDISED], rows


def index_csv(
    result: IndexResult, station: StationInfo, settings: ComputeSettings, today: dt.date | None = None
) -> str:
    """Render one index as Climpact-style CSV text."""
    period = "Annual" if result.frequency == "annual" else "Monthly"
    description = f"{period} {result.definition.name}: {result.definition.description} [{result.definition.units}]"
    names, rows = _columns(result)
    lines = header_lines(description, station, settings, today)
    lines.append(", ".join(names))
    lines += [", ".join([label, *row]) for label, row in zip(result.labels, rows, strict=True)]
    return "\n".join(lines) + "\n"


@dataclass(frozen=True)
class ClimpactTable:
    """A parsed Climpact-style CSV: header fields and the data with ``-99.9`` read as missing."""

    header: dict[str, str]
    frame: pd.DataFrame

    def value_column(self) -> str:
        """Name of the column that holds the index value in each of the layouts."""
        columns = list(self.frame.columns)
        for name in ("val", "duration", "sl"):
            if name in columns:
                return name
        return columns[1]

    def values(self) -> pd.Series:
        series = pd.to_numeric(self.frame[self.value_column()], errors="coerce")
        return pd.Series(series.to_numpy(), index=self.frame["time"].astype(str).to_numpy())


def read_index_csv(source: str | Path) -> ClimpactTable:
    """Read a Climpact-style index CSV written by the R tool or by :func:`index_csv`.

    ``source`` is a path or the CSV text itself. Handles the two-line column header of the
    heatwave files.
    """
    text = (
        Path(source).read_text(encoding="utf-8") if isinstance(source, Path) or "\n" not in str(source) else str(source)
    )
    lines = text.splitlines()
    header = {}
    for line in lines[:HEADER_LINES]:
        key, _, value = line.partition(",")
        header[key.strip('" :')] = value.strip('"')
    body = lines[HEADER_LINES:]
    names = [name.strip() for name in body[0].split(",")]
    start = 1
    if len(names) == 1 and len(body) > 2 and "," not in body[1]:
        names, start = [names[0], body[1].strip()], 2
    frame = pd.read_csv(
        io.StringIO("\n".join(body[start:])), names=names, sep=r"\s*,\s*", engine="python", dtype=str, quotechar='"'
    )
    return ClimpactTable(header, frame.replace(MISSING, np.nan))
