"""Compact, centered top HUD for the interactive REACH CLI."""
import re
import unicodedata
from urllib.parse import urlsplit


_ANSI = re.compile(
    r"\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])"
    r"|\x9d[^\x07\x9c]*(?:\x07|\x9c)"
    r"|\x9b[0-?]*[ -/]*[@-~]"
)
_DISPLAY_FORMAT_CONTROLS = frozenset(
    "\u061c\u200b\u200e\u200f\u202a\u202b\u202c\u202d\u202e"
    "\u2060\u2066\u2067\u2068\u2069\ufeff"
)
_MAX_WIDTH = 92
_MIN_WIDTH = 60
_VERTICAL = "\u2502"
_TOP_LEFT, _TOP_RIGHT = "\u250c", "\u2510"
_BOTTOM_LEFT, _BOTTOM_RIGHT = "\u2514", "\u2518"
_HORIZONTAL = "\u2500"


def strip_ansi(text):
    return _ANSI.sub("", "" if text is None else str(text))


def strip_terminal_controls(text):
    """Remove terminal controls and bidi spoofing while preserving Unicode joiners."""
    text = strip_ansi(text)
    return "".join(char for char in text
                   if char in "\n\t" or
                   (unicodedata.category(char) != "Cc" and
                    char not in _DISPLAY_FORMAT_CONTROLS))


def _is_extend(char):
    code = ord(char)
    return (unicodedata.category(char) in ("Mn", "Mc", "Me", "Cf") or
            0x1F3FB <= code <= 0x1F3FF or 0xE0020 <= code <= 0xE007F)


def _graphemes(text):
    cluster = ""
    join_next = False
    regional_count = 0
    for char in text:
        code = ord(char)
        regional = 0x1F1E6 <= code <= 0x1F1FF
        join_regional = regional and regional_count == 1 and all(
            0x1F1E6 <= ord(item) <= 0x1F1FF for item in cluster)
        if not cluster or _is_extend(char) or char == "\u200d" or join_next or join_regional:
            cluster += char
        else:
            yield cluster
            cluster = char
            regional_count = 0
        if regional:
            regional_count += 1
        elif char != "\u200d" and not _is_extend(char):
            regional_count = 0
        if char == "\u200d":
            join_next = True
        elif join_next:
            join_next = False
    if cluster:
        yield cluster


def _cluster_width(cluster):
    bases = [char for char in cluster
             if not _is_extend(char) and char != "\u200d"]
    if not bases:
        return 0
    if ("\u200d" in cluster or "\u20e3" in cluster or
            sum(0x1F1E6 <= ord(char) <= 0x1F1FF for char in bases) > 1):
        return max(2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
                   for char in bases)
    return sum(2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
               for char in bases)


def display_width(text):
    return sum(_cluster_width(cluster)
               for cluster in _graphemes(strip_terminal_controls(text)))


def _safe_text(value):
    return strip_terminal_controls("" if value is None else str(value))


def _clip(text, width):
    width = max(0, int(width))
    text = _safe_text(text).replace("\n", " ").replace("\t", " ")
    if display_width(text) <= width:
        return text
    if width <= 1:
        return "." if width else ""
    out = []
    used = 0
    for cluster in _graphemes(text):
        size = _cluster_width(cluster)
        if used + size > width - 1:
            break
        out.append(cluster)
        used += size
    return "".join(out) + "."


def _pad(text, width):
    text = _clip(text, width)
    return text + " " * max(0, width - display_width(text))


def panel_geometry(columns):
    """Return the centered panel width and left margin for the current TTY."""
    columns = max(1, int(columns))
    if columns <= 2:
        return {"columns": columns, "width": columns, "left": 0,
                "compact": True}
    target = min(_MAX_WIDTH, max(_MIN_WIDTH, columns // 2))
    width = min(columns - 2, target)
    return {"columns": columns, "width": width,
            "left": max(0, (columns - width) // 2),
            "compact": width < 54}


def _colored(text, enabled, code):
    if not enabled:
        return text
    from . import themes
    from .terminal import PAINT
    role = themes.color_role(code) or "border"
    return themes.paint_role(role, text, enabled=True,
                             managed_screen=PAINT.managed_screen)


def _border(width, label, top, color):
    if width <= 0:
        return ""
    if width == 1:
        return _colored(_TOP_LEFT if top else _BOTTOM_LEFT, color, "36")
    left = _TOP_LEFT if top else _BOTTOM_LEFT
    right = _TOP_RIGHT if top else _BOTTOM_RIGHT
    interior = max(0, width - 2)
    label = _clip(" " + label + " ", interior)
    gap = max(0, interior - display_width(label))
    start = gap // 2
    line = left + _HORIZONTAL * start + label
    line += _HORIZONTAL * (interior - start - display_width(label)) + right
    return _colored(line, color, "36")


def _percent(metrics, key):
    value = metrics.get(key) if isinstance(metrics, dict) else None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return "--"
    if number < 0:
        return "--"
    return "%d%%" % min(100, int(round(number)))


def _ram(metrics):
    used = metrics.get("ram_used") if isinstance(metrics, dict) else None
    total = metrics.get("ram_total") if isinstance(metrics, dict) else None
    try:
        used, total = float(used), float(total)
    except (TypeError, ValueError, OverflowError):
        return "--"
    if used < 0 or total <= 0:
        return "--"
    return "%d%%" % min(100, int(round(100.0 * used / total)))


def _gpu(metrics):
    if not isinstance(metrics, dict):
        return "GPU n/a"
    percent = _percent(metrics, "gpu_pct")
    if percent != "--":
        metric = str(metrics.get("gpu_metric") or "").lower()
        label = "GPU 3D" if "3d engine" in metric else "GPU"
        return label + " " + percent
    used = metrics.get("gpu_memory_used")
    total = metrics.get("gpu_memory_total")
    try:
        used = float(used)
    except (TypeError, ValueError, OverflowError):
        used = None
    try:
        total = float(total)
    except (TypeError, ValueError, OverflowError):
        total = None
    if used is not None and used >= 0:
        if total is not None and total > 0:
            return "VRAM %.1f/%.1fG" % (used / 1024.0, total / 1024.0)
        return "VRAM %.1fG" % (used / 1024.0)
    return "GPU n/a"


def safe_endpoint(endpoint):
    """Reduce URLs to host:port, excluding userinfo, paths and query keys."""
    raw = _safe_text(endpoint).strip()
    if not raw:
        return "(none)"
    try:
        parsed = urlsplit(raw if "://" in raw else "http://" + raw)
        if not parsed.hostname:
            return "(invalid endpoint)"
        return parsed.hostname + ((":" + str(parsed.port)) if parsed.port else "")
    except ValueError:
        return "(invalid endpoint)"


def _terminal_snapshot(terminal):
    if hasattr(terminal, "snapshot"):
        terminal = terminal.snapshot()
    return terminal if isinstance(terminal, dict) else {}


def _terminal_lines(terminal):
    terminal = _terminal_snapshot(terminal)
    status = _clip(terminal.get("status") or "idle", 20)
    command = _clip(terminal.get("display_draft") or "", 32)
    output = _clip((terminal.get("output") or "").splitlines()[-1]
                   if terminal.get("output") else "", 40)
    if terminal.get("focused"):
        command = "> " + command if command else "> type command"
    else:
        command = "Ctrl+T to open"
    return ("MINI-TERM", status + ": " + command, output)


def render_header(columns, *, version="1.0.0", model="auto", endpoint="",
                  mode="chat", cwd="", branch="", telemetry=None,
                  terminal=None, streaming=False, color=False, max_rows=5):
    """Return centered, clipped rows for a pinned top panel."""
    geometry = panel_geometry(columns)
    width, left = geometry["width"], geometry["left"]
    max_rows = max(0, min(5, int(max_rows)))
    if width <= 0 or max_rows == 0:
        return []
    if width == 1:
        return [_clip("R", 1)]
    metrics = telemetry if isinstance(telemetry, dict) else {}
    cpu, gpu, ram = _percent(metrics, "cpu_pct"), _gpu(metrics), _ram(metrics)
    safe_model = _clip(model or "auto", 24)
    safe_mode = _clip(mode or "chat", 18)
    safe_cwd = _clip(str(cwd).replace("\\", "/").rstrip("/").split("/")[-1], 18)
    safe_branch = _clip(branch or "", 16)
    endpoint_text = safe_endpoint(endpoint)
    center = [
        "REACH CLI v" + _clip(version, 12),
        safe_mode + " · " + safe_model,
        endpoint_text + (" · " + safe_cwd if safe_cwd else ""),
    ]
    if safe_branch and safe_branch not in ("(none)", "HEAD"):
        center[2] += " · " + safe_branch
    right = _terminal_lines(terminal)

    summary = "CPU " + cpu + " · " + gpu + " · RAM " + ram
    if max_rows <= 2:
        rows = [_colored(_clip("SIGNAL-REACH · " + summary, width),
                         color, "36")]
    elif max_rows <= 3:
        rows = [_border(width, "SIGNAL-REACH", True, color)]
        if max_rows >= 2:
            rows.append(_colored(
                _VERTICAL + _pad(summary + " · " + right[1], width - 2)
                + _VERTICAL, color, "36"))
        if max_rows >= 3:
            rows.append(_border(width, "LIVE", False, color))
    elif geometry["compact"] or max_rows < 5:
        content_width = max(0, width - 2)
        if content_width < 18:
            middle = summary
            rows = [_border(width, "REACH", True, color),
                    _colored(_VERTICAL + _pad(middle, content_width) + _VERTICAL,
                             color, "36"),
                    _border(width, "LIVE", False, color)]
        else:
            rows = [_border(width, "SIGNAL-REACH", True, color)]
            first = "CPU " + cpu + " · " + gpu
            second = "RAM " + ram + " · " + right[1]
            if max_rows >= 4:
                rows.append(_colored(_VERTICAL + _pad(first, content_width) + _VERTICAL,
                                     color, "36"))
                rows.append(_colored(_VERTICAL + _pad(second, content_width) + _VERTICAL,
                                     color, "36"))
                rows.append(_border(width, "LIVE · Ctrl+T", False, color))
            else:
                rows.append(_colored(
                    _VERTICAL + _pad(summary + " · " + right[1], content_width)
                    + _VERTICAL, color, "36"))
                rows.append(_border(width, "LIVE", False, color))
    else:
        usable = width - 4
        left_width = usable // 3
        right_width = usable // 3
        center_width = usable - left_width - right_width

        def content_row(a, b, c):
            line = (_VERTICAL + _pad(a, left_width) + _VERTICAL
                    + _pad(b, center_width) + _VERTICAL
                    + _pad(c, right_width) + _VERTICAL)
            return _colored(line, color, "36")

        rows = [_border(width, "SIGNAL-REACH", True, color)]
        content = [
            ("CPU " + cpu, center[0], right[0]),
            (gpu, center[1], right[1]),
            ("RAM " + ram, center[2], right[2]),
        ]
        if max_rows == 4:
            content = [content[0], (content[1][0], content[2][1], content[2][2])]
        for a, b, c in content:
            rows.append(content_row(a, b, c))
        state = _terminal_snapshot(terminal)
        status = "STREAMING" if streaming else (
            "MINI-TERM FOCUSED" if state.get("focused") else "LIVE")
        rows.append(_border(width, status, False, color))
    return [" " * left + row for row in rows[:max_rows]]
