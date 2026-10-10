"""The new CLI's rectangular, pinned input footer and pure box renderers.

Native input owns the logical draft. FooterScreen owns transcript rendering,
cursor placement, and resize replay for the entire interactive chat session.
"""

import os
import re
import sys

from .splash import (
    content_width,
    display_width,
    margin_pad,
    truncate_display,
)
from .terminal import c_bold, c_cyan, c_dim, c_green, c_magenta

TL, TR, BL, BR, H, V = "\u250c", "\u2510", "\u2514", "\u2518", "\u2500", "\u2502"
MARK = "\u203a "
DOT = " \u00b7 "
HINTS = ("/help", "/endpoint", "\\ newline", "ctrl+c stop", "ctrl+d quit")
_ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def visible_width(text):
    return display_width(_ANSI.sub("", text))


def box_width(columns=None):
    if columns is None:
        return max(1, content_width())
    return max(1, min(int(columns) - 1, 120))


def short_endpoint(base):
    text = re.sub(r"^[a-z]+://", "", str(base or "")).rstrip("/")
    return text or "local"


def _fit_chrome(text, width):
    if visible_width(text) <= width:
        return text
    return truncate_display(_ANSI.sub("", text), max(0, width))


def _workspace_label(client):
    """``folder@branch`` for the border — the agent's workpath, else cwd."""
    path = getattr(client, "workpath", None) if client is not None else None
    if not path:
        try:
            path = os.getcwd()
        except OSError:
            path = ""
    if not path:
        return ""
    folder = os.path.basename(os.path.normpath(str(path))) or str(path)
    try:
        from .terminal import git_branch
        branch = git_branch(str(path))
    except Exception:
        branch = None
    return folder + ("@" + branch if branch else "")


def client_meta(client):
    """(model, endpoint, details) — details carries mode + folder@branch."""
    model = "auto"
    if client is not None and getattr(client, "model", None):
        model = " ".join(str(client.model).split()) or "auto"
    endpoint = short_endpoint(getattr(client, "base", ""))
    details = ["agent" if getattr(client, "agent", False) else "chat"]
    folder = _workspace_label(client)
    if folder:
        details.append(folder)
    return model, endpoint, DOT.join(details)


def session_meta(client):
    """Cumulative counters for the bottom border: ``3 turns · 9.8k tok``."""
    totals = getattr(client, "session_totals", None) if client is not None else None
    if not isinstance(totals, dict) or not totals.get("turns"):
        return ""
    parts = ["%d turn%s" % (totals["turns"], "" if totals["turns"] == 1 else "s")]
    from .splash import _format_tokens
    tokens = _format_tokens(totals.get("tokens"))
    if tokens:
        parts.append("Σ " + tokens)
    return DOT.join(parts)


def box_top(width, label="you", model="auto", endpoint="", details=""):
    """``\u256d\u2500 you \u2500\u2500\u2500 model \u00b7 endpoint \u2500\u256e`` sized to width."""
    inner = width - 2
    left = " %s " % label
    right_text = DOT.join(p for p in (model, endpoint, details) if p)
    room = inner - display_width(left) - 4
    if room < 6:
        right_text = ""
    elif display_width(right_text) > room:
        # shed the detail tail, then the endpoint, before truncating the model
        for parts in ((model, endpoint), (model,)):
            right_text = DOT.join(p for p in parts if p)
            if display_width(right_text) <= room:
                break
        if display_width(right_text) > room:
            right_text = truncate_display(right_text, room)
    right = " %s " % right_text if right_text else ""
    fill = max(0, inner - 1 - display_width(left) - display_width(right) - 1)
    head = c_cyan(TL + H) + c_bold(c_green(left)) + c_cyan(H * fill)
    if right:
        if DOT in right:
            m, e = right.split(DOT, 1)
            right = c_magenta(m) + c_dim(DOT + e)
        else:
            right = c_magenta(right)
    return _fit_chrome(head + right + c_cyan(H + TR), width)


def box_row(width, text="", first=True):
    """One content row: ``\u2502 \u203a text            \u2502``."""
    lead = MARK if first else "  "
    body = text
    room = width - 4 - display_width(lead)
    if display_width(body) > room:
        body = truncate_display(body, room)
    pad = max(0, room - display_width(body))
    marker = c_bold(c_green(lead)) if first else lead
    return _fit_chrome(c_cyan(V) + " " + marker + body + " " * pad
                       + " " + c_cyan(V), width)


def box_bottom(width, hints=HINTS, stats=""):
    """Hint rail and right-aligned session counters, with intact corners."""
    if width <= 1:
        return c_cyan(BL) if width else ""
    if width <= 3:
        return c_cyan(BL + H * (width - 2) + BR)
    room = width - 4
    parts = list(hints)
    right = " %s " % stats if stats and display_width(stats) + 2 <= room else ""
    while parts and display_width(" %s " % DOT.join(parts)) > room - display_width(right):
        parts.pop()
    text = " %s " % DOT.join(parts) if parts else ""
    fill = max(0, room - display_width(text) - display_width(right))
    return (c_cyan(BL + H) + c_dim(text) + c_cyan(H * fill)
            + c_dim(right) + c_cyan(H + BR))


def echo_box(text, width, label="you", model="auto", endpoint="", details="", stats=""):
    """The submitted turn, redrawn as a closed box (wraps long lines)."""
    room = width - 6
    rows = []
    for line in str(text).split("\n") or [""]:
        rows.extend(_wrap_display(line, room))
    lines = [box_top(width, label, model, endpoint, details)]
    lines += [box_row(width, row, i == 0) for i, row in enumerate(rows)]
    lines.append(box_bottom(width, hints=(), stats=stats))
    return lines


def editor_available():
    """The pinned editor uses native console input and the Python stdlib."""
    if os.name == "nt":
        return True
    try:
        import termios
        return bool(termios)
    except ImportError:
        return False


_SCREEN = None


def active_footer():
    return _SCREEN


def pin_footer(out=None, client=None):
    """Enter the new CLI's pinned layout; one renderer owns the screen."""
    global _SCREEN
    if _SCREEN is not None:
        return True
    from .footer import FooterScreen
    screen = FooterScreen(client, out or sys.stdout)
    if not screen.start():
        return False
    _SCREEN = screen
    return True


def unpin_footer(out=None):
    global _SCREEN
    screen, _SCREEN = _SCREEN, None
    if screen is not None:
        screen.close()


from contextlib import contextmanager


@contextmanager
def footer_session(client):
    """Route chat output through the same owner as the pinned input box."""
    from .prompt import use_chatbox
    original = sys.stdout
    pinned = False
    try:
        if use_chatbox():
            pinned = pin_footer(original, client)
        if pinned:
            sys.stdout = active_footer()
            from .footer_input import session_input_mode
            with session_input_mode():
                yield active_footer()
        else:
            yield None
    finally:
        if pinned:
            sys.stdout = original
            unpin_footer()


def read_inline_input(message=""):
    """Agent approvals share the pinned editor, never a second cursor owner."""
    screen = active_footer()
    if screen is None:
        return input(message)
    from .footer_input import read_line
    if message:
        screen.write(message + "\n")
    try:
        answer = read_line(lambda text, cursor: screen.set_input(
            text, cursor, label="allow"), on_scroll=screen.scroll)
        screen.finish_input(answer, echo=False)
        return answer
    except (KeyboardInterrupt, EOFError):
        screen.finish_input("", echo=False)
        raise


def _wrap_display(text, room):
    """Split by terminal cells, retaining every code point and space."""
    from .splash import char_width
    room = max(1, room)
    rows, row, used = [], "", 0
    for ch in text:
        size = char_width(ch)
        if row and used + size > room:
            rows.append(row)
            row, used = "", 0
        row += ch
        used += size
    rows.append(row)
    return rows


def _echo_lines(text, width):
    label, indent = c_bold(c_green("you \u25b8 ")), "      "
    pad = margin_pad()
    rows = []
    for line in str(text).split("\n"):
        for part in _wrap_display(line, width - display_width(indent)):
            rows.append(pad + (indent if rows else label) + part)
    return rows


def read_boxed(client, reader=None, out=None):
    """Read inside the persistent footer using a logical draft and cursor.

    Injected readers remain a plain, non-terminal test/embedding interface.
    Live input uses native events; resizing only redraws the stored model.
    """
    out = out or sys.stdout
    chunks = []
    screen = active_footer() if reader is None else None
    if reader is None and screen is None:
        raise RuntimeError("Pinned editor requires an active footer session")
    if screen is not None:
        screen.refresh_metadata()
    while True:
        if reader is None:
            from .footer_input import read_line
            from .session import history_file_path
            try:
                with open(history_file_path(), encoding="utf-8") as handle:
                    history = handle.read().splitlines()[-1000:]
            except (OSError, UnicodeError):
                history = []
            try:
                line = read_line(lambda text, cursor: screen.set_input(
                    text, cursor, chunks=tuple(chunks)), history=history,
                    on_scroll=screen.scroll)
            except (KeyboardInterrupt, EOFError):
                screen.finish_input("", echo=False)
                raise
        else:
            line = reader(MARK if not chunks else "... ")
        line = "" if line is None else str(line)
        if line.endswith("\\") and not line.endswith("\\\\"):
            chunks.append(line[:-1])
            continue
        chunks.append(line[:-1] if line.endswith("\\\\") else line)
        break
    text = "\n".join(chunks)
    if screen is not None:
        screen.finish_input(text, echo=bool(text.strip()))
    else:
        model, endpoint, details = client_meta(client)
        for row in echo_box(text, box_width(), "you", model, endpoint,
                            details, session_meta(client)):
            out.write(row + "\n")
        out.flush()
    return chunks
