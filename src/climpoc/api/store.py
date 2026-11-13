"""In-memory dataset store with a time-to-live. Nothing is ever written to disk."""

from __future__ import annotations

import secrets
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field

from climpoc.indices.engine import IndexResult, Skipped
from climpoc.io.station import ParsedStation
from climpoc.qc import QCReport

TTL_SECONDS = 60 * 60
MAX_DATASETS = 50

CacheKey = tuple[str, str, str]
"""(frequency, missing-data policy as JSON, percentile method)."""


@dataclass
class Entry:
    """One uploaded station with everything derived from it."""

    id: str
    parsed: ParsedStation
    base_period: tuple[int, int]
    qc: QCReport
    created: float
    lock: threading.Lock = field(default_factory=threading.Lock)
    computed: dict[CacheKey, dict[str, IndexResult | Skipped]] = field(default_factory=dict)


class DatasetStore:
    """Thread-safe store. Entries expire ``ttl`` seconds after creation; the oldest is evicted
    when ``max_entries`` is reached."""

    def __init__(
        self, ttl: float = TTL_SECONDS, max_entries: int = MAX_DATASETS, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self.ttl = ttl
        self.max_entries = max_entries
        self._clock = clock
        self._entries: dict[str, Entry] = {}
        self._lock = threading.Lock()

    def add(self, parsed: ParsedStation, base_period: tuple[int, int], qc: QCReport) -> Entry:
        entry = Entry(f"ds_{secrets.token_hex(8)}", parsed, base_period, qc, self._clock())
        with self._lock:
            self._purge_locked()
            while len(self._entries) >= self.max_entries:
                del self._entries[min(self._entries, key=lambda key: self._entries[key].created)]
            self._entries[entry.id] = entry
        return entry

    def get(self, dataset_id: str) -> Entry | None:
        with self._lock:
            self._purge_locked()
            return self._entries.get(dataset_id)

    def delete(self, dataset_id: str) -> bool:
        with self._lock:
            return self._entries.pop(dataset_id, None) is not None

    def purge(self) -> int:
        """Drop expired entries; returns how many were removed."""
        with self._lock:
            return self._purge_locked()

    def expires_in(self, entry: Entry) -> int:
        return max(0, round(self.ttl - (self._clock() - entry.created)))

    def __len__(self) -> int:
        with self._lock:
            return len(self._entries)

    def _purge_locked(self) -> int:
        now = self._clock()
        expired = [key for key, entry in self._entries.items() if now - entry.created >= self.ttl]
        for key in expired:
            del self._entries[key]
        return len(expired)
