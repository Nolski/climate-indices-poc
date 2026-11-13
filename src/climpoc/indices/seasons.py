"""Growing season length, from the ETCCDI definition.

"Annual (1 January to 31 December in the northern hemisphere, 1 July to 30 June in the southern
hemisphere) count between the first span of at least 6 days with daily mean temperature above
5 degC and the first span after 1 July (1 January in the southern hemisphere) of 6 days with
daily mean temperature below 5 degC."

As climdex.pcic documents it, the season must start in the first half of the year, otherwise the
length is 0, and the end is looked for in the second half. A season that does not end lasts to
the last day of the year. Days with a mean of exactly 5 degC, and missing days, belong to
neither kind of span.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from climpoc.indices.spells import find_spells


def _first_span(condition: np.ndarray, window: int) -> int | None:
    """Position of the first run of at least ``window`` true values, or ``None``."""
    return next((spell.start for spell in find_spells(condition) if spell.length >= window), None)


def growing_seasons(
    mean_temperature: np.ndarray, time: pd.DatetimeIndex, southern: bool, threshold: float = 5.0, window: int = 6
) -> pd.DataFrame:
    """Growing season of every year touched by the record.

    Returns one row per year start (1 January, or 1 July in the southern hemisphere) with
    ``length`` in days and the ``start`` and ``end`` dates. ``end`` is the first day of the cold
    span that ends the season, or the last day of the year when the season does not end.
    A year without a season has length 0 and no dates.
    """
    first_month = 7 if southern else 1
    label = np.where(time.month >= first_month, time.year, time.year - 1)
    rows = []
    for year in np.unique(label):
        days = np.flatnonzero(label == year)
        middle = pd.Timestamp(year=int(year) + (1 if southern else 0), month=1 if southern else 7, day=1)
        first_half = days[time[days] < middle]
        second_half = days[time[days] >= middle]
        year_start = pd.Timestamp(year=int(year), month=first_month, day=1)
        begin = _first_span(mean_temperature[first_half] > threshold, window)
        if begin is None:
            rows.append((year_start, 0.0, pd.NaT, pd.NaT))
            continue
        start = time[first_half[begin]]
        stop = _first_span(mean_temperature[second_half] < threshold, window)
        if stop is None:
            end = time[days[-1]]
            length = (end - start).days + 1
        else:
            end = time[second_half[stop]]
            length = (end - start).days
        rows.append((year_start, float(length), start, end))
    table = pd.DataFrame(rows, columns=["time", "length", "start", "end"]).set_index("time")
    return table.astype({"start": "datetime64[s]", "end": "datetime64[s]"})
