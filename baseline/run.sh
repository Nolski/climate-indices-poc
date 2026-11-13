#!/usr/bin/env bash
# Regenerates the Climpact (R) baseline for the bundled Sydney sample station.
#
#   ./run.sh
#
# Everything third-party runs inside a container; nothing is installed on the host.
# Host requirements: git, and podman (or docker).
#
# Tunables (environment variables):
#   CONTAINER_ENGINE  podman | docker          (default: podman if installed, else docker)
#   BASE_START        base period start year   (default 1971, as in upstream's README command)
#   BASE_END          base period end year     (default 2000)
#   CORES             cores argument           (default 2; the station code path is serial anyway)
#   KEEP_PLOTS        1 = also keep PNG/PDF plots (default 0)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

UPSTREAM_REPO="https://github.com/ARCCSS-extremes/climpact.git"
UPSTREAM_COMMIT="a8d283185907bfe6c24eda8be92ee7630e4d6a0e"   # Climpact 3.4.4
IMAGE="localhost/climpact-baseline:r4.5.3"

if [ -z "${CONTAINER_ENGINE:-}" ]; then
    if command -v podman >/dev/null 2>&1; then CONTAINER_ENGINE=podman; else CONTAINER_ENGINE=docker; fi
fi

# 1. Upstream source at the pinned commit (never modified: it is mounted read-only).
if [ ! -d upstream/.git ]; then
    git clone "$UPSTREAM_REPO" upstream
fi
if [ "$(git -C upstream rev-parse HEAD)" != "$UPSTREAM_COMMIT" ]; then
    git -C upstream fetch --depth 1 origin "$UPSTREAM_COMMIT"
    git -C upstream checkout --detach "$UPSTREAM_COMMIT"
fi
if [ -n "$(git -C upstream status --porcelain)" ]; then
    echo "upstream/ has local modifications; refusing to build a baseline from it" >&2
    exit 1
fi

# 2. Image (R 4.5.3 + the packages the station batch path needs).
mkdir -p logs
echo "building $IMAGE with $CONTAINER_ENGINE (log: logs/image-build.log)"
"$CONTAINER_ENGINE" build -t "$IMAGE" -f Dockerfile . > logs/image-build.log 2>&1 \
    || { tail -40 logs/image-build.log >&2; exit 1; }

# 3. Run the documented batch command inside the container.
rm -rf output
mkdir -p output
RUN_ARGS=(run --rm
    --security-opt label=disable            # SELinux hosts: lets the container use the bind mounts without relabelling them
    -e BASE_START="${BASE_START:-1971}" -e BASE_END="${BASE_END:-2000}" -e CORES="${CORES:-2}"
    -e KEEP_PLOTS="${KEEP_PLOTS:-0}" -e HOME=/tmp
    -v "$HERE/upstream:/src/upstream:ro"
    -v "$HERE/scripts:/scripts:ro"
    -v "$HERE/output:/out")
# Rootless podman maps container root to the invoking user, so output files are owned by you.
# With docker, run as the invoking user instead so the files are not root-owned.
if [ "$(basename "$CONTAINER_ENGINE")" != "podman" ]; then
    RUN_ARGS+=(--user "$(id -u):$(id -g)")
fi
"$CONTAINER_ENGINE" "${RUN_ARGS[@]}" "$IMAGE" bash /scripts/run_in_container.sh > logs/run.log 2>&1 \
    || { tail -40 logs/run.log >&2; exit 1; }

# 4. The inventory lives next to this script.
mv output/index_inventory.csv index_inventory.csv

echo "done:"
echo "  $(find output -path '*/indices/*.csv' | wc -l) index CSV files under output/*/indices/"
echo "  $(($(wc -l < index_inventory.csv) - 1)) rows in index_inventory.csv"
echo "  versions in output/versions.txt, batch log in output/logs/batch.log"
