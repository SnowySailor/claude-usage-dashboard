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

python3 - "$MODE" "$CLAUDE_DIR/settings.json" "$REPO/tracker" "$USAGE/statusline-next" <<'PY'
import json, os, shlex, shutil, sys, time

mode, settings_path, tracker, next_path = sys.argv[1:]
wrapper = shlex.quote(os.path.join(tracker, "statusline.sh"))

try:
    with open(settings_path) as f:
        settings = json.load(f)
except FileNotFoundError:
    settings = {}
except ValueError as e:
    sys.exit(f"{settings_path} is not valid JSON ({e}); fix it and re-run")

status = settings.get("statusLine") or {}
command = status.get("command", "")


def save():
    if os.path.exists(settings_path):
        backup = f"{settings_path}.bak.{time.strftime('%Y%m%d-%H%M%S')}"
        shutil.copy2(settings_path, backup)
        print(f"backed up settings to {backup}")
    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    with open(settings_path, "w") as f:
        json.dump(settings, f, indent=2)
        f.write("\n")


def already_records(cmd):
    """True if the statusline command (or the script it runs) already calls the tracker."""
    texts = [cmd]
    try:
        script = os.path.expanduser(shlex.split(cmd)[0]) if cmd else ""
        if os.path.isfile(script):
            with open(script, errors="ignore") as f:
                texts.append(f.read())
    except ValueError:
        pass
    return any("tracker/record.sh" in t or "track.py record" in t for t in texts)


if mode == "install":
    if command == wrapper:
        print("statusline already points at the tracker")
    elif already_records(command):
        print(f"your statusline ({command}) already records usage; leaving it as is")
    else:
        if command:
            with open(next_path, "w") as f:
                f.write(command + "\n")
            print(f"your current statusline ({command}) keeps rendering after the tracker runs")
        elif os.path.exists(next_path):
            os.remove(next_path)
        settings["statusLine"] = {**status, "type": "command", "command": wrapper}
        save()
        print(f"statusLine.command -> {wrapper}")
else:
    if command != wrapper:
        print("statusline isn't pointing at the tracker; nothing to undo")
        if already_records(command):
            print(f"note: {command} calls the tracker itself; remove that line to stop recording")
        sys.exit(0)
    previous = ""
    if os.path.exists(next_path):
        with open(next_path) as f:
            previous = f.read().strip()
        os.remove(next_path)
    if previous:
        settings["statusLine"] = {**status, "command": previous}
        print(f"statusLine.command restored to {previous}")
    else:
        settings.pop("statusLine", None)
        print("statusLine removed (there was none before installing)")
    save()
PY

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
