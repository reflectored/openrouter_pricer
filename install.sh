#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/orp"

if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun is required. Install it first: https://bun.sh" >&2
  exit 1
fi

cd "$PROJECT_DIR"
bun install
chmod +x "$PROJECT_DIR/bin/orp"

mkdir -p "$BIN_DIR"
ln -sf "$PROJECT_DIR/bin/orp" "$TARGET"

echo "Installed: $TARGET -> $PROJECT_DIR/bin/orp"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    echo
    echo "warning: $BIN_DIR is not in PATH. Add it with:"
    echo "  export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac

if [ -z "${OPENROUTER_API_KEY:-}" ]; then
  echo
  echo "note: OPENROUTER_API_KEY is not set. OpenRouter hides throughput/latency"
  echo "      from unauthenticated endpoints requests, so orp's tps column will be blank."
  echo "      Store it in the OS keyring with: orp key set"
  echo "      (uses secret-tool or the Python keyring CLI; install libsecret-tools for secret-tool)."
fi

echo
echo "Try: orp --model deepseek/deepseek-chat --list"
