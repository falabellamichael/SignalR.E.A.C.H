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

from .terminal import PAINT, c_bold, c_cyan, c_dim

_FENCE = re.compile(r"^\s*(```|~~~)\s*([\w+#.-]*)\s*$")
_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_BULLET = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^(\s*)(\d+[.)])\s+(.*)$")
_QUOTE = re.compile(r"^\s*>\s?(.*)$")
_RULE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_INLINE = re.compile(r"(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)")

# Columns used left of the text: "  │ " gutter plus the 'ai ▸ ' label.
GUTTER_COLUMNS = 10
MIN_WIDTH = 20


def enabled():
    """Render markdown only when colour is on (TTY and not NO_COLOR)."""
    return bool(PAINT.on)


def text_width(columns=None):
    if columns is None:
        columns = shutil.get_terminal_size((100, 24)).columns
    return max(MIN_WIDTH, int(columns) - GUTTER_COLUMNS)


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


def wrap_inline(text, width, first_prefix="", next_prefix=""):
    """Wrap inline-styled text to ``width`` visible columns; returns lines."""
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
    prefix, prefix_len = first_prefix, len(first_prefix)
    limit = max(1, width - prefix_len)
    pending_space = False
    for style, word, _ in words:
        if style == "space":
            pending_space = bool(cur)
            continue
        need = len(word) + (1 if pending_space else 0)
        if cur and cur_len + need > limit:
            lines.append(prefix + "".join(cur))
            prefix, prefix_len = next_prefix, len(next_prefix)
            limit = max(1, width - prefix_len)
            cur, cur_len, pending_space = [], 0, False
            need = len(word)
        if pending_space:
            cur.append(" ")
            cur_len += 1
        cur.append(_paint(style, word))
        cur_len += len(word)
        pending_space = False
    if cur or not lines:
        lines.append(prefix + "".join(cur))
    return lines


class MarkdownStream:
    """Feed deltas, get rendered lines back (without trailing newlines)."""

    def __init__(self, width=None):
        self.width = width or text_width()
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

    def _box_bottom(self):
        return c_dim("└" + "─" * min(40, self.width - 1))

    def render_line(self, line):
        fence = _FENCE.match(line)
        if self.in_code:
            if fence and fence.group(1) == self.fence and not fence.group(2):
                self.in_code = False
                return [self._box_bottom()]
            return [c_dim("│ ") + line]
        if fence:
            self.in_code = True
            self.fence = fence.group(1)
            label = fence.group(2) or "code"
            top = "┌─ " + label + " "
            return [c_dim(top + "─" * max(2, min(40, self.width - 1) - len(top)))]
        if not line.strip():
            return [""]
        if _RULE.match(line):
            return [c_dim("─" * min(40, self.width))]
        heading = _HEADING.match(line)
        if heading:
            text = re.sub(r"(\*\*|__|`)", "", heading.group(2))
            return [c_bold(c_cyan(text))]
        bullet = _BULLET.match(line)
        if bullet:
            pad = " " * len(bullet.group(1).replace("\t", "  "))
            return wrap_inline(bullet.group(2), self.width,
                               pad + "• ", pad + "  ")
        numbered = _NUMBERED.match(line)
        if numbered:
            pad = " " * len(numbered.group(1))
            mark = numbered.group(2) + " "
            return wrap_inline(numbered.group(3), self.width,
                               pad + mark, pad + " " * len(mark))
        quote = _QUOTE.match(line)
        if quote:
            return [c_dim("▎ " + l) for l in wrap_inline(quote.group(1), self.width - 2)]
        return wrap_inline(line, self.width)
