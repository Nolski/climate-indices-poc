"""Create the variant test cases under ``baseline/variants/`` from the Sydney sample station.

Usage: ``uv run python baseline/make_variants.py`` (needs the sample; see scripts/fetch_sample.sh).

Each variant gets ``input/sydney_<name>.txt`` (station file, untracked because it is derived from
the sample data), ``metadata.txt`` (the R tool's batch metadata file) and ``variant.json`` (the
parameters both implementations are run with). Everything is deterministic: fixed seed, no clock.
``run_variants.sh`` then runs the original R tool on each variant.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
SAMPLE = HERE / "upstream" / "www" / "sample_data" / "sydney_observatory_hill_1936-2015.txt"
VARIANTS = HERE / "variants"
SEED = 20261113
MISSING = -99.9
COLUMNS = ["year", "month", "day", "pr", "tasmax", "tasmin"]
METADATA_COLUMNS = ["station_file", "latitude", "longitude", "wsdin", "csdin", "Tb_HDD", "Tb_CDD", "Tb_GDD", "rxnday", "rnnmm", "txtn", "SPEI"]
DEFAULT_METADATA = {"latitude": -10, "longitude": 100, "wsdin": 3, "csdin": 3, "Tb_HDD": 18, "Tb_CDD": 18, "Tb_GDD": 10, "rxnday": 3, "rnnmm": 30, "txtn": 2, "SPEI": 24}


def load_sample() -> pd.DataFrame:
    frame = pd.read_csv(SAMPLE, sep=r"\s+", header=None, names=COLUMNS)
    frame.index = pd.to_datetime(frame[["year", "month", "day"]])
    return frame


def cold(frame: pd.DataFrame) -> pd.DataFrame:
    """Subtract 15 degC from both temperatures so that frost and ice indices are not all zero."""
    out = frame.copy()
    for column in ("tasmax", "tasmin"):
        observed = out[column] != MISSING
        out.loc[observed, column] = (out.loc[observed, column] - 15).round(1)
    return out


def gappy(frame: pd.DataFrame) -> pd.DataFrame:
    """About 3 % of days missing at random, four multi-week gaps and one whole missing year.

    Two of the gaps are rows that are absent from the file (the R tool fills them); the others,
    the random days and the missing year are rows coded -99.9. Two gaps and the missing year
    lie inside the 1971-2000 base period.
    """
    out = frame.copy()
    values = ["pr", "tasmax", "tasmin"]
    rng = np.random.default_rng(SEED)
    random_days = rng.choice(len(out), size=round(0.03 * len(out)), replace=False)
    out.iloc[random_days, [out.columns.get_loc(column) for column in values]] = MISSING
    out.loc["1978-01-20":"1978-02-25", values] = MISSING
    out.loc["1985-11-01":"1985-11-21", "tasmax"] = MISSING
    out.loc["1982-01-01":"1982-12-31", values] = MISSING
    absent = out.loc["1950-06-10":"1950-07-05"].index.union(out.loc["2003-03-01":"2003-04-15"].index)
    return out.drop(absent)


def short(frame: pd.DataFrame) -> pd.DataFrame:
    """A 30-year record that is exactly the base period."""
    return frame.loc["1971-01-01":"2000-12-31"]


def write_station(frame: pd.DataFrame, path: Path) -> None:
    lines = [
        f"{row.year}\t{row.month}\t{row.day}\t{row.pr:g}\t{row.tasmax:g}\t{row.tasmin:g}"
        for row in frame.itertuples(index=False)
    ]
    path.write_text("\n".join(lines) + "\n")


def write_variant(name: str, description: str, frame: pd.DataFrame, base: tuple[int, int], **metadata: float) -> None:
    folder = VARIANTS / name
    (folder / "input").mkdir(parents=True, exist_ok=True)
    station = f"sydney_{name}"
    write_station(frame, folder / "input" / f"{station}.txt")
    values = {**DEFAULT_METADATA, **metadata}
    row = [f"{station}.txt", *(f"{values[column]:g}" for column in METADATA_COLUMNS[1:])]
    (folder / "metadata.txt").write_text("\t".join(METADATA_COLUMNS) + "\n" + "\t".join(row) + "\n")
    command = f"Rscript climpact.batch.stations.r <stations>/ <variant>/metadata.txt {base[0]} {base[1]} 2"
    summary = {
        "name": name,
        "description": description,
        "station": station,
        "rows": len(frame),
        "first_day": f"{frame.index[0]:%Y-%m-%d}",
        "last_day": f"{frame.index[-1]:%Y-%m-%d}",
        "base_start": base[0],
        "base_end": base[1],
        "metadata": values,
        "r_command": command,
    }
    (folder / "variant.json").write_text(json.dumps(summary, indent=1) + "\n")
    print(f"{name}: {len(frame)} rows, base {base[0]}-{base[1]}")


def main() -> None:
    if not SAMPLE.exists():
        raise SystemExit(f"Sample station file absent ({SAMPLE}); run scripts/fetch_sample.sh first.")
    sample = load_sample()
    default = (1971, 2000)
    write_variant("north", "Same data, latitude +40: northern-hemisphere rules (growing season)", sample, default, latitude=40)
    write_variant("base6190", "Same data, base period 1961-1990", sample, (1961, 1990))
    write_variant("cold", "tmax and tmin lowered by 15 degC: frost, ice and cold-threshold indices are non-zero", cold(sample), default)
    write_variant("gappy", "3 % of days missing at random, four multi-week gaps (two as absent rows), 1982 missing", gappy(sample), default)
    write_variant("short", "1971-2000 only: the record equals the base period", short(sample), default)
    write_variant(
        "coldgapnorth", "The cold and gappy changes together at latitude +40: northern growing season with real seasons and gaps",
        gappy(cold(sample)), default, latitude=40,
    )  # fmt: skip
    write_variant(
        "params", "Same data, non-default user parameters", sample, default,
        wsdin=5, csdin=5, Tb_HDD=15, Tb_CDD=22, Tb_GDD=5, rxnday=7, rnnmm=25, txtn=3, SPEI=9,
    )  # fmt: skip


if __name__ == "__main__":
    main()
