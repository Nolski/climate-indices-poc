"""A small per-client request limit for public demonstrations (off unless configured).

One token bucket per client address, held in memory: a client may make ``per_minute`` requests
in a burst and then one every ``60 / per_minute`` seconds. It protects a small server from
accidental hammering; it is not a defence against a determined attacker, which is the job of the
reverse proxy in front.
"""

from __future__ import annotations

import math
import threading
import time
from collections.abc import Callable

from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from climpoc.api.errors import error_body

MAX_CLIENTS = 10_000


class TokenBuckets:
    """Thread-safe token buckets keyed by client."""

    def __init__(self, per_minute: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.capacity = float(per_minute)
        self.rate = per_minute / 60.0
        self._clock = clock
        self._buckets: dict[str, tuple[float, float]] = {}
        self._lock = threading.Lock()

    def take(self, client: str) -> float:
        """Take one token. Returns 0 when allowed, else the seconds to wait for the next token."""
        now = self._clock()
        with self._lock:
            tokens, updated = self._buckets.get(client, (self.capacity, now))
            tokens = min(self.capacity, tokens + (now - updated) * self.rate)
            if len(self._buckets) >= MAX_CLIENTS and client not in self._buckets:
                self._buckets.clear()  # bounded memory; everyone starts with a full bucket again
            if tokens < 1:
                self._buckets[client] = (tokens, now)
                return (1 - tokens) / self.rate
            self._buckets[client] = (tokens - 1, now)
            return 0.0


def client_address(scope: Scope, trust_proxy: bool) -> str:
    """The client's address: the connection's peer, or behind a trusted reverse proxy the last
    entry of ``X-Forwarded-For`` (the address that proxy saw; earlier entries can be forged)."""
    if trust_proxy:
        forwarded = dict(scope["headers"]).get(b"x-forwarded-for", b"").decode("latin-1")
        entries = [part.strip() for part in forwarded.split(",") if part.strip()]
        if entries:
            return entries[-1]
    client = scope.get("client")
    return client[0] if client else "unknown"


class RateLimitMiddleware:
    """Answer 429 with ``Retry-After`` when a client exceeds its request rate on ``/api/`` paths.

    The health check and CORS preflight requests are not counted.
    """

    def __init__(
        self, app: ASGIApp, per_minute: int, trust_proxy: bool = False, buckets: TokenBuckets | None = None
    ) -> None:
        self.app = app
        self.trust_proxy = trust_proxy
        self.buckets = buckets or TokenBuckets(per_minute)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        counted = (
            scope["type"] == "http"
            and scope["path"].startswith("/api/")
            and scope["path"] != "/api/health"
            and scope["method"] != "OPTIONS"
        )
        wait = self.buckets.take(client_address(scope, self.trust_proxy)) if counted else 0.0
        if wait <= 0:
            await self.app(scope, receive, send)
            return
        seconds = math.ceil(wait)
        body = error_body("rate_limited", f"Too many requests from this address. Try again in {seconds} s.")
        headers = {"Retry-After": str(seconds), "Cache-Control": "no-store"}
        await JSONResponse(body, status_code=429, headers=headers)(scope, receive, send)
