"""FastAPI application: a thin shell over the core library.

Uploaded data is held in memory only, for at most 60 minutes, and nothing is written to disk.
"""

from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import json
import logging
import os
import platform
import threading
from collections.abc import AsyncIterator
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Literal

import pandas as pd
import xclim
from brotli_asgi import BrotliMiddleware
from fastapi import Body, FastAPI, File, Form, Query, Response, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from starlette.formparsers import MultiPartParser
from starlette.middleware.cors import CORSMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

import climpoc
from climpoc.api.config import ApiConfig
from climpoc.api.errors import ApiError, error_body, install_error_handlers
from climpoc.api.ratelimit import RateLimitMiddleware
from climpoc.api.static import CachedStaticFiles
from climpoc.api.store import DatasetStore, Entry
from climpoc.export import bundle, netcdf, payload
from climpoc.export.station import StationInfo
from climpoc.indices.engine import ComputeOutput, IndexResult, Skipped, compute_indices
from climpoc.indices.missing import POLICIES, MissingPolicy, make_policy
from climpoc.indices.registry import REGISTRY, IndexDef, all_indices, definitions_for
from climpoc.indices.settings import Frequency, PercentileMethod, UserParameters, settings_for
from climpoc.io.station import VARIABLES, StationMeta, decode_station_bytes, parse_station_text
from climpoc.qc import QCSettings, run_qc

SAMPLE_NAME = "sydney_observatory_hill_1936-2015"
SAMPLE_RELATIVE = Path("baseline/upstream/www/sample_data") / f"{SAMPLE_NAME}.txt"
PROJECT_ROOT = Path(__file__).resolve().parents[3]
NO_STORE = {"Cache-Control": "no-store"}
LOGGER = logging.getLogger("climpoc.api")

# One index computation at a time per process. The work is CPU-bound and xclim calls are serialised
# anyway (see climpoc.indices.recipes.xclim_options); queueing whole requests keeps memory near the
# single-user level and lets the first request finish sooner than interleaving would.
_COMPUTE_LOCK = threading.Lock()

CORS_METHODS = ["GET", "POST", "DELETE", "OPTIONS"]
CORS_REQUEST_HEADERS = ["Content-Type"]
CORS_EXPOSED_HEADERS = ["Content-Disposition", "Retry-After"]


class AllowListCORS:
    """Cross-origin headers for the listed origins only.

    A request from a listed origin is handled by Starlette's ``CORSMiddleware`` (no wildcard, no
    credentials). Any other request passes through untouched and receives no CORS header at all.
    """

    def __init__(self, app: ASGIApp, origins: tuple[str, ...]) -> None:
        self.app = app
        self.origins = frozenset(origins)
        self.cors = CORSMiddleware(
            app,
            allow_origins=list(origins),
            allow_methods=CORS_METHODS,
            allow_headers=CORS_REQUEST_HEADERS,
            expose_headers=CORS_EXPOSED_HEADERS,
            allow_credentials=False,
            max_age=600,
        )

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        origin = dict(scope["headers"]).get(b"origin", b"").decode("latin-1") if scope["type"] == "http" else ""
        handler = self.cors if origin in self.origins else self.app
        await handler(scope, receive, send)


class UnexpectedErrorMiddleware:
    """Turn an unexpected exception into a structured 500 answer, and log it.

    It sits inside the CORS layer, so that even this answer carries the cross-origin headers and a
    separately hosted page can show the message instead of "could not be reached".
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            started = started or message["type"] == "http.response.start"
            await send(message)

        try:
            await self.app(scope, receive, tracking_send)
        except Exception:
            LOGGER.exception("Unexpected error while handling %s %s", scope["method"], scope["path"])
            if started:
                raise
            body = error_body("internal_error", "The server could not complete the request. Please try again.")
            await JSONResponse(body, status_code=500, headers=NO_STORE)(scope, receive, send)


class UploadTooLarge(Exception):
    pass


class UploadLimitMiddleware:
    """Reject request bodies above ``max_bytes`` with 413, by header first and while streaming."""

    def __init__(self, app: ASGIApp, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] not in ("POST", "PUT", "PATCH"):
            await self.app(scope, receive, send)
            return
        declared = dict(scope["headers"]).get(b"content-length", b"0")
        if declared.isdigit() and int(declared) > self.max_bytes:
            await self._reject(scope, receive, send)
            return
        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    raise UploadTooLarge
            return message

        try:
            await self.app(scope, limited_receive, send)
        except UploadTooLarge:
            await self._reject(scope, receive, send)

    async def _reject(self, scope: Scope, receive: Receive, send: Send) -> None:
        megabytes = self.max_bytes // (1024 * 1024)
        body = error_body("file_too_large", f"The upload is larger than the {megabytes} MB limit.")
        await JSONResponse(body, status_code=413, headers=NO_STORE)(scope, receive, send)


class SampleRequest(BaseModel):
    latitude: float = Field(-10.0, ge=-90, le=90)
    longitude: float = Field(100.0, ge=-180, le=360)
    base_start: int = 1971
    base_end: int = 2000


class PolicyRequest(BaseModel):
    id: str = "climdex"
    max_missing_days_per_year: int | None = Field(None, ge=0, le=366)
    max_missing_days_per_month: int | None = Field(None, ge=0, le=31)
    max_missing_fraction: float | None = Field(None, ge=0, le=1)


class ParametersRequest(BaseModel):
    """Parameters of the user-defined indices (the R tool's wsdin, csdin, Tb_HDD, Tb_CDD, Tb_GDD, rxnday, rnnmm)."""

    wsdi_days: int = Field(3, ge=1, le=10)
    csdi_days: int = Field(3, ge=1, le=10)
    hdd_base: float = 18.0
    cdd_base: float = 18.0
    gdd_base: float = 10.0
    rx_days: int = Field(3, ge=1, le=366)
    rnn_mm: float = Field(30.0, ge=0)


class ComputeRequest(BaseModel):
    indices: list[str] | Literal["all"] = "all"
    frequency: Frequency = "annual"
    missing_policy: PolicyRequest | None = None
    percentile_method: PercentileMethod = "climdex"
    parameters: ParametersRequest | None = None


def _find(relative: Path, variable: str) -> Path | None:
    """Locate a project file. An environment variable, when set, is the only place looked at;
    otherwise the working directory and then the source tree are tried."""
    if variable in os.environ:
        candidates = [Path(os.environ[variable])]
    else:
        candidates = [Path.cwd() / relative, PROJECT_ROOT / relative]
    return next((path for path in candidates if path.exists()), None)


def _validation_status() -> dict[str, dict[str, str]]:
    path = Path(climpoc.__file__).parent / "data" / "validation_status.json"
    return json.loads(path.read_text()) if path.exists() else {}


def _index_payload(definition: IndexDef, status: dict[str, dict[str, str]]) -> dict[str, object]:
    compared = status.get(definition.id, {})
    agrees = all(compared.get(frequency) in ("exact", "within tolerance") for frequency in definition.frequencies)
    return {
        "id": definition.id,
        "name": definition.name,
        "long_name": definition.long_name,
        "description": definition.description,
        "group": definition.group,
        "units": definition.units,
        "inputs": list(definition.inputs),
        "frequencies": list(definition.frequencies),
        "needs_base_period": definition.needs_base_period,
        "validated": bool(compared) and agrees,
        "validation": compared,
    }


def _policy(request: PolicyRequest | None) -> MissingPolicy:
    if request is None:
        return make_policy()
    if request.id not in POLICIES:
        raise ApiError(400, "unknown_missing_policy", f"Unknown missing-data policy '{request.id}'.", sorted(POLICIES))
    parameters = {key: value for key, value in request.model_dump(exclude={"id"}).items() if value is not None}
    try:
        return make_policy(request.id, **parameters)
    except TypeError:
        raise ApiError(
            400, "invalid_missing_policy", f"Policy '{request.id}' does not accept the parameters {sorted(parameters)}."
        ) from None


def _is_date(text: str) -> bool:
    try:
        dt.date.fromisoformat(text)
    except ValueError:
        return False
    return True


def _check_base_period(start: int, end: int) -> tuple[int, int]:
    if start > end:
        raise ApiError(
            400,
            "invalid_base_period",
            f"The base period starts in {start} but ends in {end}; the start year must not be later than the end year.",
        )
    return (start, end)


def _resolve_indices(requested: list[str] | Literal["all"], parameters: UserParameters | None = None) -> list[str]:
    known = REGISTRY if parameters is None else definitions_for(parameters)
    if requested == "all":
        return list(known)
    ids = [index.strip().lower() for index in requested if index.strip()]
    unknown = [index for index in ids if index not in known]
    if unknown:
        raise ApiError(400, "unknown_index", f"Unknown index identifier(s): {', '.join(unknown)}.", unknown)
    if not ids:
        raise ApiError(400, "no_indices", "No indices were requested.")
    return list(dict.fromkeys(ids))


def create_app(
    store: DatasetStore | None = None, web_dir: Path | None = None, config: ApiConfig | None = None
) -> FastAPI:
    """Build the application. ``store`` and ``web_dir`` can be injected for tests."""
    config = config if config is not None else ApiConfig.from_env()
    if store is None:
        store = DatasetStore(ttl=config.dataset_ttl_minutes * 60, max_entries=config.max_datasets)
    # Keep uploaded files in memory: Starlette would otherwise spool parts above 1 MB to a temporary file.
    MultiPartParser.spool_max_size = config.max_upload_bytes + 1024 * 1024
    status = _validation_status()

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        async def sweep() -> None:
            while True:
                await asyncio.sleep(60)
                store.purge()

        task = asyncio.create_task(sweep())
        threading.Thread(target=_warm_up, daemon=True).start()
        yield
        task.cancel()

    app = FastAPI(
        title="climpoc",
        version=climpoc.__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.store = store
    install_error_handlers(app)
    app.add_middleware(BrotliMiddleware, quality=5, minimum_size=500, gzip_fallback=True)
    app.add_middleware(UploadLimitMiddleware, max_bytes=config.max_upload_bytes)
    if config.rate_limit_per_minute:
        app.add_middleware(RateLimitMiddleware, per_minute=config.rate_limit_per_minute, trust_proxy=config.trust_proxy)
    app.add_middleware(UnexpectedErrorMiddleware)
    if config.cors_origins:
        # Outermost, so that error answers of the layers above (413, 429) carry the headers too.
        app.add_middleware(AllowListCORS, origins=config.cors_origins)

    def entry_or_404(dataset_id: str) -> Entry:
        entry = store.get(dataset_id)
        if entry is None:
            raise ApiError(
                404,
                "dataset_not_found",
                f"No dataset with id '{dataset_id}'. Uploaded data is deleted after "
                f"{store.ttl / 60:.0f} minutes; please upload the file again.",
            )
        return entry

    def dataset_payload(entry: Entry) -> dict[str, object]:
        dataset = entry.parsed.dataset
        station = StationInfo.from_dataset(dataset)
        time = dataset.indexes["time"]
        return {
            "id": entry.id,
            "station": {"name": station.name, "latitude": station.latitude, "longitude": station.longitude},
            "period": {"start": f"{time[0]:%Y-%m-%d}", "end": f"{time[-1]:%Y-%m-%d}", "n_days": len(time)},
            "base_period": {"start": entry.base_period[0], "end": entry.base_period[1]},
            "expires_in_seconds": store.expires_in(entry),
            "variables": payload.variables_payload(dataset),
            "qc": payload.qc_payload(entry.qc),
            "notes": [note.as_dict() for note in entry.parsed.notes],
        }

    def register(text: str, meta: StationMeta, base_period: tuple[int, int]) -> JSONResponse:
        parsed = parse_station_text(text, meta)
        entry = store.add(parsed, base_period, run_qc(parsed.records))
        return JSONResponse(dataset_payload(entry), status_code=201, headers=NO_STORE)

    def compute(
        entry: Entry,
        ids: list[str],
        frequency: Frequency,
        policy: MissingPolicy,
        method: PercentileMethod,
        parameters: UserParameters | None = None,
    ) -> ComputeOutput:
        """Compute the requested indices, reusing results already held for this dataset."""
        dataset = entry.parsed.dataset
        parameters = parameters or UserParameters()
        settings = settings_for(dataset, *entry.base_period, percentile_method=method, parameters=parameters)
        key = (frequency, json.dumps([policy.describe(), asdict(parameters)], sort_keys=True), method)
        elapsed = 0.0
        with entry.lock:
            cache = entry.computed.setdefault(key, {})
            todo = [index for index in ids if index not in cache]
            if todo:
                with _COMPUTE_LOCK:
                    output = compute_indices(dataset, todo, frequency, settings, policy)
                elapsed = output.elapsed_seconds
                cache.update({result.definition.id: result for result in output.results})
                cache.update({skipped.id: skipped for skipped in output.skipped})
            found = [cache[index] for index in ids]
        results = tuple(item for item in found if isinstance(item, IndexResult))
        skipped = tuple(item for item in found if isinstance(item, Skipped))
        return ComputeOutput(frequency, settings, policy, results, skipped, elapsed)

    @app.get("/api/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/limits")
    def limits() -> dict[str, int | None]:
        return config.limits()

    @app.get("/api/version")
    def version() -> dict[str, str]:
        return {"app": climpoc.__version__, "xclim": xclim.__version__, "python": platform.python_version()}

    @app.get("/api/indices")
    def indices() -> dict[str, object]:
        return {"indices": [_index_payload(definition, status) for definition in all_indices()]}

    @app.post("/api/datasets", status_code=201)
    async def upload_dataset(
        file: Annotated[UploadFile, File()],
        name: Annotated[str | None, Form(max_length=200)] = None,
        latitude: Annotated[float | None, Form(ge=-90, le=90)] = None,
        longitude: Annotated[float | None, Form(ge=-180, le=360)] = None,
        base_start: Annotated[int, Form()] = 1971,
        base_end: Annotated[int, Form()] = 2000,
    ) -> JSONResponse:
        base_period = _check_base_period(base_start, base_end)
        data = await file.read()
        if not data.strip():
            raise ApiError(400, "empty_file", "The uploaded file is empty.")
        station_name = (name or Path(file.filename or "station").stem).strip() or "station"
        meta = StationMeta(station_name, latitude, longitude)
        text = decode_station_bytes(data)
        return await asyncio.to_thread(register, text, meta, base_period)

    @app.post("/api/datasets/sample", status_code=201)
    def sample_dataset(request: Annotated[SampleRequest | None, Body()] = None) -> JSONResponse:
        request = request or SampleRequest()
        base_period = _check_base_period(request.base_start, request.base_end)
        path = _find(SAMPLE_RELATIVE, "CLIMPOC_SAMPLE_FILE")
        if path is None:
            raise ApiError(
                404,
                "sample_not_available",
                "The sample station file is not installed. Run scripts/fetch_sample.sh to download it.",
            )
        meta = StationMeta(SAMPLE_NAME, request.latitude, request.longitude)
        return register(decode_station_bytes(path.read_bytes()), meta, base_period)

    @app.get("/api/datasets/{dataset_id}")
    def get_dataset(dataset_id: str) -> JSONResponse:
        return JSONResponse(dataset_payload(entry_or_404(dataset_id)), headers=NO_STORE)

    @app.delete("/api/datasets/{dataset_id}", status_code=204)
    def delete_dataset(dataset_id: str) -> Response:
        entry_or_404(dataset_id)
        store.delete(dataset_id)
        return Response(status_code=204)

    @app.post("/api/datasets/{dataset_id}/qc")
    def rerun_qc(dataset_id: str, thresholds: Annotated[dict[str, float | int | bool], Body()]) -> JSONResponse:
        """Re-run quality control with changed thresholds (any subset of the QC settings)."""
        entry = entry_or_404(dataset_id)
        known = QCSettings().as_dict()
        unknown = sorted(set(thresholds) - set(known))
        if unknown:
            raise ApiError(400, "unknown_qc_setting", f"Unknown QC setting(s): {', '.join(unknown)}.", sorted(known))
        settings = QCSettings(**{key: type(known[key])(value) for key, value in thresholds.items()})
        entry.qc = run_qc(entry.parsed.records, settings)
        return JSONResponse(payload.qc_payload(entry.qc), headers=NO_STORE)

    @app.get("/api/datasets/{dataset_id}/daily")
    def daily(
        dataset_id: str,
        variable: Annotated[str, Query()] = "tasmax",
        start: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
        end: Annotated[str | None, Query(pattern=r"^\d{4}-\d{2}-\d{2}$")] = None,
    ) -> JSONResponse:
        entry = entry_or_404(dataset_id)
        if variable not in VARIABLES:
            raise ApiError(
                400, "unknown_variable", f"Unknown variable '{variable}'. Use one of: {', '.join(VARIABLES)}."
            )
        for value in (start, end):
            if value is not None and not _is_date(value):
                raise ApiError(
                    400, "invalid_date", f"'{value}' is not a real calendar date; write dates as YYYY-MM-DD."
                )
        return JSONResponse(payload.daily_payload(entry.parsed.dataset, variable, start, end), headers=NO_STORE)

    @app.post("/api/datasets/{dataset_id}/compute")
    def compute_endpoint(dataset_id: str, request: Annotated[ComputeRequest | None, Body()] = None) -> JSONResponse:
        request = request or ComputeRequest()
        entry = entry_or_404(dataset_id)
        parameters = UserParameters(**request.parameters.model_dump()) if request.parameters else None
        ids = _resolve_indices(request.indices, parameters)
        policy = _policy(request.missing_policy)
        output = compute(entry, ids, request.frequency, policy, request.percentile_method, parameters)
        return JSONResponse(payload.compute_payload(output, entry.id), headers=NO_STORE)

    @app.get("/api/datasets/{dataset_id}/export")
    def export(
        dataset_id: str,
        format: Annotated[Literal["zip", "netcdf", "json"], Query()] = "zip",
        frequency: Annotated[Frequency, Query()] = "annual",
        indices: Annotated[str | None, Query()] = None,
    ) -> Response:
        entry = entry_or_404(dataset_id)
        ids = _resolve_indices(indices.split(",") if indices else "all")
        output = compute(entry, ids, frequency, make_policy(), "climdex")
        if not output.results:
            reasons = [{"id": skipped.id, "reason": skipped.reason} for skipped in output.skipped]
            raise ApiError(400, "nothing_to_export", "None of the requested indices could be computed.", reasons)
        station = StationInfo.from_dataset(entry.parsed.dataset)
        stem = f"{station.file_stem}_indices_{frequency}"
        if format == "json":
            body = json.dumps(payload.compute_payload(output, entry.id), allow_nan=False).encode()
            return _download(body, "application/json", f"{stem}.json")
        if format == "netcdf":
            return _download(netcdf.to_netcdf_bytes(output, station), "application/x-netcdf", f"{stem}.nc")
        files = bundle.bundle_files(station, [output], entry.qc)
        return _download(bundle.zip_bytes(files), "application/zip", f"{stem}.zip")

    web_dir = web_dir or _find(Path("web"), "CLIMPOC_WEB_DIR")
    if web_dir is not None:
        app.mount("/", CachedStaticFiles(directory=web_dir, html=True), name="web")
    return app


def _download(content: bytes, media_type: str, filename: str) -> Response:
    headers = {"Content-Disposition": f'attachment; filename="{filename}"', **NO_STORE}
    return Response(content, media_type=media_type, headers=headers)


def _warm_up() -> None:
    """Compute every index once on three synthetic years, in the background at start-up.

    xclim compiles its run-length kernels with numba on first use, which costs a few seconds;
    doing it here keeps that delay away from the first user request. Failure is harmless.
    """
    days = pd.date_range("2000-01-01", "2002-12-31", freq="D")
    rows = "\n".join(f"{d.year} {d.month} {d.day} {i % 7} {20 + i % 9} {10 + i % 5}" for i, d in enumerate(days))
    dataset = parse_station_text(rows, StationMeta("warm-up", 10.0, 0.0)).dataset
    with contextlib.suppress(Exception):
        compute_indices(dataset, settings=settings_for(dataset, 2000, 2002))


app = create_app()
