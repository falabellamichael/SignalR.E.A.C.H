"""SQLite request log + daily token counters (analytics store)."""

import sqlite3
import threading
import time


class Analytics:
    """SQLite request log + daily token counters. Every connection is closed
    explicitly (Windows holds file locks on open handles)."""

    COLUMNS = [
        ("cached", "INTEGER DEFAULT 0"),
        ("request_body", "TEXT"),
        ("response_body", "TEXT"),
        ("key_name", "TEXT DEFAULT ''"),
    ]

    def __init__(self, db_path):
        self.db_path = db_path
        self._lock = threading.RLock()
        db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        try:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts TEXT NOT NULL,
                    model TEXT, upstream_model TEXT, ip TEXT, user_agent TEXT,
                    status INTEGER, error TEXT, latency_ms INTEGER,
                    tokens_in INTEGER, tokens_out INTEGER, stream INTEGER DEFAULT 0
                )""")
            existing = {row[1] for row in conn.execute(
                "PRAGMA table_info(requests)").fetchall()}
            for name, decl in self.COLUMNS:
                if name not in existing:
                    conn.execute("ALTER TABLE requests ADD COLUMN %s %s"
                                 % (name, decl))
            conn.execute("""
                CREATE TABLE IF NOT EXISTS rate_tokens (
                    ip TEXT PRIMARY KEY, day TEXT NOT NULL,
                    tokens INTEGER NOT NULL DEFAULT 0
                )""")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts)")
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)")
            conn.commit()
        finally:
            conn.close()

    def _connect(self):
        conn = sqlite3.connect(str(self.db_path), timeout=10)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        return conn

    def _run(self, fn):
        """Run fn(conn) under the lock; always close the connection."""
        with self._lock:
            conn = self._connect()
            try:
                return fn(conn)
            finally:
                conn.close()

    def log_request(self, **fields):
        try:
            def _write(conn):
                conn.execute(
                    "INSERT INTO requests (ts, model, upstream_model, ip,"
                    " user_agent, status, error, latency_ms, tokens_in,"
                    " tokens_out, stream, cached, request_body, response_body, key_name)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (time.strftime("%Y-%m-%dT%H:%M:%S"),
                     fields.get("model"), fields.get("upstream_model"),
                     fields.get("ip"), (fields.get("user_agent") or "")[:200],
                     fields.get("status"), fields.get("error"),
                     fields.get("latency_ms"), fields.get("tokens_in"),
                     fields.get("tokens_out"), 1 if fields.get("stream") else 0,
                     1 if fields.get("cached") else 0,
                     fields.get("request_body"), fields.get("response_body"),
                     fields.get("key_name") or ""))
                conn.commit()
            self._run(_write)
        except sqlite3.Error:
            pass  # analytics must never break the relay

    def add_tokens(self, ip, tokens):
        if not tokens:
            return 0
        day = time.strftime("%Y-%m-%d")
        try:
            def _write(conn):
                conn.execute(
                    "INSERT INTO rate_tokens (ip, day, tokens) VALUES (?,?,?) "
                    "ON CONFLICT(ip) DO UPDATE SET tokens = CASE WHEN day = ? "
                    "THEN tokens + ? ELSE ? END, day = ?",
                    (ip, day, tokens, day, tokens, tokens, day))
                conn.commit()
                row = conn.execute("SELECT tokens FROM rate_tokens WHERE ip = ?",
                                   (ip,)).fetchone()
                return row[0] if row else tokens
            return self._run(_write)
        except sqlite3.Error:
            return 0

    def tokens_today(self, key):
        day = time.strftime("%Y-%m-%d")
        try:
            def _read(conn):
                row = conn.execute(
                    "SELECT tokens FROM rate_tokens WHERE ip = ? AND day = ?",
                    (key, day)).fetchone()
                return row[0] if row else 0
            return self._run(_read)
        except sqlite3.Error:
            return 0

    def prune(self, retention_days):
        try:
            cutoff = time.strftime("%Y-%m-%dT%H:%M:%S",
                                   time.localtime(time.time()
                                                  - retention_days * 86400))
            def _write(conn):
                conn.execute("DELETE FROM requests WHERE ts < ?", (cutoff,))
                conn.commit()
            self._run(_write)
        except sqlite3.Error:
            pass

    def stats(self):
        now = time.time()
        today = time.strftime("%Y-%m-%dT00:00:00")
        day_ago = time.strftime("%Y-%m-%dT%H:%M:%S",
                                time.localtime(now - 86400))
        out = {"today": {}, "hourly": [], "by_model": [], "top_clients": [],
               "cache_hits": 0, "db": str(self.db_path)}
        try:
            def _read(conn):
                conn.row_factory = sqlite3.Row
                row = conn.execute(
                    "SELECT COUNT(*) AS n,"
                    " COALESCE(SUM(tokens_in),0) AS ti,"
                    " COALESCE(SUM(tokens_out),0) AS tout,"
                    " COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS err,"
                    " COALESCE(SUM(CASE WHEN status = 429 THEN 1 ELSE 0 END),0) AS rl,"
                    " COALESCE(AVG(latency_ms),0) AS lat,"
                    " COALESCE(ROUND(SUM(CASE WHEN tokens_out > 0 THEN tokens_out ELSE 0 END) * 1000.0 / NULLIF(SUM(CASE WHEN tokens_out > 0 THEN latency_ms ELSE 0 END), 0), 1), 0.0) AS tps "
                    "FROM requests WHERE ts >= ?", (today,)).fetchone()
                out["today"] = {
                    "requests": row["n"], "tokens_in": row["ti"],
                    "tokens_out": row["tout"], "errors": row["err"],
                    "rate_limited": row["rl"],
                    "avg_latency_ms": round(row["lat"], 1),
                    "tokens_per_sec": row["tps"] or 0.0,
                }
                out["cache_hits"] = conn.execute(
                    "SELECT COUNT(*) FROM requests WHERE ts >= ? AND cached = 1",
                    (today,)).fetchone()[0]
                out["hourly"] = [{
                    "hour": r["h"], "requests": r["n"], "tokens_in": r["ti"],
                    "tokens_out": r["tout"], "errors": r["err"],
                } for r in conn.execute(
                    "SELECT substr(ts, 1, 13) || ':00' AS h, COUNT(*) AS n,"
                    " COALESCE(SUM(tokens_in),0) AS ti,"
                    " COALESCE(SUM(tokens_out),0) AS tout,"
                    " COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS err "
                    "FROM requests WHERE ts >= ? GROUP BY h ORDER BY h", (day_ago,))]
                out["by_model"] = [{
                    "model": r["model"] or "(unknown)", "requests": r["n"],
                    "tokens_in": r["ti"], "tokens_out": r["tout"],
                } for r in conn.execute(
                    "SELECT model, COUNT(*) AS n,"
                    " COALESCE(SUM(tokens_in),0) AS ti,"
                    " COALESCE(SUM(tokens_out),0) AS tout "
                    "FROM requests WHERE ts >= ? GROUP BY model ORDER BY n DESC",
                    (today,))]
                out["top_clients"] = [{
                    "ip": r["ip"] or "?",
                    "requests": r["n"],
                    "tokens_in": r["ti"],
                    "tokens_out": r["tout"],
                    "errors": r["err"],
                    "last_seen": r["last_seen"],
                    "last_model": r["last_model"] or "—",
                    "user_agent": r["user_agent"] or "",
                } for r in conn.execute(
                    "SELECT ip, COUNT(*) AS n,"
                    " COALESCE(SUM(tokens_in),0) AS ti,"
                    " COALESCE(SUM(tokens_out),0) AS tout,"
                    " COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS err,"
                    " MAX(ts) AS last_seen,"
                    " (SELECT model FROM requests r2 WHERE r2.ip = requests.ip AND r2.ts >= ? ORDER BY r2.id DESC LIMIT 1) AS last_model,"
                    " (SELECT user_agent FROM requests r3 WHERE r3.ip = requests.ip AND r3.ts >= ? ORDER BY r3.id DESC LIMIT 1) AS user_agent "
                    "FROM requests WHERE ts >= ? AND ip IS NOT NULL "
                    "GROUP BY ip ORDER BY last_seen DESC LIMIT 25", (today, today, today))]
            self._run(_read)
        except sqlite3.Error:
            pass
        return out

    def logs(self, limit=100, status=None, model=None):
        query = ("SELECT id, ts, model, upstream_model, ip, user_agent, status,"
                 " error, latency_ms, tokens_in, tokens_out, stream, cached, key_name "
                 "FROM requests")
        clauses, params = [], []
        if status:
            clauses.append("status LIKE ?")
            params.append(status.replace("*", "%"))
        if model:
            clauses.append("model LIKE ?")
            params.append(model.replace("*", "%"))
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += " ORDER BY id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        try:
            def _read(conn):
                conn.row_factory = sqlite3.Row
                return [dict(r) for r in conn.execute(query, params)]
            return self._run(_read)
        except sqlite3.Error:
            return []

    def clear(self):
        try:
            def _write(conn):
                conn.execute("DELETE FROM requests")
                conn.commit()
                return True
            return self._run(_write)
        except sqlite3.Error:
            return False
