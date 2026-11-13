"""Exports: Climpact-style CSV, tidy CSV, NetCDF and the bundle."""

from __future__ import annotations

import datetime as dt
import io
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import xarray as xr

from climpoc.export import bundle, climpact_csv, netcdf, tables, tidy
from climpoc.export.payload import compute_payload, daily_payload, qc_payload
from climpoc.export.station import StationInfo
from climpoc.indices.engine import ComputeOutput, compute_indices
from climpoc.indices.settings import settings_for
from climpoc.qc import run_qc
from conftest import STATION

INDICES = ["su", "txx", "cdd", "tx90p", "prcptot"]


@pytest.fixture(scope="module")
def output(synthetic) -> ComputeOutput:
    dataset = synthetic.dataset.copy()
    dataset["tasmax"] = dataset["tasmax"].where(dataset["time"].dt.year != 1995)
    return compute_indices(dataset, INDICES, "annual", settings_for(dataset, 1991, 2000))


@pytest.fixture(scope="module")
def station(synthetic) -> StationInfo:
    return StationInfo.from_dataset(synthetic.dataset)


def test_standard_layout_and_missing_code(output: ComputeOutput, station: StationInfo) -> None:
    text = climpact_csv.index_csv(output.result("su"), station, output.settings, dt.date(2026, 1, 2))
    lines = text.splitlines()
    assert lines[0].startswith('"Description: ","Annual SU: ')
    assert lines[1:5] == [
        '"Station: ","synthetic"',
        '"Latitude: ","45"',
        '"Longitude: ","5"',
        '"Base_period: ","1991-2000"',
    ]
    assert lines[5].startswith('"Software_version: ","climpoc ')
    assert lines[6] == '"Date_of_calculation: ","2026-01-02"'
    assert lines[7] == "time, su, standardised values (using all years)"
    assert lines[8].split(", ")[0] == "1990" and len(lines) == 8 + 12
    assert lines[8 + 5] == "1995, -99.9, -99.9"


def test_dated_and_spell_layouts(output: ComputeOutput, station: StationInfo) -> None:
    dated = climpact_csv.index_csv(output.result("txx"), station, output.settings).splitlines()
    assert dated[7] == "time, val, ymd"
    value, date = dated[8].split(", ")[1:]
    assert float(value) > 20 and date.startswith("1990-")
    assert dated[8 + 5] == "1995, -99.9, -99.9"
    spell = climpact_csv.index_csv(output.result("cdd"), station, output.settings).splitlines()
    assert spell[7] == "time, start, duration, end"
    start, duration, end = spell[9].split(", ")[1:]
    assert (pd.Timestamp(end) - pd.Timestamp(start)).days + 1 == int(duration)


def test_csv_round_trip(output: ComputeOutput, station: StationInfo) -> None:
    for index in INDICES:
        result = output.result(index)
        table = climpact_csv.read_index_csv(climpact_csv.index_csv(result, station, output.settings))
        assert table.header["Station"] == "synthetic"
        np.testing.assert_allclose(table.values().to_numpy(), result.values.to_numpy(), rtol=1e-9, equal_nan=True)
        assert list(table.values().index) == result.labels


def test_standardise() -> None:
    scores = climpact_csv.standardise(np.array([1.0, 2.0, 3.0, np.nan]))
    np.testing.assert_allclose(scores[:3], [-1.0, 0.0, 1.0])
    assert np.isnan(scores[3])
    assert np.isnan(climpact_csv.standardise(np.zeros(5))).all(), "no spread: undefined, written as -99.9"


def test_reads_r_tool_files(baseline_dir: Path) -> None:
    table = climpact_csv.read_index_csv(baseline_dir / "indices" / f"{STATION}_su_ANN.csv")
    assert table.header["Climpact_version"] == "3.4.4"
    assert table.values()["1936"] == 80
    assert np.isnan(table.values()["1996"])
    heatwave = climpact_csv.read_index_csv(baseline_dir / "indices" / f"{STATION}_TX90-HWN_ANN.csv")
    assert list(heatwave.frame.columns) == ["time", "HWN"]
    assert climpact_csv.read_index_csv(baseline_dir / "indices" / f"{STATION}_cdd_ANN.csv").value_column() == "duration"


def test_tidy_csv(output: ComputeOutput, station: StationInfo) -> None:
    frame = pd.read_csv(io.StringIO(tidy.tidy_csv(output.results, station)))
    assert list(frame.columns) == list(tidy.COLUMNS)
    assert len(frame) == len(INDICES) * 12
    row = frame[(frame["index"] == "su") & (frame["time"] == 1995)].iloc[0]
    assert pd.isna(row["value"]) and row["units"] == "days" and row["frequency"] == "annual"


def test_netcdf_is_cf_style_and_readable(output: ComputeOutput, station: StationInfo) -> None:
    dataset = xr.open_dataset(io.BytesIO(netcdf.to_netcdf_bytes(output, station)))
    assert dataset.attrs["Conventions"] == "CF-1.11"
    assert dataset.attrs["base_period"] == "1991-2000"
    assert "climdex" in dataset.attrs["missing_data_policy"]
    assert dataset["time"].attrs["bounds"] == "time_bnds"
    assert dataset["txx"].attrs["units"] == "degC" and dataset["txx"].attrs["cell_methods"] == "time: maximum"
    assert float(dataset["lat"]) == 45.0
    np.testing.assert_allclose(dataset["su"].to_numpy(), output.result("su").values.to_numpy(), equal_nan=True)
    assert str(dataset["time"].to_numpy()[0])[:10] == "1990-01-01"


def test_trend_and_qc_tables(output: ComputeOutput, synthetic) -> None:
    trend = pd.read_csv(io.StringIO(tables.trend_csv(output.results)))
    assert list(trend.columns) == list(tables.TREND_COLUMNS)
    assert set(trend["Index"]) == set(INDICES)
    assert (trend["Lower bound"] <= trend["Slope"]).all() and (trend["Slope"] <= trend["Upper bound"]).all()
    report = run_qc(synthetic.records)
    findings = pd.read_csv(io.StringIO(tables.qc_findings_csv(report)))
    assert len(findings) == sum(result.count for result in report.results)
    missing = pd.read_csv(io.StringIO(tables.missing_by_year_csv(report)))
    assert list(missing.columns) == ["Year", "Prec", "TX", "TN"] and len(missing) == 12


def test_bundle_contents(output: ComputeOutput, station: StationInfo, synthetic, tmp_path: Path) -> None:
    files = bundle.bundle_files(station, [output], run_qc(synthetic.records))
    names = set(zipfile.ZipFile(io.BytesIO(bundle.zip_bytes(files))).namelist())
    expected = {f"indices/synthetic_{index}_ANN.csv" for index in INDICES} | {
        "README.txt", "synthetic_indices_annual.csv", "synthetic_indices_annual.nc",
        "trend/synthetic_trend.csv", "qc/synthetic_qc_findings.csv", "qc/synthetic_missing_by_year.csv",
    }  # fmt: skip
    assert names == expected
    readme = files["README.txt"].decode()
    assert "Not affiliated with or endorsed by WMO" in readme
    assert "Base period:          1991-2000" in readme and "xclim" in readme and '"id": "climdex"' in readme
    written = bundle.write_directory(files, tmp_path / "out")
    assert len(written) == len(files) and (tmp_path / "out" / "indices" / "synthetic_su_ANN.csv").exists()


def test_bundle_needs_results(station: StationInfo) -> None:
    with pytest.raises(ValueError, match="Nothing to export"):
        bundle.bundle_files(station, [])


def test_station_file_stem_is_safe() -> None:
    assert StationInfo("../etc/pass wd", None, None).file_stem == "etc_pass_wd"
    assert StationInfo("///", None, None).file_stem == "station"


def test_payloads_use_null_for_missing(output: ComputeOutput, synthetic) -> None:
    body = compute_payload(output, "ds_x")
    su = next(result for result in body["results"] if result["id"] == "su")  # type: ignore[union-attr]
    assert su["values"][5] is None and su["time"][5] == "1995"
    assert su["stats"]["n"] == 11 and su["trend"]["method"] == "sen"
    assert body["missing_policy"] == {"id": "climdex", "max_missing_days_per_year": 15, "max_missing_days_per_month": 3}
    daily = daily_payload(synthetic.dataset, "pr", "1990-01-01", "1990-01-10")
    assert len(daily["time"]) == 10 and daily["units"] == "mm/day"  # type: ignore[arg-type]
    qc = qc_payload(run_qc(synthetic.records), max_records=3)
    assert all(len(check["records"]) <= 3 for check in qc["checks"])  # type: ignore[union-attr]
    assert len(qc["missing_by_year"]) == 12  # type: ignore[arg-type]
