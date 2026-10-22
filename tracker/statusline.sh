#!/bin/bash
# Claude Code statusLine command set by install.sh: records usage, then renders the statusline you had
# before installing (saved in ~/.claude/usage/statusline-next), or a minimal one if you had none.
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USAGE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/usage"
input=$(cat)
printf '%s' "$input" | "$DIR/record.sh"
next=$(cat "$USAGE/statusline-next" 2>/dev/null)
if [ -n "$next" ]; then
    printf '%s' "$input" | bash -c "$next"
else
    printf '%s' "$input" | python3 "$DIR/track.py" line
fi
