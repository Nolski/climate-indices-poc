"""JSON-ready dictionaries for index results (shared by the API, the CLI and the JSON export)."""

from __future__ import annotations

import math

import numpy as np
import xarray as xr

from climpoc.indices.engine import ComputeOutput, IndexResult
from climpoc.io.station import VARIABLES
from climpoc.qc import QCReport
from climpoc.stats.trend import Trend, sen_trend

STEPS_PER_DECADE = {"annual": 10, "monthly": 120}


def clean(value: float | None, digits: int = 4) -> float | None:
    """Round for transport; NaN and infinities become ``None`` (JSON null)."""
    if value is None or not math.isfinite(value):
        return None
    return round(float(value), digits)


def result_trend(result: IndexResult) -> Trend | None:
    return sen_trend(result.values.to_numpy())


def trend_payload(trend: Trend | None, frequency: str) -> dict[str, object] | None:
    if trend is None:
        return None
    scale = STEPS_PER_DECADE[frequency]
    return {
        "method": "sen",
        "slope_per_decade": clean(trend.slope * scale),
        "lower": clean(trend.lower * scale),
        "upper": clean(trend.upper * scale),
        "p_value": clean(trend.p_value, 6),
        "n": trend.n,
    }


def stats_payload(values: np.ndarray) -> dict[str, object]:
    valid = values[np.isfinite(values)]
    if valid.size == 0:
        return {"n": 0, "mean": None, "min": None, "max": None}
    return {"n": int(valid.size), "mean": clean(valid.mean()), "min": clean(valid.min()), "max": clean(valid.max())}


def result_payload(result: IndexResult) -> dict[str, object]:
    values = result.values.to_numpy()
    definition = result.definition
    return {
        "id": definition.id,
        "name": definition.name,
        "long_name": definition.long_name,
        "units": definition.units,
        "time": result.labels,
        "values": [clean(value) for value in values],
        "stats": stats_payload(values),
        "trend": trend_payload(result_trend(result), result.frequency),
    }


def compute_payload(output: ComputeOutput, dataset_id: str) -> dict[str, object]:
    return {
        "dataset_id": dataset_id,
        "frequency": output.frequency,
        "base_period": {"start": output.settings.base_start, "end": output.settings.base_end},
        "missing_policy": output.policy.describe(),
        "elapsed_ms": round(output.elapsed_seconds * 1000),
        "results": [result_payload(result) for result in output.results],
        "skipped": [{"id": skipped.id, "reason": skipped.reason} for skipped in output.skipped],
    }


def qc_payload(report: QCReport, max_records: int = 200) -> dict[str, object]:
    """QC results; each check lists at most ``max_records`` records, ``count`` is the true total."""
    checks = [
        {
            "id": result.id,
            "title": result.title,
            "severity": result.severity,
            "description": result.description,
            "count": result.count,
            "records": [
                {
                    "date": f"{finding.date:%Y-%m-%d}",
                    "variable": finding.variable,
                    "value": clean(finding.value, 2),
                    "detail": finding.detail,
                }
                for finding in result.findings[:max_records]
            ],
        }
        for result in report.results
    ]
    table = report.missing_by_year
    missing = [
        {"year": int(year), "pr": int(row.pr), "tasmax": int(row.tasmax), "tasmin": int(row.tasmin)}
        for year, row in zip(table.index, table.itertuples(), strict=True)
    ]
    return {
        "summary": report.summary(),
        "settings": report.settings.as_dict(),
        "checks": checks,
        "missing_by_year": missing,
    }


def variables_payload(dataset: xr.Dataset) -> dict[str, object]:
    """Units, missing count and range of each daily variable."""
    payload = {}
    for name in VARIABLES:
        values = dataset[name].to_numpy()
        valid = values[np.isfinite(values)]
        payload[name] = {
            "units": str(dataset[name].attrs["units"]),
            "n_missing": int(values.size - valid.size),
            "min": clean(valid.min(), 2) if valid.size else None,
            "max": clean(valid.max(), 2) if valid.size else None,
            "mean": clean(valid.mean(), 2) if valid.size else None,
        }
    return payload


def daily_payload(
    dataset: xr.Dataset, variable: str, start: str | None = None, end: str | None = None
) -> dict[str, object]:
    """One daily variable, optionally limited to ``start``..``end`` (ISO dates, inclusive)."""
    series = dataset[variable].sel(time=slice(start, end))
    return {
        "variable": variable,
        "units": str(series.attrs["units"]),
        "time": list(series.indexes["time"].strftime("%Y-%m-%d")),
        "values": [clean(value, 2) for value in series.to_numpy()],
    }
