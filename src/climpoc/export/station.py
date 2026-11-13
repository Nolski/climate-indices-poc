"""Station description shared by all exports."""

from __future__ import annotations

from dataclasses import dataclass

import xarray as xr


@dataclass(frozen=True)
class StationInfo:
    name: str
    latitude: float | None
    longitude: float | None

    @classmethod
    def from_dataset(cls, dataset: xr.Dataset) -> StationInfo:
        def coordinate(name: str) -> float | None:
            return float(dataset[name]) if name in dataset.coords else None

        return cls(str(dataset.attrs.get("station_name", "station")), coordinate("lat"), coordinate("lon"))

    @property
    def file_stem(self) -> str:
        """Station name reduced to characters that are safe in file names."""
        safe = "".join(char if char.isalnum() or char in "-_." else "_" for char in self.name).strip("._")
        return safe or "station"


def format_number(value: float | None) -> str:
    """Shortest decimal text with up to 10 significant digits; integers without a decimal point."""
    return "" if value is None else format(value, ".10g")
