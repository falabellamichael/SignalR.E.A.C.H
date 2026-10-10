"""Model-backed pinned terminal footer for interactive chat.

The footer owns the alternate screen and every physical write while active.
Input is supplied as a logical buffer by the editor; no screen cells are read
back to recover a draft. The transcript is retained and reflowed on resize.
"""

import os
import bisect
import shutil
import threading
import unicodedata

from . import themes as app_themes
from . import terminal as term
from .terminal import VERSION, c_bold, c_cyan, c_green
from .chatbox import (BL, BR, H, MARK, TL, TR, V, box_bottom, box_row, box_top,
                      client_meta, session_meta)
from .splash import PAGE_WIDTH, char_width, display_width, layout_mode, strip_ansi
from .hud import render_header
from .mini_terminal import MiniTerminal
from .system_telemetry import SystemTelemetry


# Windows console cells count residual marks, joiners and regional indicators.
# NFC first keeps composable accents in one cell.
_WINDOWS_NATIVE_WIDTH = os.name == "nt"


class _Line:
    __slots__ = ("cells", "cursor", "source_margin", "prefix", "continuation",
                 "dirty_from", "wrapped", "wrapped_key")

    def __init__(self, source_margin=0, prefix="", continuation=""):
        self.cells = []  # pairs of (visible glyph, active SGR sequences)
        self.cursor = 0
        self.source_margin = source_margin
        self.prefix = prefix
        self.continuation = continuation
        self.dirty_from = 0
        self.wrapped = []
        self.wrapped_key = None


def _glyph_width(glyph):
    """Width shared by transcript wrapping and the editor cursor."""
    glyph = unicodedata.normalize("NFC", glyph)
    if _WINDOWS_NATIVE_WIDTH:
        return sum(2 if 0x1F1E6 <= ord(ch) <= 0x1F1FF else
                   1 if unicodedata.category(ch) in ("Mn", "Me", "Cf") else
                   char_width(ch) for ch in glyph)
    width = 0
    joined = False
    for ch in glyph:
        if ch == "\u200d":
            joined = True
            continue
        if unicodedata.category(ch) in ("Mn", "Me", "Cf"):
            continue
        size = char_width(ch)
        width = max(width, size) if joined else width + size
        joined = False
    return width


def _clip(text, width):
    """Clip plain chrome without a truncation marker or broken wide glyph."""
    out = []
    used = 0
    for ch in text:
        size = _glyph_width(ch)
        if used + size > width:
            break
        out.append(ch)
        used += size
    return "".join(out)


def _visible_char(ch):
    """Display a literal control in a draft without executing it as VT."""
    code = ord(ch)
    if code < 32 and ch != "\n":
        return "^" + chr(code + 64)
    if code == 127:
        return "^?"
    if 128 <= code < 160:
        return "\\x%02X" % code
    return ch


def _project_text(text, newline="\n"):
    """Turn literal controls into text, then compose the complete string."""
    return unicodedata.normalize(
        "NFC", "".join(newline if ch == "\n" else _visible_char(ch)
                       for ch in str(text)))


def _visible_text(text):
    return _project_text(text, newline="\u21b5")


def _chrome_text(text):
    """Keep metadata safe for the shared chrome's standard width budget."""
    result = []
    for ch in _visible_text(text):
        if (_WINDOWS_NATIVE_WIDTH and
                (unicodedata.category(ch) in ("Mn", "Me", "Cf") or
                 0x1F1E6 <= ord(ch) <= 0x1F1FF)):
            result.append("\\u%04X" % ord(ch) if ord(ch) <= 0xFFFF
                          else "\\U%08X" % ord(ch))
        else:
            result.append(ch)
    return "".join(result)


def _wrap_plain(text, room):
    """Wrap projected input by actual terminal cells."""
    room = max(1, room)
    rows = [""]
    used = 0
    for ch in _project_text(text):
        if ch == "\n":
            rows.append("")
            used = 0
            continue
        size = _glyph_width(ch)
        if rows[-1] and used + size > room:
            rows.append("")
            used = 0
        if size > room:
            rows[-1] += "?"
            used += 1
        else:
            rows[-1] += ch
            used += size
    return rows


def _draft_rows(text, cursor, room):
    """Wrap input and locate a code-point cursor in terminal cells."""
    room = max(1, room)
    rows = [""]
    used = 0
    cursor = max(0, min(len(text), int(cursor)))
    projected = _project_text(text)
    target = len(_project_text(text[:cursor]))
    position = (0, 0)
    for index, ch in enumerate(projected):
        if index == target:
            position = (len(rows) - 1, used)
        if ch == "\n":
            rows.append("")
            used = 0
            continue
        size = _glyph_width(ch)
        if rows[-1] and used + size > room:
            rows.append("")
            used = 0
            if index == target:
                position = (len(rows) - 1, 0)
        if size > room:
            rows[-1] += "?"
            used += 1
        else:
            rows[-1] += ch
            used += size
    if target == len(projected):
        position = (len(rows) - 1, used)
    return rows, position


def _styled(cells):
    """Encode one row, resetting SGR before a new row is drawn."""
    parts = []
    active = ""
    for glyph, style in cells:
        if style != active:
            if active:
                parts.append("\x1b[0m")
            if style:
                parts.append(style)
            active = style
        parts.append(unicodedata.normalize("NFC", glyph))
    if active:
        parts.append("\x1b[0m")
    return "".join(parts)


class FooterScreen:
    """Pinned boxed editor over a reflowable transcript.

    The caller passes this object as the stdout sink during the session and
    calls set_input whenever its editor buffer changes. A single lock covers
    parsing, redraws, resize polling and writes to the underlying stream.
    """

    def __init__(self, client, out, size=None):
        self.client = client
        self.out = out
        self._size_provider = size
        self._lock = threading.RLock()
        self._stop = threading.Event()
        self._watcher = None
        self._active = False
        self._last_size = None
        self._lines = [_Line()]
        self._style = ""
        self._escape = ""
        self._draft = ""
        self._cursor = 0
        self._chunks = ()
        self._label = "you"
        self._banner_cleared = False
        self._geometry = {}
        self._meta_key = None
        self._meta_value = None
        self.mini_terminal = MiniTerminal()
        self._mini_runner = None
        self._telemetry = SystemTelemetry()
        self._telemetry_key = None
        self._follow_tail = True
        self._scroll_anchor = None
        self._visual_rows = []
        self._visual_anchors = []
        self._visual_line_starts = []
        self._visual_key = None
        self._visual_dirty = 0
        self._last_display = None
        self._paint_size = None
        self._scroll_state = {
            "following": True, "top": 0, "max_top": 0,
            "total_rows": 0, "visible_rows": 0, "anchor": None,
        }

    def isatty(self):
        method = getattr(self.out, "isatty", None)
        return bool(method()) if method else False

    def fileno(self):
        return self.out.fileno()

    def snapshot(self):
        """Copy logical state and the latest zero-based screen geometry."""
        with self._lock:
            return {
                "text": self._draft,
                "cursor": self._cursor,
                "chunks": tuple(self._chunks),
                "transcript": "\n".join(
                    "".join(glyph for glyph, _ in line.cells)
                    for line in self._lines),
                "geometry": dict(self._geometry),
                "scroll": dict(self._scroll_state),
                "active": self._active,
            }

    def _size(self):
        try:
            source = self._size_provider() if callable(self._size_provider) else self._size_provider
            if source is None:
                try:
                    source = os.get_terminal_size(self.out.fileno())
                except (OSError, AttributeError, TypeError, ValueError):
                    source = shutil.get_terminal_size((80, 24))
            cols = int(source.columns if hasattr(source, "columns") else source[0])
            rows = int(source.lines if hasattr(source, "lines") else source[1])
            return max(1, cols), max(1, rows)
        except (OSError, TypeError, ValueError, IndexError, AttributeError):
            return self._last_size or (80, 24)

    @staticmethod
    def _layout(cols):
        width = max(1, cols - 1)
        if layout_mode() == "center":
            width = min(width, PAGE_WIDTH)
            margin = max(0, (cols - width) // 2)
        else:
            margin = 0
        return width, margin

    def start(self):
        with self._lock:
            if self._active:
                return True
            if not self.isatty():
                return False
            self._last_size = self._size()
            self._lines = [_Line(self._layout(self._last_size[0])[1])]
            self._visual_key = None
            self._visual_dirty = 0
            self._last_display = None
            self._follow_tail = True
            self._scroll_anchor = None
            self._stop.clear()
            self._active = True
            term.PAINT.managed_screen = True
            self._telemetry.start()
            modes = "\x1b[?1049h\x1b[?1000h\x1b[?1006h"
            if os.name != "nt":
                modes += "\x1b[?2004h"
            self.out.write(modes)
            self._draw()
            self._watcher = threading.Thread(
                target=self._watch, name="reach-footer-resize", daemon=True)
            self._watcher.start()
            return True

    def close(self):
        with self._lock:
            if not self._active:
                return
            self._active = False
            self._stop.set()
            self._telemetry.stop()
            modes = "\x1b[?25h\x1b[?1006l\x1b[?1000l"
            if os.name != "nt":
                modes += "\x1b[?2004l"
            self.out.write(modes + "\x1b[0m\x1b[?1049l")
            self.out.flush()
            term.PAINT.managed_screen = False
            watcher = self._watcher
        if watcher is not None and watcher is not threading.current_thread():
            watcher.join(timeout=0.2)

    def _watch(self):
        while not self._stop.wait(0.02):
            with self._lock:
                if not self._active:
                    return
                sample = self._telemetry.snapshot()
                sample_key = tuple(sample.get(key) for key in (
                    "cpu_pct", "gpu_pct", "gpu_name", "gpu_status",
                    "gpu_memory_used", "gpu_memory_total", "ram_used",
                    "ram_total"))
                resized = self._size() != self._last_size
                changed = sample_key != self._telemetry_key
                if resized or changed:
                    self._telemetry_key = sample_key
                    self._draw()
            try:
                from .footer_input import poll_scroll_events
                events = poll_scroll_events() or ()
            except (ImportError, AttributeError, OSError, RuntimeError):
                events = ()
            self.scroll_events(events)

    def write(self, text):
        text = str(text)
        with self._lock:
            if not self._active:
                return self.out.write(text)
            self._consume(text)
            self._draw(incremental=True)
        return len(text)

    def flush(self):
        with self._lock:
            if self._active and self._size() != self._last_size:
                self._draw()
            self.out.flush()

    def set_input(self, text, cursor, chunks=(), label="you"):
        with self._lock:
            self._draft = str(text)
            self._cursor = max(0, min(len(self._draft), int(cursor)))
            self._chunks = tuple(str(item) for item in chunks)
            self._label = str(label)
            if self._active:
                self._draw()

    def reset_input(self):
        self.set_input("", 0)

    def scroll_lines(self, delta):
        """Scroll transcript rows; positive goes up, negative goes down."""
        with self._lock:
            if not self._active:
                return
            if self._size() != self._last_size:
                self._draw()
            state = self._scroll_state
            top = max(0, min(state["max_top"], state["top"] - int(delta)))
            if top >= state["max_top"]:
                self._follow_tail = True
                self._scroll_anchor = None
            else:
                self._follow_tail = False
                self._scroll_anchor = self._visual_rows[top][:2]
            self._draw()

    def scroll_pages(self, delta):
        """Scroll by a viewport, keeping one row of reading overlap."""
        with self._lock:
            if self._active and self._size() != self._last_size:
                self._draw()
            step = max(1, self._scroll_state["visible_rows"] - 1)
            self.scroll_lines(int(delta) * step)

    def return_live(self):
        """Follow the newest output again."""
        with self._lock:
            self._follow_tail = True
            self._scroll_anchor = None
            if self._active:
                self._draw()

    def scroll(self, action, amount=1):
        """Dispatch normalized editor and mouse scroll events."""
        self.scroll_events(((action, amount),))

    def scroll_events(self, events):
        """Apply a navigation burst in order, painting its final view once."""
        if not events:
            return
        with self._lock:
            if not self._active:
                return
            if self._size() != self._last_size:
                self._draw()
            state = self._scroll_state
            top, maximum = state["top"], state["max_top"]
            page = max(1, state["visible_rows"] - 1)
            changed = False
            for action, amount in events:
                action = str(action)
                if action.startswith("scroll_"):
                    action = action[len("scroll_"):]
                amount = max(1, int(amount))
                if action == "live":
                    top = maximum
                elif action in ("up", "down", "page_up", "page_down"):
                    delta = amount * (page if action.startswith("page_") else 1)
                    top = max(0, min(maximum, top + (
                        delta if action in ("down", "page_down") else -delta)))
                else:
                    continue
                changed = True
            if changed:
                self._follow_tail = top >= maximum
                self._scroll_anchor = (None if self._follow_tail else
                                       self._visual_rows[top][:2])
                self._draw()

    def refresh_metadata(self):
        """Refresh the workspace branch once when a new prompt begins."""
        with self._lock:
            self._meta_key = None
            if self._active:
                self._draw()

    def refresh_header(self):
        """Redraw the pinned HUD after a mini-terminal state change."""
        with self._lock:
            if self._active:
                self._draw(incremental=True)

    def refresh_theme(self):
        """Repaint only the visual frame; logical text and scroll stay intact."""
        with self._lock:
            self._last_display = None
            self._paint_size = None
            if self._active:
                self._draw()

    def set_mini_runner(self, runner):
        """Install the session's approved shell-tool callback."""
        self._mini_runner = runner if callable(runner) else None

    def run_mini_terminal(self, request_id):
        """Execute only a current Enter-submitted request."""
        runner = self._mini_runner
        if runner is None:
            return False
        self.refresh_header()
        result = self.mini_terminal.execute_submitted(request_id, runner)
        self.refresh_header()
        return result

    def _header(self, cols, max_rows):
        if max_rows <= 0:
            return []
        key = tuple(getattr(self.client, name, None)
                    for name in ("model", "base", "agent", "workpath"))
        if key != self._meta_key:
            self._meta_key = key
            self._meta_value = client_meta(self.client)
        model, endpoint, details = self._meta_value
        parts = str(details or "").split(" \u00b7 ")
        workspace = parts[-1] if len(parts) > 1 else ""
        cwd, separator, branch = workspace.rpartition("@")
        if not separator:
            cwd, branch = workspace, ""
        return render_header(
            cols, version=VERSION, model=model, endpoint=endpoint,
            mode="agent" if getattr(self.client, "agent", False) else "chat",
            cwd=cwd, branch=branch, telemetry=self._telemetry.snapshot(),
            terminal=self.mini_terminal,
            color=bool(self.isatty() and term.PAINT.on), max_rows=max_rows)

    def clear_banner_on_submit(self):
        with self._lock:
            if self._banner_cleared:
                return
            self._banner_cleared = True
            self._lines = [_Line()]
            self._visual_dirty = 0
            self._follow_tail = True
            self._scroll_anchor = None
            if self._active:
                self._draw()

    def finish_input(self, text, echo=True):
        with self._lock:
            if echo:
                self.clear_banner_on_submit()
                self._follow_tail = True
                self._scroll_anchor = None
            self._draft = ""
            self._cursor = 0
            self._chunks = ()
            self._label = "you"
            if echo:
                for index, part in enumerate(str(text).split("\n")):
                    line = _Line(prefix="you \u25b8 " if index == 0 else "      ",
                                 continuation="      ")
                    for raw in part:
                        for ch in _visible_char(raw):
                            if unicodedata.category(ch) in ("Mn", "Me", "Cf") and line.cells:
                                glyph, style = line.cells[-1]
                                line.cells[-1] = (glyph + ch, style)
                            else:
                                line.cells.append((ch, ""))
                    self._lines.append(line)
                self._lines.append(_Line())
            if self._active:
                self._draw()

    def _consume(self, text):
        for ch in text:
            if self._escape:
                self._escape += ch
                if self._escape.startswith("\x1b["):
                    if len(self._escape) >= 3 and "@" <= ch <= "~":
                        self._csi(self._escape)
                        self._escape = ""
                    elif len(self._escape) > 64:
                        self._escape = ""
                elif len(self._escape) >= 2:
                    self._escape = ""
                continue
            if ch == "\x1b":
                self._escape = ch
            elif ch == "\n":
                self._pending_up = 0
                self._dirty_line()
                self._lines.append(_Line(self._layout(self._size()[0])[1]))
            elif ch == "\r":
                self._lines[-1].cursor = 0
            elif ch == "\b":
                self._lines[-1].cursor = max(0, self._lines[-1].cursor - 1)
            elif ch == "\t":
                line = self._lines[-1]
                column = sum(_glyph_width(g) for g, _ in line.cells[:line.cursor])
                for _ in range(4 - column % 4):
                    self._put(" ")
            elif ord(ch) >= 32 and ord(ch) != 127:
                for glyph in _visible_char(ch):
                    self._put(glyph)

    def _put(self, ch):
        line = self._lines[-1]
        if not line.cells and not line.prefix:
            # A newline can precede a resize before response_indent creates
            # the next line's padding. Record the margin with its first glyph.
            line.source_margin = self._layout(self._size()[0])[1]
        if unicodedata.category(ch) in ("Mn", "Me", "Cf") and line.cursor:
            self._dirty_line(line.cursor - 1)
            glyph, style = line.cells[line.cursor - 1]
            line.cells[line.cursor - 1] = (glyph + ch, style)
            return
        self._dirty_line(line.cursor)
        if line.cursor < len(line.cells):
            line.cells[line.cursor] = (ch, self._style)
        else:
            line.cells.append((ch, self._style))
        line.cursor += 1

    def _csi(self, sequence):
        command = sequence[-1]
        params = sequence[2:-1]
        line = self._lines[-1]
        if command in ("A", "F"):
            self._pending_up = int(params) if params.isdigit() else 1
            return
        elif command == "J" and params in ("", "0"):
            up = getattr(self, "_pending_up", 0)
            self._pending_up = 0
            if up > 0:
                empty_tail = 1 if (self._lines and not self._lines[-1].cells) else 0
                cut = max(0, len(self._lines) - up - empty_tail)
                del self._lines[cut:]
                self._lines.append(_Line(self._layout(self._size()[0])[1]))
                self._visual_dirty = min(self._visual_dirty, len(self._lines) - 1)
                self._dirty_line()
                return
        if command == "m":
            codes = params.split(";") if params else ["0"]
            if codes == ["0"]:
                self._style = ""
            elif "0" in codes:
                self._style = sequence
            else:
                self._style += sequence
        elif command == "K":
            self._dirty_line(0 if params in ("1", "2") else line.cursor)
            mode = params or "0"
            if mode == "0":
                del line.cells[line.cursor:]
            elif mode == "1":
                del line.cells[:line.cursor]
                line.cursor = 0
            elif mode == "2":
                line.cells.clear()
                line.cursor = 0
        elif command == "G":
            try:
                line.cursor = max(0, min(len(line.cells), int(params or "1") - 1))
            except ValueError:
                pass

    def _dirty_line(self, offset=0):
        index = len(self._lines) - 1
        self._visual_dirty = min(self._visual_dirty, index)
        line = self._lines[index]
        line.dirty_from = min(line.dirty_from, offset)

    def _visual_transcript(self, width, margin):
        """Reflow changed line tails; unchanged history remains indexed."""
        key = (width, margin, _WINDOWS_NATIVE_WIDTH)
        if key != self._visual_key:
            self._visual_key = key
            self._visual_dirty = 0
        start_line = min(self._visual_dirty, len(self._lines))
        start_row = (self._visual_line_starts[start_line]
                     if start_line < len(self._visual_line_starts)
                     else len(self._visual_rows))
        del self._visual_rows[start_row:]
        del self._visual_anchors[start_row:]
        del self._visual_line_starts[start_line:]
        for line_index in range(start_line, len(self._lines)):
            line = self._lines[line_index]
            self._visual_line_starts.append(len(self._visual_rows))
            cells = line.cells
            old = line.source_margin
            if old and len(cells) >= old and all(
                    glyph == " " for glyph, _ in cells[:old]):
                cells = cells[old:]
            skipped = len(line.cells) - len(cells)
            prefix = _clip(line.prefix, max(0, width - 1))
            continuation = _clip(line.continuation, max(0, width - 1))
            if not prefix and "".join(g for g, _ in cells[:4]) == "  \u2502 ":
                continuation = _clip("  \u2502 ", max(0, width - 1))
            line_key = key + (prefix, continuation, skipped)
            offset = 0
            cached = []
            if line.wrapped_key == line_key and line.wrapped:
                dirty = max(0, line.dirty_from - skipped)
                cut = max(0, bisect.bisect_right(
                    [item[0] for item in line.wrapped], dirty) - 1)
                offset = line.wrapped[cut][0]
                cached = line.wrapped[:cut]
            wrapped = cached
            segment = []
            segment_start = offset
            used = 0
            first = offset == 0
            first_room = max(1, width - display_width(prefix))
            continuation_room = max(1, width - display_width(continuation))
            for cell_index in range(offset, len(cells)):
                glyph, style = cells[cell_index]
                room = first_room if first else continuation_room
                size = _glyph_width(glyph)
                if segment and used + size > room:
                    lead = prefix if first else continuation
                    wrapped.append((segment_start,
                                    " " * margin + lead + _styled(segment)))
                    segment, used, first = [], 0, False
                    segment_start = cell_index
                    room = continuation_room
                if size > room:
                    segment.append(("?", style))
                    used += 1
                else:
                    segment.append((glyph, style))
                    used += size
            lead = prefix if first else continuation
            wrapped.append((segment_start,
                            " " * margin + lead + _styled(segment)))
            line.wrapped, line.wrapped_key = wrapped, line_key
            line.dirty_from = len(line.cells)
            self._visual_rows.extend((line_index, offset, text)
                                     for offset, text in wrapped)
            self._visual_anchors.extend((line_index, offset)
                                        for offset, _ in wrapped)
        self._visual_dirty = len(self._lines)
        return self._visual_rows

    def _footer(self, width, margin, height):
        if height == 1:
            visible = _visible_text(self._draft)
            before = _visible_text(self._draft[:self._cursor])
            return [" " * margin + _clip(visible, width)], (0, min(
                width - 1, _glyph_width(before)))
        key = tuple(getattr(self.client, name, None)
                    for name in ("model", "base", "agent", "workpath"))
        if key != self._meta_key:
            self._meta_key = key
            self._meta_value = client_meta(self.client)
        model, endpoint, details = (_chrome_text(value)
                                    for value in self._meta_value)
        room = max(1, width - 6)
        body = []
        for chunk in self._chunks:
            body.extend(_wrap_plain(chunk, room))
        draft, (draft_row, draft_col) = _draft_rows(self._draft, self._cursor, room)
        cursor_row = len(body) + draft_row
        body.extend(draft)
        if height >= 3:
            capacity = max(1, height - 2)
            wanted = min(len(body), capacity)
            top = max(0, min(cursor_row - wanted + 1, len(body) - wanted))
            shown = body[top:top + wanted]
            lines = [self._box_top(width, model, endpoint, details)]
            lines += [self._box_row(width, part, index == 0)
                      for index, part in enumerate(shown)]
            lines.append(self._box_bottom(width))
            input_row = 1 + cursor_row - top
        else:
            shown = body[-1:]
            lines = [self._box_top(width, model, endpoint, details)]
            lines += [self._box_row(width, shown[0], True)]
            input_row = len(lines) - 1
        cursor_col = min(max(0, width - 2), 4 + draft_col)
        return [" " * margin + line for line in lines], (input_row, cursor_col)

    def _box_top(self, width, model, endpoint, details):
        line = box_top(width, _chrome_text(self._label), model, endpoint, details)
        if width >= 2 and not strip_ansi(line).endswith(TR):
            return TL + H * (width - 2) + TR
        return line

    @staticmethod
    def _box_row(width, part, first):
        if _WINDOWS_NATIVE_WIDTH and _glyph_width(part) != display_width(part):
            if width >= 6:
                room = width - 6
                body = _clip(part, room)
                pad = room - _glyph_width(body)
                lead = MARK if first else "  "
                marker = c_bold(c_green(lead)) if first else lead
                return (c_cyan(V) + " " + marker + body + " " * pad + " "
                        + c_cyan(V))
            middle = _clip(part, max(0, width - 2))
            if width >= 2:
                return (V + middle +
                        " " * (width - 2 - _glyph_width(middle)) + V)
            return V
        line = box_row(width, part, first)
        if width >= 2 and not strip_ansi(line).endswith(V):
            middle = _clip(part, width - 2)
            return V + middle + " " * (width - 2 - _glyph_width(middle)) + V
        return line

    def _box_bottom(self, width):
        line = box_bottom(width, stats=session_meta(self.client))
        if width >= 2 and not strip_ansi(line).endswith(BR):
            line = box_bottom(width)
            if not strip_ansi(line).endswith(BR):
                line = BL + H * (width - 2) + BR
        return line

    def _draw(self, incremental=False):
        cols, rows = self._size()
        width, margin = self._layout(cols)
        if rows >= 4:
            room = max(1, width - 6)
            body_rows = sum(len(_wrap_plain(chunk, room)) for chunk in self._chunks)
            body_rows += len(_wrap_plain(self._draft, room))
            footer_height = min(rows - 1, max(3, body_rows + 2))
        else:
            footer_height = 2 if rows == 3 else 1
        header_budget = min(5, max(0, rows - footer_height - 1))
        if header_budget == 2:
            header_budget = 1
        header = self._header(cols, header_budget)
        header_height = len(header)
        transcript_height = max(0, rows - footer_height - header_height)
        status_rows = 1 if transcript_height >= 2 else 0
        visible_rows = transcript_height - status_rows
        visual = self._visual_transcript(width, margin)
        self._visual_rows = visual
        max_top = max(0, len(visual) - visible_rows) if visible_rows else 0
        if self._follow_tail:
            top = max_top
        elif self._scroll_anchor is None or not visual:
            top = 0
        else:
            top = max(0, min(max_top,
                             bisect.bisect_right(self._visual_anchors,
                                                 self._scroll_anchor) - 1))
        anchor = visual[top][:2] if visual and visible_rows else None
        self._scroll_state = {
            "following": self._follow_tail, "top": top, "max_top": max_top,
            "total_rows": len(visual), "visible_rows": visible_rows,
            "anchor": list(anchor) if anchor is not None else None,
        }
        transcript = [item[2] for item in visual[top:top + visible_rows]]
        display = list(header)
        display.extend([""] * max(0, visible_rows - len(transcript)))
        display.extend(transcript)
        if status_rows:
            if self._follow_tail:
                status = "live \u00b7 PgUp/PgDn / wheel"
            else:
                status = "scroll %d/%d \u00b7 PgDn live" % (top + 1, max_top + 1)
            display.append(" " * margin + c_cyan(_clip(status, width)))
        footer, (cursor_row, cursor_col) = self._footer(
            width, margin, footer_height)
        display.extend(footer)
        display = display[:rows]
        paint_size = (cols, rows, width, margin, header_height,
                      transcript_height)
        full = (not incremental or self._paint_size != paint_size or
                self._last_display is None)
        color_enabled = bool(term.PAINT.on and self.isatty())
        frame = ["\x1b[?25l\x1b[H" if full else "\x1b[?25l"]
        if full:
            frame.append(app_themes.background_sequence(color_enabled) or "\x1b[0m")
        for index, line in enumerate(display, 1):
            if full or self._last_display[index - 1] != line:
                rendered = app_themes.render_line(line, color_enabled)
                frame.append("\x1b[%d;1H%s\x1b[K" % (index, rendered))
        screen_row = min(rows, header_height + transcript_height + cursor_row + 1)
        screen_col = min(cols, margin + cursor_col + 1)
        frame.append("\x1b[%d;%dH\x1b[?25h" % (screen_row, screen_col))
        self._geometry = {
            "columns": cols, "rows": rows,
            "header_rows": header_height, "transcript_top": header_height,
            "footer_top": header_height + transcript_height,
            "footer_rows": footer_height, "footer_left": margin,
            "footer_width": width, "transcript_rows": transcript_height,
            "scroll_status_row": (header_height + transcript_height - 1
                                   if status_rows else None),
            "cursor_row": screen_row - 1, "cursor_column": screen_col - 1,
        }
        self.out.write("".join(frame))
        self.out.flush()
        self._last_display = display
        self._paint_size = paint_size
        self._last_size = (cols, rows)
