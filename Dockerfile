# syntax=docker/dockerfile:1
# Works with docker and with podman (podman build --format docker keeps the HEALTHCHECK).

# ---- build stage: resolve and install the locked runtime dependencies ---------------------------
FROM docker.io/library/python:3.12-slim AS build
COPY --from=ghcr.io/astral-sh/uv:0.10.2 /uv /usr/local/bin/uv
# Few parallel downloads and a long timeout: builds must survive a slow or unreliable connection.
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never \
    UV_HTTP_TIMEOUT=300 UV_CONCURRENT_DOWNLOADS=2
WORKDIR /app
COPY pyproject.toml uv.lock ./
# The cache mount keeps finished downloads between attempts: a retried build only fetches what failed.
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-install-project
COPY README.md LICENSE NOTICE ./
COPY src ./src
RUN --mount=type=cache,target=/root/.cache/uv uv sync --frozen --no-dev --no-editable

# Sample station file for the "try the sample" button: downloaded at build time from the Climpact
# repository at a pinned commit, checksum-verified, never stored in this repository.
# See scripts/fetch_sample.sh for the attribution.
COPY scripts/fetch_sample.sh scripts/fetch_sample.sh
RUN bash scripts/fetch_sample.sh /sample \
 && printf '%s\n' \
    "sydney_observatory_hill_1936-2015.txt: sample station data distributed with Climpact" \
    "(https://github.com/ARCCSS-extremes/climpact, GPL-3.0), fetched unmodified at build time." \
    "See /app/NOTICE." > /sample/ATTRIBUTION.txt

# ---- runtime stage: interpreter, virtual environment, static front end, nothing else ------------
FROM docker.io/library/python:3.12-slim AS runtime
LABEL org.opencontainers.image.title="climpoc" \
      org.opencontainers.image.description="Climate indices for station data: a Python and xclim proof of concept for Climpact's station workflow" \
      org.opencontainers.image.source="https://github.com/Nolski/climate-indices-poc" \
      org.opencontainers.image.licenses="GPL-3.0-or-later"
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin climpoc
WORKDIR /app
COPY --from=build /app/.venv /app/.venv
COPY --from=build /sample /app/sample
COPY web /app/web
COPY LICENSE NOTICE /app/
ENV PATH="/app/.venv/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    NUMBA_CACHE_DIR=/tmp/numba-cache \
    CLIMPOC_WEB_DIR=/app/web \
    CLIMPOC_SAMPLE_FILE=/app/sample/sydney_observatory_hill_1936-2015.txt
USER 10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)"]
CMD ["climpoc", "serve", "--host", "0.0.0.0", "--port", "8000"]
