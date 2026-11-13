"""CSV tables that accompany the index files: trend summary and quality-control results."""

from __future__ import annotations

import csv
import io
from collections.abc import Iterable

from climpoc.export.payload import result_trend
from climpoc.export.station import format_number
from climpoc.indices.engine import IndexResult
from climpoc.qc import QCReport

TREND_COLUMNS = ("Index", "Frequency", "StartYear", "EndYear", "Lower bound", "Slope", "Upper bound", "p_value", "n")
QC_COLUMNS = ("check", "severity", "date", "variable", "value", "detail")
MISSING_COLUMNS = ("Year", "Prec", "TX", "TN")


def _csv(header: Iterable[str], rows: Iterable[Iterable[object]]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(header)
    writer.writerows(rows)
    return buffer.getvalue()


def trend_csv(results: Iterable[IndexResult]) -> str:
    """Sen's slope per time step with 95 % bounds, as in the R tool's trend file, plus p-value and n."""
    rows = []
    for result in results:
        trend = result_trend(result)
        if trend is None:
            continue
        years = result.values.indexes["time"].year
        numbers = [format_number(x) for x in (trend.lower, trend.slope, trend.upper, trend.p_value)]
        rows.append([result.definition.id, result.frequency, years.min(), years.max(), *numbers, trend.n])
    return _csv(TREND_COLUMNS, rows)


def qc_findings_csv(report: QCReport) -> str:
    """Every quality-control finding as one row (not capped)."""
    rows = [
        [
            result.id,
            result.severity,
            f"{finding.date:%Y-%m-%d}",
            finding.variable,
            format_number(finding.value),
            finding.detail,
        ]
        for result in report.results
        for finding in result.findings
    ]
    return _csv(QC_COLUMNS, rows)


def missing_by_year_csv(report: QCReport) -> str:
    """Missing days per year, in the R tool's column order (Year, Prec, TX, TN)."""
    table = report.missing_by_year
    rows = [[year, row.pr, row.tasmax, row.tasmin] for year, row in zip(table.index, table.itertuples(), strict=True)]
    return _csv(MISSING_COLUMNS, rows)
