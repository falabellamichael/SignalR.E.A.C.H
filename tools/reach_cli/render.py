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
from .terminal import c_bold, c_cyan, c_dim, c_green, c_magenta

_FENCE = re.compile(r"^\s*(```|~~~)\s*([\w+#.-]*)\s*$")
_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$")
_BULLET = re.compile(r"^(\s*)[-*+]\s+(.*)$")
_NUMBERED = re.compile(r"^(\s*)(\d+[.)])\s+(.*)$")
_QUOTE = re.compile(r"^\s*>\s?(.*)$")
_RULE = re.compile(r"^\s*([-*_])(\s*\1){2,}\s*$")
_INLINE = re.compile(r"(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)")
_CODE_PARTS = re.compile(
    r'''("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\s+)''')
_CODE_TOKENS = re.compile(
    r'''("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_]\w*\b)''')
_CODE_LANGUAGES = {
    "py": "python", "python": "python", "js": "javascript",
    "javascript": "javascript", "ts": "javascript", "typescript": "javascript",
    "json": "json", "sh": "shell", "bash": "shell", "shell": "shell",
    "zsh": "shell", "ps1": "shell", "powershell": "shell",
    "sql": "sql", "lua": "lua", "luau": "lua",
}
_CODE_KEYWORDS = set((
    "and as async await begin break case catch class const continue create def "
    "delete do else elseif end except export extends false finally for from "
    "function if import in insert into is let local new nil none not null of "
    "or pass raise return select set then throw true try update var where while "
    "with yield").split())

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
    if style == "keyword":
        return c_cyan(text)
    if style == "string":
        return c_green(text)
    if style == "number":
        return c_magenta(text)
    if style == "diff_sign":
        return terminal.c_diff_sign(text)
    if style == "comment":
        return c_dim(text)
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
    words = []  # adjacent style fragments belong to the same visible word
    current = []
    for style, chunk in _segments(text):
        for piece in re.split(r"(\s+)", chunk):
            if piece == "":
                continue
            if piece.isspace():
                if current:
                    words.append(current)
                    current = []
                if words and words[-1] is not None:
                    words.append(None)
            else:
                current.append((style, piece))
    if current:
        words.append(current)
    lines = []
    cur, cur_len = [], 0
    prefix = first_prefix
    limit = width - display_width(prefix)
    pending_space = False
    for fragments in words:
        if fragments is None:
            pending_space = bool(cur)
            continue
        need = sum(display_width(part) for _, part in fragments) + (1 if pending_space else 0)
        if cur and cur_len + need > limit:
            lines.append(prefix + "".join(cur))
            prefix = next_prefix
            limit = width - display_width(prefix)
            cur, cur_len, pending_space = [], 0, False
        if pending_space:
            cur.append(" ")
            cur_len += 1
        for style, word in fragments:
            while word:
                if cur_len == limit:
                    lines.append(prefix + "".join(cur))
                    prefix = next_prefix
                    limit = width - display_width(prefix)
                    cur, cur_len = [], 0
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


def _diff_sign(text, language):
    if str(language).lower() not in ("diff", "patch"):
        return ""
    if text.startswith(("+++", "---")):
        return ""
    return text[:1] if text[:1] in ("+", "-") else ""


def _code_prefix(prefix, sign):
    if sign and prefix.startswith("│"):
        paint = terminal.c_green if sign == "+" else terminal.c_red
        return paint("│") + c_dim(prefix[1:])
    return c_dim(prefix)


def _code_segments(text, language):
    """Conservative single-line colour hints for common labelled languages."""
    if _diff_sign(text, language):
        return [("diff_sign", text[0]), ("plain", text[1:])]
    language = _CODE_LANGUAGES.get(str(language).lower())
    if not language:
        return [("plain", text)]
    comment = {"python": "#", "shell": "#", "javascript": "//",
               "sql": "--", "lua": "--"}.get(language)
    out = []
    pos = 0
    for match in _CODE_TOKENS.finditer(text):
        gap = text[pos:match.start()]
        if comment and comment in gap:
            index = pos + gap.index(comment)
            out.append(("plain", text[pos:index]))
            out.append(("comment", text[index:]))
            return out
        if gap:
            out.append(("plain", gap))
        token = match.group(0)
        style = ("string" if token[0] in "\"'`" else
                 "number" if token[0].isdigit() else
                 "keyword" if token.lower() in _CODE_KEYWORDS else "plain")
        out.append((style, token))
        pos = match.end()
    tail = text[pos:]
    if comment and comment in tail:
        index = tail.index(comment)
        out.extend((("plain", tail[:index]), ("comment", tail[index:])))
    elif tail:
        out.append(("plain", tail))
    return out


def _code_slice(segments, start, end):
    parts = []
    pos = 0
    for style, chunk in segments:
        stop = pos + len(chunk)
        if stop > start and pos < end:
            parts.append(_paint(style, chunk[max(0, start - pos):end - pos]))
        pos = stop
        if pos >= end:
            break
    return "".join(parts)


def _wrap_verbatim(text, width, language="", with_offsets=False):
    """Keep code whitespace, moving whole tokens to a marked continuation."""
    width = max(1, int(width))
    prefix = _fit_prefix("│ ", width)
    source = text.expandtabs(4)
    if not source:
        row = c_dim(prefix)
        return [(0, row)] if with_offsets else [row]
    sign = _diff_sign(source, language)
    indent_source = source[1:] if sign else source
    indent = indent_source[:len(indent_source) - len(indent_source.lstrip(" "))]
    continuation = _fit_prefix("│ ↳ " + indent, width)
    # Break only at source whitespace outside quoted strings. A token wider
    # than the available row still needs a bounded split on tiny terminals.
    breaks = [match.end() for match in _CODE_PARTS.finditer(source)
              if match.group(0).isspace()]
    segments = _code_segments(source, language)
    lines = []
    start = 0
    while start < len(source):
        room = width - display_width(prefix)
        part, rest = _take_fragment(source[start:], room)
        end = start + len(part)
        if rest:
            choices = [index for index in breaks
                       if start < index <= end and source[start:index].strip()]
            if choices:
                end = choices[-1]
                part = source[start:end]
        # _take_fragment projects an unfit two-cell glyph as '?' on a
        # one-cell terminal; do not restore that glyph through the painter.
        body = (part if part == "?" and source[start:end] != "?"
                else _code_slice(segments, start, end))
        row = _code_prefix(prefix, sign) + body
        lines.append((0 if start == 0 else 2 + start, row)
                     if with_offsets else row)
        start = end
        prefix = continuation
    return lines


def _box_top(language, width):
    top = truncate_display("┌─ " + (language or "code") + " ", width)
    return c_dim(top + "─" * max(0, width - display_width(top)))


class MarkdownSource:
    """One semantic source line, retained for managed-screen resize reflow."""

    __slots__ = ("text", "kind", "language")

    def __init__(self, text, kind="prose", language=""):
        self.text = text
        self.kind = kind
        self.language = language

    def render(self, width):
        """Render afresh at the actual room remaining after reply chrome."""
        width = max(1, int(width))
        if self.kind == "code":
            return _wrap_verbatim(self.text, width, self.language)
        if self.kind == "code_top":
            return [_box_top(self.language, width)]
        if self.kind == "code_bottom":
            return [c_dim("└" + "─" * (width - 1))]
        return MarkdownStream(width).render_line(self.text)

    def plain(self):
        """Unwrapped styled text used for source anchors and plain snapshots."""
        if self.kind == "code":
            source = self.text.expandtabs(4)
            return _code_prefix("│ ", _diff_sign(source, self.language)) + _code_slice(
                _code_segments(source, self.language), 0, len(source))
        if self.kind == "code_top":
            return c_dim("┌─ " + (self.language or "code") + " ")
        if self.kind == "code_bottom":
            return c_dim("└")
        # This is deliberately independent of the current terminal width.
        # Actual wrapped rows always come from render(width).
        return "".join(self.render(max(1, display_width(self.text) + 10)))

    def render_rows(self, width):
        """Fenced rows with character anchors into their semantic plain text.

        Offsets exclude repeated visual gutters, continuation arrows and
        indentation. Prose uses the managed screen's existing cell reflow.
        """
        width = max(1, int(width))
        if self.kind == "code":
            return _wrap_verbatim(self.text, width, self.language, with_offsets=True)
        if self.kind == "prose":
            raise ValueError("prose row anchors come from managed cell reflow")
        return [(0, row) for row in self.render(width)]


class MarkdownStream:
    """Feed deltas, get rendered lines back (without trailing newlines)."""

    def __init__(self, width=None, source_mode=False):
        # None follows the current terminal for each complete source line.
        self.width = width
        self.buf = ""
        self.in_code = False
        self.fence = "```"
        self.language = ""
        self.source_mode = source_mode

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
            out.append(MarkdownSource(self.fence, "code_bottom", self.language)
                       if self.source_mode else self._box_bottom())
            self.in_code = False
        return out

    def _line_width(self):
        return max(1, int(text_width() if self.width is None else self.width))

    def _box_bottom(self):
        return c_dim("└" + "─" * (self._line_width() - 1))

    def render_line(self, line):
        width = None if self.source_mode else self._line_width()
        fence = _FENCE.match(line)
        if self.in_code:
            if fence and fence.group(1) == self.fence and not fence.group(2):
                self.in_code = False
                return ([MarkdownSource(line, "code_bottom", self.language)]
                        if self.source_mode else [self._box_bottom()])
            return ([MarkdownSource(line, "code", self.language)]
                    if self.source_mode else _wrap_verbatim(line, width, self.language))
        if fence:
            self.in_code = True
            self.fence = fence.group(1)
            self.language = fence.group(2)
            return ([MarkdownSource(line, "code_top", self.language)]
                    if self.source_mode else [_box_top(self.language, width)])
        if self.source_mode:
            return [MarkdownSource(line)]
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
