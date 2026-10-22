#!/bin/bash
# Set up Claude Code usage tracking for the dashboard.
#
#   ./install.sh                 point Claude Code's statusline at tracker/statusline.sh (keeps your current
#                                statusline's output) and import token usage from existing transcripts
#   ./install.sh --no-backfill   same, without importing existing transcripts
#   ./install.sh --uninstall     restore your previous statusline (the database is kept)
#
# Scripts run from this checkout, so re-run ./install.sh if you move it. Respects CLAUDE_CONFIG_DIR.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
USAGE="$CLAUDE_DIR/usage"
MODE=install
BACKFILL=1
for arg in "$@"; do
    case "$arg" in
        --uninstall) MODE=uninstall ;;
        --no-backfill) BACKFILL=0 ;;
        -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
python3 -c 'import sqlite3' 2>/dev/null || { echo "python3 is missing the sqlite3 module" >&2; exit 1; }
chmod +x "$REPO/tracker/record.sh" "$REPO/tracker/statusline.sh" "$REPO/tracker/track.py"
mkdir -p "$USAGE"

python3 "$REPO/tracker/install_statusline.py" "$MODE"

if [ "$MODE" = install ]; then
    if [ "$BACKFILL" = 1 ]; then
        echo "importing token usage from existing transcripts..."
        python3 "$REPO/tracker/track.py" backfill
    fi
    cat <<MSG

Done. Usage is recorded to $USAGE/usage.db each time the statusline updates.
Cost is only known from now on: transcripts carry tokens, not cost, so imported history is estimated.

Start the dashboard:  docker compose up -d --build   ->  http://localhost:10001
MSG
fi
