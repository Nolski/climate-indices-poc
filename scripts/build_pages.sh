#!/usr/bin/env bash
# Assembles the static site for GitHub Pages in _site/.
#
#   scripts/build_pages.sh                                   demonstration only (no API)
#   API_BASE=https://api.example.org scripts/build_pages.sh  page talks to that API
#
# Environment:
#   API_BASE          address of the separately hosted API: scheme and host, optional port and
#                     path, no trailing "/api". Empty: the site shows the demonstration only.
#   API_ALTERNATIVES  optional, comma-separated: further API addresses that ?api=... may select.
#   OUT               output folder (default: _site in the repository root).
#
# The output is web/ without tests, check scripts and READMEs. Exactly two things differ from
# the copy the container serves: config.js (written here) and the connect-src part of the
# Content-Security-Policy in index.html (the API origins are added, never a wildcard).
# Nothing is downloaded, installed, committed or published by this script.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/web"
OUT="${OUT:-$ROOT/_site}"
API_BASE="${API_BASE:-}"
API_ALTERNATIVES="${API_ALTERNATIVES:-}"

# An address is only accepted if it is a plain http(s) URL: it is written into JavaScript and
# into an HTML attribute, so quotes, spaces and anything else unexpected must stop the build.
ADDRESS='^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
clean() { # prints the address without trailing slashes, or fails
  local value="${1%/}"
  while [ "${value%/}" != "$value" ]; do value="${value%/}"; done
  if ! [[ "$value" =~ $ADDRESS ]]; then
    echo "build_pages.sh: not a usable API address: '$1' (expected for example https://api.example.org)" >&2
    exit 2
  fi
  case "$value" in */api) echo "build_pages.sh: give the address without the trailing /api: '$1'" >&2; exit 2 ;; esac
  printf '%s' "$value"
}
origin_of() { printf '%s' "$1" | sed -E 's#^(https?://[^/]+).*#\1#'; }

BASES=()
if [ -n "$API_BASE" ]; then BASES+=("$(clean "$API_BASE")"); fi
ALTS=()
if [ -n "$API_ALTERNATIVES" ]; then
  IFS=',' read -r -a RAW <<< "$API_ALTERNATIVES"
  for a in "${RAW[@]}"; do
    a="$(printf '%s' "$a" | tr -d '[:space:]')"
    [ -n "$a" ] && ALTS+=("$(clean "$a")")
  done
fi
if [ ${#BASES[@]} -eq 0 ] && [ ${#ALTS[@]} -gt 0 ]; then
  echo "build_pages.sh: API_ALTERNATIVES needs API_BASE as well" >&2
  exit 2
fi

case "$OUT" in ""|"/"|"$ROOT"|"$WEB") echo "build_pages.sh: refusing to write to '$OUT'" >&2; exit 2 ;; esac
rm -rf "$OUT"
mkdir -p "$OUT"

# Copy the page: everything the browser can ask for, nothing else.
( cd "$WEB" && find . -type f \
    ! -path './tests/*' ! -path './vendor/*' ! -path './fixtures-provisional/*' \
    ! -name '*.md' ! -name '*.sh' ! -name '.*' -print0 ) |
  while IFS= read -r -d '' f; do
    mkdir -p "$OUT/$(dirname "$f")"
    cp "$WEB/$f" "$OUT/$f"
  done
touch "$OUT/.nojekyll"

# config.js
js_list() { local first=1 out=""; for v in "$@"; do out+="$([ $first -eq 1 ] || printf ', ')'$v'"; first=0; done; printf '%s' "$out"; }
DEMO_ONLY=false
[ ${#BASES[@]} -eq 0 ] && DEMO_ONLY=true
{
  echo "// Written by scripts/build_pages.sh for the GitHub Pages build. See web/config.js in the"
  echo "// repository for what each field means."
  echo "export default {"
  echo "  apiBase: '${BASES[0]:-}',"
  echo "  apiAlternatives: [$(js_list "${ALTS[@]+"${ALTS[@]}"}")],"
  echo "  demoOnly: $DEMO_ONLY,"
  echo "};"
} > "$OUT/config.js"

# Content-Security-Policy: allow connections to the API origins, and to nothing else.
ORIGINS=""
for b in "${BASES[@]+"${BASES[@]}"}" "${ALTS[@]+"${ALTS[@]}"}"; do
  o="$(origin_of "$b")"
  case " $ORIGINS " in *" $o "*) ;; *) ORIGINS="${ORIGINS:+$ORIGINS }$o" ;; esac
done
if ! grep -q "connect-src 'self';" "$OUT/index.html"; then
  echo "build_pages.sh: index.html has no \"connect-src 'self';\" to extend" >&2
  exit 3
fi
if [ -n "$ORIGINS" ]; then
  sed -i.bak "s#connect-src 'self';#connect-src 'self' $ORIGINS;#" "$OUT/index.html"
  rm -f "$OUT/index.html.bak"
fi

# Sanity: the page must work under /<repo>/, so nothing may point at the domain root.
if grep -nE '(href|src)="/' "$OUT/index.html"; then
  echo "build_pages.sh: index.html has a URL that starts at the domain root" >&2
  exit 3
fi

# Report.
size() { wc -c < "$1" | tr -d ' '; }
gz() { gzip -9 -c "$1" | wc -c | tr -d ' '; }
kb() { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1024 }'; }
total=0; files=0
while IFS= read -r -d '' f; do total=$((total + $(size "$f"))); files=$((files + 1)); done < <(find "$OUT" -type f -print0)
first_raw=0; first_gz=0; first_n=0
FIRST=(index.html css/app.css i18n/en.json)
while IFS= read -r m; do FIRST+=("$m"); done < <(grep -o 'rel="modulepreload" href="[^"]*"' "$OUT/index.html" | sed 's/.*href="//; s/"$//')
for f in "${FIRST[@]}"; do
  first_raw=$((first_raw + $(size "$OUT/$f"))); first_gz=$((first_gz + $(gz "$OUT/$f"))); first_n=$((first_n + 1))
done
demo_gz=0
for f in version indices; do [ -f "$OUT/fixtures/$f.json" ] && demo_gz=$((demo_gz + $(gz "$OUT/fixtures/$f.json"))); done
fix_raw=0
while IFS= read -r -d '' f; do fix_raw=$((fix_raw + $(size "$f"))); done < <(find "$OUT/fixtures" -type f -print0 2>/dev/null)

echo "Pages build written to $OUT"
if [ ${#BASES[@]} -gt 0 ]; then
  echo "  API:                ${BASES[0]}/api${ALTS[0]:+ (alternatives: ${ALTS[*]})}"
  echo "  connect-src:        'self' $ORIGINS"
else
  echo "  API:                none (demonstration only)"
  echo "  connect-src:        'self'"
fi
echo "  files:              $files, $(kb "$total") KB in total ($(kb "$fix_raw") KB of that is saved examples, fetched only when used)"
echo "  first load:         $first_n requests, $(kb "$first_raw") KB raw, $(kb "$first_gz") KB gzipped"
echo "  + in demonstration: 2 small saved examples on first load, $(kb "$demo_gz") KB gzipped (version, list of indices); the large ones only when a step needs them"
