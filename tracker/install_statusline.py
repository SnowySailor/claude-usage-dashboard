#!/usr/bin/env python3
"""Point Claude Code's statusLine at tracker/statusline.sh, or undo that. Called by install.sh.

  install_statusline.py install     # saves your current statusline command to ~/.claude/usage/statusline-next
  install_statusline.py uninstall   # restores it
"""
import json
import os
import shlex
import shutil
import sys
import time

mode = sys.argv[1] if len(sys.argv) > 1 else ""
if mode not in ("install", "uninstall"):
    sys.exit(f"usage: {sys.argv[0]} install|uninstall")

claude_dir = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
settings_path = os.path.join(claude_dir, "settings.json")
next_path = os.path.join(claude_dir, "usage", "statusline-next")
wrapper = shlex.quote(os.path.join(os.path.dirname(os.path.abspath(__file__)), "statusline.sh"))

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
