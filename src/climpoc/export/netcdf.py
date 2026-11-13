"""NetCDF export with CF attributes (written in memory, classic format, no extra dependencies)."""

from __future__ import annotations

import datetime as dt
import json

import numpy as np
import pandas as pd
import xarray as xr
import xclim

import climpoc
from climpoc.export.station import StationInfo
from climpoc.indices.engine import ComputeOutput

# Unit strings accepted by udunits for the units used in the registry.
CF_UNITS = {"degC": "degC", "days": "days", "mm": "mm", "mm/day": "mm d-1", "%": "%", "degree-days": "K d"}


def _time_bounds(time: pd.DatetimeIndex, frequency: str) -> np.ndarray:
    step = pd.DateOffset(years=1) if frequency == "annual" else pd.DateOffset(months=1)
    return np.stack([time.to_numpy(), (time + step).to_numpy()], axis=1)


def to_dataset(output: ComputeOutput, station: StationInfo) -> xr.Dataset:
    """Assemble all results of one frequency into a CF-style dataset on a shared time axis."""
    if not output.results:
        raise ValueError("There are no index results to export.")
    time = output.results[0].values.indexes["time"]
    dataset = xr.Dataset(coords={"time": ("time", time, {"standard_name": "time", "axis": "T", "bounds": "time_bnds"})})
    dataset["time_bnds"] = (("time", "bnds"), _time_bounds(time, output.frequency))
    for result in output.results:
        attrs = dict(result.values.attrs)
        attrs["units"] = CF_UNITS[result.definition.units]
        attrs["coordinates"] = "lat lon station_name"
        dataset[result.definition.id] = ("time", result.values.to_numpy(), attrs)
    dataset = dataset.assign_coords(station_name=((), station.name, {"cf_role": "timeseries_id"}))
    if station.latitude is not None:
        dataset = dataset.assign_coords(
            lat=((), station.latitude, {"units": "degrees_north", "standard_name": "latitude"})
        )
    if station.longitude is not None:
        dataset = dataset.assign_coords(
            lon=((), station.longitude, {"units": "degrees_east", "standard_name": "longitude"})
        )
    now = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    dataset.attrs = {
        "Conventions": "CF-1.11",
        "featureType": "timeSeries",
        "title": f"Climate indices for station {station.name} ({output.frequency})",
        "source": f"climpoc {climpoc.__version__} using xclim {xclim.__version__}",
        "history": f"{now}: indices computed by climpoc {climpoc.__version__}",
        "comment": climpoc.DISCLAIMER,
        "frequency": output.frequency,
        "base_period": f"{output.settings.base_start}-{output.settings.base_end}",
        "missing_data_policy": json.dumps(output.policy.describe()),
        "compute_settings": json.dumps(output.settings.as_dict()),
    }
    return dataset


def to_netcdf_bytes(output: ComputeOutput, station: StationInfo) -> bytes:
    """Serialise to NetCDF bytes without touching the disk."""
    dataset = to_dataset(output, station)
    encoding = {name: {"_FillValue": np.nan} for name in dataset.data_vars if name != "time_bnds"}
    encoding["time"] = {"units": "days since 1850-01-01", "calendar": "standard", "dtype": "float64"}
    encoding["time_bnds"] = {
        "units": "days since 1850-01-01",
        "calendar": "standard",
        "dtype": "float64",
        "_FillValue": None,
    }
    return bytes(dataset.to_netcdf(encoding=encoding))
