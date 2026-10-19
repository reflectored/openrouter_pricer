#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/orp"

if [ -L "$TARGET" ] || [ -f "$TARGET" ]; then
  rm -f "$TARGET"
  echo "Removed: $TARGET"
else
  echo "Nothing to remove at $TARGET"
fi

if [ "${1:-}" = "--purge" ]; then
  rm -rf "$PROJECT_DIR/node_modules"
  echo "Removed: $PROJECT_DIR/node_modules"
fi

echo "Project files left intact at $PROJECT_DIR"
echo "Run with --purge to also delete node_modules."
