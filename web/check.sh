#!/usr/bin/env bash
# Runs every check that can be made on the front end without a browser.
#
#   web/check.sh                      static checks, unit tests, asset check, page weight
#   CLIMPOC_API=http://127.0.0.1:8000 web/check.sh      also checks the running backend
#   CLIMPOC_NODE_MODULES=/path/to/node_modules web/check.sh   also runs the simulated-DOM test
#                                     (needs jsdom, a development-only dependency that is
#                                     deliberately not stored in this repository)
#
# Needs: bash, node 20 or newer, python3, curl, gzip. Nothing is installed or downloaded.
set -u
cd "$(dirname "$0")"
FAILED=0
PASSED=0
run() { # title, command...
  local title="$1"; shift
  echo
  echo "== $title"
  if "$@"; then PASSED=$((PASSED + 1)); else FAILED=$((FAILED + 1)); echo "   ^^ FAILED: $title"; fi
}

syntax() {
  local bad=0 n=0
  for f in js/*.js tests/*.mjs tests/*.cjs; do
    n=$((n + 1))
    node --check "$f" || bad=1
  done
  python3 -c "import json,sys; [json.load(open(f)) for f in sys.argv[1:]]" i18n/*.json fixtures/*.json || bad=1
  bash -n measure.sh && bash -n check.sh || bad=1
  [ $bad -eq 0 ] && echo "  ok    $n JavaScript files parse (node --check); all JSON files parse; shell scripts parse"
  return $bad
}

unit() {
  local out
  out=$(node --test tests/unit.test.mjs 2>&1)
  local code=$?
  echo "$out" | grep -E '^not ok|^# (tests|pass|fail) ' | sed 's/^/  /'
  [ $code -ne 0 ] && echo "$out" | grep -B2 -A12 '^not ok' | head -60
  return $code
}

assets() {
  local port=$((20000 + RANDOM % 20000)) bad=0 n=0
  python3 -m http.server "$port" --bind 127.0.0.1 >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.1; done
  local refs
  refs=$( { echo ""; grep -oE '(href|src)="[^"#][^"]*"' index.html | sed -E 's/^(href|src)="//; s/"$//' | grep -v '^data:'; ls i18n/*.json fixtures/*.json; } | sort -u)
  for p in $refs; do
    n=$((n + 1))
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/$p")
    if [ "$code" != "200" ]; then bad=1; echo "  FAIL  /$p returned HTTP $code"; fi
  done
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/?fixtures=1")
  [ "$code" = "200" ] || { bad=1; echo "  FAIL  /?fixtures=1 returned HTTP $code"; }
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  [ $bad -eq 0 ] && echo "  ok    $n paths return HTTP 200 from a plain static server (page, stylesheet, modules, language files, fixtures)"
  return $bad
}

dom() {
  node tests/smoke_dom.mjs | sed 's/^/  /'
  return "${PIPESTATUS[0]}"
}

# The GitHub Pages build: only config.js and the CSP differ from web/, and the result works when
# it is served from a sub-path (as a project site at /<repo>/ is).
pages() {
  local build=../scripts/build_pages.sh bad=0 tmp
  if [ ! -x "$build" ]; then echo "  SKIP  ../scripts/build_pages.sh not found"; return 0; fi
  tmp=$(mktemp -d)
  local site="$tmp/some-user/climate-repo" demo="$tmp/demo-only"
  OUT="$site" API_BASE="https://api.example.org/" "$build" > "$tmp/log-a" 2>&1 || { bad=1; echo "  FAIL  build with API_BASE failed"; cat "$tmp/log-a"; }
  OUT="$demo" API_BASE="" "$build" > "$tmp/log-b" 2>&1 || { bad=1; echo "  FAIL  build without API_BASE failed"; cat "$tmp/log-b"; }
  if [ $bad -eq 0 ]; then
    grep -q "apiBase: 'https://api.example.org'," "$site/config.js" && grep -q "demoOnly: false," "$site/config.js" || { bad=1; echo "  FAIL  config.js does not carry the API address"; }
    grep -q "connect-src 'self' https://api.example.org;" "$site/index.html" || { bad=1; echo "  FAIL  CSP connect-src does not name the API origin"; }
    grep -q "apiBase: ''," "$demo/config.js" && grep -q "demoOnly: true," "$demo/config.js" || { bad=1; echo "  FAIL  build without API_BASE is not demonstration-only"; }
    grep -q "connect-src 'self';" "$demo/index.html" || { bad=1; echo "  FAIL  CSP changed although there is no API"; }
    if grep -q 'connect-src[^;]*\*' "$site/index.html" "$demo/index.html"; then bad=1; echo "  FAIL  CSP has a wildcard"; fi
    [ -f "$site/.nojekyll" ] || { bad=1; echo "  FAIL  .nojekyll missing"; }
    local extra
    extra=$(cd "$site" && find . -type f \( -path './tests/*' -o -name '*.md' -o -name '*.sh' \) | head -3)
    [ -z "$extra" ] || { bad=1; echo "  FAIL  build contains files that should not be published: $extra"; }
    # which files differ from web/ (tests, scripts and READMEs aside)?
    local differ
    differ=$(diff -rq -x tests -x '*.md' -x '*.sh' -x .nojekyll . "$site" | sed -E 's#^Files \./([^ ]+) and .*#\1#; s#^Only in .*: #only: #' | sort | tr '\n' ' ')
    [ "$differ" = "config.js index.html " ] || { bad=1; echo "  FAIL  more than config.js and index.html differ from web/: $differ"; }
    differ=$(diff -rq -x tests -x '*.md' -x '*.sh' -x .nojekyll . "$demo" | sed -E 's#^Files \./([^ ]+) and .*#\1#; s#^Only in .*: #only: #' | sort | tr '\n' ' ')
    [ "$differ" = "config.js " ] || { bad=1; echo "  FAIL  the demonstration-only build differs from web/ in more than config.js: $differ"; }
    for addr in "https://x.example/api" "https://x.example'; alert(1)//" "javascript:alert(1)" "https://x.example/?a=1" "https://*.example"; do
      if OUT="$tmp/rejected" API_BASE="$addr" "$build" > /dev/null 2>&1; then bad=1; echo "  FAIL  bad API address accepted: $addr"; fi
    done
    # serve the parent folder, so the site lives at /some-user/climate-repo/ like a project site
    local port=$((20000 + RANDOM % 20000)) n=0 code p
    ( cd "$tmp" && exec python3 -m http.server "$port" --bind 127.0.0.1 > /dev/null 2>&1 ) &
    local pid=$!
    for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$port/" && break; sleep 0.1; done
    local prefix="http://127.0.0.1:$port/some-user/climate-repo"
    local refs
    refs=$( { echo ""; grep -oE '(href|src)="[^"#][^"]*"' "$site/index.html" | sed -E 's/^(href|src)="//; s/"$//' | grep -v '^data:'; (cd "$site" && ls i18n/*.json fixtures/*.json js/*.js); } | sort -u)
    for p in $refs; do
      n=$((n + 1))
      code=$(curl -s -o /dev/null -w '%{http_code}' "$prefix/$p")
      [ "$code" = "200" ] || { bad=1; echo "  FAIL  $prefix/$p returned HTTP $code"; }
    done
    # nothing the page asks for may also be needed at the domain root
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/js/main.js")
    [ "$code" = "404" ] || { bad=1; echo "  FAIL  test set-up: the site is also reachable at the root"; }
    kill "$pid" 2> /dev/null; wait "$pid" 2> /dev/null
    [ $bad -eq 0 ] && echo "  ok    build with an API address: config.js and the CSP connect-src carry it, nothing else differs from web/" \
      && echo "  ok    build without one: demonstration only, CSP untouched; five malformed addresses are refused" \
      && echo "  ok    $n paths return HTTP 200 when the site is served from /some-user/climate-repo/" \
      && grep -E 'first load|in demonstration' "$tmp/log-a" | sed 's/^ */  note  /'
  fi
  rm -rf "$tmp"
  return $bad
}

run "1. Syntax" syntax
run "2. Unit tests of the logic modules (API client, translation, data shaping, chart, storage)" unit
run "3. Static checks (HTML structure, translations, module graph, offline, CSS)" node tests/check_static.mjs
run "4. Colour contrast (WCAG 2.2 AA)" node tests/check_contrast.mjs
run "5. Every referenced asset is served" assets
run "6. Page weight against the budget" ./measure.sh --check
run "7. GitHub Pages build: only the config differs, and it works under a sub-path" pages
run "8. Whole page in a simulated DOM: demonstration, same origin, separate API, API unreachable" dom
if [ -n "${CLIMPOC_API:-}" ]; then
  run "9. Contract check against the running API at $CLIMPOC_API (the DOM test above also ran its 'live' scenario)" node tests/check_api.mjs "$CLIMPOC_API"
else
  echo
  echo "== 9. Contract check against a running API"
  echo "  SKIP  set CLIMPOC_API=http://HOST:PORT to run it"
fi

echo
echo "------------------------------------------------------------"
if [ $FAILED -eq 0 ]; then echo "check.sh: all $PASSED groups passed"; else echo "check.sh: $FAILED group(s) FAILED, $PASSED passed"; fi
echo "Not covered by any of this: how the page looks and behaves in a real browser. See README.md."
exit $FAILED
