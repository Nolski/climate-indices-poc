"""Shared fixtures. Tests that need the sample station or the R baseline skip when they are absent."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from climpoc.io.station import ParsedStation, StationMeta, parse_station_text, read_station_file

ROOT = Path(__file__).resolve().parents[1]
STATION = "sydney_observatory_hill_1936-2015"
SAMPLE = ROOT / "baseline" / "upstream" / "www" / "sample_data" / f"{STATION}.txt"
BASELINE = ROOT / "baseline" / "output" / STATION


def synthetic_text(start: str = "1990-01-01", end: str = "2001-12-31", seed: int = 0) -> str:
    """A plausible station file: seasonal temperatures with noise and intermittent rain."""
    days = pd.date_range(start, end, freq="D")
    rng = np.random.default_rng(seed)
    season = 8 * np.sin(2 * np.pi * (days.day_of_year.to_numpy() - 100) / 365.25)
    tmax = np.round(22 + season + rng.normal(0, 3, len(days)), 1)
    tmin = np.round(tmax - 8 - np.abs(rng.normal(0, 2, len(days))), 1)
    rain = np.round(np.where(rng.random(len(days)) < 0.3, rng.gamma(0.8, 9.0, len(days)), 0.0), 1)
    rows = zip(days.year, days.month, days.day, rain, tmax, tmin, strict=True)
    return "\n".join(f"{y} {m} {d} {p} {x} {n}" for y, m, d, p, x, n in rows) + "\n"


def station_text(rows: list[tuple[str, float, float, float]]) -> str:
    """Station text from ``(ISO date, precip, tmax, tmin)`` rows."""
    lines = []
    for date, pr, tmax, tmin in rows:
        year, month, day = (int(part) for part in date.split("-"))
        lines.append(f"{year} {month} {day} {pr} {tmax} {tmin}")
    return "\n".join(lines) + "\n"


def daily_station(start: str, end: str, pr: float = 0.0, tmax: float = 20.0, tmin: float = 10.0) -> pd.DataFrame:
    """A constant daily table (index: date) that tests modify before turning it into a station."""
    index = pd.date_range(start, end, freq="D")
    return pd.DataFrame({"pr": pr, "tasmax": tmax, "tasmin": tmin}, index=index)


def parse_frame(frame: pd.DataFrame, latitude: float | None = 10.0) -> ParsedStation:
    """Parse a daily table (NaN = missing) through the real parser."""
    filled = frame.fillna(-99.9)
    rows = [
        (f"{date:%Y-%m-%d}", row.pr, row.tasmax, row.tasmin)
        for date, row in zip(filled.index, filled.itertuples(), strict=True)
    ]
    return parse_station_text(station_text(rows), StationMeta("test", latitude, 0.0))


@pytest.fixture(scope="session")
def synthetic() -> ParsedStation:
    return parse_station_text(synthetic_text(), StationMeta("synthetic", 45.0, 5.0))


@pytest.fixture(scope="session")
def sample_path() -> Path:
    if not SAMPLE.exists():
        pytest.skip(f"sample station file absent ({SAMPLE}); run scripts/fetch_sample.sh")
    return SAMPLE


@pytest.fixture(scope="session")
def sample(sample_path: Path) -> ParsedStation:
    return read_station_file(sample_path, StationMeta(STATION, -10.0, 100.0))


@pytest.fixture(scope="session")
def baseline_dir() -> Path:
    if not BASELINE.exists():
        pytest.skip(f"R baseline outputs absent ({BASELINE}); run baseline/run.sh")
    return BASELINE
