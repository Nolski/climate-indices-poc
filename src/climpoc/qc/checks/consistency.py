"""Daily maximum temperature not above daily minimum temperature."""

from __future__ import annotations

import pandas as pd

from climpoc.qc.base import Finding, QCSettings, register


def _describe(settings: QCSettings) -> str:
    rule = "lower than or equal to" if settings.tmax_tmin_inclusive else "lower than"
    return f"Days where tmax is {rule} tmin"


@register("tmax_lt_tmin", "Maximum below minimum", "error", _describe)
def tmax_lt_tmin(records: pd.DataFrame, settings: QCSettings) -> list[Finding]:
    difference = records["tasmax"] - records["tasmin"]
    mask = difference <= 0 if settings.tmax_tmin_inclusive else difference < 0
    flagged = records.loc[mask.to_numpy(bool)]
    return [
        Finding(row.date, "tasmax", float(row.tasmax), f"tmin {row.tasmin:.1f}")
        for row in flagged.itertuples(index=False)
    ]
