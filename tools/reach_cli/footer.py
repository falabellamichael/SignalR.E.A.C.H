"""Model-backed pinned terminal footer for interactive chat.

The footer owns the alternate screen and every physical write while active.
Input is supplied as a logical buffer by the editor; no screen cells are read
back to recover a draft. The transcript is retained and reflowed on resize.
"""

import os
import bisect
import re
import shutil
import threading
import time
import unicodedata

from collections import deque

from . import themes as app_themes
from . import terminal as term
from .terminal import VERSION, c_bold, c_cyan, c_dim, c_green
from .chatbox import (BL, BR, H, MARK, TL, TR, V, box_bottom, box_row, box_top,
                      client_meta, session_meta)
from .splash import PAGE_WIDTH, char_width, display_width, layout_mode, strip_ansi
from .hud import render_header
from .pets import PET_NAMES, get_client_pet
from .system_telemetry import SystemTelemetry


# Windows console cells count residual marks, joiners and regional indicators.
# NFC first keeps composable accents in one cell.
_WINDOWS_NATIVE_WIDTH = os.name == "nt"


class _Line:
    __slots__ = ("cells", "cursor", "source_margin", "prefix", "continuation",
                 "dirty_from", "wrapped", "wrapped_key", "tool", "markdown")

    def __init__(self, source_margin=0, prefix="", continuation=""):
        self.cells = []  # pairs of (visible glyph, active SGR sequences)
        self.cursor = 0
        self.source_margin = source_margin
        self.prefix = prefix
        self.continuation = continuation
        self.dirty_from = 0
        self.wrapped = []
        self.wrapped_key = None
        self.tool = None
        self.markdown = None


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
        self.pet = get_client_pet(client)
        self._pet_tick = 0.0
        self._pet_status = None
        self._header_budget = 0
        self._telemetry = SystemTelemetry()
        self._telemetry_key = None
        self._telemetry_value = {}
        self._follow_tail = True
        self._reading_padding = None
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
        self._thought_regions = []
        self._pointer = None
        self._hover = None
        self._dismissed_thought = None
        self._covered = set()
        self._bubble_geometry = None
        self._thought_layout = None
        self._interaction_boxes = ()
        self._followups = deque()
        self._draft_carry = None
        self._menu = None
        self._menu_geometry = None

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
                "menu": dict(self._menu) if self._menu is not None else None,
                "menu_geometry": dict(self._menu_geometry) if self._menu_geometry is not None else None,
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
            self._reading_padding = None
            self._scroll_anchor = None
            self._thought_regions = []
            self._hover = None
            self._pointer = None
            self._dismissed_thought = None
            self._covered = set()
            self._bubble_geometry = None
            self._thought_layout = None
            self._interaction_boxes = ()
            self._followups.clear()
            self._draft_carry = None
            self._menu = None
            self._menu_geometry = None
            self._stop.clear()
            self._active = True
            term.PAINT.managed_screen = True
            self._telemetry.start()
            # 1003 any-event tracking feeds pointer motion; terminals that do
            # not report movement simply never produce a hover event.
            modes = "\x1b[?1049h\x1b[?1000h\x1b[?1003h\x1b[?1006h"
            if os.name != "nt":
                modes += "\x1b[?2004h"
            self.out.write(modes)
            self._draw()
            from .footer_input import set_ui_resolver
            set_ui_resolver(self.capture_click)
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
            modes = "\x1b[?25h\x1b[?1006l\x1b[?1003l\x1b[?1000l"
            if os.name != "nt":
                modes += "\x1b[?2004l"
            self.out.write(modes + "\x1b[0m\x1b[?1049l")
            self.out.flush()
            term.PAINT.managed_screen = False
            from .footer_input import set_ui_resolver
            set_ui_resolver(None)
            watcher = self._watcher
        if watcher is not None and watcher is not threading.current_thread():
            watcher.join(timeout=0.2)

    def _watch(self):
        while not self._stop.wait(0.02):
            try:
                self._watch_tick()
            except Exception:
                # This thread owns scrolling, resize, clicks and hover for
                # the whole session. One bad poll or draw must never kill
                # it — a dead watcher is scrolling that silently stops.
                continue

    def _watch_tick(self):
        # Input is serviced before optional telemetry/animation work. A
        # recurring header failure must never starve scroll or click events.
        from .footer_input import poll_ui_events, poll_pointer
        for kind, payload in poll_ui_events() or ():
            try:
                if kind == "hover":
                    self.hover(payload)
                elif kind == "click":
                    self.click(payload)
                elif kind == "scroll":
                    self.scroll_ui(*payload)
            except Exception:
                continue
        self.hover(poll_pointer())
        with self._lock:
            if not self._active:
                return
            sample = self._telemetry_snapshot()
            sample_key = tuple(sample.get(key) for key in (
                "cpu_pct", "gpu_pct", "gpu_name", "gpu_status",
                "gpu_memory_used", "gpu_memory_total", "ram_used",
                "ram_total"))
            resized = self._size() != self._last_size
            changed = sample_key != self._telemetry_key
            now = time.monotonic()
            pet_state = self.pet.snapshot()
            pet_status = pet_state.get("status")
            status_changed = pet_status != self._pet_status
            animate = (pet_state["motion"] and
                       now - self._pet_tick >= 0.1)
            if resized or changed or animate or status_changed:
                self._telemetry_key = sample_key
                self._pet_tick = now
                self._pet_status = pet_status
                if resized:
                    self._draw()
                else:
                    self._draw_header()

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

    def write_markdown_source(self, source, continuation):
        """Retain one source line so resize can rebuild prose and code rows."""
        with self._lock:
            if not self._active:
                return False
            margin = self._layout(self._size()[0])[1]
            continued = strip_ansi(continuation)
            if margin and continued.startswith(" " * margin):
                continued = continued[margin:]
            # A fence following an AI label/thought starts on its own row;
            # every code border and body then share the same gutter budget.
            leading = "".join(g for g, _ in self._lines[-1].cells)
            if source.kind == "code_top" and leading.strip() != continued.strip():
                self._consume("\n" + continuation)
            index = len(self._lines) - 1
            line = self._lines[index]
            leading = tuple(line.cells)
            plain = source.plain()
            self._consume(plain + "\n")
            line.markdown = {"source": source, "leading": leading,
                             "continuation": continued}
            if source.kind == "prose":
                body = strip_ansi(plain)
                hanging = re.match(r"^(\s*)(?:• |\d+[.)] )", body)
                if hanging:
                    continued += " " * _glyph_width(hanging.group(0))
                elif body.startswith("▎ "):
                    continued += "▎ "
                line.continuation = continued
            self._visual_dirty = min(self._visual_dirty, index)
            self._draw(incremental=True)
            return True

    def set_input(self, text, cursor, chunks=(), label="you"):
        with self._lock:
            text = str(text)
            if text != self._draft and label == "you":
                self.pet.note_input(text)
            self._draft = text
            self._cursor = max(0, min(len(self._draft), int(cursor)))
            self._chunks = tuple(str(item) for item in chunks)
            self._label = str(label)
            if self._active:
                self._draw(incremental=True)

    def reset_input(self):
        self.set_input("", 0)

    def set_menu(self, title, choices, selected=0, current=None):
        """Paint a keyboard menu without putting it in the chat transcript."""
        choices = tuple(tuple(str(part) for part in choice) for choice in choices)
        if not choices:
            self.clear_menu()
            return
        if any(len(choice) != 3 for choice in choices):
            raise ValueError("Menu choices require value, label and detail.")
        with self._lock:
            self._menu = {
                "title": str(title), "choices": choices,
                "selected": max(0, min(len(choices) - 1, int(selected))),
                "current": current,
            }
            self._interaction_boxes = ()
            if self._active:
                self._draw(incremental=True)

    def clear_menu(self):
        """Reveal the retained transcript and restore the editor cursor."""
        with self._lock:
            self._menu = None
            self._menu_geometry = None
            if self._active:
                self._draw(incremental=True)

    def queue_followup(self, text):
        """A prompt submitted while a reply streams — fires once it ends."""
        with self._lock:
            self._followups.append(str(text))

    def take_followup(self):
        """Oldest queued follow-up prompt, or None when the queue is empty."""
        with self._lock:
            return self._followups.popleft() if self._followups else None

    def has_followups(self):
        """Whether queued follow-ups wait — Enter on an empty draft releases."""
        with self._lock:
            return bool(self._followups)

    def carry_draft(self, text, cursor):
        """Preserve an unsubmitted composer draft across reader handoffs."""
        text = str(text or "")
        with self._lock:
            self._draft_carry = (text, max(0, min(len(text), int(cursor or 0)))) \
                if text else None

    def take_draft_carry(self):
        """Consume the carried draft; the next prompt opens with it."""
        with self._lock:
            carry, self._draft_carry = self._draft_carry, None
            return carry or ("", 0)

    def scroll_lines(self, delta):
        """Scroll transcript rows; positive goes up, negative goes down."""
        with self._lock:
            if not self._active or self._menu is not None:
                return
            if self._size() != self._last_size:
                self._draw()
            if self._reading_padding is not None:
                self._reading_padding = None
                self._draw(incremental=True)
            state = self._scroll_state
            top = max(0, min(state["max_top"], state["top"] - int(delta)))
            if top >= state["max_top"]:
                self._follow_tail = True
                self._scroll_anchor = None
            else:
                self._follow_tail = False
                self._scroll_anchor = (self._visual_rows[top][:2]
                                       if top < len(self._visual_rows) else None)
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
            if self._menu is not None:
                return
            self._follow_tail = True
            self._reading_padding = None
            self._scroll_anchor = None
            if self._active:
                self._draw()

    def scroll(self, action, amount=1):
        """Dispatch normalized editor and mouse scroll events."""
        self.scroll_events(((action, amount),))

    def scroll_ui(self, action, amount=1, pointer=None):
        """Wheel scrolls the surface under it; page keys follow pinned focus."""
        with self._lock:
            if not self._active or self._menu is not None:
                return
            if self._size() != self._last_size:
                self._draw()
            if pointer is not None:
                self.hover(pointer)
            thought = self._hover
            target = thought is not None and self._bubble_geometry is not None and (
                (pointer is None and thought.get("pinned")) or
                (pointer is not None and (self._inside_bubble(pointer) or
                    (self._thought_at(*pointer) or (None,))[0] is thought.get("region"))))
            if target:
                self._scroll_thought(action, amount)
            else:
                if thought is not None and not thought.get("pinned"):
                    self._hide_thought()
                self.scroll_events(((action, amount),))

    def scroll_events(self, events):
        """Apply a navigation burst in order, painting its final view once."""
        if not events:
            return
        with self._lock:
            if not self._active or self._menu is not None:
                return
            if self._size() != self._last_size:
                self._draw()
            if self._reading_padding is not None:
                self._reading_padding = None
                self._draw(incremental=True)
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
                self._scroll_anchor = (
                    None if self._follow_tail or top >= len(self._visual_rows)
                    else self._visual_rows[top][:2])
                self._draw()

    def note_thought(self, parts, length):
        """Bind the thought mark just written to its reasoning text source.

        ``parts`` is the reply's live list of reasoning fragments, read when
        the bubble is drawn so a still-streaming thought keeps growing.
        """
        with self._lock:
            index = len(self._lines) - 1
            while index > 0 and not self._lines[index].cells:
                index -= 1
            line = self._lines[index]
            self._thought_regions.append({
                "line": index,
                "start": max(0, line.cursor - max(1, int(length))),
                "end": line.cursor,
                "parts": parts,
            })

    @staticmethod
    def _tool_details(parts):
        """Keep styled details as safe logical lines, outside the output stream."""
        lines = []
        style = ""
        for part in parts:
            if isinstance(part, dict) and "summary" in part:
                header = FooterScreen._tool_details([part["summary"]])[0]
                arrow = next(i for i, (glyph, _) in enumerate(header.cells) if glyph == ">")
                header.tool = {"arrow": arrow, "expanded": False,
                               "details": FooterScreen._tool_details(part["details"])}
                lines.append(header)
                continue
            for raw in str(part).split("\n"):
                line = _Line(prefix="    ", continuation="    ")
                for piece in re.split(r"(\x1b\[[0-9;]*m)", raw):
                    if re.fullmatch(r"\x1b\[[0-9;]*m", piece):
                        codes = piece[2:-1].split(";") if piece[2:-1] else ["0"]
                        style = "" if codes == ["0"] else (
                            piece if "0" in codes else style + piece)
                    else:
                        for glyph in _project_text(piece, newline="\u21b5"):
                            if unicodedata.category(glyph) in ("Mn", "Me", "Cf") and line.cells:
                                previous, active = line.cells[-1]
                                line.cells[-1] = (previous + glyph, active)
                            else:
                                line.cells.append((glyph, style))
                line.cursor = len(line.cells)
                lines.append(line)
        return lines

    def begin_tool_call(self, summary, details):
        """Add a collapsed call; return its opaque line token for later results."""
        with self._lock:
            if not self._active:
                return None
            if self._lines[-1].cells:
                self._consume("\n")
            index = len(self._lines) - 1
            self._consume(str(summary).replace("\n", " ") + "\n")
            line = self._lines[index]
            # The summary supplies its own indentation, without a painted
            # page margin. Keep those spaces when centered chat is reflowed.
            line.source_margin = 0
            arrow = next((i for i, (glyph, _style) in enumerate(line.cells)
                          if glyph == ">"), None)
            if arrow is None:
                arrow = 0
                line.cells.insert(0, (">", ""))
            line.tool = {"index": index, "arrow": arrow, "expanded": False,
                         "details": self._tool_details(details)}
            self._visual_dirty = min(self._visual_dirty, index)
            self._draw(incremental=True)
            return line

    def finish_tool_call(self, token, details):
        """Append results to this call, preserving its disclosure state."""
        with self._lock:
            if not self._active or not isinstance(token, _Line) or token.tool is None:
                return False
            index = token.tool["index"]
            if index >= len(self._lines) or self._lines[index] is not token:
                return False
            token.tool["details"].extend(self._tool_details(details))
            if token.tool["expanded"]:
                self._visual_dirty = min(self._visual_dirty, index)
                self._draw(incremental=True)
            return True

    def _inside_bubble(self, pointer):
        box = self._bubble_geometry
        if box is None or pointer is None:
            return False
        x, y = pointer
        return box["left"] <= x < box["left"] + box["width"] and \
            box["row"] <= y < box["row"] + box["height"]

    def capture_click(self, pointer):
        """Resolve against an immutable completed frame; never block input."""
        if not self._active or self._menu is not None or pointer is None:
            return None
        x, y = pointer
        for left, top, right, bottom, target in self._interaction_boxes:
            if left <= x < right and top <= y < bottom:
                return target
        return None

    def _hold_view(self):
        if self._follow_tail:
            state = self._scroll_state
            self._follow_tail = False
            top = state["top"]
            self._scroll_anchor = self._visual_rows[top][:2] if self._visual_rows else None
            self._reading_padding = state.get("padding", max(0,
                state["visible_rows"] - min(state["visible_rows"], state["total_rows"]-top)))

    def click(self, pointer):
        """Open tools or pin thoughts using the clicked frame's logical target."""
        with self._lock:
            if not self._active or self._menu is not None or pointer is None:
                return False
            if self._size() != self._last_size:
                self._draw()
            target = pointer.target if hasattr(pointer, "target") else self.capture_click(pointer)
            if target is None:
                if self._hover is not None and self._hover.get("pinned"):
                    self._dismiss_thought()
                    self._draw(incremental=True)
                return False
            kind, identity = target
            if kind == "thought_close":
                if self._hover is None or self._hover["parts"] is not identity:
                    return False
                self._dismiss_thought()
                self._pointer = None
                self._draw(incremental=True)
                return True
            if kind == "thought_body":
                if self._hover is None or self._hover["parts"] is not identity:
                    return False
                self._hover.update(pinned=True, following=False)
                self._hold_view()
                self._draw(incremental=True)
                return True
            if kind == "thought":
                if not any(region is identity for region in self._thought_regions):
                    return False
                if self._hover is not None and self._hover["parts"] is identity["parts"] and self._hover.get("pinned"):
                    self._dismiss_thought()
                elif self._hover is not None and self._hover["parts"] is identity["parts"]:
                    self._hover.update(pinned=True, following=False)
                else:
                    self._open_thought(identity, pinned=True)
                    self._hold_view()
                self._draw(incremental=True)
                return True
            if kind == "tool_detail":
                parent, detail = identity
                index = parent.tool["index"] if parent.tool is not None else -1
                if not 0 <= index < len(self._lines) or self._lines[index] is not parent:
                    return False
                offset = next((offset for offset, item in self._detail_rows(parent)
                               if item is detail), None)
                if offset is None:
                    return False
                arrow = detail.tool["arrow"]
                detail.tool["expanded"] = not detail.tool["expanded"]
                _, style = detail.cells[arrow]
                detail.cells[arrow] = ("v" if detail.tool["expanded"] else ">", style)
                detail.dirty_from = min(detail.dirty_from, arrow)
                self._visual_dirty = min(self._visual_dirty, index)
                self._hold_view()
                self._pointer = None
                self._hide_thought()
                self._draw(incremental=True, hold_view=True)
                return True
            if kind != "tool":
                return False
            line = identity
            line_index = line.tool["index"] if line.tool is not None else -1
            if not 0 <= line_index < len(self._lines) or self._lines[line_index] is not line:
                return False
            arrow = line.tool["arrow"]
            line.tool["expanded"] = not line.tool["expanded"]
            _, style = line.cells[arrow]
            line.cells[arrow] = ("v" if line.tool["expanded"] else ">", style)
            line.dirty_from = min(line.dirty_from, arrow)
            self._visual_dirty = min(self._visual_dirty, line_index)
            # A user opening details is browsing. Anchor the call so long
            # results remain reachable and incoming tokens do not displace it.
            self._follow_tail = False
            self._reading_padding = None
            self._scroll_anchor = (line_index, 0)
            self._pointer = None
            self._hide_thought()
            self._draw(incremental=True, hold_view=True)
            return True

    def _transcript_at(self, x, y):
        """Resolve a visible terminal cell to its indexed transcript row."""
        state = self._scroll_state
        top = int(state.get("top") or 0)
        visible = int(state.get("visible_rows") or 0)
        shown = max(0, min(visible, int(state.get("total_rows") or 0) - top))
        row = y - int(self._geometry.get("transcript_top") or 0) - state.get("padding", visible - shown)
        index = top + row
        if row < 0 or row >= shown or index >= len(self._visual_rows):
            return None
        return index

    def hover(self, pointer):
        """Track the pointer and toggle the thought bubble on transitions."""
        with self._lock:
            if not self._active or self._menu is not None:
                return
            if self._size() != self._last_size:
                self._draw()
            self._pointer = pointer
            if self._hover is not None and (self._hover.get("pinned") or self._inside_bubble(pointer)):
                if self._hover.get("revision") != len(self._hover["parts"]):
                    self._hover["revision"] = len(self._hover["parts"])
                    self._draw(incremental=True)
                return
            hit = self._thought_at(*pointer) if pointer is not None else None
            if self._dismissed_thought is not None:
                if hit is not None and hit[0]["parts"] is self._dismissed_thought:
                    return
                self._dismissed_thought = None
            if hit is None:
                changed = self._hover is not None
                self._hide_thought()
                target = self.capture_click(pointer)
                if target is not None and target[0] == "tool" and self._follow_tail:
                    self._hold_view()
                    changed = True
            else:
                region, visual = hit
                changed = (self._hover is None or
                           self._hover["parts"] is not region["parts"] or
                           self._hover.get("revision") != len(region["parts"]))
                if self._hover is None or self._hover["parts"] is not region["parts"]:
                    self._open_thought(region, visual=visual)
                else:
                    self._hover.update(visual=visual, revision=len(region["parts"]))
                if self._follow_tail:
                    self._hold_view()
                    changed = True
            if changed:
                self._draw(incremental=True)

    def _hide_thought(self):
        self._hover = None
        self._thought_layout = None
        self._bubble_geometry = None

    def _dismiss_thought(self):
        # A stationary pointer must not reopen a box explicitly closed by
        # click. Hover becomes available again once it leaves this mark.
        self._dismissed_thought = self._hover["parts"] if self._hover is not None else None
        self._hide_thought()

    def _open_thought(self, region, visual=None, pinned=False):
        self._dismissed_thought = None
        self._hover = {"parts": region["parts"], "region": region,
                       "visual": visual, "revision": len(region["parts"]),
                       "pinned": pinned, "following": not pinned,
                       "top": 0, "anchor": (0, 0)}
        self._thought_layout = None

    def thought_snapshot(self):
        """Copy popup navigation state without exposing private reasoning."""
        with self._lock:
            if self._hover is None:
                return None
            return {key: self._hover.get(key) for key in
                    ("pinned", "following", "top", "max_top", "total", "visible")}

    def _thought_at(self, x, y):
        """(region, visual index) under a zero-based pointer cell, or None."""
        if x is None or y is None:
            return None
        if not self._thought_regions or not self._visual_rows:
            return None
        geometry = self._geometry
        index = self._transcript_at(x, y)
        if index is None:
            return None
        line_index, offset, _text = self._visual_rows[index]
        if line_index >= len(self._lines):
            return None
        line = self._lines[line_index]
        old = line.source_margin
        cells = line.cells
        stripped = (cells[old:] if old and len(cells) >= old
                    and all(glyph == " " for glyph, _style in cells[:old])
                    else cells)
        skipped = len(line.cells) - len(stripped)
        width = (int(geometry.get("footer_width") or 0) or
                 self._layout(self._size()[0])[0])
        margin = int(geometry.get("footer_left") or 0)
        prefix = _clip(line.prefix, max(0, width - 1))
        if offset == 0:
            lead = prefix
        else:
            lead = _clip(line.continuation, max(0, width - 1))
            if not lead and not prefix and "".join(
                    glyph for glyph, _style in stripped[:4]) == "  \u2502 ":
                lead = _clip("  \u2502 ", max(0, width - 1))
        column = x - margin - display_width(lead)
        if column < 0:
            return None
        used = 0
        for cell_index in range(offset, len(stripped)):
            size = _glyph_width(stripped[cell_index][0])
            if used <= column < used + size:
                logical = skipped + cell_index
                for region in self._thought_regions:
                    if (region["line"] == line_index and
                            region["start"] <= logical < region["end"]):
                        return region, index
                return None
            used += size
        return None

    def _thought_rows(self, width):
        """Incrementally wrap reasoning; long streams do not rebuild old text."""
        parts = self._hover["parts"]
        cache = self._thought_layout
        if cache is None or cache["parts"] is not parts or cache["seen"] > len(parts):
            cache = {"parts": parts, "seen": 0, "lines": [_Line()], "rows": [],
                     "starts": [], "dirty": 0, "width": None}
            self._thought_layout = cache
        end_seen = len(parts)
        for part in parts[cache["seen"]:end_seen]:
            for glyph in _project_text(part):
                line = cache["lines"][-1]
                cache["dirty"] = min(cache["dirty"], len(cache["lines"]) - 1)
                line.dirty_from = min(line.dirty_from, len(line.cells))
                if glyph == "\n":
                    cache["lines"].append(_Line())
                elif unicodedata.category(glyph) in ("Mn", "Me", "Cf") and line.cells:
                    previous, style = line.cells[-1]
                    line.dirty_from = min(line.dirty_from, len(line.cells)-1)
                    line.cells[-1] = (previous + glyph, style)
                else:
                    line.cells.append((glyph, ""))
        cache["seen"] = end_seen
        if cache["width"] != width:
            cache["dirty"] = 0
            cache["width"] = width
        dirty = cache["dirty"]
        start = cache["starts"][dirty] if dirty < len(cache["starts"]) else len(cache["rows"])
        del cache["rows"][start:]
        del cache["starts"][dirty:]
        for index in range(dirty, len(cache["lines"])):
            cache["starts"].append(len(cache["rows"]))
            for offset, row in self._wrap_transcript_line(cache["lines"][index], width, 0,
                                                         (width, 0, _WINDOWS_NATIVE_WIDTH)):
                cache["rows"].append((index, offset, strip_ansi(row)))
        cache["dirty"] = len(cache["lines"])
        return cache["rows"]

    def _scroll_thought(self, action, amount=1):
        view = self._hover
        if view is None:
            return
        rows = self._thought_rows(max(1, min(52, self._geometry["footer_width"] - 4)))
        maximum = max(0, len(rows) - max(1, view.get("visible", 1)))
        top = min(maximum, max(0, view.get("top", 0)))
        action = str(action)
        if action.startswith("scroll_"):
            action = action[len("scroll_"):]
        page = max(1, view.get("visible", 1) - 1)
        if action == "live":
            top = maximum
        elif action in ("up", "down", "page_up", "page_down"):
            step = max(1, int(amount)) * (page if action.startswith("page_") else 1)
            top = max(0, min(maximum, top + (-step if action in ("up", "page_up") else step)))
        else:
            return
        view["top"] = top
        view["anchor"] = rows[top][:2] if rows else (0, 0)
        view["following"] = top >= maximum and action not in ("up", "page_up")
        self._draw(incremental=True)

    def _hover_overlay(self, top, transcript_top, visible_rows, width, margin):
        """Absolute (row, column, lines) for the bubble, or None off-screen."""
        if self._hover is None or not visible_rows or width < 6 or visible_rows < 3:
            self._bubble_geometry = None
            return None
        view = self._hover
        state = self._scroll_state
        inner = max(1, min(52, width - 4))
        rows = self._thought_rows(inner)
        capacity = min(visible_rows - 2, 10)
        maximum = max(0, len(rows) - capacity)
        if view["following"]:
            thought_top = maximum
        else:
            anchors = [item[:2] for item in rows]
            thought_top = max(0, min(maximum, bisect.bisect_right(anchors, view["anchor"])-1))
        selected = rows[thought_top:thought_top + capacity]
        view.update(top=thought_top, max_top=maximum, total=len(rows), visible=capacity,
                    anchor=rows[thought_top][:2] if rows else (0, 0))
        title = " thought" + (" · pinned" if view["pinned"] else "")
        box_width = inner + 4
        head = TL + _clip(title, box_width - 4).ljust(box_width - 4, H) + " x" + TR
        body = [V + " " + item[2] + " " * max(0, inner - _glyph_width(item[2])) + " " + V
                for item in selected]
        label = "%d–%d/%d%s" % (thought_top + 1, thought_top + len(selected), len(rows),
                                  " · live" if view["following"] else "")
        tail = BL + _clip(" " + label + " ", box_width - 2).center(box_width - 2, H) + BR
        lines = [c_dim(line) for line in [head] + body + [tail]]
        height = len(lines)
        area_bottom = transcript_top + visible_rows
        previous = self._bubble_geometry
        mark_row = None
        region = view["region"]
        for index in range(top, min(len(self._visual_rows), top + state["visible_rows"])):
            line_index, offset, _text = self._visual_rows[index]
            if line_index == region["line"] and offset <= region["start"] < (
                    self._visual_rows[index+1][1] if index+1 < len(self._visual_rows) and
                    self._visual_rows[index+1][0] == line_index else len(self._lines[line_index].cells)):
                mark_row = transcript_top + state.get("padding", 0) + index - top
                view["visual"] = index
                break
        if previous is not None and (view["pinned"] or self._inside_bubble(self._pointer) or mark_row is None):
            row, left = previous["row"], previous["left"]
        elif mark_row is not None:
            row = mark_row + 1
            if row + height > area_bottom:
                row = mark_row - height
            left = (self._pointer or (margin, mark_row))[0]
        else:
            row, left = transcript_top, margin
        row = max(transcript_top, min(row, area_bottom - height))
        left = max(margin, min(left, margin + width - box_width))
        self._bubble_geometry = {"row": row, "left": left, "height": height, "width": box_width}
        return row, left, lines

    def refresh_metadata(self):
        """Refresh the workspace branch once when a new prompt begins."""
        with self._lock:
            self._meta_key = None
            if self._active:
                self._draw()

    def refresh_header(self):
        """Redraw the pinned HUD after a pet or activity change."""
        with self._lock:
            if self._active:
                self._draw_header()

    def _draw_header(self):
        """Paint the reserved header band without laying out or painting chat.

        The screen lock serializes this with transcript writes. DECSC/DECRC
        preserve the physical cursor and its rendition; header ticks leave
        cursor visibility alone and never lay out chat or redraw an overlay.
        """
        cols, rows = self._size()
        width, margin = self._layout(cols)
        if (self._last_display is None or self._paint_size is None or
                self._paint_size[:4] != (cols, rows, width, margin)):
            self._draw()
            return
        height = self._geometry.get("header_rows", 0)
        if not height:
            return
        header = self._header(cols, self._header_budget)
        if len(header) != height:
            self._draw()
            return
        color_enabled = bool(term.PAINT.on and self.isatty())
        patches = []
        for index, line in enumerate(header):
            if self._last_display[index] != line:
                patches.append("\x1b[%d;1H%s\x1b[K" % (
                    index + 1, app_themes.render_line(line, color_enabled)))
        if patches:
            self.out.write("\x1b7" + "".join(patches) + "\x1b8")
            self.out.flush()
            self._last_display[:height] = header

    def refresh_theme(self):
        """Repaint only the visual frame; logical text and scroll stay intact."""
        with self._lock:
            self._last_display = None
            self._paint_size = None
            if self._active:
                self._draw()

    def select_pet(self, kind):
        with self._lock:
            if not self.pet.select(kind):
                return False
            if self.client is not None:
                self.client.pet = self.pet.snapshot()["kind"]
            self.refresh_header()
            return True

    def cycle_pet(self):
        """Change companions without changing the editor or its cursor."""
        with self._lock:
            kind = self.pet.snapshot()["kind"]
            next_kind = PET_NAMES[(PET_NAMES.index(kind) + 1) % len(PET_NAMES)]
            self.select_pet(next_kind)
            from .session import save_session_config
            save_session_config(pet=next_kind,
                                pet_motion=self.pet.snapshot()["motion"])
            return next_kind

    def set_pet_motion(self, enabled):
        with self._lock:
            self.pet.set_motion(enabled)
            if self.client is not None:
                self.client.pet_motion = bool(enabled)
            self.refresh_header()

    def set_pet_activity(self, activity):
        with self._lock:
            self.pet.set_activity(activity)
            self.refresh_header()

    def care_pet(self, action):
        """Apply care and repaint only the companion's reserved header."""
        with self._lock:
            result = self.pet.care(action)
            self.refresh_header()
            return result

    def _telemetry_snapshot(self):
        try:
            sample = self._telemetry.snapshot()
            if isinstance(sample, dict):
                self._telemetry_value = dict(sample)
        except Exception:
            pass
        return self._telemetry_value

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
            cwd=cwd, branch=branch, telemetry=self._telemetry_snapshot(),
            pet=self.pet,
            color=bool(self.isatty() and term.PAINT.on), max_rows=max_rows)

    def clear_banner_on_submit(self):
        with self._lock:
            if self._banner_cleared:
                return
            self._banner_cleared = True
            self._lines = [_Line()]
            self._thought_regions = []
            self._hide_thought()
            self._dismissed_thought = None
            self._visual_dirty = 0
            self._follow_tail = True
            self._reading_padding = None
            self._scroll_anchor = None
            if self._active:
                self._draw()

    def finish_input(self, text, echo=True):
        with self._lock:
            if echo:
                self.clear_banner_on_submit()
                self._follow_tail = True
                self._reading_padding = None
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

    @staticmethod
    def _detail_rows(line):
        """Reserve offsets even for hidden children so resize anchors stay stable."""
        offset = len(line.cells) + 1
        def walk(details, visible):
            nonlocal offset
            for detail in details:
                start = offset
                offset += len(detail.cells) + 1
                if visible:
                    yield start, detail
                if detail.tool is not None:
                    yield from walk(detail.tool["details"],
                                    visible and detail.tool["expanded"])
        yield from walk(line.tool["details"], line.tool["expanded"])

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
            wrapped = self._wrap_transcript_line(line, width, margin, key)
            self._visual_rows.extend((line_index, offset, text)
                                     for offset, text in wrapped)
            self._visual_anchors.extend((line_index, offset)
                                        for offset, _ in wrapped)
            if line.tool is not None and line.tool["expanded"]:
                # Synthetic detail offsets follow the header's cells and
                # remain sorted with ordinary transcript anchors on resize.
                for detail_start, detail in self._detail_rows(line):
                    details = self._wrap_transcript_line(detail, width, margin, key)
                    self._visual_rows.extend((line_index, detail_start + offset, text)
                                             for offset, text in details)
                    self._visual_anchors.extend((line_index, detail_start + offset)
                                                for offset, _ in details)
        self._visual_dirty = len(self._lines)
        return self._visual_rows

    @staticmethod
    def _wrap_transcript_line(line, width, margin, key):
        """Wrap an ordinary line or a tool's detail using the same cell model."""
        if line.markdown is not None and line.markdown["source"].kind != "prose":
            return FooterScreen._wrap_markdown_code(line, width, margin, key)
        cells = line.cells
        old = line.source_margin
        if old and len(cells) >= old and all(
                glyph == " " for glyph, _ in cells[:old]):
            cells = cells[old:]
        skipped = len(line.cells) - len(cells)
        prefix = _clip(line.prefix, max(0, width - 1))
        continuation = _clip(line.continuation, max(0, width - 1))
        if not continuation and not prefix and "".join(g for g, _ in cells[:4]) == "  \u2502 ":
            continuation = _clip("  \u2502 ", max(0, width - 1))
        line_key = key + (prefix, continuation, skipped)
        offset = 0
        cached = []
        if line.wrapped_key == line_key and line.wrapped:
            dirty = max(0, line.dirty_from - skipped)
            cut = max(0, bisect.bisect_right(
                [item[0] for item in line.wrapped], dirty) - 1)
            # A growing last word can move back across the previous soft
            # boundary. Reflow one earlier row while retaining older history.
            cut = max(0, cut - 1)
            offset = line.wrapped[cut][0]
            cached = line.wrapped[:cut]
        wrapped = cached
        segment = []
        segment_start = offset
        used = 0
        first = offset == 0
        first_room = max(1, width - display_width(prefix))
        continuation_room = max(1, width - display_width(continuation))
        cell_index = offset
        last_break = None
        has_word = False
        soft_start = False
        while cell_index < len(cells):
            glyph, style = cells[cell_index]
            room = first_room if first else continuation_room
            size = _glyph_width(glyph)
            if soft_start and not segment and glyph.isspace():
                cell_index += 1
                segment_start = cell_index
                continue
            if segment and used + size > room:
                lead = prefix if first else continuation
                boundary = last_break if last_break is not None else len(segment)
                end = boundary
                while end and segment[end - 1][0].isspace():
                    end -= 1
                wrapped.append((segment_start, " " * margin + lead + _styled(segment[:end])))
                segment_start += boundary
                segment = segment[boundary:]
                used = sum(_glyph_width(item[0]) for item in segment)
                first = False
                last_break = None
                has_word = bool(segment)
                soft_start = not segment
                if not segment:
                    segment_start = cell_index
                # Reconsider the glyph with the continuation's own budget.
                continue
            if size > room:
                segment.append(("?", style))
                used += 1
            else:
                segment.append((glyph, style))
                used += size
            if glyph.isspace():
                if has_word:
                    last_break = len(segment)
            else:
                has_word = True
                soft_start = False
            cell_index += 1
        lead = prefix if first else continuation
        wrapped.append((segment_start,
                        " " * margin + lead + _styled(segment)))
        line.wrapped, line.wrapped_key = wrapped, line_key
        line.dirty_from = len(line.cells)
        return wrapped

    @staticmethod
    def _wrap_markdown_code(line, width, margin, key):
        """Rebuild a code source line and its box at the current cell budget."""
        data = line.markdown
        leading = list(data["leading"])
        old = line.source_margin
        if old and len(leading) >= old and all(g == " " for g, _ in leading[:old]):
            leading = leading[old:]
        removed = len(data["leading"]) - len(leading)
        first = _styled(leading)
        continued = data["continuation"]
        line_key = key + ("markdown", first, continued)
        if line.wrapped_key == line_key and line.dirty_from >= len(line.cells):
            return line.wrapped
        room = max(1, width - max(_glyph_width(strip_ansi(first)), _glyph_width(continued)))
        source = data["source"]
        rendered = source.render_rows(room)
        semantic = strip_ansi(source.plain())
        # Renderer offsets refer to characters in the undecorated source.
        # Translate once to our glyph-cell indices for stable scroll anchors.
        cell_offsets = [0]
        for glyph in semantic:
            previous = cell_offsets[-1]
            joins_previous = previous and unicodedata.category(glyph) in ("Mn", "Me", "Cf")
            cell_offsets.append(previous + (0 if joins_previous else 1))
        rows = []
        for index, (source_offset, body) in enumerate(rendered):
            lead = first if index == 0 else continued
            # Native Windows cell widths remain the final authority, including
            # flag/combining glyphs whose Markdown width may be smaller.
            projected = FooterScreen._tool_details([lead + body])[0]
            projected.prefix = ""
            projected.continuation = continued
            wrapped = FooterScreen._wrap_transcript_line(projected, width, margin, key)
            offset = (0 if index == 0 else len(leading) +
                      cell_offsets[min(source_offset, len(semantic))])
            for start, text in wrapped:
                anchored = offset + start
                if index and start:
                    # Extra native-width fallback rows must not count the
                    # repeated outer gutter a second time.
                    anchored -= len(FooterScreen._tool_details([lead])[0].cells)
                rows.append((min(anchored, len(line.cells) - removed), text))
        line.wrapped, line.wrapped_key = rows, line_key
        line.dirty_from = len(line.cells)
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

    def _menu_overlay(self, transcript_top, transcript_height, width, margin, rows):
        """Fit the menu to the available transcript cells and keep focus visible."""
        if self._menu is None:
            self._menu_geometry = None
            return None
        menu = self._menu
        choices, selected = menu["choices"], menu["selected"]
        available = max(1, transcript_height)
        box_width = min(width, PAGE_WIDTH)
        selected_detail = _chrome_text(choices[selected][2])
        boxed = box_width >= 8 and available >= 4
        detail_rows = int(boxed and available >= 6 and bool(selected_detail))
        chrome_rows = 2 if boxed else (2 if available >= 3 else int(available >= 2))
        capacity = max(1, min(10, available - chrome_rows - detail_rows))
        start = max(0, min(selected - capacity // 2, len(choices) - capacity))
        end = min(len(choices), start + capacity)
        lines = []
        hint = "↑/↓ move · Enter select · Esc cancel · %d/%d" % (selected + 1, len(choices))

        def entry(index):
            value, label, _detail = choices[index]
            marker = "> " if index == selected else "  "
            if box_width < 5:
                marker = ""
            current = " (current)" if value == menu["current"] else ""
            return marker + _chrome_text(label) + current

        if boxed:
            inner = box_width - 4

            def box_row(text, paint=c_dim):
                body = _clip(text, inner)
                return c_cyan(V) + " " + paint(body) + " " * (
                    inner - _glyph_width(body)) + " " + c_cyan(V)

            title = _clip(" " + _chrome_text(menu["title"]) + " ", box_width - 2)
            lines.append(c_cyan(TL + title + H * (
                box_width - 2 - _glyph_width(title)) + TR))
            for index in range(start, end):
                paint = (lambda text: c_bold(c_green(text))) if index == selected else (lambda text: text)
                lines.append(box_row(entry(index), paint))
            if detail_rows:
                lines.append(box_row(selected_detail))
            hint = _clip(" " + hint + " ", box_width - 2)
            lines.append(c_dim(BL + hint + H * (
                box_width - 2 - _glyph_width(hint)) + BR))
        else:
            if available >= 2:
                lines.append(c_cyan(_clip(_chrome_text(menu["title"]), box_width)))
            for index in range(start, end):
                text = _clip(entry(index), box_width)
                lines.append(c_bold(c_green(text)) if index == selected else text)
            if available >= 3:
                lines.append(c_dim(_clip(hint, box_width)))
        height = len(lines)
        row = min(rows - height, transcript_top + max(0, (transcript_height - height) // 2))
        left = margin + max(0, (width - box_width) // 2)
        self._menu_geometry = {
            "row": row, "left": left, "height": height, "width": box_width,
            "start": start, "end": end, "selected": selected,
        }
        return row, left, lines

    def _draw(self, incremental=False, hold_view=False):
        cols, rows = self._size()
        width, margin = self._layout(cols)
        minimum_footer = 3 if rows >= 4 else (2 if rows == 3 else 1)
        # The header owns its rows before the draft is measured. Its height
        # changes only on terminal resize, never as the composer grows.
        self._header_budget = min(5, max(0, rows - minimum_footer - 1))
        if self._header_budget == 2:
            self._header_budget = 1
        header = self._header(cols, self._header_budget)
        header_height = len(header)
        header_gap = int(bool(header_height and
                              rows - header_height - minimum_footer >= 5))
        transcript_top = header_height + header_gap
        if rows >= 4:
            room = max(1, width - 6)
            body_rows = sum(len(_wrap_plain(chunk, room)) for chunk in self._chunks)
            body_rows += len(_wrap_plain(self._draft, room))
            footer_height = min(rows - transcript_top - 1, max(3, body_rows + 2))
        else:
            footer_height = 2 if rows == 3 else 1
        transcript_height = max(0, rows - footer_height - transcript_top)
        status_rows = 1 if transcript_height >= 2 else 0
        visible_rows = transcript_height - status_rows
        visual = self._visual_transcript(width, margin)
        self._visual_rows = visual
        held_padding = (min(self._reading_padding, max(0, visible_rows - 1))
                        if not self._follow_tail and self._reading_padding is not None else None)
        view_rows = visible_rows - (held_padding or 0)
        max_top = max(0, len(visual) - view_rows) if view_rows else 0
        if self._follow_tail:
            top = max_top
        elif self._scroll_anchor is None or not visual:
            top = 0
        else:
            top = max(0, min(max_top,
                             bisect.bisect_right(self._visual_anchors,
                                                 self._scroll_anchor) - 1))
        anchor = visual[top][:2] if visual and view_rows else None
        transcript = [item[2] for item in visual[top:top + view_rows]]
        padding = (held_padding if held_padding is not None else
                   max(0, visible_rows - len(transcript)))
        if hold_view and not self._follow_tail:
            # A near-tail call's requested anchor can be clamped. Freeze
            # the view actually painted, so later tokens cannot migrate it
            # toward that requested anchor or consume its leading padding.
            self._scroll_anchor = anchor
            self._reading_padding = padding
            view_rows = visible_rows - padding
            max_top = max(0, len(visual) - view_rows) if view_rows else 0
        self._scroll_state = {
            "following": self._follow_tail, "top": top, "max_top": max_top,
            "total_rows": len(visual), "visible_rows": view_rows,
            "padding": padding, "shown_rows": len(transcript),
            "anchor": list(anchor) if anchor is not None else None,
        }
        display = list(header)
        display.extend([""] * header_gap)
        display.extend([""] * padding)
        display.extend(transcript)
        display.extend([""] * max(0, visible_rows - padding - len(transcript)))
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
        paint_size = (cols, rows, width, margin, transcript_top,
                      transcript_height)
        full = (not incremental or self._paint_size != paint_size or
                self._last_display is None)
        color_enabled = bool(term.PAINT.on and self.isatty())
        if self._menu is not None:
            overlay = self._menu_overlay(transcript_top, transcript_height,
                                         width, margin, rows)
        else:
            overlay = self._hover_overlay(top, transcript_top, visible_rows,
                                          width, margin)
        # Rows a previous bubble covered must repaint once it moves or hides.
        stale = self._covered
        covered = set()
        frame = ["\x1b[?25l\x1b[H" if full else "\x1b[?25l"]
        if full:
            frame.append(app_themes.background_sequence(color_enabled) or "\x1b[0m")
        for index, line in enumerate(display, 1):
            if (full or index - 1 in stale or
                    self._last_display[index - 1] != line):
                rendered = app_themes.render_line(line, color_enabled)
                frame.append("\x1b[%d;1H%s\x1b[K" % (index, rendered))
        if overlay is not None:
            overlay_row, overlay_left, overlay_lines = overlay
            for row_offset, text in enumerate(overlay_lines):
                if self._menu is not None:
                    # Clear the menu's row margins so transcript fragments
                    # do not compete with its labels. Covered rows restore
                    # from the retained display when the menu closes.
                    frame.append("\x1b[%d;1H%s\x1b[K" % (
                        overlay_row + row_offset + 1,
                        app_themes.render_line(" " * overlay_left + text, color_enabled)))
                else:
                    frame.append("\x1b[%d;%dH%s" % (
                        overlay_row + row_offset + 1, overlay_left + 1,
                        app_themes.render_line(text, color_enabled)))
                covered.add(overlay_row + row_offset)
        self._covered = covered
        screen_row = min(rows, transcript_top + transcript_height + cursor_row + 1)
        screen_col = min(cols, margin + cursor_col + 1)
        frame.append("\x1b[%d;%dH" % (screen_row, screen_col))
        if self._menu is None:
            frame.append("\x1b[?25h")
        self._geometry = {
            "columns": cols, "rows": rows,
            "header_rows": header_height, "header_gap": header_gap,
            "header_region_rows": transcript_top, "transcript_top": transcript_top,
            "footer_top": transcript_top + transcript_height,
            "footer_rows": footer_height, "footer_left": margin,
            "footer_width": width, "transcript_rows": transcript_height,
            "scroll_status_row": (transcript_top + transcript_height - 1
                                   if status_rows else None),
            "cursor_row": screen_row - 1, "cursor_column": screen_col - 1,
        }
        self.out.write("".join(frame))
        self.out.flush()
        self._last_display = display
        self._paint_size = paint_size
        self._last_size = (cols, rows)
        self._publish_interactions()

    def _publish_interactions(self):
        """Publish only visible logical hit targets after a frame is painted."""
        if self._menu is not None:
            self._interaction_boxes = ()
            return
        boxes = []
        geometry, state = self._geometry, self._scroll_state
        margin = geometry["footer_left"]
        top = state["top"]
        for visual in range(top, min(len(self._visual_rows), top + state["visible_rows"])):
            line_index, offset, text = self._visual_rows[visual]
            if line_index >= len(self._lines):
                continue
            line = self._lines[line_index]
            y = geometry["transcript_top"] + state["padding"] + visual - top
            if y in self._covered:
                continue
            if line.tool is not None and offset == 0:
                arrow = margin + sum(_glyph_width(g) for g, _ in line.cells[:line.tool["arrow"]])
                boxes.append((arrow, y, _glyph_width(strip_ansi(text)), y+1, ("tool", line)))
            if line.tool is not None and offset:
                for start, detail in self._detail_rows(line):
                    if start == offset and detail.tool is not None:
                        arrow = margin + _glyph_width(detail.prefix) + sum(
                            _glyph_width(g) for g, _ in detail.cells[:detail.tool["arrow"]])
                        boxes.append((arrow, y, _glyph_width(strip_ansi(text)), y+1,
                                      ("tool_detail", (line, detail))))
                        break
            regions = [r for r in self._thought_regions if r["line"] == line_index]
            if not regions:
                continue
            cells = line.cells
            old = line.source_margin
            skipped = old if old and len(cells) >= old and all(g == " " for g, _ in cells[:old]) else 0
            cells = cells[skipped:]
            lead = _clip(line.prefix if offset == 0 else line.continuation, max(0, geometry["footer_width"]-1))
            if offset and not lead and not line.prefix and "".join(g for g, _ in cells[:4]) == "  │ ":
                lead = "  │ "
            x = margin + _glyph_width(lead)
            right = _glyph_width(strip_ansi(text))
            for cell in range(offset, len(cells)):
                size = _glyph_width(cells[cell][0])
                if x >= right:
                    break
                for region in regions:
                    if region["start"] <= skipped + cell < region["end"]:
                        boxes.append((x, y, min(right, x+size), y+1, ("thought", region)))
                x += size
        if self._hover is not None and self._bubble_geometry is not None:
            box = self._bubble_geometry
            left, row, width, height = (box[k] for k in ("left", "row", "width", "height"))
            parts = self._hover["parts"]
            boxes.insert(0, (left, row, left+width, row+height, ("thought_body", parts)))
            boxes.insert(0, (left+width-3, row, left+width-1, row+1, ("thought_close", parts)))
        self._interaction_boxes = tuple(boxes)
