"""Dates that appear more than once in the file."""

from __future__ import annotations

import pandas as pd

from climpoc.qc.base import Finding, QCSettings, register


@register(
    "duplicate_dates",
    "Duplicated dates",
    "error",
    lambda _: "Dates that appear more than once in the file",
)
def duplicate_dates(records: pd.DataFrame, settings: QCSettings) -> list[Finding]:
    repeated = records.loc[records["date"].duplicated(keep="first").to_numpy(bool)]
    lines = repeated["line"] if "line" in repeated else [None] * len(repeated)
    return [
        Finding(date, "date", None, f"repeated on line {line}" if line is not None else "repeated")
        for date, line in zip(repeated["date"], lines, strict=True)
    ]
