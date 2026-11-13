#!/usr/bin/env bash
# Runs INSIDE the container. Invoked by ../run.sh.
#
# Mounts expected:
#   /src/upstream  (read-only)  pristine checkout of ARCCSS-extremes/climpact
#   /scripts       (read-only)  this directory
#   /out           (read-write) becomes baseline/output on the host
#
# Climpact's batch mode writes its results next to the metadata file and drops a temporary file
# next to each station file, so it is run from a throw-away copy of the checkout, never in /src.
set -euo pipefail

BASE_START="${BASE_START:-1971}"
BASE_END="${BASE_END:-2000}"
CORES="${CORES:-2}"
KEEP_PLOTS="${KEEP_PLOTS:-0}"
PRIMARY_STATION="${PRIMARY_STATION:-sydney_observatory_hill_1936-2015}"

WORK=/tmp/climpact
rm -rf "$WORK"
mkdir -p "$WORK" /out/logs
(cd /src/upstream && tar cf - --exclude=.git .) | tar xf - -C "$WORK"
cd "$WORK"

# The documented batch command from upstream's README ("ADVANCED: Batch process multiple station
# files from the command line"), verbatim apart from the three variables.
echo "+ Rscript climpact.batch.stations.r ./www/sample_data/ ./www/sample_data/climpact.sample.batch.metadata.txt $BASE_START $BASE_END $CORES" | tee /out/logs/batch.log
Rscript climpact.batch.stations.r \
    ./www/sample_data/ \
    ./www/sample_data/climpact.sample.batch.metadata.txt \
    "$BASE_START" "$BASE_END" "$CORES" 2>&1 | tee -a /out/logs/batch.log

# Batch output folder = metadata path minus its extension.
BATCH_OUT="$WORK/www/sample_data/climpact.sample.batch.metadata"
test -d "$BATCH_OUT" || { echo "batch output folder missing: $BATCH_OUT" >&2; exit 1; }

# Plots are not needed for a numeric baseline (about 15 MB of PNG/PDF per station).
if [ "$KEEP_PLOTS" != "1" ]; then
    find "$BATCH_OUT" -type d -name plots -prune -exec rm -rf {} +
    find "$BATCH_OUT" -type f \( -name '*.png' -o -name '*.pdf' \) -delete
fi
find "$BATCH_OUT" -type d -empty -delete
cp -a "$BATCH_OUT"/. /out/

# Record exactly what produced the numbers.
Rscript /scripts/versions.R > /out/versions.txt 2>&1

# One row per index output, for the comparison harness.
Rscript /scripts/make_inventory.R /out "$PRIMARY_STATION" /src/upstream /out/index_inventory.csv

echo "container run finished"
