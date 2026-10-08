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


# MIRROR of server/reachd/settings.py:mask_key: keep the two in sync.
# Kept as a copy so tools/ does not import the whole reachd package for a
# display helper; tests/test_reach_cli.py asserts both return the same output.
def mask_key(key):
    """Mask key for safe display in logs and UI (prefix only, no secret chars)."""
    if not key or not isinstance(key, str):
        return "(none)"
    if len(key) <= 12:
        return "set (short)"
    if key.startswith("sk-reach-"):
        return "sk-reach-…"
    return key[:8] + "…" + key[-4:]
