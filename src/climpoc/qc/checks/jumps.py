"""Large temperature changes from one day to the next."""

from __future__ import annotations

import pandas as pd

from climpoc.qc.base import TEMPERATURES, Finding, QCSettings, consecutive_days, register


def _describe(settings: QCSettings) -> str:
    return f"Change of {settings.max_temperature_jump:g} degC or more to the following day"


@register("temperature_jump", "Large day-to-day jump", "warning", _describe)
def temperature_jump(records: pd.DataFrame, settings: QCSettings) -> list[Finding]:
    """Flag the first day of each pair whose rounded difference reaches the threshold."""
    findings: list[Finding] = []
    next_is_consecutive = consecutive_days(records).shift(-1, fill_value=False)
    for variable in TEMPERATURES:
        change = (records[variable].shift(-1) - records[variable]).round(1)
        mask = (change.abs() >= settings.max_temperature_jump) & next_is_consecutive
        flagged = records.loc[mask.to_numpy(bool), ["date", variable]]
        findings += [
            Finding(date, variable, float(value), f"next day {change.at[index]:+.1f} degC")
            for index, date, value in zip(flagged.index, flagged["date"], flagged[variable], strict=True)
        ]
    return sorted(findings, key=lambda finding: (finding.date, finding.variable))
