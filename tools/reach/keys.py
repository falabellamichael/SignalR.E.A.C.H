"""OmniRoute key discovery and display masking."""

import sqlite3
from pathlib import Path
def find_omniroute_key():
    db = Path.home() / ".omniroute" / "storage.sqlite"
    if not db.is_file():
        return None
    try:
        conn = sqlite3.connect("file:%s?mode=ro" % db, uri=True)
        rows = conn.execute(
            "SELECT name, key FROM api_keys "
            "WHERE revoked_at IS NULL AND is_active = 1").fetchall()
        conn.close()
    except sqlite3.Error:
        return None
    preferred = [k for name, k in rows if name == "SimpleRAG"]
    if preferred:
        return preferred[0]
    return rows[0][1] if rows else None


def mask_key(key):
    if not key:
        return "(none)"
    if len(key) <= 12:
        return "set (short)"
    return key[:8] + "…" + key[-4:]
