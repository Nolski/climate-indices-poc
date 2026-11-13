"""Tidy (long-format) CSV: one row per index, period and value. Missing values are empty cells."""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable

import numpy as np

from climpoc.export.station import StationInfo, format_number
from climpoc.indices.engine import IndexResult

COLUMNS = ("station", "index", "name", "units", "frequency", "time", "value")


def tidy_csv(results: Iterable[IndexResult], station: StationInfo) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(COLUMNS)
    for result in results:
        definition = result.definition
        prefix = [station.name, definition.id, definition.name, definition.units, result.frequency]
        for label, value in zip(result.labels, result.values.to_numpy(), strict=True):
            writer.writerow([*prefix, label, format_number(float(value)) if np.isfinite(value) else ""])
    return buffer.getvalue()
