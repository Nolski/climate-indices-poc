"""Bundle of all exports: Climpact-style CSV per index, tidy CSV, NetCDF, trends, QC and a README."""

from __future__ import annotations

import datetime as dt
import io
import json
import platform
import zipfile
from collections.abc import Sequence
from pathlib import Path

import xclim

import climpoc
from climpoc.export import climpact_csv, netcdf, tables, tidy
from climpoc.export.station import StationInfo
from climpoc.indices.engine import ComputeOutput
from climpoc.qc import QCReport

README_TEMPLATE = """\
Climate indices for station: {station}
Generated {now} by climpoc {version} (xclim {xclim}, Python {python}).
{disclaimer}
climpoc is free software under the GNU General Public License, version 3 or later:
https://github.com/Nolski/climate-indices-poc

SETTINGS
  Latitude / longitude: {latitude} / {longitude}
  Base period:          {base}
  Hemisphere rule:      {hemisphere}
  Missing-data policy:  {policy}
  Compute settings:     {settings}
  QC thresholds:        {qc_settings}

FILES
  indices/<station>_<index>_ANN.csv, _MON.csv
      One file per index and frequency in the layout of the Climpact R tool: 7 header lines,
      one line of column names, then rows separated by ", ". Missing values are -99.9.
      Columns are "time, <index>, standardised values (using all years)", or "time, val, ymd"
      (value and date of occurrence), or "time, start, duration, end" (dry and wet spells).
      time is YYYY for annual and YYYY-MM for monthly files.
  <station>_indices_<frequency>.csv
      The same values in long format: station, index, name, units, frequency, time, value.
      Missing values are empty.
  <station>_indices_<frequency>.nc
      NetCDF (classic format) with CF-1.11 attributes; one variable per index.
  trend/<station>_trend.csv
      Sen's slope per time step with 95 % confidence bounds, Mann-Kendall p-value and the number
      of values used. No row when fewer than 10 values or less than 70 % of the series are valid.
  qc/<station>_qc_findings.csv
      Every quality-control finding: check, severity, date, variable, value, detail.
  qc/<station>_missing_by_year.csv
      Missing days per year for precipitation (Prec), maximum (TX) and minimum (TN) temperature.

INDICES
{indices}
{skipped}"""


def _index_lines(outputs: Sequence[ComputeOutput]) -> str:
    seen: dict[str, str] = {}
    for output in outputs:
        for result in output.results:
            definition = result.definition
            seen[definition.id] = (
                f"  {definition.id:10s} {definition.name}: {definition.description} [{definition.units}]"
            )
    return "\n".join(seen.values())


def _skipped_lines(outputs: Sequence[ComputeOutput]) -> str:
    lines = [
        f"  {skipped.id} ({output.frequency}): {skipped.reason}" for output in outputs for skipped in output.skipped
    ]
    return "\nNOT COMPUTED\n" + "\n".join(lines) + "\n" if lines else ""


def readme_text(station: StationInfo, outputs: Sequence[ComputeOutput], qc: QCReport | None) -> str:
    settings = outputs[0].settings
    return README_TEMPLATE.format(
        station=station.name,
        now=dt.datetime.now(dt.UTC).strftime("%Y-%m-%d %H:%M UTC"),
        version=climpoc.__version__,
        xclim=xclim.__version__,
        python=platform.python_version(),
        disclaimer=climpoc.DISCLAIMER,
        latitude=station.latitude,
        longitude=station.longitude,
        base=f"{settings.base_start}-{settings.base_end}",
        hemisphere="southern (growing season year July-June)" if settings.southern_hemisphere else "northern",
        policy=json.dumps(outputs[0].policy.describe()),
        settings=json.dumps(settings.as_dict()),
        qc_settings=json.dumps(qc.settings.as_dict()) if qc else "QC not run",
        indices=_index_lines(outputs),
        skipped=_skipped_lines(outputs),
    )


def bundle_files(
    station: StationInfo, outputs: Sequence[ComputeOutput], qc: QCReport | None = None
) -> dict[str, bytes]:
    """All export files as ``{relative path: content}`` for one or more frequencies."""
    if not outputs:
        raise ValueError("Nothing to export: no index results were supplied.")
    stem = station.file_stem
    files: dict[str, bytes] = {"README.txt": readme_text(station, outputs, qc).encode()}
    everything = [result for output in outputs for result in output.results]
    for output in outputs:
        for result in output.results:
            text = climpact_csv.index_csv(result, station, output.settings)
            files[f"indices/{climpact_csv.file_name(station, result)}"] = text.encode()
        if output.results:
            files[f"{stem}_indices_{output.frequency}.csv"] = tidy.tidy_csv(output.results, station).encode()
            files[f"{stem}_indices_{output.frequency}.nc"] = netcdf.to_netcdf_bytes(output, station)
    files[f"trend/{stem}_trend.csv"] = tables.trend_csv(everything).encode()
    if qc is not None:
        files[f"qc/{stem}_qc_findings.csv"] = tables.qc_findings_csv(qc).encode()
        files[f"qc/{stem}_missing_by_year.csv"] = tables.missing_by_year_csv(qc).encode()
    return files


def zip_bytes(files: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def write_directory(files: dict[str, bytes], directory: Path) -> list[Path]:
    """Write the bundle files below ``directory`` (used by the command line, never by the API)."""
    written = []
    for name, content in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        written.append(path)
    return written
