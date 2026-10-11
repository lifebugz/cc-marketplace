#!/bin/sh
# Fails when the committed mod API types are older than the installed Claude Code.
set -eu
if ! command -v claude >/dev/null 2>&1; then
  echo "Claude Code is not installed here, so the types version is not checked."
  exit 0
fi
written=$(sed -n '1s/^\/\/ Written by Claude Code \([0-9.]*\)\.$/\1/p' .claude-types/claude-code/index.d.ts)
installed=$(claude --version | sed -n 's/^\([0-9][0-9.]*\).*/\1/p')
if [ -z "$written" ] || [ -z "$installed" ]; then
  echo "Could not read the versions (types: '$written', claude: '$installed')." >&2
  exit 1
fi
oldest=$(printf '%s\n%s\n' "$written" "$installed" | sort -V | head -1)
if [ "$written" != "$installed" ] && [ "$oldest" = "$written" ]; then
  echo "The committed types are from Claude Code $written, but $installed is installed." >&2
  echo "Load any mod once with 'claude --plugin-dir plugins/<mod>', then run 'bun run types:sync'." >&2
  exit 1
fi
echo "types $written, claude $installed"
