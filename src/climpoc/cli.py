"""Command line: ``climpoc run`` for offline batch use, ``climpoc serve`` for the web application."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from climpoc import DISCLAIMER, __version__
from climpoc.indices.missing import POLICIES
from climpoc.indices.registry import all_indices, definitions_for
from climpoc.indices.settings import UserParameters


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="climpoc", description=f"Climate indices for station data. {DISCLAIMER}")
    parser.add_argument("--version", action="version", version=f"climpoc {__version__}")
    commands = parser.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="quality-control a station file, compute indices and write all exports")
    run.add_argument("file", type=Path, help="station text file: year month day precip tmax tmin, missing = -99.9")
    run.add_argument("--out", type=Path, required=True, metavar="DIR", help="output directory (created if needed)")
    run.add_argument(
        "--base", type=int, nargs=2, default=(1971, 2000), metavar=("START", "END"),
        help="base period years (default: 1971 2000)",
    )  # fmt: skip
    run.add_argument(
        "--lat", type=float, default=None, help="station latitude; zero or below selects southern-hemisphere rules"
    )
    run.add_argument("--lon", type=float, default=None, help="station longitude")
    run.add_argument("--name", default=None, help="station name (default: file name)")
    run.add_argument(
        "--indices", nargs="+", default=None, metavar="ID",
        help="index identifiers, space or comma separated (default: all)",
    )  # fmt: skip
    run.add_argument("--frequency", choices=("annual", "monthly"), default=None, help="default: both")
    run.add_argument(
        "--missing-policy", choices=sorted(POLICIES), default="climdex", help="missing-data policy (default: climdex)"
    )
    run.add_argument(
        "--percentile-method", choices=("climdex", "xclim"), default="climdex",
        help="xclim: xclim's own thresholds and bootstrap (slower, differs from the R tool)",
    )  # fmt: skip
    run.add_argument(
        "--repair-dates", action="store_true",
        help="sort rows, drop repeated dates and fill absent days instead of stopping",
    )  # fmt: skip
    user = run.add_argument_group(
        "user-defined indices (the R tool's wsdin, csdin, Tb_HDD, Tb_CDD, Tb_GDD, rxnday, rnnmm)"
    )
    user.add_argument(
        "--wsdi-days", type=int, default=3, metavar="D", help="spell length of WSDId, 1-10 (default 3: wsdi3)"
    )
    user.add_argument(
        "--csdi-days", type=int, default=3, metavar="D", help="spell length of CSDId, 1-10 (default 3: csdi3)"
    )
    user.add_argument(
        "--hdd-base", type=float, default=18.0, metavar="DEGC", help="heating degree-day base (default 18)"
    )
    user.add_argument(
        "--cdd-base", type=float, default=18.0, metavar="DEGC", help="cooling degree-day base (default 18)"
    )
    user.add_argument(
        "--gdd-base", type=float, default=10.0, metavar="DEGC", help="growing degree-day base (default 10)"
    )
    user.add_argument(
        "--rx-days", type=int, default=3, metavar="D", help="window of RXdday in days (default 3: rx3day)"
    )
    user.add_argument(
        "--rnn-mm", type=float, default=30.0, metavar="MM", help="threshold of Rnnmm in mm (default 30: r30mm)"
    )
    run.add_argument("--zip", action="store_true", help="also write the exports as one zip file")

    serve = commands.add_parser("serve", help="start the web application")
    serve.add_argument(
        "--host", default="127.0.0.1", help="address to listen on (default: 127.0.0.1; use 0.0.0.0 in a container)"
    )
    serve.add_argument("--port", type=int, default=8000)

    commands.add_parser("indices", help="list the available indices")
    return parser


def _parameters(arguments: argparse.Namespace) -> UserParameters:
    return UserParameters(
        wsdi_days=arguments.wsdi_days,
        csdi_days=arguments.csdi_days,
        hdd_base=arguments.hdd_base,
        cdd_base=arguments.cdd_base,
        gdd_base=arguments.gdd_base,
        rx_days=arguments.rx_days,
        rnn_mm=arguments.rnn_mm,
    )


def _index_ids(values: Sequence[str] | None, parameters: UserParameters) -> list[str] | None:
    if values is None:
        return None
    known = definitions_for(parameters)
    ids = [part.strip().lower() for value in values for part in value.split(",") if part.strip()]
    unknown = [index for index in ids if index not in known]
    if unknown:
        raise SystemExit(f"Unknown index identifier(s): {', '.join(unknown)}. Run 'climpoc indices' for the list.")
    return ids


def _run(arguments: argparse.Namespace) -> int:
    # Imported here so that 'climpoc --help' does not pay for importing xclim.
    from climpoc.export import bundle
    from climpoc.export.station import StationInfo
    from climpoc.indices.engine import compute_indices
    from climpoc.indices.missing import make_policy
    from climpoc.indices.settings import settings_for
    from climpoc.io.station import StationFileError, StationMeta, read_station_file
    from climpoc.qc import run_qc

    try:
        parameters = _parameters(arguments)
    except ValueError as error:
        raise SystemExit(str(error)) from None
    ids = _index_ids(arguments.indices, parameters)
    if not arguments.file.exists():
        raise SystemExit(f"File not found: {arguments.file}")
    meta = StationMeta(arguments.name or arguments.file.stem, arguments.lat, arguments.lon)
    try:
        parsed = read_station_file(arguments.file, meta, "repair" if arguments.repair_dates else "strict")
        settings = settings_for(
            parsed.dataset, *arguments.base, percentile_method=arguments.percentile_method, parameters=parameters
        )
    except StationFileError as error:
        print(error, file=sys.stderr)
        for issue in error.issues:
            print(f"  {issue.message}", file=sys.stderr)
        return 2
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    for note in parsed.notes:
        print(f"note: {note.message}")
    qc = run_qc(parsed.records)
    for result in qc.results:
        if result.count:
            print(f"QC {result.severity}: {result.title}: {result.count}")
    policy = make_policy(arguments.missing_policy)
    frequencies = [arguments.frequency] if arguments.frequency else ["annual", "monthly"]
    outputs = [compute_indices(parsed.dataset, ids, frequency, settings, policy) for frequency in frequencies]
    for output in outputs:
        print(f"{output.frequency}: {len(output.results)} indices in {output.elapsed_seconds:.1f} s")
        for skipped in output.skipped:
            if arguments.frequency or not skipped.reason.startswith("not available at"):
                print(f"  skipped {skipped.id}: {skipped.reason}")
    outputs = [output for output in outputs if output.results]
    if not outputs:
        print("No index could be computed; nothing was written.", file=sys.stderr)
        return 1
    station = StationInfo.from_dataset(parsed.dataset)
    files = bundle.bundle_files(station, outputs, qc)
    written = bundle.write_directory(files, arguments.out)
    if arguments.zip:
        archive = arguments.out / f"{station.file_stem}_indices.zip"
        archive.write_bytes(bundle.zip_bytes(files))
        written.append(archive)
    print(f"Wrote {len(written)} files to {arguments.out}")
    return 0


def _serve(arguments: argparse.Namespace) -> int:
    import uvicorn

    from climpoc.api.config import ApiConfig, ConfigError

    try:
        ApiConfig.from_env()
    except ConfigError as error:
        print(f"Cannot start: {error}", file=sys.stderr)
        return 2
    uvicorn.run("climpoc.api.app:app", host=arguments.host, port=arguments.port, log_level="info")
    return 0


def _list_indices() -> int:
    for definition in all_indices():
        frequencies = "/".join(definition.frequencies)
        print(f"{definition.id:10s} {definition.units:12s} {frequencies:15s} {definition.long_name}")
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    if arguments.command == "run":
        return _run(arguments)
    if arguments.command == "serve":
        return _serve(arguments)
    return _list_indices()


if __name__ == "__main__":
    sys.exit(main())
