"""Keep submitted endpoint credentials out of terminal echoes and history.

Only endpoint slash commands are transformed. Dispatchers still validate the
original text; this helper must never make an unsafe URL valid for execution.
"""

import re


_ENDPOINT_COMMAND = re.compile(r"\A\s*/endpoints?(?:\s|\Z)", re.IGNORECASE)
_URL = re.compile(r"https?://[^\s'\"`<>]+", re.IGNORECASE)
_LITERAL_KEY = re.compile(
    r"(--(?:api[-_]?)?key)(?:=|\s+)(?:\"[^\"]*(?:\"|\Z)|'[^']*(?:'|\Z)|[^\s]+)",
    re.IGNORECASE,
)


def sanitize_endpoint_command(text):
    """Redact obvious credential positions in endpoint commands only."""
    if not isinstance(text, str) or not _ENDPOINT_COMMAND.match(text):
        return text

    def safe_url(match):
        value = match.group(0)
        # URLs carrying a query/fragment are rejected by validation anyway.
        # Remove complete components, regardless of the credential's label.
        value = re.split(r"[?#]", value, maxsplit=1)[0] + (
            "?[redacted]" if "?" in value or "#" in value else "")
        return re.sub(r"(https?://)[^/?#]*@", r"\1[redacted]@", value,
                      count=1, flags=re.IGNORECASE)

    text = _LITERAL_KEY.sub(lambda match: match.group(1) + " [redacted]", text)
    text = _URL.sub(safe_url, text)
    return "".join(char for char in text if char in "\n\t" or ord(char) >= 32 and ord(char) != 127)
