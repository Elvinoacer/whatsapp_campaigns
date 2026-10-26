#!/usr/bin/env bash
set -uo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$PROJECT_DIR" || exit 1

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo "Usage: ./run.sh [dev|production] [--no-browser] [--skip-build]"
  echo "Run without arguments for the menu. --skip-build reuses an existing production build."
  exit 0
fi

# A file-manager launch needs its own terminal for the menu, logs and stop button.
if [[ ! -t 0 && -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" && "${CAMPAIGNDESK_TERMINAL:-}" != "1" ]]; then
  export CAMPAIGNDESK_TERMINAL=1
  if command -v gnome-terminal >/dev/null 2>&1; then
    exec gnome-terminal --wait -- "$PROJECT_DIR/run.sh" "$@"
  elif command -v x-terminal-emulator >/dev/null 2>&1; then
    exec x-terminal-emulator -e "$PROJECT_DIR/run.sh" "$@"
  fi
fi

MODE="${1:-}"
if [[ -z "$MODE" ]]; then
  if [[ ! -t 0 ]]; then
    echo "Run ./run-dev.sh or ./run-production.sh, or open run.sh in a terminal to choose a mode."
    exit 1
  fi
  echo ""
  echo "CampaignDesk"
  echo "  1) Development — reload when files change"
  echo "  2) Production — build and run"
  echo "  3) Exit"
  read -r -p "Choose 1 or 2: " MODE || exit 0
  case "$MODE" in
    1) MODE=dev ;;
    2) MODE=production ;;
    3) exit 0 ;;
    *) echo "Please choose 1, 2 or 3."; exit 1 ;;
  esac
else
  shift
fi

# Desktop sessions sometimes lack the Node.js path configured in the user's shell.
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
  for candidate in "$HOME"/.nvm/versions/node/v*/bin/node /usr/local/node-v*/bin/node; do
    if [[ -x "$candidate" ]] && "$candidate" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' 2>/dev/null; then
      export PATH="$(dirname -- "$candidate"):$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js 22+ and npm are required. Install them, then run this file again."
  STATUS=1
else
  if [[ ! -t 0 ]]; then
    exec node scripts/platform.mjs "$MODE" "$@"
  fi
  node scripts/platform.mjs "$MODE" "$@"
  STATUS=$?
fi
if [[ -t 0 ]]; then
  echo ""
  read -r -p "Platform stopped. Press Enter to close this window… " _ || true
fi
exit "$STATUS"
