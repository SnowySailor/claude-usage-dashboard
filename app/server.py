#!/usr/bin/env python3
"""Claude Code usage dashboard: a JSON API over ~/.claude/usage/usage.db plus the static frontend.

  GET /api/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=Area/City&project=&model=
  GET /api/session/<session_id>?tz=Area/City

The DB is only ever opened read-only (mode=ro + query_only). Actual billed cost comes from
cost_events (written by track.py from the statusline); the per-token-type split is an estimate:
each request's token counts x pricing.json.
"""
import json
import os
import sqlite3
from collections import Counter, defaultdict, deque
from datetime import date, datetime, timedelta, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DB = os.environ.get("USAGE_DB", "/data/usage.db")
HERE = os.path.dirname(os.path.abspath(__file__))
PRICING_PATH = os.path.join(HERE, "pricing.json")
STATIC = os.path.join(HERE, "static")
PORT = int(os.environ.get("PORT", "8000"))

TOKENS = ("input", "cache_write_5m", "cache_write_1h", "cache_read", "output")
COMPONENTS = TOKENS + ("web_search",)
REQUEST_COLS = """session_id, agent_id, ts, model, input_tokens AS input, cache_write_5m, cache_write_1h,
                  cache_read, output_tokens AS output, thinking_tokens, web_searches, web_fetches, speed"""

_pricing = {"mtime": None, "data": None}


def pricing():
    mtime = os.path.getmtime(PRICING_PATH)
    if _pricing["mtime"] != mtime:
        with open(PRICING_PATH) as f:
            _pricing["data"] = json.load(f)
        _pricing["mtime"] = mtime
    return _pricing["data"]


def rates_for(model):
    models = pricing()["models"]
    if model in models:
        return models[model]
    # Tolerate suffixed ids (e.g. a dated snapshot): longest matching prefix wins.
    prefixes = [k for k in models if model and model.startswith(k)]
    return models[max(prefixes, key=len)] if prefixes else None


def request_cost(r):
    """Estimated USD per billing component for one request row, or None if the model has no price."""
    p = rates_for(r["model"])
    if not p:
        return None
    prompt = r["input"] + r["cache_write_5m"] + r["cache_write_1h"] + r["cache_read"]
    lp = p.get("long_prompt")
    rates = {**p, **lp} if lp and prompt > lp["threshold"] else p
    mult = p.get("fast_multiplier", 1.0) if r["speed"] == "fast" else 1.0
    cost = {k: r[k] * rates[k] * mult / 1e6 for k in TOKENS}
    cost["web_search"] = (r["web_searches"] or 0) * pricing()["web_search_per_1k"] / 1000
    return cost


def cache_savings(r):
    """Net USD saved by caching: reads billed below the input rate, minus the write premium."""
    p = rates_for(r["model"])
    if not p:
        return 0.0
    mult = p.get("fast_multiplier", 1.0) if r["speed"] == "fast" else 1.0
    return mult / 1e6 * (r["cache_read"] * (p["input"] - p["cache_read"])
                         - r["cache_write_5m"] * (p["cache_write_5m"] - p["input"])
                         - r["cache_write_1h"] * (p["cache_write_1h"] - p["input"]))


def context_size(r):
    return r["input"] + r["cache_write_5m"] + r["cache_write_1h"] + r["cache_read"]


def project_name(cwd):
    return os.path.basename((cwd or "").rstrip("/")) or "(unknown)"


def open_db():
    db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    db.execute("PRAGMA query_only = 1")
    db.row_factory = sqlite3.Row
    return db


def read(fn):
    """Run fn(db) inside one read transaction (a consistent snapshot) on a fresh read-only
    connection. Retries once: the WAL index (-shm) isn't shared between the macOS host and the
    Docker VM, so a read racing a track.py write/checkpoint can fail transiently."""
    for attempt in range(2):
        db = open_db()
        try:
            db.execute("BEGIN")
            return fn(db)
        except sqlite3.DatabaseError:
            if attempt:
                raise
        finally:
            db.close()


def utc_iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def parse_ts(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def get_tz(q):
    try:
        return ZoneInfo(q.get("tz") or "UTC")
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo("UTC")


def parse_date(s):
    try:
        return date.fromisoformat(s) if s else None
    except ValueError:
        return None


def zeros(keys):
    return {k: 0 for k in keys}


def add(dst, src):
    for k, v in src.items():
        dst[k] += v


def dashboard(q):
    tz = get_tz(q)
    project, model = q.get("project") or None, q.get("model") or None
    tracked_only = q.get("tracked") == "1"
    d_from, d_to = parse_date(q.get("from")), parse_date(q.get("to"))
    lo = utc_iso(datetime(d_from.year, d_from.month, d_from.day, tzinfo=tz)) if d_from else ""
    hi = utc_iso(datetime(d_to.year, d_to.month, d_to.day, tzinfo=tz) + timedelta(days=1)) if d_to else "9999"

    def load(db):
        nonlocal lo
        tracked_since = db.execute("SELECT MIN(ts) FROM cost_events").fetchone()[0]
        if tracked_only and tracked_since:
            lo = max(lo, tracked_since)
        return (
            {r["session_id"]: dict(r) for r in db.execute(
                "SELECT session_id, cwd, model, cost_usd, lines_added, lines_removed FROM session_stats")},
            db.execute(f"SELECT {REQUEST_COLS} FROM requests WHERE ts >= ? AND ts < ? AND model != '<synthetic>' "
                       "ORDER BY ts", (lo, hi)).fetchall(),
            db.execute("SELECT session_id, ts, delta_usd FROM cost_events WHERE ts >= ? AND ts < ?", (lo, hi)).fetchall(),
            db.execute("SELECT MIN(ts), MAX(ts) FROM requests WHERE model != '<synthetic>'").fetchone(),
            tracked_since,
            [r[0] for r in db.execute("SELECT DISTINCT model FROM requests WHERE model IS NOT NULL "
                                      "AND model != '<synthetic>' ORDER BY 1")],
            # Requests before the range that an in-range cost event still pays for: a session's first
            # event carries everything spent since its previous event (or since the session began).
            db.execute(f"""SELECT {REQUEST_COLS} FROM requests JOIN (
                               SELECT session_id, (SELECT MAX(ts) FROM cost_events c2 WHERE c2.session_id = c.session_id
                                                   AND c2.ts < ?) AS prev
                               FROM cost_events c WHERE ts >= ? AND ts < ? GROUP BY session_id
                           ) w USING (session_id)
                           WHERE ts < ? AND ts > COALESCE(w.prev, '') AND model != '<synthetic>'""",
                       (lo, lo, hi, lo)).fetchall() if lo else [],
            dict(db.execute("SELECT session_id, MIN(ts) FROM cost_events GROUP BY session_id").fetchall()),
            dict(db.execute("SELECT session_id, MIN(ts) FROM requests GROUP BY session_id").fetchall()),
            db.execute("SELECT compact_window FROM sessions WHERE compact_window IS NOT NULL "
                       "AND (? IS NULL OR replace(model, '[1m]', '') = ?) ORDER BY last_seen DESC LIMIT 1",
                       (model, model)).fetchone(),
        )

    (sessions, reqs, events, (data_min, data_max), tracked_since, models, pre_range,
     first_event, first_request, latest_window) = read(load)
    proj = {sid: project_name(s["cwd"]) for sid, s in sessions.items()}
    local_day = lambda ts: parse_ts(ts).astimezone(tz).date()

    def new_bucket():
        return {"tokens": zeros(TOKENS), "cost": zeros(COMPONENTS), "requests": 0, "thinking": 0,
                "savings": 0.0, "ctx_max": 0, "ctx_sum": 0, "ctx_n": 0, "actual": 0.0}

    # Tracked-only mode keeps just what the reported cost fully covers: sessions that have cost events, minus,
    # for sessions already running when tracking began, their first event (it carries all earlier spend) and
    # every request that event paid for.
    def cutoff(sid):
        return first_event[sid] if first_request.get(sid, "") < tracked_since else ""

    def in_scope(sid, ts):
        if project and proj.get(sid) != project:
            return False
        return not tracked_only or sid in first_event and ts > cutoff(sid)

    keep = lambda r: in_scope(r["session_id"], r["ts"]) and not (model and r["model"] != model)
    # Actual (reported) cost is recorded per session, so it can't be split by model.
    show_actual = model is None
    kept_events = [e for e in events if in_scope(e["session_id"], e["ts"])] if show_actual else []

    total = new_bucket()
    days = defaultdict(new_bucket)
    by_model = defaultdict(new_bucket)
    by_project = defaultdict(new_bucket)
    hourly = defaultdict(new_bucket)
    per_session = {}
    unpriced = 0
    subagent_cost = 0.0

    for r in reqs:
        sid = r["session_id"]
        if not keep(r):
            continue
        local = parse_ts(r["ts"]).astimezone(tz)
        toks = {k: r[k] for k in TOKENS}
        cost = request_cost(r)
        if cost is None:
            unpriced += 1
            cost = zeros(COMPONENTS)
        est = sum(cost.values())
        ctx = context_size(r) if r["agent_id"] is None else 0
        s = per_session.setdefault(sid, {**new_bucket(), "first": r["ts"], "last": r["ts"], "subagent_requests": 0,
                                         "models": Counter()})
        s["last"] = r["ts"]
        s["models"][r["model"]] += 1
        s["subagent_requests"] += r["agent_id"] is not None
        if r["agent_id"] is not None:
            subagent_cost += est
        for b in (total, days[local.date().isoformat()], by_model[r["model"]], by_project[proj.get(sid, "(unknown)")],
                  hourly[local.hour], s):
            add(b["tokens"], toks)
            add(b["cost"], cost)
            b["requests"] += 1
            b["thinking"] += r["thinking_tokens"] or 0
            b["savings"] += cache_savings(r)
            if ctx:
                b["ctx_max"] = max(b["ctx_max"], ctx)
                b["ctx_sum"] += ctx
                b["ctx_n"] += 1

    # Attribute each request's estimated cost to the cost event that paid for it. What an event reports beyond
    # its requests' estimate is "unlogged": calls whose usage never reaches the transcript (e.g. compaction).
    covered = defaultdict(deque)
    for r in sorted((r for r in list(pre_range) + list(reqs) if keep(r)), key=lambda r: r["ts"]):
        covered[r["session_id"]].append(r)
    attributed = defaultdict(lambda: zeros(COMPONENTS + ("unlogged",)))
    est_billed = 0.0
    for e in sorted(kept_events, key=lambda e: e["ts"]):
        queue, cost = covered[e["session_id"]], zeros(COMPONENTS)
        while queue and queue[0]["ts"] <= e["ts"]:
            add(cost, request_cost(queue.popleft()) or {})
        bucket = attributed[local_day(e["ts"]).isoformat()]
        add(bucket, cost)
        bucket["unlogged"] += e["delta_usd"] - sum(cost.values())
        est_billed += sum(cost.values())

    if show_actual:
        for e in kept_events:
            sid = e["session_id"]
            p = proj.get(sid, "(unknown)")
            for b in (total, days[local_day(e["ts"]).isoformat()], by_project[p]):
                b["actual"] += e["delta_usd"]
                b["billed"] = True
            if sid not in per_session:
                per_session[sid] = {**new_bucket(), "first": e["ts"], "last": e["ts"], "subagent_requests": 0,
                                    "models": Counter()}
            per_session[sid]["actual"] += e["delta_usd"]
            per_session[sid]["billed"] = True

    est_of = lambda b: sum(b["cost"].values())
    hit_rate = lambda t: t["cache_read"] / max(1, t["input"] + t["cache_write_5m"] + t["cache_write_1h"] + t["cache_read"])
    tracked_day = local_day(tracked_since) if tracked_since else None

    # Continuous day axis: the selected range, or (for "all") the span of the data.
    first_day = d_from or (local_day(data_min) if data_min else datetime.now(tz).date())
    if tracked_only and tracked_day:
        first_day = max(first_day, tracked_day)
    # In tracked-only mode the cost split is by billing event, so each day's parts sum to its reported cost.
    split = tracked_only and show_actual and tracked_since is not None
    last_day = d_to or max(datetime.now(tz).date(), first_day)
    daily = []
    d = first_day
    while d <= last_day:
        b = days.get(d.isoformat()) or new_bucket()
        tracked = show_actual and tracked_day is not None and d >= tracked_day
        daily.append({
            "day": d.isoformat(), "tokens": b["tokens"],
            "cost": attributed.get(d.isoformat()) or zeros(COMPONENTS + ("unlogged",)) if split else b["cost"],
            "est": est_of(b),
            "actual": b["actual"] if tracked else None, "requests": b["requests"],
            "ctx_max": b["ctx_max"], "ctx_avg": b["ctx_sum"] / b["ctx_n"] if b["ctx_n"] else None,
            "cache_hit": hit_rate(b["tokens"]) if b["requests"] else None,
        })
        d += timedelta(days=1)

    session_rows = []
    for sid, s in per_session.items():
        info = sessions.get(sid, {})
        session_rows.append({
            "session_id": sid, "project": proj.get(sid, "(unknown)"),
            "model": info.get("model") or (s["models"].most_common(1)[0][0] if s["models"] else None),
            "first": s["first"], "last": s["last"], "requests": s["requests"],
            "subagent_requests": s["subagent_requests"], "est": est_of(s),
            "actual": s["actual"] if s.get("billed") else None, "session_total": info.get("cost_usd"),
            "ctx_max": s["ctx_max"], "tokens": s["tokens"], "cache_hit": hit_rate(s["tokens"]),
            "lines_added": info.get("lines_added"), "lines_removed": info.get("lines_removed"),
        })
    session_rows.sort(key=lambda s: s["last"], reverse=True)

    est_total = est_of(total)
    return {
        "range": {"from": first_day.isoformat(), "to": last_day.isoformat()},
        "meta": {
            "projects": sorted({p for p in proj.values()}),
            "models": models,
            "data_min": data_min, "data_max": data_max, "tracked_since": tracked_since,
            "show_actual": show_actual, "tracked_only": tracked_only, "split": split,
            "compact_window": latest_window[0] if latest_window else None,
        },
        "kpis": {
            "est": est_total, "actual": total["actual"] if show_actual else None,
            "est_billed": est_billed,
            "unattributed": total["actual"] - est_billed if show_actual else None,
            "requests": total["requests"], "sessions": len(per_session),
            "tokens": total["tokens"], "thinking": total["thinking"],
            "cost": {k: sum(a[k] for a in attributed.values()) for k in COMPONENTS + ("unlogged",)} if split
                    else total["cost"],
            "cache_hit": hit_rate(total["tokens"]), "cache_savings": total["savings"],
            "ctx_max": total["ctx_max"], "ctx_avg": total["ctx_sum"] / total["ctx_n"] if total["ctx_n"] else None,
            "subagent_cost": subagent_cost, "unpriced_requests": unpriced,
        },
        "daily": daily,
        "by_model": sorted(({"model": k, "est": est_of(b), "requests": b["requests"], "tokens": b["tokens"],
                             "cost": b["cost"]} for k, b in by_model.items()), key=lambda x: -x["est"]),
        "by_project": sorted(({"project": k, "est": est_of(b), "actual": b["actual"] if b.get("billed") else None,
                               "requests": b["requests"]} for k, b in by_project.items()),
                             key=lambda x: -max(x["est"], x["actual"] or 0)),
        "hourly": [{"hour": h, "est": est_of(hourly[h]), "requests": hourly[h]["requests"]} for h in range(24)],
        "sessions": session_rows,
    }


def session_detail(sid):
    def load(db):
        return (
            db.execute("SELECT * FROM session_stats WHERE session_id = ?", (sid,)).fetchone(),
            db.execute(f"SELECT {REQUEST_COLS} FROM requests WHERE session_id = ? AND model != '<synthetic>' "
                       "ORDER BY ts", (sid,)).fetchall(),
            db.execute("SELECT ts, cost_usd FROM cost_events WHERE session_id = ? ORDER BY ts", (sid,)).fetchall(),
        )

    info, reqs, events = read(load)
    if info is None:
        return None
    rows = []
    for r in reqs:
        cost = request_cost(r) or zeros(COMPONENTS)
        rows.append({"ts": r["ts"], "agent_id": r["agent_id"], "model": r["model"], "ctx": context_size(r),
                     "tokens": {k: r[k] for k in TOKENS}, "cost": cost})
    return {
        "session": {**dict(info), "project": project_name(info["cwd"])},
        "requests": rows,
        "cost_events": [{"ts": e["ts"], "cost_usd": e["cost_usd"]} for e in events],
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC, **kwargs)

    def do_GET(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/"):
            return super().do_GET()
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        try:
            if url.path == "/api/dashboard":
                return self.send_json(dashboard(q))
            if url.path.startswith("/api/session/"):
                body = session_detail(unquote(url.path[len("/api/session/"):]))
                return self.send_json(body) if body else self.send_json({"error": "session not found"}, 404)
            self.send_json({"error": "not found"}, 404)
        except sqlite3.Error as e:
            self.send_json({"error": f"database: {e}"}, 503)

    def send_json(self, body, status=200):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def end_headers(self):
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/"):
            return
        super().log_message(fmt, *args)


if __name__ == "__main__":
    print(f"serving on :{PORT}, db={DB} (read-only)", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
