"""Startup splash and turn footer. Width-aware, no full-screen TUI."""

import os
import re
import shutil
import subprocess
import sys
import time
import unicodedata
import urllib.parse

from .commands import LOCAL_ENDPOINT_URL, _current_base, _normalize_endpoint_url
from .terminal import (
    VERSION,
    c_bold,
    c_cyan,
    c_dim,
    c_green,
    c_red,
    c_yellow,
)

def banner(client, base, mode):
    """Startup splash. A TTY with colour gets the box; otherwise one plain line."""
    try:
        if _plain_chrome():
            print(plain_header(client, base, mode))
            return
        width = banner_columns()
        pad = margin_pad() + " " * max(0, (content_width() - width) // 2)
        for line in render_banner_lines(client, base, mode):
            print(pad + line)
    except Exception:
        try:
            print(plain_header(client, base, mode))
        except Exception:
            print("REACH CLI v" + VERSION)




def print_footer(client, cited=False):
    """Turn footer sized to the terminal.

    Stats come from ``client.last_turn`` (tokens, rounds, latency in seconds).
    Missing keys are left out. The signature stays ``(client, cited=False)``
    so the chat loop can keep calling it.
    """
    try:
        print(margin_pad()
              + render_footer(client, cited=cited, columns=content_width()))
        print()
    except Exception as exc:
        print(c_red("  ✗ %s" % exc))


# ---- display width, splash, footer, prompt --------------------------------

_ANSI_RE = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")

# 3-line block wordmark: SIGNAL, a dash, REACH. Each line is 47 columns
# when ambiguous characters are narrow (the usual Western terminal).
LOGO = (
    "█▀▀  █  █▀▀ █▄█ █▀█ █       █▀█ █▀▀ █▀█ █▀▀ █ █",
    "▀▀█  █  █ █ █▀█ █▀█ █   ─── █▀▄ █▀▀ █▀█ █   █▀█",
    "▀▀▀  █  ▀▀▀ █ █ ▀ ▀ █▄▄     ▀ ▀ ▀▀▀ ▀ ▀ ▀▀▀ ▀ ▀",
)

TIPS = (
    "/endpoint switches the relay. /help lists every command.",
    "End a line with \\ to continue. Ctrl-R searches history.",
    "Ctrl-C at an empty prompt warns once; press it again to quit.",
    "Tab completes /commands, and paths after /workpath.",
)

FOOTER_HINT = "? help · ^C stop · ^D quit"
BANNER_MAX_COLUMNS = 90

# ── layout: centred page column vs full window width ────────────────────
PAGE_WIDTH = 96
_LAYOUT = {"mode": "center"}  # "center" | "full"


def set_layout(mode):
    mode = str(mode or "").strip().lower()
    if mode in ("center", "full"):
        _LAYOUT["mode"] = mode
        return mode
    return None


def layout_mode():
    return _LAYOUT["mode"]


def content_width():
    """Width of the UI column — a centred page, or the whole window."""
    cols = terminal_columns()
    if _LAYOUT["mode"] == "full":
        return max(1, cols - 1)
    return max(1, min(PAGE_WIDTH, cols - 1))


def content_margin():
    """Left gutter under the centred layout; 0 at full width."""
    if _LAYOUT["mode"] == "full":
        return 0
    return max(0, (terminal_columns() - content_width()) // 2)


def margin_pad():
    """Spaces that indent content under the centred layout.

    Piped output stays clean — the gutter only exists on a real TTY.
    """
    try:
        if not sys.stdout.isatty():
            return ""
    except Exception:
        return ""
    return " " * content_margin()


def strip_ansi(text):
    return _ANSI_RE.sub("", "" if text is None else str(text))


def _ambiguous_is_wide():
    """Ambiguous East Asian width is wide in CJK locales and narrow otherwise."""
    lang = os.environ.get("LC_ALL") or os.environ.get("LC_CTYPE") or os.environ.get("LANG") or ""
    lang = lang.upper().replace("-", "_")
    return any(tag in lang for tag in ("ZH", "JA", "JP", "KO", "CN", "TW", "HK"))


def char_width(ch):
    """Columns for one character, using unicodedata.east_asian_width."""
    if not ch:
        return 0
    code = ord(ch)
    if code < 32 or code == 127:
        return 0
    if unicodedata.combining(ch):
        return 0
    kind = unicodedata.east_asian_width(ch)
    if kind in ("W", "F"):
        return 2
    if kind == "A" and _ambiguous_is_wide():
        return 2
    return 1


def display_width(text):
    """Visible columns. ANSI colour codes do not count."""
    return sum(char_width(ch) for ch in strip_ansi(text))


def terminal_columns(default=80):
    try:
        cols = shutil.get_terminal_size(fallback=(default, 24)).columns
    except Exception:
        cols = default
    if not isinstance(cols, int) or cols < 1:
        return default if isinstance(default, int) and default >= 1 else 80
    return cols


def truncate_display(text, width):
    if width <= 0:
        return ""
    if display_width(text) <= width:
        return text
    ellipsis = "…"
    limit = width - char_width(ellipsis)
    if limit < 1:
        limit = width
        ellipsis = ""
    out = []
    used = 0
    for ch in text:
        needed = char_width(ch)
        if used + needed > limit:
            break
        out.append(ch)
        used += needed
    return "".join(out) + ellipsis


def banner_columns():
    return min(BANNER_MAX_COLUMNS, content_width())


def _plain_chrome():
    """Plain header when stdout is not a terminal, or colour is off.

    NO_COLOR flattens the splash too, unless ``--color always`` set
    COLOR_FORCED. A non-TTY is always one line, even when paint is on.
    """
    try:
        interactive = bool(sys.stdout.isatty())
    except Exception:
        interactive = False
    if not interactive:
        return True
    from . import terminal as term
    if os.environ.get("NO_COLOR") and not term.COLOR_FORCED:
        return True
    return not term.PAINT.on


def plain_header(client, base, mode):
    """Single line used when colour or a TTY is unavailable."""
    model = "(auto)"
    if client is not None and getattr(client, "model", None):
        model = str(client.model)
    url = base or (_current_base(client) if client is not None else "") or "(none)"
    mode_label = "agent" if client is not None and getattr(client, "agent", False) else (mode or "chat")
    text = "REACH CLI v%s · RAG Endpoint & AI Chat Host · %s · %s · %s" % (
        VERSION, model, url, mode_label)
    cols = terminal_columns()
    if display_width(text) > cols:
        text = truncate_display(text, cols)
    return text


def git_branch(cwd=None):
    """Current git branch, or None. Never raises."""
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--abbrev-ref", "HEAD"],
            cwd=cwd or None,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False,
        )
    except Exception:
        return None
    if proc.returncode != 0:
        return None
    try:
        name = proc.stdout.decode("utf-8", "replace").strip()
    except Exception:
        return None
    if not name or name == "HEAD":
        return name or None
    return name


def endpoint_label_for(url):
    """Short label for an endpoint URL. Does not contact the network."""
    norm = _normalize_endpoint_url(url or "") or ""
    if not norm:
        return "(none)"
    if norm == LOCAL_ENDPOINT_URL:
        return "local"
    parsed = urllib.parse.urlparse(norm)
    return parsed.netloc or "custom"


def current_tip(index=None):
    if index is None:
        index = time.localtime().tm_yday
    return TIPS[int(index) % len(TIPS)]


def _horizontal(width, left, mid, right):
    side = char_width(left) + char_width(right)
    if width < side:
        return truncate_display(left, width)
    fill = max(0, width - side)
    unit = char_width(mid) or 1
    count = fill // unit
    extra = fill - count * unit
    return left + (mid * count) + (" " * extra) + right


def _row_colored(content, width):
    left, right = "│", "│"
    if width < char_width(left) + char_width(right):
        return c_cyan(truncate_display(left, width))
    inner = max(0, width - char_width(left) - char_width(right))
    visible = display_width(content)
    if visible > inner:
        content = truncate_display(strip_ansi(content), inner)
        visible = display_width(content)
    pad = inner - visible
    if pad < 0:
        pad = 0
    return c_cyan(left) + content + (" " * pad) + c_cyan(right)


def _logo_lines(inner):
    raw = list(LOGO)
    if any(display_width(line) > max(0, inner - 2) for line in raw):
        raw = ["SIGNAL", "───", "REACH"]
    return ["  " + line for line in raw]


def _version_content():
    ident = "⚡ REACH CLI v%s" % VERSION
    tag = " · RAG Endpoint & AI Chat Host"
    return c_bold(c_yellow(ident)) + c_dim(tag)


def _tip_content(index=None):
    return c_yellow("● Tip") + c_dim("  " + current_tip(index))


def _mode_label(client, mode):
    if client is not None and getattr(client, "agent", False):
        return "agent"
    return mode or "chat"


def session_facts(client, base, mode):
    url = base or (_current_base(client) if client is not None else "") or "(none)"
    if not isinstance(url, str):
        url = str(url)
    name = endpoint_label_for(url)
    model = "(auto)"
    if client is not None and getattr(client, "model", None):
        model = str(client.model)
    try:
        cwd = os.getcwd()
    except OSError:
        cwd = "(unknown)"
    from . import terminal as term
    branch = term.git_branch(None if cwd == "(unknown)" else cwd) or "(none)"
    if name in ("(none)",):
        endpoint = url or "(none)"
    else:
        endpoint = "%s · %s" % (name, url)
    return (
        ("endpoint", endpoint),
        ("model", model),
        ("mode", _mode_label(client, mode)),
        ("cwd", cwd),
        ("git", branch),
    )


def render_banner_lines(client, base, mode, tip_index=None):
    width = banner_columns()
    inner = max(0, width - 2 * char_width("│"))
    lines = [c_cyan(_horizontal(width, "┌", "─", "┐"))]
    for logo in _logo_lines(inner):
        lines.append(_row_colored(logo, width))
    lines.append(_row_colored("", width))
    lines.append(_row_colored("  " + _version_content(), width))
    lines.append(_row_colored("  " + _tip_content(tip_index), width))
    lines.append(c_cyan(_horizontal(width, "├", "─", "┤")))
    for label, value in session_facts(client, base, mode):
        text = "  " + label.ljust(8) + "  " + value
        # Colour the label only; keep the value plain so padding stays honest.
        colored = "  " + c_green(label.ljust(8)) + "  " + value
        if display_width(text) > inner:
            colored = "  " + c_green(label.ljust(8)) + "  " + truncate_display(
                value, max(0, inner - display_width("  " + label.ljust(8) + "  ")))
        lines.append(_row_colored(colored, width))
    lines.append(c_cyan(_horizontal(width, "└", "─", "┘")))
    return lines


def _format_tokens(value):
    try:
        count = int(value)
    except (TypeError, ValueError):
        return None
    if count < 0:
        return None
    if count < 1000:
        return "%d tok" % count
    if count < 10000:
        text = "%.1f" % (count / 1000.0)
        if text.endswith(".0"):
            text = text[:-2]
        return text + "k tok"
    if count < 1000000:
        return "%dk tok" % (count // 1000)
    text = "%.1f" % (count / 1000000.0)
    if text.endswith(".0"):
        text = text[:-2]
    return text + "M tok"


def _format_rounds(value):
    try:
        count = int(value)
    except (TypeError, ValueError):
        return None
    if count < 0:
        return None
    if count == 1:
        return "1 round"
    return "%d rounds" % count


def _format_latency(value):
    try:
        seconds = float(value)
    except (TypeError, ValueError):
        return None
    if seconds < 0:
        return None
    if seconds < 10:
        return "%.1fs" % seconds
    return "%.0fs" % seconds


def render_footer(client, cited=False, columns=None):
    """Plain-coloured footer line. Left stats, right hint, padded to ``columns``."""
    model = "auto"
    url = ""
    if client is not None:
        if getattr(client, "model", None):
            model = str(client.model)
        url = _current_base(client)
    label = endpoint_label_for(url) if url else "(none)"
    parts = [model, label]
    turn = getattr(client, "last_turn", None) if client is not None else None
    if isinstance(turn, dict):
        if "tokens" in turn:
            text = _format_tokens(turn.get("tokens"))
            if text:
                parts.append(text)
        if "rounds" in turn:
            text = _format_rounds(turn.get("rounds"))
            if text:
                parts.append(text)
        if "latency" in turn:
            text = _format_latency(turn.get("latency"))
            if text:
                parts.append(text)
        elif "latency_ms" in turn:
            try:
                text = _format_latency(float(turn.get("latency_ms")) / 1000.0)
            except (TypeError, ValueError):
                text = None
            if text:
                parts.append(text)
    if cited:
        parts.append("grounded")
    left = "  └─ " + " · ".join(parts)
    right = FOOTER_HINT
    cols = columns if isinstance(columns, int) and columns >= 1 else terminal_columns()
    gap = cols - display_width(left) - display_width(right)
    if gap >= 1:
        return c_cyan(left) + (" " * gap) + c_dim(right)
    room = cols - display_width(right) - 1
    if room < 4:
        return c_dim(truncate_display(right, cols))
    left = truncate_display(left, room)
    gap = cols - display_width(left) - display_width(right)
    return c_cyan(left) + (" " * max(1, gap)) + c_dim(right)

