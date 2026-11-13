"""Static front-end files with cache headers suited to slow connections."""

from __future__ import annotations

from starlette.responses import Response
from starlette.staticfiles import StaticFiles
from starlette.types import Scope

ONE_WEEK = 7 * 24 * 3600
ONE_YEAR = 365 * 24 * 3600
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": (
        "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
        "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
    ),
}


def cache_control(path: str, versioned: bool) -> str:
    """Cache policy: pages and fixtures are revalidated; assets are kept for a week, or for a
    year when the URL carries a version (``?v=...``), since its content can then never change."""
    if path.endswith((".html", "/")) or path == "" or "fixtures/" in path:
        return "no-cache"
    if versioned:
        return f"public, max-age={ONE_YEAR}, immutable"
    return f"public, max-age={ONE_WEEK}"


class CachedStaticFiles(StaticFiles):
    """``StaticFiles`` (ETag and Last-Modified revalidation built in) plus cache and security headers."""

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        if response.status_code in (200, 304):
            versioned = b"v=" in scope.get("query_string", b"")
            response.headers["Cache-Control"] = cache_control(path if path != "." else "", versioned)
        for name, value in SECURITY_HEADERS.items():
            response.headers.setdefault(name, value)
        return response
