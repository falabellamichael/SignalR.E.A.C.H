"""Model-backed pinned terminal footer for interactive chat.

The footer owns the alternate screen and every physical write while active.
Input is supplied as a logical buffer by the editor; no screen cells are read
back to recover a draft. The transcript is retained and reflowed on resize.
"""

import os
import shutil
import threading
import unicodedata

from .terminal import c_bold, c_cyan, c_green
from .chatbox import (BL, BR, H, MARK, TL, TR, V, box_bottom, box_row, box_top,
                      client_meta, session_meta)
from .splash import PAGE_WIDTH, char_width, display_width, layout_mode, strip_ansi


# Windows console cells count residual marks, joiners and regional indicators.
# NFC first keeps composable accents in one cell.
_WINDOWS_NATIVE_WIDTH = os.name == "nt"


class _Line:
    __slots__ = ("cells", "cursor", "source_margin", "prefix", "continuation")

    def __init__(self, source_margin=0, prefix="", continuation=""):
        self.cells = []  # pairs of (visible glyph, active SGR sequences)
        self.cursor = 0
        self.source_margin = source_margin
        self.prefix = prefix
        self.continuation = continuation


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
            self._stop.clear()
            self._active = True
            modes = "\x1b[?1049h"
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
            modes = "\x1b[?25h"
            if os.name != "nt":
                modes += "\x1b[?2004l"
            self.out.write(modes + "\x1b[?1049l")
            self.out.flush()
            watcher = self._watcher
        if watcher is not None and watcher is not threading.current_thread():
            watcher.join(timeout=0.2)

    def _watch(self):
        while not self._stop.wait(0.05):
            with self._lock:
                if not self._active:
                    return
                if self._size() != self._last_size:
                    self._draw()

    def write(self, text):
        text = str(text)
        with self._lock:
            if not self._active:
                return self.out.write(text)
            self._consume(text)
            self._draw()
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

    def refresh_metadata(self):
        """Refresh the workspace branch once when a new prompt begins."""
        with self._lock:
            self._meta_key = None
            if self._active:
                self._draw()

    def clear_banner_on_submit(self):
        with self._lock:
            if self._banner_cleared:
                return
            self._banner_cleared = True
            self._lines = [_Line()]
            if self._active:
                self._draw()

    def finish_input(self, text, echo=True):
        with self._lock:
            if echo:
                self.clear_banner_on_submit()
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
        if unicodedata.category(ch) in ("Mn", "Me", "Cf") and line.cursor:
            glyph, style = line.cells[line.cursor - 1]
            line.cells[line.cursor - 1] = (glyph + ch, style)
            return
        if line.cursor < len(line.cells):
            line.cells[line.cursor] = (ch, self._style)
        else:
            line.cells.append((ch, self._style))
        line.cursor += 1

    def _csi(self, sequence):
        command = sequence[-1]
        params = sequence[2:-1]
        line = self._lines[-1]
        if command == "m":
            codes = params.split(";") if params else ["0"]
            if codes == ["0"]:
                self._style = ""
            elif "0" in codes:
                self._style = sequence
            else:
                self._style += sequence
        elif command == "K":
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

    def _visual_transcript(self, width, margin):
        rows = []
        for line in self._lines:
            cells = line.cells
            old = line.source_margin
            if old and len(cells) >= old and all(
                    glyph == " " for glyph, _ in cells[:old]):
                cells = cells[old:]
            raw = "".join(glyph for glyph, _ in cells)
            prefix = _clip(line.prefix, max(0, width - 1))
            continuation = _clip(line.continuation, max(0, width - 1))
            if not prefix and raw.startswith("  \u2502 "):
                continuation = _clip("  \u2502 ", max(0, width - 1))
            segment = []
            used = 0
            first = True
            for glyph, style in cells:
                room = max(1, width - display_width(
                    prefix if first else continuation))
                size = _glyph_width(glyph)
                if segment and used + size > room:
                    lead = prefix if first else continuation
                    rows.append(" " * margin + lead + _styled(segment))
                    segment, used, first = [], 0, False
                if size > room:
                    segment.append(("?", style))
                    used += 1
                else:
                    segment.append((glyph, style))
                    used += size
            lead = prefix if first else continuation
            rows.append(" " * margin + lead + _styled(segment))
        return rows

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

    def _draw(self):
        cols, rows = self._size()
        width, margin = self._layout(cols)
        if rows >= 4:
            room = max(1, width - 6)
            body_rows = sum(len(_wrap_plain(chunk, room)) for chunk in self._chunks)
            body_rows += len(_wrap_plain(self._draft, room))
            footer_height = min(rows - 1, max(3, body_rows + 2))
        else:
            footer_height = 2 if rows == 3 else 1
        transcript_height = rows - footer_height
        transcript = (self._visual_transcript(width, margin)[-transcript_height:]
                      if transcript_height else [])
        display = ([""] * max(0, transcript_height - len(transcript)) + transcript)
        footer, (cursor_row, cursor_col) = self._footer(
            width, margin, footer_height)
        display.extend(footer)
        display = display[:rows]
        frame = ["\x1b[?25l\x1b[H"]
        for index, line in enumerate(display, 1):
            frame.append("\x1b[%d;1H%s\x1b[K" % (index, line))
        screen_row = min(rows, transcript_height + cursor_row + 1)
        screen_col = min(cols, margin + cursor_col + 1)
        frame.append("\x1b[%d;%dH\x1b[?25h" % (screen_row, screen_col))
        self._geometry = {
            "columns": cols, "rows": rows, "footer_top": transcript_height,
            "footer_rows": footer_height, "footer_left": margin,
            "footer_width": width, "transcript_rows": transcript_height,
            "cursor_row": screen_row - 1, "cursor_column": screen_col - 1,
        }
        self.out.write("".join(frame))
        self.out.flush()
        self._last_size = (cols, rows)
