#!/usr/bin/env bash
# Hygiene guard: the shell script corpus stays shellcheck-clean (ticket #3),
# and fake-gh's issue listing keeps its numeric ordering (guards the SC2012
# fix). Offline. Run: bash tests/hygiene.sh
set -u
plugin=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d "${TMPDIR:-/tmp}/multipi-hygiene.XXXXXX")
trap 'rm -rf "$work"' EXIT

passed=0
failed=0
pass() { echo "PASS $*"; passed=$((passed + 1)); }
fail() { echo "FAIL $*"; failed=$((failed + 1)); }
expect() { # expect DESCRIPTION EXPECTED ACTUAL
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (expected '$2', got '$3')"; fi
}

# --- shellcheck: the Makefile target is the contract -------------------------
if command -v shellcheck >/dev/null 2>&1; then
  out=$(make -C "$plugin" shellcheck 2>&1)
  rc=$?
  expect "make shellcheck exits 0 under shellcheck $(shellcheck --version | awk '/^version:/{print $2}')" "0" "$rc"
  [ -n "$out" ] && echo "$out"
  if echo "$out" | grep -Eq 'SC[0-9]{4}'; then
    fail "shellcheck printed findings"
  else
    pass "shellcheck reports no findings"
  fi
else
  # Same degrade-to-warning policy as the Makefile target.
  out=$(make -C "$plugin" shellcheck 2>&1)
  rc=$?
  expect "make shellcheck degrades to a warning without the binary" "0" "$rc"
  if echo "$out" | grep -q "WARNING: shellcheck not installed"; then
    pass "absence warns instead of skipping silently"
  else
    fail "no absence warning"
  fi
fi

# --- the gate wiring: hygiene must be visible to the batch gate ---------------
# The gate reads its checks from .devloop.json, not from `make check` (learned
# the hard way in gate round 1): the suite must be exposed there. Same reader
# policy as the loop itself: jq when installed, else python3.
gate_check_field() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '[.checks[]? | select(.name == "hygiene")] | first // empty
      | "\(.command) \(.heavy)"' "$plugin/.devloop.json" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json, sys
e = [c for c in json.load(open(sys.argv[1])).get("checks", [])
      if isinstance(c, dict) and c.get("name") == "hygiene"]
sys.stdout.write("%s %s" % (e[0]["command"], str(e[0]["heavy"]).lower()) if e else "")' \
      "$plugin/.devloop.json" 2>/dev/null
  fi
}
expect ".devloop.json exposes the hygiene check to the gate (non-heavy)" \
  "bash tests/hygiene.sh false" "$(gate_check_field)"

# --- fake-gh issue list: numeric ordering ------------------------------------
list_numbers() { # list_numbers STATE -> space-separated issue numbers, in order
  FAKE_GH_DIR="$work/gh" "$plugin/tests/fake-gh" issue list --state "$1" --json number \
    | sed -n 's/.*"number":\([0-9]*\).*/\1/p' | tr '\n' ' ' | sed -e 's/ $//'
}
expect "issue list is empty for a fresh fake gh (open)" \
  "0" "$(FAKE_GH_DIR="$work/gh" "$plugin/tests/fake-gh" issue list --state open >/dev/null 2>&1; echo $?)"
expect "issue list (open) sorts numerically, not lexicographically" \
  "1 2 10" "$(printf 'one\nb\n' >"$work/gh/issues/1";
            printf 'two\nb\n' >"$work/gh/issues/2";
            printf 'ten\nb\n' >"$work/gh/issues/10";
            list_numbers open)"
expect "issue list (closed) sorts numerically too" \
  "3 11" "$(printf 'three\nb\n' >"$work/gh/issues-closed/3";
           printf 'eleven\nb\n' >"$work/gh/issues-closed/11";
           list_numbers closed)"
expect "issue list without --json stays one line per issue" \
  "#1 one" "$(FAKE_GH_DIR="$work/gh" "$plugin/tests/fake-gh" issue list --state open | head -1)"

echo "hygiene: $passed passed, $failed failed"
[ "$failed" -eq 0 ]
