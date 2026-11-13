"""Longest spells that may cross year boundaries (consecutive dry and wet days).

Rule (Climpact and climdex.pcic, as documented in the Climpact user guide): spells are found in
the whole record, not year by year. A spell is credited to the year in which it ends, so a
value can exceed 365. A year that lies wholly inside a spell that ends later has no value.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd


@dataclass(frozen=True)
class Spell:
    start: int
    end: int

    @property
    def length(self) -> int:
        return self.end - self.start + 1


def find_spells(condition: np.ndarray) -> list[Spell]:
    """Runs of ``True`` as inclusive ``(start, end)`` positions. ``False`` or missing ends a run."""
    padded = np.concatenate(([False], condition.astype(bool), [False]))
    change = np.flatnonzero(padded[1:] != padded[:-1])
    return [Spell(int(start), int(end) - 1) for start, end in zip(change[::2], change[1::2], strict=True)]


def longest_spell_by_end_year(condition: np.ndarray, time: pd.DatetimeIndex) -> pd.DataFrame:
    """Longest spell credited to each year: columns ``length``, ``start``, ``end`` (dates).

    ``length`` is 0 when no spell ends in a year and NaN when the whole year is inside a spell
    that ends in a later year. Of equally long spells the first is reported.
    """
    spells = find_spells(condition)
    ends = np.array([spell.end for spell in spells], dtype=np.int64)
    starts = np.array([spell.start for spell in spells], dtype=np.int64)
    found = pd.DataFrame(
        {"year": time.year[ends], "length": (ends - starts + 1).astype(float), "start": time[starts], "end": time[ends]}
    )
    longest = found.sort_values("length", ascending=False, kind="stable").drop_duplicates("year").set_index("year")
    years = pd.Index(np.arange(time.year.min(), time.year.max() + 1), name="year")
    table = longest.reindex(years)
    table["length"] = table["length"].fillna(0.0)
    in_spell = pd.Series(condition.astype(bool), index=time).groupby(time.year).all()
    table.loc[in_spell & (table["length"] == 0), "length"] = np.nan
    return table
