"""Suspicious rounding: years in which one final decimal digit dominates.

Readings recorded to a tenth of a unit should use the ten final digits roughly equally. A year
in which, for example, most values end in .0 suggests whole-degree rounding or a unit conversion.
Precipitation is assessed on rain days only.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from climpoc.qc.base import Finding, QCSettings, register


def final_digit_shares(values: np.ndarray) -> np.ndarray:
    """Share of values ending in each tenth digit 0-9 (values are read to one decimal)."""
    digits = np.rint(np.abs(values) * 10).astype(np.int64) % 10
    return np.bincount(digits, minlength=10) / len(values)


def _describe(settings: QCSettings) -> str:
    return (
        f"Years in which one final decimal digit accounts for more than "
        f"{settings.rounding_digit_share:.0%} of values (10% expected)"
    )


@register("rounding", "Rounding pattern", "info", _describe)
def rounding(records: pd.DataFrame, settings: QCSettings) -> list[Finding]:
    years = records["date"].dt.year
    series = {
        "pr": records["pr"].where(records["pr"] > 0),
        "tasmax": records["tasmax"],
        "tasmin": records["tasmin"],
    }
    findings: list[Finding] = []
    for variable, column in series.items():
        for year, sample in column.dropna().groupby(years):
            if len(sample) < settings.rounding_min_values:
                continue
            shares = final_digit_shares(sample.to_numpy(float))
            digit = int(shares.argmax())
            if shares[digit] > settings.rounding_digit_share:
                findings.append(
                    Finding(
                        pd.Timestamp(year=int(year), month=1, day=1),
                        variable,
                        None,
                        f"{year}: {shares[digit]:.0%} of {len(sample)} values end in .{digit}",
                    )
                )
    return sorted(findings, key=lambda finding: (finding.date, finding.variable))
