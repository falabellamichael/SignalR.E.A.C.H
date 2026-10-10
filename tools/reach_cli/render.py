"""Streaming markdown renderer for replies under the '│' gutter.

Standard library only. Text arrives in arbitrary deltas; complete lines are
rendered as soon as their newline arrives, the rest on ``flush()``. Covers
headings, **bold**, `inline code`, bullets, numbered lists, quotes, rules
and fenced code blocks (a dim box with a language label), and wraps prose to
a width. With rendering disabled (NO_COLOR / non-TTY) callers print the raw
text instead, so piped output stays exactly what the model sent.
"""

import re
import shutil

from . import terminal
from .splash import char_width, display_width, truncate_display
from .terminal import c_bold, c_cyan, c_dim

_FENCE = re.compile(r"^\s*(```|~~~)\s*([\w+#.-]*)\s*$")
_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_BULLET = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^(\s*)(\d+[.)])\s+(.*)$")
_QUOTE = re.compile(r"^\s*>\s?(.*)$")
_RULE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_INLINE = re.compile(r"(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)")

# Columns used left of the text: "  │ " gutter plus the 'ai ▸ ' label.
GUTTER_COLUMNS = 10


def enabled():
    """Render markdown only when colour is on (TTY and not NO_COLOR)."""
    # read terminal.PAINT at call time: __main__ replaces the object at startup
    return bool(getattr(terminal.PAINT, "on", False))


def text_width(columns=None):
    if columns is None:
        try:
            from .splash import content_width
            columns = content_width() + 1
        except Exception:
            columns = shutil.get_terminal_size((100, 24)).columns
    return max(1, int(columns) - GUTTER_COLUMNS)


def _segments(text):
    """Split inline markdown into [(style, text)], style in plain/bold/code."""
    out = []
    pos = 0
    for match in _INLINE.finditer(text):
        if match.start() > pos:
            out.append(("plain", text[pos:match.start()]))
        token = match.group(0)
        if token.startswith("`"):
            out.append(("code", token[1:-1]))
        else:
            out.append(("bold", token[2:-2]))
        pos = match.end()
    if pos < len(text):
        out.append(("plain", text[pos:]))
    return out


def _paint(style, text):
    if style == "bold":
        return c_bold(text)
    if style == "code":
        return c_cyan(text)
    return text


def _fit_prefix(prefix, width):
    """Keep a column for text even when the hanging indent is too wide."""
    room = max(0, width - 1)
    used = 0
    for index, ch in enumerate(prefix):
        used += char_width(ch)
        if used > room:
            return prefix[:index]
    return prefix


def _take_fragment(text, room):
    """Take at most ``room`` display columns from a long word or code line."""
    used = 0
    for index, ch in enumerate(text):
        size = char_width(ch)
        if used + size > room:
            if index == 0:  # a wide glyph cannot fit a one-column line
                return "?", text[1:]
            return text[:index], text[index:]
        used += size
    return text, ""


def wrap_inline(text, width, first_prefix="", next_prefix=""):
    """Wrap inline-styled text to ``width`` visible columns; returns lines."""
    width = max(1, int(width))
    first_prefix = _fit_prefix(first_prefix, width)
    next_prefix = _fit_prefix(next_prefix, width)
    words = []  # (style, word, glue_before)
    for style, chunk in _segments(text):
        if style == "code":
            words.append((style, chunk, False))
            continue
        for piece in re.split(r"(\s+)", chunk):
            if piece == "":
                continue
            if piece.isspace():
                words.append(("space", " ", False))
            else:
                words.append((style, piece, False))
    lines = []
    cur, cur_len = [], 0
    prefix = first_prefix
    limit = width - display_width(prefix)
    pending_space = False
    for style, word, _ in words:
        if style == "space":
            pending_space = bool(cur)
            continue
        need = display_width(word) + (1 if pending_space else 0)
        if cur and cur_len + need > limit:
            lines.append(prefix + "".join(cur))
            prefix = next_prefix
            limit = width - display_width(prefix)
            cur, cur_len, pending_space = [], 0, False
        if pending_space:
            cur.append(" ")
            cur_len += 1
        while word:
            fragment, word = _take_fragment(word, limit - cur_len)
            cur.append(_paint(style, fragment))
            cur_len += display_width(fragment)
            if word:
                lines.append(prefix + "".join(cur))
                prefix = next_prefix
                limit = width - display_width(prefix)
                cur, cur_len = [], 0
        pending_space = False
    if cur or not lines:
        lines.append(prefix + "".join(cur))
    return lines


def _wrap_verbatim(text, width):
    """Wrap code without collapsing its spaces or applying prose styling."""
    prefix = _fit_prefix("│ ", width)
    room = width - display_width(prefix)
    remaining = text.expandtabs(4)
    if not remaining:
        return [c_dim(prefix)]
    lines = []
    while remaining:
        part, remaining = _take_fragment(remaining, room)
        lines.append(c_dim(prefix) + part)
    return lines


class MarkdownStream:
    """Feed deltas, get rendered lines back (without trailing newlines)."""

    def __init__(self, width=None):
        # None follows the current terminal for each complete source line.
        self.width = width
        self.buf = ""
        self.in_code = False
        self.fence = "```"

    def feed(self, delta):
        self.buf += delta or ""
        out = []
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            out.extend(self.render_line(line))
        return out

    def flush(self):
        out = []
        if self.buf:
            out.extend(self.render_line(self.buf))
            self.buf = ""
        if self.in_code:  # an unterminated fence still gets its box closed
            out.append(self._box_bottom())
            self.in_code = False
        return out

    def _line_width(self):
        return max(1, int(text_width() if self.width is None else self.width))

    def _box_bottom(self):
        return c_dim("└" + "─" * min(40, self._line_width() - 1))

    def render_line(self, line):
        width = self._line_width()
        fence = _FENCE.match(line)
        if self.in_code:
            if fence and fence.group(1) == self.fence and not fence.group(2):
                self.in_code = False
                return [self._box_bottom()]
            return _wrap_verbatim(line, width)
        if fence:
            self.in_code = True
            self.fence = fence.group(1)
            label = fence.group(2) or "code"
            top = truncate_display("┌─ " + label + " ", min(40, width))
            return [c_dim(top + "─" * max(0, min(40, width) - display_width(top)))]
        if not line.strip():
            return [""]
        if _RULE.match(line):
            return [c_dim("─" * min(40, width))]
        heading = _HEADING.match(line)
        if heading:
            text = re.sub(r"(\*\*|__|`)", "", heading.group(2))
            return [c_bold(c_cyan(part)) for part in wrap_inline(text, width)]
        bullet = _BULLET.match(line)
        if bullet:
            pad = " " * len(bullet.group(1).replace("\t", "  "))
            return wrap_inline(bullet.group(2), width,
                               pad + "• ", pad + "  ")
        numbered = _NUMBERED.match(line)
        if numbered:
            pad = " " * len(numbered.group(1))
            mark = numbered.group(2) + " "
            return wrap_inline(numbered.group(3), width,
                               pad + mark, pad + " " * len(mark))
        quote = _QUOTE.match(line)
        if quote:
            return [c_dim(part) for part in wrap_inline(
                quote.group(1), width, "▎ ", "▎ ")]
        return wrap_inline(line, width)
