#!/usr/bin/env bash
# Runs every suite in tests/suites one after another and prints a table. Exit code is non-zero when any test fails.
#   PAGE=/path/to/index.html   page under test (default: ../index.html)
#   BASE=/path/to/base.html    baseline page for the BASE-vs-NEW suites; when unset it is taken from `git show origin/main:index.html`
#   ONLY=regex                 run only the tests whose title matches
#   SUITES="03 05"             run only the suites whose file name starts with one of these
cd "$(dirname "$0")" || exit 2
ROOT="$(cd .. && pwd)"
mkdir -p .results .tmp
rm -f .results/*.json
if [ -z "${BASE:-}" ]; then
  if git -C "$ROOT" cat-file -e origin/main:index.html 2>/dev/null; then
    BASE="$PWD/.tmp/base.html"
    git -C "$ROOT" show origin/main:index.html > "$BASE"
    export BASE
  else
    echo "note: no BASE page (origin/main not found); the BASE-vs-NEW tests are skipped"
  fi
else
  export BASE
fi
export PAGE="${PAGE:-$ROOT/index.html}"
echo "page under test: $PAGE"
[ -n "${BASE:-}" ] && echo "baseline page:   $BASE"
start=$(date +%s)
status=0
for f in suites/*.js; do
  n="$(basename "$f")"
  if [ -n "${SUITES:-}" ]; then
    keep=0; for s in $SUITES; do case "$n" in "$s"*) keep=1;; esac; done
    [ $keep -eq 1 ] || continue
  fi
  echo; echo "== $n"
  node "$f" || status=1
done
echo
node lib/table.js || status=1
echo "total time: $(( $(date +%s) - start )) s"
exit $status
