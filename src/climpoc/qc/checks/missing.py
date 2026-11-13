"""Months and years with more missing days than the index calculation tolerates."""

from __future__ import annotations

import pandas as pd

from climpoc.io.station import VARIABLES
from climpoc.qc.base import Finding, QCSettings, register


def daily_frame(records: pd.DataFrame) -> pd.DataFrame:
    """One row per calendar day from first to last date; absent days count as missing."""
    unique = records.drop_duplicates("date").set_index("date")[list(VARIABLES)].sort_index()
    return unique.reindex(pd.date_range(unique.index[0], unique.index[-1], freq="D"))


def missing_counts(records: pd.DataFrame, by: str) -> pd.DataFrame:
    """Missing days per variable for each ``by`` period (``"year"`` or ``"month"``)."""
    absent = daily_frame(records).isna()
    keys = [absent.index.year] if by == "year" else [absent.index.year, absent.index.month]
    names = ["year"] if by == "year" else ["year", "month"]
    return absent.groupby(keys).sum().rename_axis(names).astype(int)


def _describe(settings: QCSettings) -> str:
    return (
        f"Months with more than {settings.max_missing_days_per_month} missing days and years with more "
        f"than {settings.max_missing_days_per_year}; indices are not calculated for these periods"
    )


@register("missing_data", "Missing data", "info", _describe)
def missing_data(records: pd.DataFrame, settings: QCSettings) -> list[Finding]:
    findings: list[Finding] = []
    by_month = missing_counts(records, "month")
    by_year = missing_counts(records, "year")
    for variable in VARIABLES:
        over = by_month[variable][by_month[variable] > settings.max_missing_days_per_month]
        findings += [
            Finding(
                pd.Timestamp(year=year, month=month, day=1), variable, None, f"{year}-{month:02d}: {count} missing days"
            )
            for (year, month), count in over.items()
        ]
        over_year = by_year[variable][by_year[variable] > settings.max_missing_days_per_year]
        findings += [
            Finding(
                pd.Timestamp(year=year, month=1, day=1), variable, None, f"{year}: {count} missing days in the year"
            )
            for year, count in over_year.items()
        ]
    return sorted(findings, key=lambda finding: (finding.date, finding.variable))
