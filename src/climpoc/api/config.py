"""Deployment settings of the web API, read from environment variables and validated at start-up.

Everything is optional. With nothing set the API behaves as a same-origin application with the
default limits: no cross-origin access, no request limit.
"""

from __future__ import annotations

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass

_ORIGIN = re.compile(r"^https?://[A-Za-z0-9.-]+(:\d{1,5})?$")


class ConfigError(ValueError):
    """An environment variable has a value that cannot be used; the message names it."""


@dataclass(frozen=True)
class ApiConfig:
    cors_origins: tuple[str, ...] = ()
    """Exact origins (scheme, host, optional port) allowed to call the API from a browser."""
    max_datasets: int = 50
    max_upload_mb: int = 20
    dataset_ttl_minutes: int = 60
    rate_limit_per_minute: int = 0
    """Requests per client address per minute; 0 switches the limit off."""
    trust_proxy: bool = False
    """Take the client address from ``X-Forwarded-For`` (set this only behind a reverse proxy)."""

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> ApiConfig:
        env = os.environ if env is None else env
        return cls(
            cors_origins=_origins(env.get("CLIMPOC_CORS_ORIGINS", "")),
            max_datasets=_integer(env, "CLIMPOC_MAX_DATASETS", 50, 1, 10_000),
            max_upload_mb=_integer(env, "CLIMPOC_MAX_UPLOAD_MB", 20, 1, 1024),
            dataset_ttl_minutes=_integer(env, "CLIMPOC_DATASET_TTL_MINUTES", 60, 1, 24 * 60),
            rate_limit_per_minute=_integer(env, "CLIMPOC_RATE_LIMIT_PER_MINUTE", 0, 0, 100_000),
            trust_proxy=_flag(env, "CLIMPOC_TRUST_PROXY"),
        )

    def limits(self) -> dict[str, int | None]:
        """The limits a client needs to know, as served by ``GET /api/limits``."""
        return {
            "max_upload_mb": self.max_upload_mb,
            "max_datasets": self.max_datasets,
            "dataset_ttl_minutes": self.dataset_ttl_minutes,
            "rate_limit_per_minute": self.rate_limit_per_minute or None,
        }


def _origins(value: str) -> tuple[str, ...]:
    origins = tuple(part.strip().rstrip("/") for part in value.split(",") if part.strip())
    for origin in origins:
        if not _ORIGIN.fullmatch(origin):
            raise ConfigError(
                f"CLIMPOC_CORS_ORIGINS: '{origin}' is not an origin. Give exact origins such as "
                "https://example.github.io (scheme and host, no path, no wildcard), separated by commas."
            )
    return origins


def _integer(env: Mapping[str, str], name: str, default: int, low: int, high: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name}: '{raw}' is not a whole number.") from None
    if not low <= value <= high:
        raise ConfigError(f"{name}: {value} is outside the allowed range {low} to {high}.")
    return value


def _flag(env: Mapping[str, str], name: str) -> bool:
    raw = env.get(name, "").strip().lower()
    if raw in ("", "0", "false", "no", "off"):
        return False
    if raw in ("1", "true", "yes", "on"):
        return True
    raise ConfigError(f"{name}: '{raw}' is not understood; use 1 or 0.")
