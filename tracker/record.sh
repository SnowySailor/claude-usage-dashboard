#!/bin/bash
# Record Claude Code usage from statusline JSON (stdin) into ~/.claude/usage/usage.db.
# Returns immediately: the work runs in the background so the statusline never waits on it.
# Add this one line to your own statusline script, where $input holds the JSON Claude Code sent it:
#   echo "$input" | /path/to/claude-usage-dashboard/tracker/record.sh
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USAGE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/usage"
mkdir -p "$USAGE"
input=$(cat)
(printf '%s' "$input" | python3 "$DIR/track.py" record >> "$USAGE/errors.log" 2>&1 &)
