"""In-memory LRU response cache."""

import collections
import threading
import time

# ----------------------------------------------------------------------
# Response cache (in-memory LRU)
# ----------------------------------------------------------------------

class ResponseCache:
    def __init__(self):
        self._lock = threading.RLock()
        self._entries = collections.OrderedDict()   # key -> (expires, body)
        self.hits = 0
        self.misses = 0

    def get(self, key):
        with self._lock:
            entry = self._entries.get(key)
            if not entry:
                self.misses += 1
                return None
            expires, body = entry
            if time.time() >= expires:
                self._entries.pop(key, None)
                self.misses += 1
                return None
            self._entries.move_to_end(key)
            self.hits += 1
            return body

    def put(self, key, body, ttl_s, max_entries):
        with self._lock:
            while len(self._entries) > max_entries - 1:
                self._entries.popitem(last=False)
            self._entries[key] = (time.time() + ttl_s, body)

    def clear(self):
        with self._lock:
            self._entries.clear()

    def __len__(self):
        with self._lock:
            return len(self._entries)

    def snapshot(self):
        with self._lock:
            return {"entries": len(self._entries), "hits": self.hits,
                    "misses": self.misses}
