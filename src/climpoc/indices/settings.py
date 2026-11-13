"""Settings shared by every index calculation."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict, dataclass
from typing import Literal

import xarray as xr

Frequency = Literal["annual", "monthly"]
PercentileMethod = Literal["climdex", "xclim"]
FREQUENCIES: tuple[Frequency, ...] = ("annual", "monthly")
XARRAY_FREQ: dict[str, str] = {"annual": "YS", "monthly": "MS"}


@dataclass(frozen=True)
class UserParameters:
    """Parameters of the user-defined indices, as in the R tool's interface and batch metadata.

    Each one names an index: ``wsdi_days=5`` gives ``wsdi5``, ``hdd_base=15`` gives ``hddheat15``,
    ``rx_days=7`` gives ``rx7day``, ``rnn_mm=25`` gives ``r25mm``. The defaults are those of the
    R tool's sample metadata file, so the default index identifiers are stable.
    """

    wsdi_days: int = 3
    csdi_days: int = 3
    hdd_base: float = 18.0
    cdd_base: float = 18.0
    gdd_base: float = 10.0
    rx_days: int = 3
    rnn_mm: float = 30.0

    @classmethod
    def from_climpact_metadata(cls, metadata: Mapping[str, float]) -> UserParameters:
        """Build from the columns of the R tool's batch metadata file (``wsdin``, ``Tb_HDD``, ...)."""
        return cls(
            wsdi_days=int(metadata["wsdin"]),
            csdi_days=int(metadata["csdin"]),
            hdd_base=float(metadata["Tb_HDD"]),
            cdd_base=float(metadata["Tb_CDD"]),
            gdd_base=float(metadata["Tb_GDD"]),
            rx_days=int(metadata["rxnday"]),
            rnn_mm=float(metadata["rnnmm"]),
        )

    def __post_init__(self) -> None:
        for name in ("wsdi_days", "csdi_days"):
            if not 1 <= getattr(self, name) <= 10:
                raise ValueError(f"{name} must be between 1 and 10 days, not {getattr(self, name)}.")
        if self.rx_days < 1:
            raise ValueError(f"rx_days must be at least 1 day, not {self.rx_days}.")
        if self.rnn_mm < 0:
            raise ValueError(f"rnn_mm must not be negative, not {self.rnn_mm}.")


@dataclass(frozen=True)
class ComputeSettings:
    """Parameters of an index run. Defaults reproduce Climpact 3.4.4 / climdex.pcic 1.2-0."""

    base_start: int = 1971
    base_end: int = 2000
    southern_hemisphere: bool = False
    """Growing season year runs July to June when true."""
    percentile_method: PercentileMethod = "climdex"
    """``climdex``: 365-day calendar, 29 February dropped from the base sample, Zhang et al. (2005)
    in-base bootstrap computed in numpy. ``xclim``: xclim's ``percentile_doy`` (thresholds
    interpolated to 366 days) and its experimental ``bootstrap=True`` (several seconds per index)."""
    percentile_window: int = 5
    min_base_fraction: float = 0.1
    """Smallest share of non-missing base-period values for a day-of-year threshold to exist."""
    wet_day_mm: float = 1.0
    parameters: UserParameters = UserParameters()

    def __post_init__(self) -> None:
        if self.base_start > self.base_end:
            raise ValueError(
                f"The base period starts in {self.base_start} but ends in {self.base_end}; "
                "the start year must not be later than the end year."
            )

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


def is_southern(latitude: float | None) -> bool:
    """Hemisphere rule of the R tool: latitude above zero is northern, zero or below is southern."""
    return latitude is not None and latitude <= 0


def settings_for(
    dataset: xr.Dataset, base_start: int = 1971, base_end: int = 2000, **overrides: object
) -> ComputeSettings:
    """Build settings for a station dataset, taking the hemisphere from its ``lat`` coordinate."""
    latitude = float(dataset["lat"]) if "lat" in dataset.coords else None
    values: dict[str, object] = {"southern_hemisphere": is_southern(latitude), **overrides}
    return ComputeSettings(base_start=base_start, base_end=base_end, **values)  # type: ignore[arg-type]
