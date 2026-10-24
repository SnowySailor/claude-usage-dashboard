#!/usr/bin/env python3
"""Claude Code usage tracker -> ~/.claude/usage/usage.db (SQLite).

  track.py record     # stdin = statusline JSON; called by statusline-wrapper.sh on every statusline refresh
  track.py line       # stdin = statusline JSON; print a minimal status line (used when no other statusline is set)
  track.py backfill   # ingest token usage from every transcript still on disk (no cost: transcripts don't carry it)
  track.py stats      # print a summary
  track.py day [DATE] # sessions billed on one local day (YYYY-MM-DD, default today)

Cost comes from Claude Code itself (statusline cost.total_cost_usd). Per-request token
usage comes from the session transcript (+ subagent transcripts), deduped by requestId. Pro/Max plan limits
(5-hour and weekly use) come from the statusline's rate_limits; API accounts don't get them.
"""
import glob
import json
import math
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone

CLAUDE_DIR = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
DB = os.path.join(CLAUDE_DIR, "usage", "usage.db")
STATE = os.path.join(CLAUDE_DIR, "usage", "state")  # last seen raw cost per session
PROJECTS = os.path.join(CLAUDE_DIR, "projects")
CONFIG = os.path.join(CLAUDE_DIR, ".claude.json") if os.environ.get("CLAUDE_CONFIG_DIR") \
    else os.path.expanduser("~/.claude.json")
WEEK = 7 * 86400
MANAGED_SETTINGS = ("/Library/Application Support/ClaudeCode/managed-settings.json",
                    "/etc/claude-code/managed-settings.json")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id     TEXT PRIMARY KEY,
    cwd            TEXT,
    model          TEXT,
    version        TEXT,
    cost_usd       REAL,     -- session total (survives cost counter resets on resume)
    cost_raw_last  REAL,     -- last raw cost.total_cost_usd seen
    cost_base      REAL DEFAULT 0,
    duration_ms    INTEGER,
    api_duration_ms INTEGER,
    lines_added    INTEGER,
    lines_removed  INTEGER,
    first_seen     TEXT,     -- first time the statusline saw a non-zero cost
    last_seen      TEXT,     -- last time the statusline saw the cost change
    compact_window INTEGER   -- auto-compact window in effect, in tokens
);
CREATE TABLE IF NOT EXISTS cost_events (
    session_id TEXT,
    ts         TEXT,
    cost_usd   REAL,         -- cumulative session cost at ts
    delta_usd  REAL,         -- cost added since the previous event
    account    TEXT          -- accounts.account the session was on
);
CREATE INDEX IF NOT EXISTS cost_events_ts ON cost_events(ts);
CREATE TABLE IF NOT EXISTS rate_limits (
    session_id          TEXT,
    ts                  TEXT,
    five_hour_pct       REAL,     -- Pro/Max plan limits, account-wide, as of this session's latest response
    five_hour_resets_at INTEGER,  -- unix seconds
    seven_day_pct       REAL,
    seven_day_resets_at INTEGER,
    account             TEXT
);
CREATE INDEX IF NOT EXISTS rate_limits_session ON rate_limits(session_id, ts);
CREATE TABLE IF NOT EXISTS accounts (
    account      TEXT PRIMARY KEY,  -- accountUuid/organizationUuid of the Claude login
    email        TEXT,
    organization TEXT,
    last_seen    TEXT
);
CREATE TABLE IF NOT EXISTS requests (
    request_id     TEXT PRIMARY KEY,
    session_id     TEXT,
    agent_id       TEXT,     -- NULL for the main thread, else the subagent id
    ts             TEXT,
    cwd            TEXT,
    model          TEXT,
    input_tokens   INTEGER,
    cache_write_5m INTEGER,
    cache_write_1h INTEGER,
    cache_read     INTEGER,
    output_tokens  INTEGER,
    thinking_tokens INTEGER,
    web_searches   INTEGER,
    web_fetches    INTEGER,
    speed          TEXT,
    service_tier   TEXT
);
CREATE INDEX IF NOT EXISTS requests_session ON requests(session_id);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE TABLE IF NOT EXISTS ingested_files (
    path   TEXT PRIMARY KEY,
    offset INTEGER
);
DROP VIEW IF EXISTS session_stats;
CREATE VIEW session_stats AS
SELECT ids.session_id,
       COALESCE(s.cwd, r.cwd)          AS cwd,
       COALESCE(s.model, r.model)      AS model,
       s.cost_usd,
       COALESCE(r.first_request, s.first_seen) AS first_request,
       COALESCE(r.last_request,  s.last_seen)  AS last_request,
       r.requests, r.subagent_requests,
       r.input_tokens, r.cache_write_5m, r.cache_write_1h, r.cache_read,
       r.output_tokens, r.thinking_tokens,
       s.duration_ms, s.api_duration_ms, s.lines_added, s.lines_removed, s.compact_window
FROM (SELECT session_id FROM sessions UNION SELECT session_id FROM requests) ids
LEFT JOIN sessions s USING (session_id)
LEFT JOIN (
    SELECT session_id,
           (SELECT cwd FROM requests r1 WHERE r1.session_id = requests.session_id AND agent_id IS NULL ORDER BY ts LIMIT 1) AS cwd,
           (SELECT model FROM requests r1 WHERE r1.session_id = requests.session_id AND agent_id IS NULL ORDER BY ts DESC LIMIT 1) AS model,
           MIN(ts) AS first_request, MAX(ts) AS last_request,
           COUNT(*) AS requests, COUNT(agent_id) AS subagent_requests,
           SUM(input_tokens) AS input_tokens, SUM(cache_write_5m) AS cache_write_5m,
           SUM(cache_write_1h) AS cache_write_1h, SUM(cache_read) AS cache_read,
           SUM(output_tokens) AS output_tokens, SUM(thinking_tokens) AS thinking_tokens
    FROM requests GROUP BY session_id
) r USING (session_id);
"""


COLUMNS = (("sessions", "compact_window", "INTEGER"), ("cost_events", "account", "TEXT"),
           ("rate_limits", "account", "TEXT"))


def connect():
    os.makedirs(os.path.dirname(DB), exist_ok=True)
    db = sqlite3.connect(DB, timeout=15)
    db.execute("PRAGMA journal_mode=WAL")
    # IMMEDIATE: concurrent statusline refreshes otherwise race to drop and recreate the view.
    db.executescript("BEGIN IMMEDIATE;" + SCHEMA)
    missing = [(t, c, kind) for t, c, kind in COLUMNS if c not in {r[1] for r in db.execute(f"PRAGMA table_info({t})")}]
    # Rows from before accounts were recorded belong to the account logged in now. Read it before altering
    # anything, so a config that can't be read leaves the columns missing and the backfill for the next write.
    account = current_account() if any(c == "account" for _, c, _ in missing) else None
    for t, c, kind in missing:
        db.execute(f"ALTER TABLE {t} ADD COLUMN {c} {kind}")
        if c == "account" and account:
            db.execute(f"UPDATE {t} SET account = ? WHERE account IS NULL", (account[0],))
    if account:
        seen(db, account)
    db.commit()
    return db


def current_account():
    """(key, email, organization) of the Claude login in Claude Code's global config, or None without one (API key).
    The limits belong to a seat in an organization, so the key is accountUuid/organizationUuid."""
    for attempt in range(4):
        try:
            with open(CONFIG) as f:
                config = json.load(f)
            break
        except FileNotFoundError:
            return None
        except ValueError:  # Claude Code is rewriting it
            if attempt == 3:
                raise
            time.sleep(0.05)
    a = config.get("oauthAccount") if isinstance(config, dict) else None
    if not isinstance(a, dict) or not a.get("accountUuid"):
        return None
    return f"{a['accountUuid']}/{a.get('organizationUuid')}", a.get("emailAddress"), a.get("organizationName")


def seen(db, account):
    db.execute("""
        INSERT INTO accounts VALUES (?,?,?,?) ON CONFLICT(account) DO UPDATE SET
            email = excluded.email, organization = excluded.organization, last_seen = excluded.last_seen
        """, (*account, now_iso()))


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def ingest_file(db, path, agent_id=None):
    """Read new complete lines of a transcript since the last ingest and upsert its requests."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return
    row = db.execute("SELECT offset FROM ingested_files WHERE path = ?", (path,)).fetchone()
    offset = row[0] if row and row[0] <= size else 0
    if offset == size:
        return
    with open(path, "rb") as f:
        f.seek(offset)
        data = f.read()
    end = data.rfind(b"\n") + 1  # leave a partially written last line for next time
    rows = []
    for line in data[:end].splitlines():
        if b'"usage"' not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        msg = e.get("message") or {}
        u = msg.get("usage")
        rid = e.get("requestId")
        if e.get("type") != "assistant" or not u or not rid:
            continue
        cc = u.get("cache_creation") or {}
        cw_total = u.get("cache_creation_input_tokens") or 0
        cw_1h = cc.get("ephemeral_1h_input_tokens") or 0
        cw_5m = cc.get("ephemeral_5m_input_tokens", cw_total - cw_1h) or 0
        stu = u.get("server_tool_use") or {}
        rows.append((
            rid, e.get("sessionId"), agent_id, e.get("timestamp"), e.get("cwd"), msg.get("model"),
            u.get("input_tokens") or 0, cw_5m, cw_1h, u.get("cache_read_input_tokens") or 0,
            u.get("output_tokens") or 0, (u.get("output_tokens_details") or {}).get("thinking_tokens") or 0,
            stu.get("web_search_requests") or 0, stu.get("web_fetch_requests") or 0,
            u.get("speed"), u.get("service_tier"),
        ))
    # A request is logged once per content block; later entries carry the final usage, so REPLACE keeps the last.
    db.executemany("INSERT OR REPLACE INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)
    db.execute("INSERT OR REPLACE INTO ingested_files VALUES (?, ?)", (path, offset + end))


def ingest_session(db, transcript_path):
    ingest_file(db, transcript_path)
    for sub in glob.glob(os.path.join(transcript_path[:-len(".jsonl")], "subagents", "*.jsonl")):
        ingest_file(db, sub, os.path.basename(sub)[:-len(".jsonl")])


def window_tokens(v):
    """Tokens from an auto-compact window value (200000, "200k", "1M"), or None if invalid or out of range."""
    if isinstance(v, str):
        m = re.fullmatch(r"(\d+(?:\.\d+)?)([kKmM]?)", v.strip())
        v = float(m[1]) * {"": 1, "k": 1e3, "m": 1e6}[m[2].lower()] if m else None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return int(v) if 100_000 <= v <= 1_000_000 else None


def settings_window(d):
    """modelSettings.<model>.autoCompactWindow, else autoCompactWindow, from the highest-precedence settings file
    that sets either. None for "auto"."""
    norm = lambda m: (m or "").lower().removesuffix("[1m]")
    model = norm((d.get("model") or {}).get("id"))
    project = (d.get("workspace") or {}).get("project_dir") or d.get("cwd")
    project_files = (os.path.join(project, ".claude", "settings.local.json"),
                     os.path.join(project, ".claude", "settings.json")) if project else ()
    for path in MANAGED_SETTINGS + project_files + (os.path.join(CLAUDE_DIR, "settings.json"),):
        try:
            with open(path) as f:
                s = json.load(f)
        except (OSError, ValueError):
            continue
        if not isinstance(s, dict):
            continue
        per_model = {norm(k): v for k, v in (s.get("modelSettings") or {}).items() if isinstance(v, dict)}
        for v in ((per_model.get(model) or {}).get("autoCompactWindow"), s.get("autoCompactWindow")):
            if v == "auto":
                return None
            if window_tokens(v):
                return window_tokens(v)
    return None


def compact_window(d):
    """Auto-compact window for the session, resolved like Claude Code does, capped at the model's context window.
    A window passed with --autocompact isn't visible here."""
    size = (d.get("context_window") or {}).get("context_window_size")
    window = window_tokens(os.environ.get("CLAUDE_CODE_AUTO_COMPACT_WINDOW")) or settings_window(d)
    return min(window, size) if window and size else window or size


def plan_limits(d):
    """(five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at) from the statusline's rate_limits,
    or None when neither window is there: API accounts never get them, and spend_limit isn't a plan limit."""
    rl = d.get("rate_limits")
    number = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None
    out = []
    for key in ("five_hour", "seven_day"):
        w = rl.get(key) if isinstance(rl, dict) else None
        w = w if isinstance(w, dict) else {}
        pct, resets = number(w.get("used_percentage")), number(w.get("resets_at"))
        out += [float(pct) if pct is not None else None, int(resets) if resets is not None else None]
    return tuple(out) if any(v is not None for v in out) else None


def switched(prev_reset, reset):
    """Whether a session's weekly reset moved by something other than whole weeks: another account answered."""
    if prev_reset is None or reset is None:
        return False
    off = (reset - prev_reset) % WEEK
    return 3600 < off < WEEK - 3600


def record():
    d = json.load(sys.stdin)
    sid = d.get("session_id")
    if not sid:
        return
    cost = d.get("cost") or {}
    raw = float(cost.get("total_cost_usd") or 0)
    limits = plan_limits(d)
    # The statusline refreshes far more often than requests happen: only touch the DB when the cost or the plan
    # limits changed. Both change only when this session gets a response, so an idle session never writes the
    # stale limits it still holds.
    key = repr((raw, limits))
    state = os.path.join(STATE, os.path.basename(sid))
    try:
        with open(state) as f:
            if f.read().strip() == key:
                return
    except OSError:
        pass
    os.makedirs(STATE, exist_ok=True)
    with open(state, "w") as f:
        f.write(key)
    ts = now_iso()
    db = connect()
    with db:
        prev = db.execute("SELECT cost_raw_last, cost_base, cost_usd FROM sessions WHERE session_id = ?", (sid,)).fetchone()
        raw_last, base, total_prev = prev if prev else (0.0, 0.0, 0.0)
        raw_last, base, total_prev = raw_last or 0.0, base or 0.0, total_prev or 0.0
        if raw < raw_last:  # counter restarted (e.g. resumed in a new process): keep what was already spent
            base += raw_last
        total = base + raw
        changed = total > total_prev + 1e-9
        db.execute("""
            INSERT INTO sessions (session_id, cwd, model, version, cost_usd, cost_raw_last, cost_base,
                                  duration_ms, api_duration_ms, lines_added, lines_removed, first_seen, last_seen,
                                  compact_window)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(session_id) DO UPDATE SET
                cwd = excluded.cwd, model = excluded.model, version = excluded.version,
                cost_usd = excluded.cost_usd, cost_raw_last = excluded.cost_raw_last, cost_base = excluded.cost_base,
                duration_ms = excluded.duration_ms, api_duration_ms = excluded.api_duration_ms,
                lines_added = excluded.lines_added, lines_removed = excluded.lines_removed,
                compact_window = excluded.compact_window,
                first_seen = COALESCE(sessions.first_seen, excluded.first_seen),
                last_seen = CASE WHEN ? THEN excluded.last_seen ELSE sessions.last_seen END
            """, (sid, (d.get("workspace") or {}).get("project_dir") or d.get("cwd"),
                  (d.get("model") or {}).get("id"), d.get("version"), total, raw, base,
                  cost.get("total_duration_ms"), cost.get("total_api_duration_ms"),
                  cost.get("total_lines_added"), cost.get("total_lines_removed"),
                  ts if total > 0 else None, ts if total > 0 else None, compact_window(d), changed))
        last = db.execute("""
            SELECT five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at, account FROM rate_limits
            WHERE session_id = ? ORDER BY ts DESC LIMIT 1""", (sid,)).fetchone()
        # The global config shows the latest login, but a session started before a /login elsewhere can still be
        # on the old account. So a session keeps its account until its weekly reset moves off its weekly schedule.
        account = last and last[4]
        if not account or limits and switched(last[3], limits[3]):
            current = current_account()
            account = current and current[0]
            if current:
                seen(db, current)
        if changed:
            db.execute("INSERT INTO cost_events (session_id, ts, cost_usd, delta_usd, account) VALUES (?,?,?,?,?)",
                       (sid, ts, total, total - total_prev, account))
        # A blocked request costs nothing but still moves the limits, so they get their own table.
        if limits and limits != (last and last[:4]):
            db.execute("""
                INSERT INTO rate_limits (session_id, ts, five_hour_pct, five_hour_resets_at, seven_day_pct,
                                         seven_day_resets_at, account)
                VALUES (?,?,?,?,?,?,?)""", (sid, ts, *limits, account))
        tp = d.get("transcript_path")
        if tp and tp.endswith(".jsonl"):
            ingest_session(db, tp)


def backfill():
    db = connect()
    paths = glob.glob(os.path.join(PROJECTS, "*", "*.jsonl"))
    for p in paths:
        with db:
            ingest_session(db, p)
    n = db.execute("SELECT COUNT(*), COUNT(DISTINCT session_id) FROM requests").fetchone()
    print(f"ingested {len(paths)} transcripts: {n[0]} requests across {n[1]} sessions")


def show(db, title, sql, params=()):
    cur = db.execute(sql, params)
    cols = [c[0] for c in cur.description]
    rows = [[("" if v is None else f"{v:,.2f}" if isinstance(v, float) else f"{v:,}" if isinstance(v, int) else str(v)) for v in r] for r in cur]
    w = [max([len(c)] + [len(r[i]) for r in rows]) for i, c in enumerate(cols)]
    print(f"\n== {title}")
    print("  ".join(c.ljust(w[i]) for i, c in enumerate(cols)))
    for r in rows:
        print("  ".join(v.rjust(w[i]) if i else v.ljust(w[i]) for i, v in enumerate(r)))


# Cost billed per (session, local day) from cost_events, joined with the tokens of that session's requests on that day.
SESSION_DAYS = """
WITH c AS (
    SELECT session_id, date(ts, 'localtime') AS day, SUM(delta_usd) AS cost_usd FROM cost_events GROUP BY 1, 2
), t AS (
    SELECT session_id, date(ts, 'localtime') AS day, COUNT(*) AS requests,
           time(MIN(ts), 'localtime') AS first, time(MAX(ts), 'localtime') AS last,
           SUM(input_tokens) AS input, SUM(cache_write_5m + cache_write_1h) AS cache_write,
           SUM(cache_read) AS cache_read, SUM(output_tokens) AS output
    FROM requests GROUP BY 1, 2
)
SELECT day, substr(session_id, 1, 8) AS session,
       replace(st.cwd, rtrim(st.cwd, replace(st.cwd, '/', '')), '') AS project,
       c.cost_usd, st.cost_usd AS session_total, t.requests, t.first, t.last,
       t.input, t.cache_write, t.cache_read, t.output
FROM c LEFT JOIN t USING (session_id, day) JOIN session_stats st USING (session_id)
"""


def day():
    """Sessions billed on one local day (default today): track.py day [YYYY-MM-DD]"""
    db = connect()
    d = sys.argv[2] if len(sys.argv) > 2 else datetime.now().strftime("%Y-%m-%d")
    show(db, f"Billed on {d}", SESSION_DAYS + " WHERE day = ? ORDER BY c.cost_usd DESC", (d,))
    show(db, "Total", "SELECT SUM(delta_usd) AS cost_usd, COUNT(DISTINCT session_id) AS sessions "
         "FROM cost_events WHERE date(ts, 'localtime') = ?", (d,))


def stats():
    db = connect()
    show = lambda title, sql: globals()["show"](db, title, sql)
    show("All time", """SELECT COUNT(*) AS sessions, COUNT(cost_usd) AS with_cost, SUM(cost_usd) AS cost_usd,
        SUM(requests) AS requests, SUM(input_tokens) AS input, SUM(cache_write_5m + cache_write_1h) AS cache_write,
        SUM(cache_read) AS cache_read, SUM(output_tokens) AS output FROM session_stats""")
    show("Cost by day (last 14)", """SELECT date(ts, 'localtime') AS day, SUM(delta_usd) AS cost_usd,
        COUNT(DISTINCT session_id) AS sessions FROM cost_events GROUP BY day ORDER BY day DESC LIMIT 14""")
    show("Cost by session per day (last 7 days)", SESSION_DAYS +
         " WHERE day >= date('now', 'localtime', '-6 days') ORDER BY day DESC, c.cost_usd DESC")
    show("By project", """SELECT replace(cwd, rtrim(cwd, replace(cwd, '/', '')), '') AS project, COUNT(*) AS sessions,
        SUM(cost_usd) AS cost_usd, SUM(requests) AS requests, SUM(output_tokens) AS output
        FROM session_stats GROUP BY project ORDER BY cost_usd DESC NULLS LAST, requests DESC""")
    show("Recent sessions", """SELECT substr(session_id, 1, 8) AS session,
        replace(cwd, rtrim(cwd, replace(cwd, '/', '')), '') AS project, model, cost_usd,
        datetime(first_request, 'localtime') AS first_request, datetime(last_request, 'localtime') AS last_request,
        requests, output_tokens AS output FROM session_stats ORDER BY last_request DESC LIMIT 15""")


def line():
    """Minimal status line: [model] $cost · context %."""
    d = json.load(sys.stdin)
    model = (d.get("model") or {}).get("display_name") or "Claude"
    cost = float((d.get("cost") or {}).get("total_cost_usd") or 0)
    pct = (d.get("context_window") or {}).get("used_percentage")
    print(f"[{model}] ${cost:.2f}" + (f" · {pct:.0f}% ctx" if isinstance(pct, (int, float)) else ""))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stats"
    {"record": record, "line": line, "backfill": backfill, "stats": stats, "day": day}[cmd]()
