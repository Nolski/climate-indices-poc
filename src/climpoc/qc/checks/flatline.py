"""Runs of identical values on consecutive days."""

from __future__ import annotations

import numpy as np
import pandas as pd

from climpoc.qc.base import Finding, QCSettings, consecutive_days, register


def identical_runs(values: np.ndarray, consecutive: np.ndarray) -> list[tuple[int, int]]:
    """Return ``(start, length)`` for every run of equal, non-missing values on consecutive days."""
    same = np.zeros(len(values), dtype=bool)
    same[1:] = np.isclose(values[1:], values[:-1], atol=1e-9) & consecutive[1:]
    runs: list[tuple[int, int]] = []
    start = 0
    for position in range(1, len(values) + 1):
        if position == len(values) or not same[position]:
            if position - start > 1:
                runs.append((start, position - start))
            start = position
    return runs


def _describe(settings: QCSettings) -> str:
    return (
        f"The same value on {settings.flatline_min_repeats + 1} or more consecutive days "
        "(temperature; precipitation on rain days only)"
    )


@register("flatline", "Repeated identical values", "warning", _describe)
def flatline(records: pd.DataFrame, settings: QCSettings) -> list[Finding]:
    consecutive = consecutive_days(records).to_numpy(bool)
    series = {
        "tasmax": records["tasmax"],
        "tasmin": records["tasmin"],
        "pr": records["pr"].where(records["pr"] > 0),
    }
    findings: list[Finding] = []
    for variable, column in series.items():
        values = column.to_numpy(float)
        for start, length in identical_runs(values, consecutive):
            if length > settings.flatline_min_repeats:
                findings.append(
                    Finding(
                        records["date"].iat[start], variable, float(values[start]), f"{length} equal values in a row"
                    )
                )
    return sorted(findings, key=lambda finding: (finding.date, finding.variable))
