"""Compute engine: run registry recipes and apply units, missing-data policy and labels uniformly."""

from __future__ import annotations

import time as clock
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field

import numpy as np
import pandas as pd
import xarray as xr
from xclim.core.units import convert_units_to

from climpoc.indices.missing import ClimdexPolicy, MissingPolicy
from climpoc.indices.recipes import Computed, Context, NotComputable
from climpoc.indices.registry import IndexDef, definitions_for, get
from climpoc.indices.settings import XARRAY_FREQ, ComputeSettings, Frequency, settings_for

# Unit strings xclim may return for each target unit when no numeric conversion is needed.
# A 1-day maximum rate in mm/day is the same number as the amount in mm.
_EQUIVALENT_UNITS: dict[str, frozenset[str]] = {
    "days": frozenset({"days", "d"}),
    "mm": frozenset({"mm", "mm/day", "mm d-1"}),
    "mm/day": frozenset({"mm/day", "mm d-1"}),
    "%": frozenset({"%"}),
    "degC": frozenset({"degC"}),
    "degree-days": frozenset({"K days", "K d", "d K", "degC days", "degC d"}),
}


MIN_RECORD_DAYS = 28


@dataclass(frozen=True)
class IndexResult:
    """One index at one frequency. ``values`` is NaN where the period is missing.

    The ``time`` axis holds period starts: 1 January for annual values (also for growing-season
    years, which are labelled by their first calendar year) and the first of the month otherwise.
    """

    definition: IndexDef
    frequency: Frequency
    values: xr.DataArray
    aux: Mapping[str, xr.DataArray] = field(default_factory=dict)

    @property
    def labels(self) -> list[str]:
        pattern = "%Y" if self.frequency == "annual" else "%Y-%m"
        return list(self.values.indexes["time"].strftime(pattern))

    def to_series(self) -> pd.Series:
        return pd.Series(self.values.to_numpy(), index=self.labels, name=self.definition.id)


@dataclass(frozen=True)
class Skipped:
    id: str
    reason: str


@dataclass(frozen=True)
class ComputeOutput:
    frequency: Frequency
    settings: ComputeSettings
    policy: MissingPolicy
    results: tuple[IndexResult, ...]
    skipped: tuple[Skipped, ...]
    elapsed_seconds: float

    def result(self, index_id: str) -> IndexResult:
        return next(result for result in self.results if result.definition.id == index_id)


def compute_indices(
    dataset: xr.Dataset,
    index_ids: Iterable[str] | None = None,
    frequency: Frequency = "annual",
    settings: ComputeSettings | None = None,
    policy: MissingPolicy | None = None,
) -> ComputeOutput:
    """Compute the requested indices (all by default) for a station dataset.

    Indices that cannot be computed (not offered at this frequency, an input without data, a
    base period without data) are returned in ``skipped`` with a plain-language reason.
    Unknown identifiers raise ``KeyError``.
    """
    started = clock.perf_counter()
    settings = settings or settings_for(dataset)
    policy = policy or ClimdexPolicy()
    available = definitions_for(settings.parameters)
    if index_ids is None:
        definitions = list(available.values())
    else:
        definitions = [get(index_id, settings.parameters) for index_id in index_ids]
    context = Context(dataset, settings)
    cache: MaskCache = {}
    results: list[IndexResult] = []
    skipped: list[Skipped] = []
    for definition in definitions:
        reason = _skip_reason(definition, dataset, frequency)
        if reason is None:
            try:
                results.append(_compute_one(definition, context, frequency, policy, cache))
                continue
            except NotComputable as error:
                reason = str(error)
        skipped.append(Skipped(definition.id, reason))
    elapsed = clock.perf_counter() - started
    return ComputeOutput(frequency, settings, policy, tuple(results), tuple(skipped), elapsed)


def _skip_reason(definition: IndexDef, dataset: xr.Dataset, frequency: Frequency) -> str | None:
    if frequency not in definition.frequencies:
        return f"not available at {frequency} frequency"
    if dataset.sizes["time"] < MIN_RECORD_DAYS:
        return f"the record has only {dataset.sizes['time']} days; at least {MIN_RECORD_DAYS} are needed"
    empty = [name for name in definition.inputs if not bool(dataset[name].notnull().any())]
    if empty:
        return f"requires {' and '.join(empty)}, which has no values in this file"
    return None


def _compute_one(
    definition: IndexDef, context: Context, frequency: Frequency, policy: MissingPolicy, cache: MaskCache
) -> IndexResult:
    freq = XARRAY_FREQ[frequency]
    computed = definition.recipe.compute(context, freq)
    values = _harmonise_units(computed.values, definition.units).astype(float)
    missing = _missing_periods(definition, computed, context.dataset, freq, policy, cache)
    missing = missing.reindex(time=values.indexes["time"], fill_value=True)
    values = values.where(~missing)
    axis = _period_axis(context.time, frequency)
    values = _relabel(values, frequency).reindex(time=axis)
    aux = {
        name: _relabel(array, frequency).reindex(time=axis).where(values.notnull())
        for name, array in computed.aux.items()
    }
    return IndexResult(definition, frequency, _with_metadata(values, definition), aux)


def _harmonise_units(values: xr.DataArray, target: str) -> xr.DataArray:
    """Convert kelvin to degC; otherwise only accept units known to be equivalent to ``target``."""
    units = str(values.attrs.get("units", ""))
    if target == "degC" and units == "K":
        if "difference" in str(values.attrs.get("units_metadata", "")):
            return values.assign_attrs(units="degC")
        return convert_units_to(values, "degC")
    if units not in _EQUIVALENT_UNITS[target]:
        raise RuntimeError(f"Unexpected units '{units}' where '{target}' was expected")
    return values.assign_attrs(units=target)


def _pad_to_whole_periods(presence: xr.DataArray, freq: str) -> xr.DataArray:
    """Extend the daily series to whole periods; days outside the record count as missing."""
    time = presence.indexes["time"]
    offset = pd.tseries.frequencies.to_offset(freq)
    start = offset.rollback(time[0])
    end = offset.rollforward(time[-1] + pd.Timedelta(days=1)) - pd.Timedelta(days=1)
    return presence.reindex(time=pd.date_range(start, end, freq="D"), fill_value=False)


MaskCache = dict[tuple[tuple[str, ...], str], xr.DataArray]


def _missing_periods(
    definition: IndexDef, computed: Computed, dataset: xr.Dataset, freq: str, policy: MissingPolicy, cache: MaskCache
) -> xr.DataArray:
    """Missing periods for one index. Masks based on input variables are shared between indices."""
    period_freq = computed.period_freq or freq
    if computed.presence is not None:
        return policy.period_is_missing(_pad_to_whole_periods(computed.presence, period_freq), period_freq)
    key = (definition.inputs, period_freq)
    if key not in cache:
        present = np.logical_and.reduce([dataset[name].notnull().to_numpy() for name in definition.inputs])
        presence = xr.DataArray(present, coords={"time": dataset["time"]}, dims="time")
        cache[key] = policy.period_is_missing(_pad_to_whole_periods(presence, period_freq), period_freq)
    return cache[key]


def _relabel(array: xr.DataArray, frequency: Frequency) -> xr.DataArray:
    """Label annual periods by 1 January of the year in which they start."""
    if frequency != "annual":
        return array
    years = array.indexes["time"].year
    return array.assign_coords(time=pd.to_datetime({"year": years, "month": 1, "day": 1}).to_numpy())


def _period_axis(time: pd.DatetimeIndex, frequency: Frequency) -> pd.DatetimeIndex:
    """Every calendar year (or month) touched by the record."""
    freq = XARRAY_FREQ[frequency]
    start = time[0].replace(day=1) if frequency == "monthly" else time[0].replace(month=1, day=1)
    return pd.date_range(start, time[-1], freq=freq, name="time")


def _with_metadata(values: xr.DataArray, definition: IndexDef) -> xr.DataArray:
    attrs = {
        "long_name": definition.long_name,
        "description": definition.description,
        "units": definition.units,
    }
    if definition.cell_methods:
        attrs["cell_methods"] = definition.cell_methods
    data = np.asarray(values.to_numpy(), dtype=np.float64)
    return xr.DataArray(data, coords={"time": values.indexes["time"]}, dims="time", name=definition.id, attrs=attrs)
