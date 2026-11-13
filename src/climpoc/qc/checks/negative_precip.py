"""Negative precipitation amounts."""

from __future__ import annotations

import pandas as pd

from climpoc.qc.base import Finding, QCSettings, findings_where, register


@register("negative_precip", "Negative precipitation", "error", lambda _: "Days with precipitation below zero")
def negative_precip(records: pd.DataFrame, settings: QCSettings) -> list[Finding]:
    return findings_where(records, records["pr"] < 0, "pr", "below 0 mm")
