# Claude Usage Dashboard

A local dashboard for your Claude Code usage: cost per day, cost split by token type (input, cache writes, cache reads, output), context size, cache hit rate, and per-session timelines.

Usage is recorded from Claude Code's statusline into a SQLite database at `~/.claude/usage/usage.db`. The dashboard runs in a Docker container, opens that database read-only, and serves at http://localhost:10001. Nothing leaves your machine.

## Requirements

- macOS or Linux
- Claude Code
- `python3` (standard library only)
- Docker, to run the dashboard

## Install

```bash
git clone https://github.com/SnowySailor/claude-usage-dashboard.git
cd claude-usage-dashboard
./install.sh
docker compose up -d --build
```

Then open http://localhost:10001.

`install.sh` does the following:

1. Sets Claude Code's `statusLine` command in `~/.claude/settings.json` to `tracker/statusline.sh`, after backing the file up.
   - If you already had a statusline, it keeps rendering: the tracker runs first, then your previous command.
   - If your statusline already records usage, it's left alone.
2. Imports token usage from the session transcripts already on disk. Use `--no-backfill` to skip this.

The scripts run from this folder, so re-run `./install.sh` if you move it.

### Using your own statusline script

If you'd rather not have the installer touch `settings.json`, add this one line to your statusline script. `$input` is the JSON Claude Code passes it on stdin.

```bash
echo "$input" | /path/to/claude-usage-dashboard/tracker/record.sh
```

It records in the background and returns immediately, so your statusline isn't slowed down.

### Uninstall

```bash
./install.sh --uninstall     # restores your previous statusline
docker compose down
```

The database at `~/.claude/usage/` is kept. Delete it yourself if you want the data gone.

## What gets recorded

| Source | Data |
|---|---|
| Statusline JSON, on each refresh where the session cost changed | Session cost as Claude Code reports it (`cost.total_cost_usd`), duration, lines added/removed |
| Session transcripts (`~/.claude/projects/**.jsonl`), main thread and subagents | Per-request tokens: input, cache writes (5m / 1h), cache reads, output, thinking, web searches |

Cost tracking starts when you install. Transcripts carry tokens but not cost, so imported history gets an *estimated* cost: tokens × the prices in [`app/pricing.json`](app/pricing.json).

## Reading the dashboard

- **All dollar amounts are what the usage would cost at API list prices.** On a Pro or Max plan, they aren't what you pay.
- **Reported vs. estimated.**
  - **Reported** is Claude Code's own cost figure.
  - **Estimated** is computed from token counts.

  They differ slightly, because some calls are charged but never logged to the transcript, mainly compaction summaries.
- **"Tracked data only"** (on by default) limits the view to data the reported cost fully covers. In this mode the cost appears as a single number, and its token-type split adds up to it exactly. Charged cost with no transcript tokens shows as a gray "Not in transcripts" part.
- **Click a session** in the table to see its context size per request (drops are compactions) and its running cost.

## Command line

```bash
python3 tracker/track.py stats          # summary: totals, cost by day, by project, recent sessions
python3 tracker/track.py day 2026-10-21 # sessions charged on one day
python3 tracker/track.py backfill       # re-import token usage from transcripts
```

## Configuration

- **Prices:** edit `app/pricing.json` (USD per million tokens). The dashboard reloads it automatically.
- **Port:** change `127.0.0.1:10001` in `docker-compose.yml`.
- **Auto-compact line:** the context chart marks 350K. Change `AUTO_COMPACT` in `app/static/app.js` to match your setting.
- **Config directory:** `CLAUDE_CONFIG_DIR` is respected by the installer, the tracker, and the Docker mount.

`app/` is mounted into the container, so frontend and pricing edits apply on reload. Changes to `server.py` need `docker compose restart`.

## How it works

```
Claude Code statusline ──► tracker/statusline.sh ──► tracker/record.sh ──► tracker/track.py record
                                     │                                          │
                                     ▼                                          ▼
                     your previous statusline output              ~/.claude/usage/usage.db
                                                                                │  (read-only)
                                                                                ▼
                                                  app/server.py (Docker) ──► http://localhost:10001
```

- **`tracker/track.py`** writes to the database only when a session's cost has changed. Each time, it reads only the new lines of the session's transcripts.
- **`app/server.py`** is a standard-library Python server. It opens the database with a read-only connection.
  - The data folder is mounted read-write anyway: SQLite in WAL mode needs readers to update the `usage.db-shm` index file.
- **The frontend** is plain HTML with Chart.js and Tailwind loaded from CDNs, so the page needs internet access.
