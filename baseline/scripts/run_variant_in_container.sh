#!/usr/bin/env bash
# Runs INSIDE the container. Invoked by ../run_variants.sh, once per variant.
#
# Mounts expected:
#   /src/upstream  (read-only)  pristine checkout of ARCCSS-extremes/climpact
#   /variant       (read-only)  baseline/variants/<name> (input/, metadata.txt)
#   /out           (read-write) becomes baseline/variants/<name>/output on the host
#
# The R tool is run unmodified with its documented batch command. Whatever it does (including
# refusing or crashing) is recorded: the exit status goes to /out/r_exit_status.txt and the console
# output to /out/logs/batch.log (logs are not tracked in git).
set -uo pipefail

BASE_START="${BASE_START:?}"
BASE_END="${BASE_END:?}"

WORK=/tmp/climpact
CASE=/tmp/case
rm -rf "$WORK" "$CASE"
mkdir -p "$WORK" "$CASE/stations" /out/logs
(cd /src/upstream && tar cf - --exclude=.git .) | tar xf - -C "$WORK"
cp /variant/input/*.txt "$CASE/stations/"
cp /variant/metadata.txt "$CASE/metadata.txt"
cd "$WORK"

echo "+ Rscript climpact.batch.stations.r $CASE/stations/ $CASE/metadata.txt $BASE_START $BASE_END 2" | tee /out/logs/batch.log
Rscript climpact.batch.stations.r "$CASE/stations/" "$CASE/metadata.txt" "$BASE_START" "$BASE_END" 2 2>&1 | tee -a /out/logs/batch.log
STATUS="${PIPESTATUS[0]}"
echo "$STATUS" > /out/r_exit_status.txt

# Batch output folder = metadata path minus its extension. Plots are dropped (numeric comparison only).
if [ -d "$CASE/metadata" ]; then
    find "$CASE/metadata" -type d -name plots -prune -exec rm -rf {} +
    find "$CASE/metadata" -type f \( -name '*.png' -o -name '*.pdf' \) -delete
    find "$CASE/metadata" -type d -empty -delete
    cp -a "$CASE/metadata"/. /out/
fi
# Error and warning files the R tool may leave next to the station files.
find "$CASE" -maxdepth 2 -type f \( -name '*.errors.txt' -o -name '*.warnings.txt' \) -exec cp {} /out/logs/ \;
echo "R exit status: $STATUS"
