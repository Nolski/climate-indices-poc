"""Recipes: the small set of ways an index is computed.

Each registry entry names one recipe and its parameters. A recipe turns the station dataset into
one value per period; units, missing-data masking and labelling are applied afterwards by the
engine, identically for every index.
"""

from __future__ import annotations

import contextlib
import operator
import threading
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from functools import cached_property
from typing import Literal, Protocol

import numpy as np
import pandas as pd
import xarray as xr
import xclim
from xclim.compute import run_length
from xclim.core.calendar import percentile_doy
from xclim.indicators import atmos, convert

from climpoc.indices import thresholds
from climpoc.indices.seasons import growing_seasons
from climpoc.indices.settings import ComputeSettings
from climpoc.indices.spells import longest_spell_by_end_year

XCLIM_OPTIONS = {"check_missing": "skip", "as_dataset": False}
_XCLIM_LOCK = threading.RLock()


@contextlib.contextmanager
def xclim_options() -> Iterator[None]:
    """Apply this package's xclim options for the duration of one xclim call.

    xclim keeps its options in one process-wide dictionary, so a ``set_options`` block in one
    thread changes what every other thread sees, and leaving the block resets it under them.
    The web server computes requests in worker threads; the lock makes each block atomic.
    """
    with _XCLIM_LOCK, xclim.set_options(**XCLIM_OPTIONS):
        yield


Comparison = Literal[">", "<"]


class NotComputable(Exception):
    """The index cannot be computed for this dataset; the message says why in plain language."""


@dataclass(frozen=True)
class Computed:
    """Raw recipe output.

    ``values`` has one value per period on a ``time`` axis of period starts. ``aux`` holds extra
    columns such as dates of occurrence. ``presence`` (daily booleans) overrides the default
    "all inputs present" basis of the missing-data mask; ``period_freq`` overrides the period
    used for the mask (growing-season years that start in July).
    """

    values: xr.DataArray
    aux: Mapping[str, xr.DataArray] = field(default_factory=dict)
    presence: xr.DataArray | None = None
    period_freq: str | None = None


class Context:
    """Station data plus settings, with derived series computed once and shared by recipes."""

    def __init__(self, dataset: xr.Dataset, settings: ComputeSettings) -> None:
        self.dataset = dataset
        self.settings = settings
        self._cache: dict[tuple[object, ...], np.ndarray] = {}

    @cached_property
    def time(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(self.dataset["time"].to_numpy())

    @cached_property
    def tas(self) -> xr.DataArray:
        """Daily mean temperature, (tmax + tmin) / 2."""
        with xclim_options():
            return convert.mean_temperature_from_max_and_min(self.dataset["tasmin"], self.dataset["tasmax"])

    @property
    def base(self) -> tuple[int, int]:
        return (self.settings.base_start, self.settings.base_end)

    def variable(self, name: str) -> xr.DataArray:
        return self.tas if name == "tas" else self.dataset[name]

    def base_slice(self, name: str) -> xr.DataArray:
        start, end = self.base
        return self.variable(name).sel(time=slice(str(start), str(end)))

    def require_base_data(self, name: str) -> None:
        """Percentile thresholds need at least one year of observations in the base period."""
        valid = int(self.base_slice(name).notnull().sum())
        if valid < 365:
            start, end = self.base
            raise NotComputable(
                f"the base period {start}-{end} contains {valid} days of {name}; at least one year is needed"
            )

    def exceedance_rate(self, name: str, q: float, comparison: Comparison) -> np.ndarray:
        """Daily bootstrapped exceedance rate (cached)."""
        key = ("rate", name, q, comparison)
        if key not in self._cache:
            self._cache[key] = thresholds.exceedance_rate(
                self.variable(name).to_numpy(),
                self.time,
                self.base,
                q,
                comparison,
                self.settings.percentile_window,
                self.settings.min_base_fraction,
            )
        return self._cache[key]

    def daily_threshold(self, name: str, q: float) -> np.ndarray:
        """Plain base-period threshold for each day of the record (cached)."""
        key = ("threshold", name, q)
        if key not in self._cache:
            self._cache[key] = thresholds.daily_thresholds(
                self.variable(name).to_numpy(),
                self.time,
                self.base,
                q,
                self.settings.percentile_window,
                self.settings.min_base_fraction,
            )
        return self._cache[key]

    def daily(self, values: np.ndarray) -> xr.DataArray:
        """Wrap a numpy array as a daily series on the record's time axis."""
        return xr.DataArray(values, coords={"time": self.dataset["time"]}, dims="time")


class Recipe(Protocol):
    def compute(self, context: Context, freq: str) -> Computed: ...


def _indicator(path: str) -> xclim.core.indicator.Indicator:
    module, name = path.split(".")
    return getattr({"atmos": atmos, "convert": convert}[module], name)


def _occurrence_dates(series: xr.DataArray, freq: str, kind: Literal["max", "min"]) -> xr.DataArray:
    """Date of the first maximum (or minimum) of ``series`` within each period.

    Values are rounded to six decimals first, so that equal running totals that differ only by
    floating-point noise are treated as ties and the earliest date is reported.
    """
    valid = series.to_series().dropna().round(6)
    period = valid.index.to_period(freq[0])
    grouped = valid.groupby(period)
    dates = grouped.idxmax() if kind == "max" else grouped.idxmin()
    index = pd.DatetimeIndex(dates.index.to_timestamp(), name="time")
    return xr.DataArray(dates.to_numpy().astype("datetime64[s]"), coords={"time": index}, dims="time")


@dataclass(frozen=True)
class XclimIndicator:
    """Call one xclim indicator.

    ``inputs`` maps indicator arguments to station variables (``tas`` is the derived daily mean).
    ``fill_missing_input`` replaces missing input days before the call (the R tool treats missing
    precipitation as zero inside running totals). ``empty_value`` replaces an undefined result
    (the R tool reports an intensity of 0 for a period without wet days). ``occurrence`` adds the
    date of the period's maximum or minimum.
    """

    indicator: str
    inputs: Mapping[str, str]
    params: Mapping[str, object] = field(default_factory=dict)
    fill_missing_input: float | None = None
    empty_value: float | None = None
    occurrence: Literal["max", "min"] | None = None

    def _arguments(self, context: Context) -> dict[str, xr.DataArray]:
        arguments = {argument: context.variable(name) for argument, name in self.inputs.items()}
        if self.fill_missing_input is not None:
            arguments = {key: value.fillna(self.fill_missing_input) for key, value in arguments.items()}
        return arguments

    def compute(self, context: Context, freq: str) -> Computed:
        arguments = self._arguments(context)
        with xclim_options():
            values = _indicator(self.indicator)(**arguments, **self.params, freq=freq)
        if self.empty_value is not None:
            values = values.fillna(self.empty_value)
        aux = {}
        if self.occurrence is not None:
            aux["ymd"] = _occurrence_dates(self._occurrence_series(arguments), freq, self.occurrence)
        return Computed(values, aux)

    def _occurrence_series(self, arguments: dict[str, xr.DataArray]) -> xr.DataArray:
        """The daily series whose extreme the indicator reports (running total when windowed)."""
        series = next(iter(arguments.values()))
        window = self.params.get("window")
        if isinstance(window, int) and window > 1:
            return series.rolling(time=window, center=True).sum()
        return series


@dataclass(frozen=True)
class PercentileDays:
    """Percentage of days beyond a day-of-year percentile of the base period (TX90p and relatives).

    In-base years use the Zhang et al. (2005) bootstrap. With ``percentile_method="xclim"`` the
    thresholds and bootstrap are xclim's (``indicator``); otherwise the climdex-compatible
    implementation in :mod:`climpoc.indices.thresholds` is used.
    """

    variable: str
    percentile: float
    comparison: Comparison
    indicator: str

    def compute(self, context: Context, freq: str) -> Computed:
        context.require_base_data(self.variable)
        if context.settings.percentile_method == "xclim":
            return self._compute_xclim(context, freq)
        rate = context.daily(context.exceedance_rate(self.variable, self.percentile / 100, self.comparison))
        values = (100 * rate.resample(time=freq).mean()).assign_attrs(units="%")
        return Computed(values, presence=rate.notnull())

    def _compute_xclim(self, context: Context, freq: str) -> Computed:
        series = context.variable(self.variable)
        with xclim_options():
            per = percentile_doy(
                context.base_slice(self.variable), window=context.settings.percentile_window, per=self.percentile
            ).sel(percentiles=self.percentile)
            try:
                days = _indicator(self.indicator)(series, per, freq=freq, bootstrap=True)
            except KeyError as error:
                raise NotComputable(f"xclim could not bootstrap this record: {error.args[0]}") from error
        valid = series.notnull().resample(time=freq).sum()
        values = (100 * days / valid.where(valid > 0)).assign_attrs(units="%")
        return Computed(values)


@dataclass(frozen=True)
class SpellDuration:
    """Days in spells of at least ``window`` days beyond a day-of-year percentile (WSDI, CSDI).

    Thresholds are the plain base-period percentiles (no bootstrap); spells are counted within
    each calendar year and do not continue across 31 December. Run lengths use xclim.
    """

    variable: str
    percentile: float
    comparison: Comparison
    window: int
    indicator: str

    def compute(self, context: Context, freq: str) -> Computed:
        context.require_base_data(self.variable)
        series = context.variable(self.variable)
        if context.settings.percentile_method == "xclim":
            with xclim_options():
                per = percentile_doy(
                    context.base_slice(self.variable), window=context.settings.percentile_window, per=self.percentile
                ).sel(percentiles=self.percentile)
                return Computed(_indicator(self.indicator)(series, per, window=self.window, freq=freq))
        threshold = context.daily(context.daily_threshold(self.variable, self.percentile / 100))
        compare = operator.gt if self.comparison == ">" else operator.lt
        beyond = compare(series, threshold)
        with xclim_options():
            days = beyond.resample(time=freq).map(run_length.windowed_run_count, window=self.window, dim="time")
        return Computed(days.astype(float).assign_attrs(units="days"), presence=series.notnull() & threshold.notnull())


@dataclass(frozen=True)
class PrecipAboveQuantile:
    """Precipitation from days above a quantile of base-period wet days (R95p, R99p).

    ``as_share_of_total`` gives the percentage of total wet-day precipitation (R95pTOT).
    Climpact reports R95p as an amount in millimetres; xclim's indicator of that name counts
    days, so the amount is summed here with xarray.
    """

    percentile: float
    as_share_of_total: bool = False

    def compute(self, context: Context, freq: str) -> Computed:
        context.require_base_data("pr")
        pr = context.dataset["pr"]
        wet_day = context.settings.wet_day_mm
        limit = thresholds.wet_day_quantile(pr.to_numpy(), context.time, context.base, self.percentile / 100, wet_day)
        if not np.isfinite(limit):
            raise NotComputable("the base period has no wet days, so the precipitation percentile is undefined")
        amount = pr.where(pr > limit).resample(time=freq).sum()
        if not self.as_share_of_total:
            return Computed(amount.assign_attrs(units="mm"))
        total = pr.where(pr >= wet_day).resample(time=freq).sum()
        return Computed((100 * amount / total.where(total > 0)).assign_attrs(units="%"))


@dataclass(frozen=True)
class LongestSpell:
    """Longest dry (or wet) spell, allowed to cross year boundaries (CDD, CWD).

    The spell is credited to the year in which it ends, as Climpact does. xclim's
    ``dry_spell_max_length`` credits a spell to the year in which it starts or cuts it at the
    year end, so the attribution is done here; see :mod:`climpoc.indices.spells`.
    """

    wet: bool

    def compute(self, context: Context, freq: str) -> Computed:
        pr = context.dataset["pr"].to_numpy()
        wet_day = context.settings.wet_day_mm
        condition = pr >= wet_day if self.wet else pr < wet_day
        table = longest_spell_by_end_year(condition, context.time)
        index = pd.DatetimeIndex(pd.to_datetime({"year": table.index, "month": 1, "day": 1}), name="time")

        def column(name: str) -> xr.DataArray:
            return xr.DataArray(table[name].to_numpy(), coords={"time": index}, dims="time")

        values = column("length").assign_attrs(units="days")
        return Computed(values, {"start": column("start"), "end": column("end")})


@dataclass(frozen=True)
class GrowingSeason:
    """Growing season length from the ETCCDI definition (see :mod:`climpoc.indices.seasons`).

    Northern hemisphere: calendar year. Southern hemisphere: the year runs from 1 July to
    30 June and is labelled by its first calendar year.

    xclim's ``growing_season_length`` is not used: it ends the season at the first span that is
    *not above* the threshold (or starts it at the first span *not below*), so days at exactly
    5 degC count differently, and it does not require the season to start in the first half of
    the year. On a cold-climate test record it differed from the R tool in 9 of 78 years, by up
    to 110 days.
    """

    threshold: float = 5.0
    window: int = 6

    def compute(self, context: Context, freq: str) -> Computed:
        southern = context.settings.southern_hemisphere
        mean = (context.dataset["tasmax"].to_numpy() + context.dataset["tasmin"].to_numpy()) / 2
        table = growing_seasons(mean, context.time, southern, self.threshold, self.window)
        index = pd.DatetimeIndex(table.index, name="time")

        def column(name: str) -> xr.DataArray:
            return xr.DataArray(table[name].to_numpy(), coords={"time": index}, dims="time")

        values = column("length").assign_attrs(units="days")
        aux = {"start": column("start"), "end": column("end")}
        return Computed(values, aux, period_freq="YS-JUL" if southern else "YS")
