"""Standard-library input for the persistent footer.

The line's text and cursor are logical state. A single reader receives key
and resize events; its callback is the only rendering path. Screen pixels
are never used to reconstruct a draft, and input() never owns this cursor.
"""

import codecs
from collections import deque
from contextlib import contextmanager
import os
import re
import sys
import threading


def _complete(text, before_cursor):
    from .prompt import complete_token
    return complete_token(text, before_cursor)


class EditBuffer:
    """Small, testable editor. Cursor indices refer to Python code points."""

    def __init__(self, text="", history=(), complete=None):
        self.text = str(text)
        self.cursor = len(self.text)
        self.history = [str(line) for line in history if isinstance(line, str)]
        self.complete = complete if complete is not None else _complete
        self._history_index = None
        self._draft = (self.text, self.cursor)
        self._completion = None
        self._search = None

    def _replace(self, start, end, text):
        self.text = self.text[:start] + text + self.text[end:]
        self.cursor = start + len(text)

    def _browse(self, direction):
        if not self.history:
            return
        if self._history_index is None:
            if direction > 0:
                return
            self._draft = (self.text, self.cursor)
            self._history_index = len(self.history)
        self._history_index = max(0, min(len(self.history),
                                        self._history_index + direction))
        if self._history_index == len(self.history):
            self.text, self.cursor = self._draft
            self._history_index = None
        else:
            self.text = self.history[self._history_index]
            self.cursor = len(self.text)

    def _tab(self):
        if self._completion is not None:
            start, suffix, matches, index = self._completion
            index = (index + 1) % len(matches)
            self.text = self.text[:start] + matches[index] + suffix
            self.cursor = start + len(matches[index])
            self._completion = (start, suffix, matches, index)
            return
        before = self.text[:self.cursor]
        word = re.search(r"\S*$", before).group()
        matches = list(dict.fromkeys(self.complete(word, before) or ()))
        matches = [match for match in matches if isinstance(match, str)]
        if not matches:
            return
        start, suffix = self.cursor - len(word), self.text[self.cursor:]
        common = os.path.commonprefix(matches)
        if len(matches) == 1:
            self._replace(start, self.cursor, matches[0])
        elif len(common) > len(word):
            self._replace(start, self.cursor, common)
            self._completion = (start, suffix, matches, -1)
        else:
            self._replace(start, self.cursor, matches[0])
            self._completion = (start, suffix, matches, 0)

    def _reverse_search(self):
        if self._search is None:
            self._draft = (self.text, self.cursor)
            self._search = (self.text, len(self.history))
        needle, end = self._search
        for index in range(end - 1, -1, -1):
            if needle in self.history[index]:
                self.text = self.history[index]
                self.cursor = len(self.text)
                self._history_index = index
                self._search = (needle, index)
                return

    def feed(self, key, text=""):
        """Apply a normalized key; return whether text or cursor changed."""
        old = (self.text, self.cursor)
        if key != "tab":
            self._completion = None
        if key != "search":
            self._search = None
        if key == "text":
            self._replace(self.cursor, self.cursor, text)
        elif key == "left":
            self.cursor = max(0, self.cursor - 1)
        elif key == "right":
            self.cursor = min(len(self.text), self.cursor + 1)
        elif key == "home":
            self.cursor = 0
        elif key == "end":
            self.cursor = len(self.text)
        elif key == "backspace" and self.cursor:
            self._replace(self.cursor - 1, self.cursor, "")
        elif key == "delete":
            self._replace(self.cursor, self.cursor + 1, "")
        elif key == "kill_left":
            self._replace(0, self.cursor, "")
        elif key == "kill_right":
            self._replace(self.cursor, len(self.text), "")
        elif key == "word_left":
            self.cursor = len(self.text[:self.cursor].rstrip())
            while self.cursor and not self.text[self.cursor - 1].isspace():
                self.cursor -= 1
        elif key == "word_right":
            while self.cursor < len(self.text) and not self.text[self.cursor].isspace():
                self.cursor += 1
            while self.cursor < len(self.text) and self.text[self.cursor].isspace():
                self.cursor += 1
        elif key == "erase_word":
            end = self.cursor
            self.feed("word_left")
            self._replace(self.cursor, end, "")
        elif key == "up":
            self._browse(-1)
        elif key == "down":
            self._browse(1)
        elif key == "tab":
            self._tab()
        elif key == "search":
            self._reverse_search()
        return old != (self.text, self.cursor)


_CONTROL = {
    "\r": "enter", "\n": "enter", "\x03": "interrupt",
    "\x04": "eof", "\x1a": "eof", "\x08": "backspace",
    "\x7f": "backspace", "\t": "tab", "\x01": "home",
    "\x05": "end", "\x02": "left", "\x06": "right",
    "\x10": "up", "\x0e": "down", "\x15": "kill_left",
    "\x0b": "kill_right", "\x17": "erase_word", "\x12": "search",
}


class WindowsKeyDecoder:
    """Decode native records, including Alt Unicode key-up-only input.

    Ordinary key releases repeat their character and are ignored. Windows
    Alt Unicode composition instead delivers its character on VK_MENU's
    release. Surrogates can arrive in separate batches; retain their state.
    """

    _KEYS = {0x25: "left", 0x27: "right", 0x24: "home", 0x23: "end",
             0x08: "backspace", 0x2e: "delete", 0x26: "up", 0x28: "down",
             0x0d: "enter", 0x09: "tab", 0x21: "scroll_page_up",
             0x22: "scroll_page_down"}

    def __init__(self):
        self._high_surrogate = None

    def feed(self, key_down, repeat, virtual_key, char, control_state=0):
        char = chr(char) if isinstance(char, int) else (char or "\0")
        if not key_down and not (virtual_key == 0x12 and char != "\0"):
            return []
        ctrl = bool(control_state & (0x04 | 0x08))
        alt = bool(control_state & (0x01 | 0x02))
        key = self._KEYS.get(virtual_key) if key_down else None
        if key is not None:
            if ctrl and key in ("left", "right"):
                key = "word_" + key
            elif ctrl and key == "backspace":
                key = "erase_word"
            return [(key, "")] * max(1, repeat)
        if char == "\0":
            return []
        if char in _CONTROL:
            return [(_CONTROL[char], "")] * max(1, repeat)
        # AltGr (Ctrl+Alt) produces ordinary Unicode text, not a shortcut.
        if ctrl and not alt and virtual_key in (0x43, 0x44, 0x5a):
            return [("interrupt" if virtual_key == 0x43 else "eof", "")]
        code = ord(char)
        if 0xd800 <= code <= 0xdbff:
            self._high_surrogate = code
            return []
        if 0xdc00 <= code <= 0xdfff:
            if self._high_surrogate is None:
                return []
            char = chr(0x10000 + ((self._high_surrogate - 0xd800) << 10)
                       + code - 0xdc00)
            self._high_surrogate = None
        else:
            self._high_surrogate = None
        if ord(char) < 32:
            return []
        return [("text", char * max(1, repeat))]


class WindowsMouseDecoder:
    """Retain high-resolution vertical wheel deltas until a full notch."""

    def __init__(self):
        self._wheel_delta = 0

    def feed(self, button_state, event_flags):
        if not event_flags & 0x0004 or event_flags & 0x0008:
            return []
        delta = (int(button_state) >> 16) & 0xffff
        if delta >= 0x8000:
            delta -= 0x10000
        self._wheel_delta += delta
        steps = abs(self._wheel_delta) // 120
        if not steps:
            return []
        direction = 1 if self._wheel_delta > 0 else -1
        self._wheel_delta -= direction * steps * 120
        return [("scroll_up" if direction > 0 else "scroll_down", steps)]


class PosixKeyDecoder:
    """Incremental UTF-8 and terminal escape decoder; no display writes."""

    _SEQUENCES = {
        "\x1b[A": "up", "\x1b[B": "down", "\x1b[C": "right",
        "\x1b[D": "left", "\x1b[H": "home", "\x1b[F": "end",
        "\x1bOA": "up", "\x1bOB": "down", "\x1bOC": "right",
        "\x1bOD": "left",
        "\x1bOH": "home", "\x1bOF": "end", "\x1b[1~": "home",
        "\x1b[4~": "end", "\x1b[7~": "home", "\x1b[8~": "end",
        "\x1b[3~": "delete", "\x1b[1;5D": "word_left",
        "\x1b[1;5C": "word_right",
        "\x1b[5~": "scroll_page_up", "\x1b[6~": "scroll_page_down",
    }

    def __init__(self):
        self._utf8 = codecs.getincrementaldecoder("utf-8")("replace")
        self._escape = ""
        self._paste = False
        self._paste_pending = ""
        self._paste_cr = False
        self._legacy_mouse = None

    @staticmethod
    def _mouse_action(button, x, y, release=False):
        if release or x <= 0 or y <= 0 or x > 1000000 or y > 1000000:
            return []
        # The high wheel bit plus button 0/1 means vertical up/down.
        # Ignore modifier bits, horizontal wheels, releases and motion.
        if button & 64 and not button & 32 and (button & 3) in (0, 1):
            return [("scroll_up" if (button & 3) == 0 else "scroll_down", 1)]
        return []

    def feed(self, data):
        events = []

        def characters():
            if isinstance(data, bytes):
                for value in data:
                    if self._legacy_mouse is not None:
                        # X10 coordinates are raw bytes, not UTF-8 text.
                        # Decoding them first can merge two coordinates and
                        # steal a following typed character as the third byte.
                        yield chr(value)
                    else:
                        for char in self._utf8.decode(bytes([value])):
                            yield char
            else:
                for char in data:
                    yield char

        def pasted(char):
            if char == "\r":
                events.append(("text", "\n"))
                self._paste_cr = True
            else:
                if not (char == "\n" and self._paste_cr):
                    events.append(("text", char))
                self._paste_cr = False

        for char in characters():
            if self._paste:
                # Only the closing bracketed-paste delimiter has meaning.
                # Other escapes and controls remain part of the logical draft.
                self._paste_pending += char
                while self._paste_pending and not "\x1b[201~".startswith(self._paste_pending):
                    pasted(self._paste_pending[0])
                    self._paste_pending = self._paste_pending[1:]
                if self._paste_pending == "\x1b[201~":
                    self._paste = False
                    self._paste_pending = ""
                    self._paste_cr = False
                continue
            if self._legacy_mouse is not None:
                self._legacy_mouse += char
                if len(self._legacy_mouse) == 3:
                    button, x, y = (ord(value) - 32 for value in self._legacy_mouse)
                    if 0 <= button <= 223 and 0 < x <= 223 and 0 < y <= 223:
                        events.extend(self._mouse_action(button, x, y))
                    self._legacy_mouse = None
                continue
            if self._escape:
                if self._escape == "\x1b" and char not in "[O":
                    # Unsupported Alt shortcuts must not consume later text.
                    self._escape = ""
                else:
                    self._escape += char
                    if self._escape == "\x1b[200~":
                        self._paste, self._escape = True, ""
                    elif self._escape == "\x1b[M":
                        self._legacy_mouse, self._escape = "", ""
                    elif self._escape in self._SEQUENCES:
                        events.append((self._SEQUENCES[self._escape], ""))
                        self._escape = ""
                    elif self._escape.startswith("\x1b[<") and char not in "Mm":
                        if len(self._escape) > 64:
                            self._escape = ""
                    elif len(self._escape) > 2 and "@" <= char <= "~":
                        match = re.fullmatch(r"\x1b\[<(\d+);(\d+);(\d+)([Mm])",
                                             self._escape)
                        if match:
                            button, x, y = (int(value) for value in match.groups()[:3])
                            events.extend(self._mouse_action(button, x, y,
                                                             match.group(4) == "m"))
                        page = re.fullmatch(r"\x1b\[([56])(?:;\d+)?~", self._escape)
                        if page:
                            events.append(("scroll_page_up" if page.group(1) == "5"
                                           else "scroll_page_down", ""))
                        self._escape = ""  # unrelated or invalid report
                    elif len(self._escape) > 64:
                        self._escape = ""
                    continue
            if char == "\x1b":
                self._escape = char
            elif char in _CONTROL:
                events.append((_CONTROL[char], ""))
            elif ord(char) >= 32:
                events.append(("text", char))
        return events

    def flush_escape(self):
        if self._escape == "\x1b":
            self._escape = ""


# Preserve repeated actions decoded from a native record. Read only one
# native record/byte at a time so accepting a line does not consume the next
# line's type-ahead from the terminal (including a command after /exit).
_READ_AHEAD = deque()
# Retain partial UTF-16/UTF-8 state between reads and prompt boundaries.
_WINDOWS_DECODER = WindowsKeyDecoder()
_POSIX_DECODER = PosixKeyDecoder()
_WINDOWS_MOUSE = WindowsMouseDecoder()
_INPUT_LOCK = threading.RLock()
_READ_ACTIVE = False
_SESSION_ACTIVE = False
_SCROLL_ACTIONS = {"scroll_page_up": "page_up", "scroll_page_down": "page_down",
                   "scroll_up": "up", "scroll_down": "down", "scroll_live": "live"}


def _drive(editor, on_change, events, on_scroll=None):
    on_change(editor.text, editor.cursor)
    for key, text in events:
        if key in _SCROLL_ACTIONS:
            if on_scroll is not None:
                on_scroll(_SCROLL_ACTIONS[key], max(1, int(text or 1)))
            continue
        if key == "enter":
            return editor.text
        if key == "interrupt":
            raise KeyboardInterrupt
        if key == "eof":
            if not editor.text:
                raise EOFError
            key = "delete"
        if key == "resize" or editor.feed(key, text):
            on_change(editor.text, editor.cursor)
    raise EOFError


def _windows_console_mode():
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.GetStdHandle.argtypes = [wintypes.DWORD]
    k32.GetStdHandle.restype = wintypes.HANDLE
    k32.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    k32.GetConsoleMode.restype = wintypes.BOOL
    k32.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k32.SetConsoleMode.restype = wintypes.BOOL
    handle = k32.GetStdHandle(wintypes.DWORD(-10).value)
    original = wintypes.DWORD()
    if not k32.GetConsoleMode(handle, ctypes.byref(original)):
        raise OSError(ctypes.get_last_error(), "Cannot read console input mode")
    return k32, handle, original.value


@contextmanager
def session_input_mode():
    """Keep native echo off while the footer owns the terminal.

    Preserve processed Ctrl-C/ISIG between input calls so reply cancellation
    keeps its existing signal behavior. read_line temporarily enters raw mode
    and restores this non-echoing baseline. Restore the user's full mode when
    the footer session ends, including failures and cancellation.
    """
    global _SESSION_ACTIVE
    with _INPUT_LOCK:
        was_active = _SESSION_ACTIVE
    if os.name == "nt":
        import ctypes
        k32, handle, original = _windows_console_mode()
        quiet = (original | 0x0008 | 0x0010 | 0x0080) & ~(0x0004 | 0x0040 | 0x0200)
        if not k32.SetConsoleMode(handle, quiet):
            raise OSError(ctypes.get_last_error(), "Cannot disable console input echo")
        try:
            with _INPUT_LOCK:
                _SESSION_ACTIVE = True
            yield
        finally:
            with _INPUT_LOCK:
                _SESSION_ACTIVE = was_active
            k32.SetConsoleMode(handle, original)
    else:
        import termios
        fd = sys.stdin.fileno()
        original = termios.tcgetattr(fd)
        quiet = list(original)
        quiet[3] &= ~(termios.ECHO | getattr(termios, "ECHONL", 0))
        termios.tcsetattr(fd, termios.TCSANOW, quiet)
        try:
            with _INPUT_LOCK:
                _SESSION_ACTIVE = True
            yield
        finally:
            with _INPUT_LOCK:
                _SESSION_ACTIVE = was_active
            termios.tcsetattr(fd, termios.TCSANOW, original)


def _windows_record_api():
    import ctypes
    from ctypes import wintypes

    class KEY(ctypes.Structure):
        _fields_ = [("down", wintypes.BOOL), ("repeat", wintypes.WORD),
                    ("key", wintypes.WORD), ("scan", wintypes.WORD),
                    ("char", ctypes.c_ushort), ("control", wintypes.DWORD)]

    class COORD(ctypes.Structure):
        _fields_ = [("x", ctypes.c_short), ("y", ctypes.c_short)]

    class MOUSE(ctypes.Structure):
        _fields_ = [("position", COORD), ("buttons", wintypes.DWORD),
                    ("control", wintypes.DWORD), ("flags", wintypes.DWORD)]

    class EVENT(ctypes.Union):
        _fields_ = [("key", KEY), ("mouse", MOUSE), ("padding", ctypes.c_byte * 16)]

    class RECORD(ctypes.Structure):
        _fields_ = [("kind", wintypes.WORD), ("event", EVENT)]

    k32, handle, original = _windows_console_mode()
    k32.ReadConsoleInputW.argtypes = [wintypes.HANDLE, ctypes.POINTER(RECORD),
                                     wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    k32.ReadConsoleInputW.restype = wintypes.BOOL
    k32.PeekConsoleInputW.argtypes = [wintypes.HANDLE, ctypes.POINTER(RECORD),
                                     wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    k32.PeekConsoleInputW.restype = wintypes.BOOL
    k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    k32.WaitForSingleObject.restype = wintypes.DWORD
    return k32, handle, original, RECORD


def _decode_windows_record(record):
    if record.kind == 0x0004:
        return [("resize", "")]
    if record.kind == 0x0001:
        key = record.event.key
        return _WINDOWS_DECODER.feed(bool(key.down), key.repeat, key.key,
                                     key.char, key.control)
    if record.kind == 0x0002:
        mouse = record.event.mouse
        return _WINDOWS_MOUSE.feed(mouse.buttons, mouse.flags)
    return []


def _poll_eligible(record):
    if record.kind in (0x0002, 0x0004, 0x0010):  # mouse, resize, focus
        return True
    if record.kind != 0x0001:
        return False
    key = record.event.key
    if not key.down:
        # The editor ignores ordinary releases, including Enter's trailing
        # carriage return. Alt Unicode input is delivered on VK_MENU's
        # release and must stay queued for the next reader.
        return key.key != 0x12 or not key.char
    return key.key in (0x21, 0x22) and not key.char


def poll_scroll_events():
    """Poll leading Win32 scroll records while no editor is reading.

    Consume ordinary key releases that the editor ignores, while retaining
    Alt Unicode releases and all ordinary text/control key presses. Typed
    input at the head of the queue therefore blocks subsequent scrolling
    until the next prompt. POSIX bytes remain untouched between prompts.
    """
    if os.name != "nt" or not _INPUT_LOCK.acquire(blocking=False):
        return []
    try:
        if _READ_ACTIVE or not _SESSION_ACTIVE:
            return []
        import ctypes
        from ctypes import wintypes
        k32, handle, _original, record_type = _windows_record_api()
        records, count = (record_type * 1)(), wintypes.DWORD()
        actions = []
        for _ in range(64):
            if not k32.PeekConsoleInputW(handle, records, 1, ctypes.byref(count)):
                raise OSError(ctypes.get_last_error(), "Cannot inspect console input")
            if not count.value or not _poll_eligible(records[0]):
                break
            if not k32.ReadConsoleInputW(handle, records, 1, ctypes.byref(count)):
                raise OSError(ctypes.get_last_error(), "Cannot read console scroll input")
            for key, amount in _decode_windows_record(records[0]):
                if key in _SCROLL_ACTIONS:
                    actions.append((_SCROLL_ACTIONS[key], max(1, int(amount or 1))))
        return actions
    finally:
        _INPUT_LOCK.release()


def _windows_events():
    import ctypes
    from ctypes import wintypes
    k32, handle, original, RECORD = _windows_record_api()
    # ReadConsoleInput owns editing; cooked echo, Quick Edit, and VT input
    # cannot share it. Restore processed Ctrl-C for the streaming phase.
    mode = (original | 0x0008 | 0x0010 | 0x0080) & ~(
        0x0001 | 0x0002 | 0x0004 | 0x0040 | 0x0200)
    if not k32.SetConsoleMode(handle, mode):
        raise OSError(ctypes.get_last_error(), "Cannot set console input mode")
    records, count = (RECORD * 1)(), wintypes.DWORD()

    def size():
        try:
            return os.get_terminal_size(sys.__stdout__.fileno())
        except (OSError, AttributeError):
            return None

    previous_size = size()
    try:
        while True:
            while _READ_AHEAD:
                yield _READ_AHEAD.popleft()
            ready = k32.WaitForSingleObject(handle, 50)
            current_size = size()
            if current_size != previous_size:
                previous_size = current_size
                yield "resize", ""
            if ready == 258:  # WAIT_TIMEOUT: viewport-only resizes still redraw
                continue
            if ready != 0:
                raise OSError(ctypes.get_last_error(), "Cannot wait for console input")
            if not k32.ReadConsoleInputW(handle, records, len(records), ctypes.byref(count)):
                raise OSError(ctypes.get_last_error(), "Cannot read console input")
            for record in records[:count.value]:
                _READ_AHEAD.extend(_decode_windows_record(record))
    finally:
        k32.SetConsoleMode(handle, original)


def _posix_events():
    import select
    import termios
    import tty
    fd = sys.stdin.fileno()
    original = termios.tcgetattr(fd)
    decoder = _POSIX_DECODER

    def size():
        try:
            return os.get_terminal_size(fd)
        except OSError:
            return None

    previous_size = size()
    try:
        tty.setraw(fd, termios.TCSANOW)
        while True:
            while _READ_AHEAD:
                yield _READ_AHEAD.popleft()
            readable, _, _ = select.select([fd], [], [], 0.05)
            current_size = size()
            if current_size != previous_size:
                previous_size = current_size
                yield "resize", ""
            if not readable:
                decoder.flush_escape()
                continue
            data = os.read(fd, 1)
            if not data:
                raise EOFError
            _READ_AHEAD.extend(decoder.feed(data))
    finally:
        termios.tcsetattr(fd, termios.TCSANOW, original)


def read_line(on_change, history=(), initial="", on_scroll=None):
    """Read a footer line; redraw through callback(text, cursor_index).

    Raises KeyboardInterrupt for Ctrl-C and EOFError for Ctrl-D/Ctrl-Z on an
    empty draft. Console modes are restored on accept, interruption, errors,
    and callback failures. No native output is produced by this module.
    """
    global _READ_ACTIVE
    with _INPUT_LOCK:
        if _READ_ACTIVE:
            raise RuntimeError("A footer input reader is already active")
        _READ_ACTIVE = True
    events = None
    try:
        editor = EditBuffer(initial, history)
        events = _windows_events() if os.name == "nt" else _posix_events()
        return _drive(editor, on_change, events, on_scroll)
    finally:
        try:
            if events is not None:
                events.close()
        finally:
            with _INPUT_LOCK:
                _READ_ACTIVE = False
