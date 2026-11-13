"""Values outside plausible physical bounds."""

from __future__ import annotations

import pandas as pd

from climpoc.qc.base import TEMPERATURES, Finding, QCSettings, findings_where, register


def _describe(settings: QCSettings) -> str:
    return (
        f"Precipitation above {settings.max_precip_mm:g} mm or temperature beyond "
        f"+/-{settings.max_abs_temperature:g} degC"
    )


@register("out_of_bounds", "Outside plausible bounds", "warning", _describe)
def out_of_bounds(records: pd.DataFrame, settings: QCSettings) -> list[Finding]:
    findings = findings_where(
        records, records["pr"] > settings.max_precip_mm, "pr", f"above {settings.max_precip_mm:g} mm"
    )
    for variable in TEMPERATURES:
        mask = records[variable].abs() > settings.max_abs_temperature
        findings += findings_where(records, mask, variable, f"beyond +/-{settings.max_abs_temperature:g} degC")
    return sorted(findings, key=lambda finding: finding.date)
