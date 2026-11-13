#!/usr/bin/env bash
# Runs the ORIGINAL Climpact R tool on every variant case under variants/ (see make_variants.py).
#
#   uv run python baseline/make_variants.py     # create the inputs (deterministic)
#   baseline/run_variants.sh [name ...]         # run R on all variants, or on the named ones
#
# Needs the image built by ./run.sh (localhost/climpact-baseline:r4.5.3) and the upstream checkout.
# The reference outputs of the default case (output/) are never touched. For each variant the R
# outputs land in variants/<name>/output/, with the R exit status in output/r_exit_status.txt and
# the console output in output/logs/batch.log (untracked). The exact command is in variant.json.
# Variants run in parallel.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
IMAGE="localhost/climpact-baseline:r4.5.3"
CONTAINER_ENGINE="${CONTAINER_ENGINE:-podman}"

if [ "$#" -gt 0 ]; then NAMES=("$@"); else NAMES=(); for d in variants/*/; do NAMES+=("$(basename "$d")"); done; fi

run_one() {
    local name="$1" dir="$HERE/variants/$1"
    local start end
    start="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['base_start'])" "$dir/variant.json")"
    end="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['base_end'])" "$dir/variant.json")"
    rm -rf "$dir/output"
    mkdir -p "$dir/output"
    "$CONTAINER_ENGINE" run --rm --security-opt label=disable \
        -e BASE_START="$start" -e BASE_END="$end" -e HOME=/tmp \
        -v "$HERE/upstream:/src/upstream:ro" -v "$HERE/scripts:/scripts:ro" \
        -v "$dir:/variant:ro" -v "$dir/output:/out" \
        "$IMAGE" bash /scripts/run_variant_in_container.sh > "$dir/output/container.log" 2>&1 || true
    echo "$name: R exit status $(cat "$dir/output/r_exit_status.txt" 2>/dev/null || echo unknown), $(find "$dir/output" -path '*/indices/*.csv' | wc -l) index files"
}

for name in "${NAMES[@]}"; do run_one "$name" & done
wait
