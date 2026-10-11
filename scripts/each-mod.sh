#!/bin/sh
# Runs one check over every plugin: typecheck, lint, test or validate.
# Usage: sh scripts/each-mod.sh <check> [paths...]
set -eu

tsc=node_modules/typescript-latest/bin/tsc
eslint=node_modules/.bin/eslint
failed=0

has_code() {
  [ -n "$(find "$1" \( -name node_modules -o -path '*/.claude-plugin/types' \) -prune -o \
    -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.ts' -o -name '*.mts' -o -name '*.cts' -o -name '*.tsx' \) \
    -print | head -1)" ]
}

typecheck() {
  for config in tsconfig.json plugins/*/tsconfig.json plugins/*/scripts/tsconfig.json; do
    [ -f "$config" ] || continue
    echo "tsc -p $config"
    "$tsc" -p "$config" || failed=1
  done
}

# One ESLint process per plugin, all at once: each builds its own TypeScript
# program, and a type-aware check can spend minutes warming one up.
lint() {
  if [ $# -gt 0 ]; then
    "$eslint" --max-warnings 0 "$@" || failed=1
    return
  fi
  logs=$(mktemp -d)
  trap 'rm -rf "$logs"' EXIT
  jobs=""
  "$eslint" --max-warnings 0 --ignore-pattern 'plugins/**' . >"$logs/root" 2>&1 &
  jobs="$!:root"
  for dir in plugins/*/; do
    dir=${dir%/}
    has_code "$dir" || continue
    name=$(basename "$dir")
    "$eslint" --max-warnings 0 "$dir" >"$logs/$name" 2>&1 &
    jobs="$jobs $!:$name"
  done
  for job in $jobs; do
    name=${job#*:}
    if wait "${job%%:*}"; then
      echo "eslint $name: ok"
    else
      echo "eslint $name: failed"
      failed=1
    fi
    cat "$logs/$name"
  done
}

test_mods() {
  for hooks in plugins/*/hooks/hooks.json; do
    [ -f "$hooks" ] || continue
    claude plugin test "${hooks%/hooks/hooks.json}" || failed=1
  done
}

validate() {
  for manifest in plugins/*/.claude-plugin/plugin.json; do
    [ -f "$manifest" ] || continue
    claude plugin validate --strict "${manifest%/.claude-plugin/plugin.json}" || failed=1
  done
  claude plugin validate --strict . || failed=1
}

check=${1:?usage: sh scripts/each-mod.sh typecheck|lint|test|validate [paths...]}
shift
case $check in
  typecheck) typecheck ;;
  lint) lint "$@" ;;
  test) test_mods ;;
  validate) validate ;;
  *)
    echo "Unknown check: $check" >&2
    exit 2
    ;;
esac
exit $failed
