"""Structured API errors: ``{"error": {"code", "message", "details"}}`` for every failure."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from climpoc.io.station import StationFileError


class ApiError(Exception):
    """An error with an HTTP status, a stable machine code and a human-readable message."""

    def __init__(self, status: int, code: str, message: str, details: list[object] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or []


def error_body(code: str, message: str, details: list[object] | None = None) -> dict[str, object]:
    return {"error": {"code": code, "message": message, "details": details or []}}


def _response(status: int, code: str, message: str, details: list[object] | None = None) -> JSONResponse:
    return JSONResponse(error_body(code, message, details), status_code=status, headers={"Cache-Control": "no-store"})


async def _api_error(_: Request, error: ApiError) -> JSONResponse:
    return _response(error.status, error.code, error.message, error.details)


async def _station_file_error(_: Request, error: StationFileError) -> JSONResponse:
    details = [issue.as_dict() for issue in error.issues]
    return _response(422, "invalid_station_file", str(error), details)


async def _validation_error(_: Request, error: RequestValidationError) -> JSONResponse:
    details = [
        {"field": ".".join(str(part) for part in item["loc"] if part != "body"), "message": item["msg"]}
        for item in error.errors()
    ]
    return _response(422, "invalid_request", "The request is not valid; see details.", details)


async def _http_error(_: Request, error: StarletteHTTPException) -> JSONResponse:
    codes = {404: "not_found", 405: "method_not_allowed", 413: "payload_too_large"}
    return _response(error.status_code, codes.get(error.status_code, "http_error"), str(error.detail))


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _api_error)  # type: ignore[arg-type]
    app.add_exception_handler(StationFileError, _station_file_error)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _validation_error)  # type: ignore[arg-type]
    app.add_exception_handler(StarletteHTTPException, _http_error)  # type: ignore[arg-type]
