#!/usr/bin/env bash
# Download the sample station file used by the demo, the tests and the validation.
#
# Source: the Climpact repository (https://github.com/ARCCSS-extremes/climpact, GPL-3.0), file
# www/sample_data/sydney_observatory_hill_1936-2015.txt at the commit pinned below: daily
# observations for Sydney Observatory Hill, as distributed with Climpact. The file is used
# unmodified as test and demonstration input. It is fetched on demand and kept in an untracked
# location; see NOTICE for the attribution.
#
# Usage: scripts/fetch_sample.sh [DESTINATION_DIRECTORY]
set -euo pipefail

COMMIT="a8d283185907bfe6c24eda8be92ee7630e4d6a0e"
NAME="sydney_observatory_hill_1936-2015.txt"
URL="https://raw.githubusercontent.com/ARCCSS-extremes/climpact/${COMMIT}/www/sample_data/${NAME}"
SHA256="949a2f535b335349474ad29251268110ea5fcccaa1afdfe989c4b00a994900e6"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-${ROOT}/baseline/upstream/www/sample_data}"
TARGET="${DEST}/${NAME}"

check() { echo "${SHA256}  ${TARGET}" | sha256sum --check --status; }

if [ -f "${TARGET}" ] && check; then
    echo "Sample already present: ${TARGET}"
    exit 0
fi

mkdir -p "${DEST}"
echo "Downloading ${URL}"
if command -v curl >/dev/null 2>&1; then
    curl --fail --silent --show-error --location --retry 3 --output "${TARGET}" "${URL}"
else
    python3 -c "import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" "${URL}" "${TARGET}"
fi

if ! check; then
    echo "Checksum mismatch for ${TARGET}; the file was removed." >&2
    rm -f "${TARGET}"
    exit 1
fi
echo "Saved ${TARGET}"
echo "Attribution: sample data from the Climpact repository (ARCCSS-extremes/climpact, GPL-3.0), commit ${COMMIT}."
