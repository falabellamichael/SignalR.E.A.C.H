"""Shared module-level constants for the reachd package."""

VERSION = "3.2.0"
SERVICE = "signalreach"
DEFAULT_PORT = 20777
MAX_BODY_BYTES = 32 * 1024 * 1024
LATENCY_SAMPLE_LIMIT = 1000
MAX_RATE_BUCKETS = 10000

GIST_ID = "e261e0c31ad08c373bcd667b6982847a"
GIST_FILE = "simple-reach-endpoint.txt"

CLIENT_DISCONNECT_ERRORS = (BrokenPipeError, ConnectionResetError, ConnectionAbortedError)
