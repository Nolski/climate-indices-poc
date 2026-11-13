"""Declarative index registry: one entry per index.

To add an index, append an ``IndexDef`` to ``_DEFINITIONS``. Most entries only name an xclim
indicator and its parameters. See ``docs/architecture.md`` for a worked example.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from climpoc.indices.recipes import (
    GrowingSeason,
    LongestSpell,
    PercentileDays,
    PrecipAboveQuantile,
    Recipe,
    SpellDuration,
    XclimIndicator,
)
from climpoc.indices.settings import Frequency, UserParameters

Group = Literal["temperature", "precipitation", "duration", "percentile"]
BOTH: tuple[Frequency, ...] = ("annual", "monthly")
ANNUAL: tuple[Frequency, ...] = ("annual",)


@dataclass(frozen=True)
class IndexDef:
    """Definition of one climate index.

    ``inputs`` are the station variables needed (``pr``, ``tasmax``, ``tasmin``); they also
    decide which missing days count against a period. ``columns`` names the Climpact CSV
    layout: ``standard`` (value plus standardised value), ``dated`` (value plus date of
    occurrence), ``spell`` or ``season`` (start, length, end).
    """

    id: str
    name: str
    long_name: str
    description: str
    group: Group
    units: str
    inputs: tuple[str, ...]
    frequencies: tuple[Frequency, ...]
    recipe: Recipe
    needs_base_period: bool = False
    columns: Literal["standard", "dated", "spell", "season"] = "standard"
    cell_methods: str = ""


def _count(indicator: str, variable: str, argument: str, thresh: str, condition: str | None = None) -> XclimIndicator:
    params: dict[str, object] = {"thresh": thresh}
    if condition is not None:
        params["condition"] = condition
    return XclimIndicator(f"atmos.{indicator}", {argument: variable}, params)


def _extreme(indicator: str, variable: str, kind: Literal["max", "min"]) -> XclimIndicator:
    return XclimIndicator(f"atmos.{indicator}", {variable: variable}, occurrence=kind)


def _rx(window: int) -> XclimIndicator:
    return XclimIndicator(
        "atmos.max_n_day_precipitation_amount", {"pr": "pr"}, {"window": window},
        fill_missing_input=0.0, occurrence="max",
    )  # fmt: skip


T, P, D, PC = "temperature", "precipitation", "duration", "percentile"
TX, TN, TM, PR = ("tasmax",), ("tasmin",), ("tasmax", "tasmin"), ("pr",)

_DEFINITIONS: tuple[IndexDef, ...] = (
    # --- fixed-threshold day counts -------------------------------------------------------
    IndexDef("fd", "FD", "Frost days", "Number of days when daily minimum temperature is below 0 degC",
             T, "days", TN, BOTH, _count("frost_days", "tasmin", "tasmin", "0 degC")),
    IndexDef("su", "SU", "Summer days", "Number of days when daily maximum temperature is above 25 degC",
             T, "days", TX, BOTH, _count("tx_days_above", "tasmax", "tasmax", "25 degC", ">")),
    IndexDef("id", "ID", "Ice days", "Number of days when daily maximum temperature is below 0 degC",
             T, "days", TX, BOTH, _count("ice_days", "tasmax", "tasmax", "0 degC")),
    IndexDef("tr", "TR", "Tropical nights", "Number of days when daily minimum temperature is above 20 degC",
             T, "days", TN, BOTH, _count("tropical_nights", "tasmin", "tasmin", "20 degC")),
    IndexDef("txge30", "TXge30", "Hot days", "Number of days when daily maximum temperature is at least 30 degC",
             T, "days", TX, BOTH, _count("tx_days_above", "tasmax", "tasmax", "30 degC", ">=")),
    IndexDef("txge35", "TXge35", "Very hot days", "Number of days when daily maximum temperature is at least 35 degC",
             T, "days", TX, BOTH, _count("tx_days_above", "tasmax", "tasmax", "35 degC", ">=")),
    IndexDef("tnlt2", "TNlt2", "Nights below 2 degC", "Number of days when daily minimum temperature is below 2 degC",
             T, "days", TN, BOTH, _count("tn_days_below", "tasmin", "tasmin", "2 degC", "<")),
    IndexDef("tnltm2", "TNltm2", "Nights below -2 degC", "Number of days when daily minimum temperature is below -2 degC",
             T, "days", TN, BOTH, _count("tn_days_below", "tasmin", "tasmin", "-2 degC", "<")),
    IndexDef("tnltm20", "TNltm20", "Nights below -20 degC", "Number of days when daily minimum temperature is below -20 degC",
             T, "days", TN, BOTH, _count("tn_days_below", "tasmin", "tasmin", "-20 degC", "<")),
    IndexDef("tmge5", "TMge5", "Days with mean temperature of at least 5 degC", "Number of days when daily mean temperature is at least 5 degC",
             T, "days", TM, BOTH, _count("tg_days_above", "tas", "tas", "5 degC", ">=")),
    IndexDef("tmlt5", "TMlt5", "Days with mean temperature below 5 degC", "Number of days when daily mean temperature is below 5 degC",
             T, "days", TM, BOTH, _count("tg_days_below", "tas", "tas", "5 degC", "<")),
    IndexDef("tmge10", "TMge10", "Days with mean temperature of at least 10 degC", "Number of days when daily mean temperature is at least 10 degC",
             T, "days", TM, BOTH, _count("tg_days_above", "tas", "tas", "10 degC", ">=")),
    IndexDef("tmlt10", "TMlt10", "Days with mean temperature below 10 degC", "Number of days when daily mean temperature is below 10 degC",
             T, "days", TM, BOTH, _count("tg_days_below", "tas", "tas", "10 degC", "<")),
    # --- extremes and means ---------------------------------------------------------------
    IndexDef("txx", "TXx", "Hottest day", "Maximum of daily maximum temperature",
             T, "degC", TX, BOTH, _extreme("tx_max", "tasmax", "max"), columns="dated", cell_methods="time: maximum"),
    IndexDef("txn", "TXn", "Coldest day", "Minimum of daily maximum temperature",
             T, "degC", TX, BOTH, _extreme("tx_min", "tasmax", "min"), columns="dated", cell_methods="time: minimum"),
    IndexDef("tnx", "TNx", "Warmest night", "Maximum of daily minimum temperature",
             T, "degC", TN, BOTH, _extreme("tn_max", "tasmin", "max"), columns="dated", cell_methods="time: maximum"),
    IndexDef("tnn", "TNn", "Coldest night", "Minimum of daily minimum temperature",
             T, "degC", TN, BOTH, _extreme("tn_min", "tasmin", "min"), columns="dated", cell_methods="time: minimum"),
    IndexDef("dtr", "DTR", "Daily temperature range", "Mean difference between daily maximum and daily minimum temperature",
             T, "degC", TM, BOTH, XclimIndicator("atmos.daily_temperature_range", {"tasmin": "tasmin", "tasmax": "tasmax"}),
             cell_methods="time: mean"),
    IndexDef("txm", "TXm", "Mean daily maximum temperature", "Mean of daily maximum temperature",
             T, "degC", TX, BOTH, XclimIndicator("atmos.tx_mean", {"tasmax": "tasmax"}), cell_methods="time: mean"),
    IndexDef("tnm", "TNm", "Mean daily minimum temperature", "Mean of daily minimum temperature",
             T, "degC", TN, BOTH, XclimIndicator("atmos.tn_mean", {"tasmin": "tasmin"}), cell_methods="time: mean"),
    IndexDef("tmm", "TMm", "Mean daily mean temperature", "Mean of daily mean temperature, (TX + TN) / 2",
             T, "degC", TM, BOTH, XclimIndicator("atmos.tg_mean", {"tas": "tas"}), cell_methods="time: mean"),
    # --- degree days ----------------------------------------------------------------------
    # --- precipitation --------------------------------------------------------------------
    IndexDef("rx1day", "Rx1day", "Wettest day", "Maximum 1-day precipitation total",
             P, "mm", PR, BOTH, XclimIndicator("atmos.max_1day_precipitation_amount", {"pr": "pr"}, occurrence="max"),
             columns="dated", cell_methods="time: maximum"),
    IndexDef("rx5day", "Rx5day", "Wettest 5 days", "Maximum 5-day precipitation total",
             P, "mm", PR, BOTH, _rx(5), columns="dated", cell_methods="time: maximum"),
    IndexDef("sdii", "SDII", "Daily precipitation intensity", "Total precipitation on wet days (at least 1 mm) divided by the number of wet days",
             P, "mm/day", PR, ANNUAL, XclimIndicator("atmos.daily_pr_intensity", {"pr": "pr"}, {"thresh": "1 mm/day"}, empty_value=0.0)),
    IndexDef("r10mm", "R10mm", "Heavy rain days", "Number of days with precipitation of at least 10 mm",
             P, "days", PR, BOTH, _count("wetdays", "pr", "pr", "10 mm/day")),
    IndexDef("r20mm", "R20mm", "Very heavy rain days", "Number of days with precipitation of at least 20 mm",
             P, "days", PR, BOTH, _count("wetdays", "pr", "pr", "20 mm/day")),
    IndexDef("prcptot", "PRCPTOT", "Total wet-day precipitation", "Total precipitation on wet days (at least 1 mm)",
             P, "mm", PR, BOTH, XclimIndicator("atmos.wet_precip_accumulation", {"pr": "pr"}, {"thresh": "1 mm/day"}),
             cell_methods="time: sum"),
    # --- spells ---------------------------------------------------------------------------
    IndexDef("cdd", "CDD", "Consecutive dry days", "Longest run of days with precipitation below 1 mm; runs may cross year ends and count for the year in which they end",
             D, "days", PR, ANNUAL, LongestSpell(wet=False), columns="spell"),
    IndexDef("cwd", "CWD", "Consecutive wet days", "Longest run of days with precipitation of at least 1 mm; runs may cross year ends and count for the year in which they end",
             D, "days", PR, ANNUAL, LongestSpell(wet=True), columns="spell"),
    # --- percentile-based -----------------------------------------------------------------
    IndexDef("tx90p", "TX90p", "Warm days", "Percentage of days when daily maximum temperature is above the 90th percentile of the base period",
             PC, "%", TX, BOTH, PercentileDays("tasmax", 90, ">", "atmos.tx90p"), needs_base_period=True),
    IndexDef("tn90p", "TN90p", "Warm nights", "Percentage of days when daily minimum temperature is above the 90th percentile of the base period",
             PC, "%", TN, BOTH, PercentileDays("tasmin", 90, ">", "atmos.tn90p"), needs_base_period=True),
    IndexDef("tx10p", "TX10p", "Cool days", "Percentage of days when daily maximum temperature is below the 10th percentile of the base period",
             PC, "%", TX, BOTH, PercentileDays("tasmax", 10, "<", "atmos.tx10p"), needs_base_period=True),
    IndexDef("tn10p", "TN10p", "Cool nights", "Percentage of days when daily minimum temperature is below the 10th percentile of the base period",
             PC, "%", TN, BOTH, PercentileDays("tasmin", 10, "<", "atmos.tn10p"), needs_base_period=True),
    IndexDef("txgt50p", "TXgt50p", "Days above the median", "Percentage of days when daily maximum temperature is above the 50th percentile of the base period",
             PC, "%", TX, BOTH, PercentileDays("tasmax", 50, ">", "atmos.tx90p"), needs_base_period=True),
    IndexDef("r95p", "R95p", "Very wet day precipitation", "Total precipitation on days above the 95th percentile of base-period wet days",
             PC, "mm", PR, ANNUAL, PrecipAboveQuantile(95), needs_base_period=True),
    IndexDef("r99p", "R99p", "Extremely wet day precipitation", "Total precipitation on days above the 99th percentile of base-period wet days",
             PC, "mm", PR, ANNUAL, PrecipAboveQuantile(99), needs_base_period=True),
    IndexDef("r95ptot", "R95pTOT", "Contribution of very wet days", "Share of total wet-day precipitation that falls on days above the 95th percentile of base-period wet days",
             PC, "%", PR, ANNUAL, PrecipAboveQuantile(95, as_share_of_total=True), needs_base_period=True),
    IndexDef("r99ptot", "R99pTOT", "Contribution of extremely wet days", "Share of total wet-day precipitation that falls on days above the 99th percentile of base-period wet days",
             PC, "%", PR, ANNUAL, PrecipAboveQuantile(99, as_share_of_total=True), needs_base_period=True),
    # --- duration -------------------------------------------------------------------------
    IndexDef("wsdi", "WSDI", "Warm spell duration", "Number of days in runs of at least 6 days with daily maximum temperature above the 90th percentile",
             D, "days", TX, ANNUAL, SpellDuration("tasmax", 90, ">", 6, "atmos.warm_spell_duration_index"), needs_base_period=True),
    IndexDef("csdi", "CSDI", "Cold spell duration", "Number of days in runs of at least 6 days with daily minimum temperature below the 10th percentile",
             D, "days", TN, ANNUAL, SpellDuration("tasmin", 10, "<", 6, "atmos.cold_spell_duration_index"), needs_base_period=True),
    IndexDef("gsl", "GSL", "Growing season length", "Days from the first run of 6 days with mean temperature above 5 degC to the first such run below 5 degC in the second half of the year",
             D, "days", TM, ANNUAL, GrowingSeason(), columns="season"),
)  # fmt: skip


def _number(value: float) -> str:
    return format(value, "g")


def parametrised_indices(parameters: UserParameters) -> tuple[IndexDef, ...]:
    """The user-defined indices for the given parameters; identifiers carry the parameter value."""
    hdd, cdd, gdd, rnn = (
        _number(x) for x in (parameters.hdd_base, parameters.cdd_base, parameters.gdd_base, parameters.rnn_mm)
    )
    rx, warm, cold = parameters.rx_days, parameters.wsdi_days, parameters.csdi_days
    degree_days = "degree-days"
    return (
        IndexDef(f"hddheat{hdd}", f"HDDheat{hdd}", "Heating degree days", f"Sum of {hdd} degC minus daily mean temperature on days below {hdd} degC",
                 T, degree_days, TM, ANNUAL, XclimIndicator("atmos.heating_degree_days", {"tas": "tas"}, {"thresh": f"{hdd} degC"})),
        IndexDef(f"cddcold{cdd}", f"CDDcold{cdd}", "Cooling degree days", f"Sum of daily mean temperature minus {cdd} degC on days above {cdd} degC",
                 T, degree_days, TM, ANNUAL, XclimIndicator("atmos.cooling_degree_days", {"tas": "tas"}, {"thresh": f"{cdd} degC"})),
        IndexDef(f"gddgrow{gdd}", f"GDDgrow{gdd}", "Growing degree days", f"Sum of daily mean temperature minus {gdd} degC on days above {gdd} degC",
                 T, degree_days, TM, ANNUAL, XclimIndicator("atmos.growing_degree_days", {"tas": "tas"}, {"thresh": f"{gdd} degC"})),
        IndexDef(f"rx{rx}day", f"Rx{rx}day", f"Wettest {rx} days", f"Maximum {rx}-day precipitation total",
                 P, "mm", PR, BOTH, _rx(rx), columns="dated", cell_methods="time: maximum"),
        IndexDef(f"r{rnn}mm", f"R{rnn}mm", f"Rain days of at least {rnn} mm", f"Number of days with precipitation of at least {rnn} mm",
                 P, "days", PR, BOTH, _count("wetdays", "pr", "pr", f"{rnn} mm/day")),
        IndexDef(f"wsdi{warm}", f"WSDI{warm}", f"Warm spell duration ({warm} days)", f"Number of days in runs of at least {warm} days with daily maximum temperature above the 90th percentile",
                 D, "days", TX, ANNUAL, SpellDuration("tasmax", 90, ">", warm, "atmos.warm_spell_duration_index"), needs_base_period=True),
        IndexDef(f"csdi{cold}", f"CSDI{cold}", f"Cold spell duration ({cold} days)", f"Number of days in runs of at least {cold} days with daily minimum temperature below the 10th percentile",
                 D, "days", TN, ANNUAL, SpellDuration("tasmin", 10, "<", cold, "atmos.cold_spell_duration_index"), needs_base_period=True),
    )  # fmt: skip


def definitions_for(parameters: UserParameters) -> dict[str, IndexDef]:
    """Every index for the given user parameters, keyed by identifier.

    A user-defined index that coincides with a fixed one (``rx_days=5`` is ``rx5day``) is not added twice.
    """
    definitions = {definition.id: definition for definition in _DEFINITIONS}
    for definition in parametrised_indices(parameters):
        definitions.setdefault(definition.id, definition)
    return definitions


REGISTRY: dict[str, IndexDef] = definitions_for(UserParameters())
"""The indices for the default user parameters."""


def get(index_id: str, parameters: UserParameters | None = None) -> IndexDef:
    """Look up an index by identifier (case-insensitive), for the given user parameters."""
    definitions = REGISTRY if parameters is None else definitions_for(parameters)
    try:
        return definitions[index_id.lower()]
    except KeyError:
        raise KeyError(f"Unknown index '{index_id}'. Known indices: {', '.join(definitions)}.") from None


def all_indices() -> tuple[IndexDef, ...]:
    return tuple(REGISTRY.values())
