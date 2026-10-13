"""App-local terminal palettes and contrast-aware ANSI rendering.

Palette data follows Ethan Schoonover's Solarized repository, Son A. Pham's
One Half palette, and Microsoft's Campbell sample. Solarized Light uses its
base01 ink (#586E75) for body text instead of canonical base00 (#657B83) so
ordinary text reaches 4.99:1 contrast against base3. Semantic text accents are
also darkened/lightened only as much as needed for 4.5:1 contrast; decorative
palette swatches and backgrounds retain their source colors.
"""

import os
import re


def _rgb(value):
    value = str(value).lstrip("#")
    return tuple(int(value[index:index + 2], 16) for index in (0, 2, 4))


def _hex(rgb):
    return "#%02X%02X%02X" % tuple(max(0, min(255, int(part))) for part in rgb)


def _luminance(value):
    channels = _rgb(value)
    linear = []
    for channel in channels:
        sample = channel / 255.0
        linear.append(sample / 12.92 if sample <= 0.04045
                      else ((sample + 0.055) / 1.055) ** 2.4)
    return sum(weight * sample for weight, sample in
               zip((0.2126, 0.7152, 0.0722), linear))


def contrast_ratio(foreground, background):
    """Return the WCAG sRGB contrast ratio for two #RRGGBB values."""
    high, low = sorted((_luminance(foreground), _luminance(background)),
                       reverse=True)
    return (high + 0.05) / (low + 0.05)


def _contrast_safe(color, background, minimum=4.5):
    """Move a palette ink toward black or white until it meets contrast."""
    if contrast_ratio(color, background) >= minimum:
        return color.upper()
    target = (255, 255, 255) if _luminance(background) < 0.5 else (0, 0, 0)
    source = _rgb(color)
    for step in range(1, 257):
        amount = step / 256.0
        candidate = _hex(tuple(round(start + (end - start) * amount)
                               for start, end in zip(source, target)))
        if contrast_ratio(candidate, background) >= minimum:
            return candidate
    return _hex(target)


class Theme:
    """Immutable-by-convention, local rendering palette."""

    def __init__(self, key, name, background=None, foreground=None, panel=None,
                 muted=None, palette=None, note=""):
        self.key = key
        self.name = name
        self.background = background.upper() if background else None
        self.foreground = foreground.upper() if foreground else None
        self.panel = (panel or background or "").upper() or None
        self.palette = dict((name, value.upper())
                            for name, value in (palette or {}).items())
        self.note = note
        self.roles = {}
        if self.background:
            # Keep all small semantic labels readable over the actual full
            # screen color. This applies to command labels, status, and code.
            source = {
                "border": self.palette.get("cyan", foreground),
                "accent": self.palette.get("blue", foreground),
                "secondary": self.palette.get("magenta", foreground),
                "success": self.palette.get("green", foreground),
                "warning": self.palette.get("yellow", foreground),
                "error": self.palette.get("red", foreground),
                "muted": muted or foreground,
                "diff_sign": self.background,
            }
            self.roles = {role: _contrast_safe(color, self.background)
                          for role, color in source.items() if color}


_SOLARIZED = {
    "base03": "#002B36", "base02": "#073642", "base01": "#586E75",
    "base00": "#657B83", "base0": "#839496", "base1": "#93A1A1",
    "base2": "#EEE8D5", "base3": "#FDF6E3", "yellow": "#B58900",
    "orange": "#CB4B16", "red": "#DC322F", "magenta": "#D33682",
    "violet": "#6C71C4", "blue": "#268BD2", "cyan": "#2AA198",
    "green": "#859900",
}

_ONE_HALF_LIGHT = {
    "black": "#383A42", "red": "#E45649", "green": "#50A14F",
    "yellow": "#C18401", "blue": "#0184BC", "magenta": "#A626A4",
    "cyan": "#0997B3", "white": "#FAFAFA",
}
_ONE_HALF_DARK = {
    "black": "#282C34", "red": "#E06C75", "green": "#98C379",
    "yellow": "#E5C07B", "blue": "#61AFEF", "magenta": "#C678DD",
    "cyan": "#56B6C2", "white": "#DCDFE4",
}

_CAMPBELL = {
    "black": "#0C0C0C", "red": "#C50F1F", "green": "#13A10E",
    "yellow": "#C19C00", "blue": "#0037DA", "magenta": "#881798",
    "cyan": "#3A96DD", "white": "#CCCCCC", "bright_black": "#767676",
    "bright_red": "#E74856", "bright_green": "#16C60C",
    "bright_yellow": "#F9F1A5", "bright_blue": "#3B78FF",
    "bright_magenta": "#B4009E", "bright_cyan": "#61D6D6",
    "bright_white": "#F2F2F2",
}


# Tokyo Night's Kitty terminal exports (night and day variants):
# https://github.com/folke/tokyonight.nvim/tree/main/extras/kitty
_TOKYO_DARK = {
    "black": "#15161E", "red": "#F7768E", "green": "#9ECE6A",
    "yellow": "#E0AF68", "blue": "#7AA2F7", "magenta": "#BB9AF7",
    "cyan": "#7DCFFF", "white": "#A9B1D6",
}
_TOKYO_LIGHT = {
    "black": "#B4B5B9", "red": "#F52A65", "green": "#587539",
    "yellow": "#8C6C3E", "blue": "#2E7DE9", "magenta": "#9854F1",
    "cyan": "#007197", "white": "#6172B0",
}


# SimpleSignal Theme Studio src/presets.ts: Lemonade Dark and Light.
# Slots follow CLI roles: blue is the citrus accent, magenta the numeric/
# keyword secondary, yellow the keyword/numeric warning, red the debug red.
_LEMONADE_DARK = {
    "black": "#0C0F0A", "red": "#E11D48", "green": "#A3E635",
    "yellow": "#FACC15", "blue": "#FFF017", "magenta": "#FB923C",
    "cyan": "#67E8F9", "white": "#FFFFFF",
}
_LEMONADE_LIGHT = {
    "black": "#000000", "red": "#E11D48", "green": "#15803D",
    "yellow": "#B45309", "blue": "#CA8A04", "magenta": "#C2410C",
    "cyan": "#1D4ED8", "white": "#FEFCE8",
}


# SimpleTheme src/presets.ts terminal surfaces and semantic inks.
# Blue uses accentColor; magenta uses the keyword token; red uses debug status.
_SIMPLETHEME_PRESETS = (
    ("vintage-grandmaster-chessboard", "Vintage Grandmaster Chessboard",
     "#181614", "#FFFFFF", "#A39889",
     ("#EBE1CE", "#E8DEC8", "#CBB898", "#D8CCB8", "#F5EEDC")),
    ("warm-latte-paper", "Warm Latte & Paper",
     "#FAF4ED", "#000000", "#6E6884",
     ("#D7827E", "#1D4ED8", "#047857", "#B45309", "#B91C1C")),
    ("matcha-latte-cream", "Matcha Latte Cream",
     "#F7FEE7", "#000000", "#3F6212",
     ("#4D7C0F", "#15803D", "#047857", "#B45309", "#3F6212")),
    ("cyberpunk-neon", "Cyberpunk Neon",
     "#08080C", "#FFFFFF", "#707090",
     ("#FFE600", "#00F0FF", "#B829FF", "#FFE600", "#FF007F")),
    ("nord-frost", "Nord Frost",
     "#2E3440", "#FFFFFF", "#4C566A",
     ("#88C0D0", "#88C0D0", "#8FBCBB", "#A3BE8C", "#81A1C1")),
    ("nord-snow-light", "Nord Snow Light",
     "#ECEFF4", "#000000", "#4C566A",
     ("#5E81AC", "#81A1C1", "#88C0D0", "#8FBCBB", "#5E81AC")),
)


def _simpletheme_presets():
    for key, name, background, foreground, muted, inks in _SIMPLETHEME_PRESETS:
        palette = dict(zip(("blue", "green", "cyan", "yellow", "magenta"), inks))
        palette.update(black="#000000", white="#FFFFFF", red="#E11D48")
        yield Theme(key, name, background, foreground, muted=muted,
                    palette=palette,
                    note="Based on SimpleTheme's %s; contrast-tuned indicators." % name)


DEFAULT_THEME = Theme("default", "Default")
_THEMES = (
    DEFAULT_THEME,
    Theme("solarized-dark", "Solarized Dark", _SOLARIZED["base03"],
          _SOLARIZED["base0"], panel=_SOLARIZED["base03"],
          muted=_SOLARIZED["base1"], palette=_SOLARIZED,
          note="Canonical Solarized Dark body pairing: base03 with base0."),
    Theme("solarized-light", "Solarized Light (contrast tuned)",
          _SOLARIZED["base3"], _SOLARIZED["base01"],
          panel=_SOLARIZED["base3"], muted=_SOLARIZED["base01"],
          palette=_SOLARIZED,
          note="Uses base01 #586E75 body ink (4.99:1) instead of base00 #657B83 (4.13:1)."),
    Theme("one-half-dark", "One Half Dark", "#282C34", "#DCDFE4",
          panel="#282C34", muted="#DCDFE4", palette=_ONE_HALF_DARK,
          note="One Half palette, included with Windows Terminal."),
    Theme("one-half-light", "One Half Light", "#FAFAFA", "#383A42",
          panel="#FAFAFA", muted="#383A42", palette=_ONE_HALF_LIGHT,
          note="One Half palette, included with Windows Terminal."),
    Theme("tokyo-dark", "Tokyo Dark", "#1A1B26", "#C0CAF5",
          muted="#A9B1D6", palette=_TOKYO_DARK,
          note="Based on Tokyo Night's Kitty night palette; contrast-tuned indicators."),
    Theme("tokyo-light", "Tokyo Light", "#E1E2E7", "#3760BF",
          muted="#6172B0", palette=_TOKYO_LIGHT,
          note="Based on Tokyo Night's Kitty day palette; contrast-tuned indicators."),
    Theme("lemonade-dark", "Lemonade Dark", "#0C0F0A", "#FFFFFF",
          muted="#8D9C79", palette=_LEMONADE_DARK,
          note="Based on SimpleTheme's Lemonade Dark; contrast-tuned citrus indicators."),
    Theme("lemonade-light", "Lemonade Light", "#FEFCE8", "#000000",
          muted="#713F12", palette=_LEMONADE_LIGHT,
          note="Based on SimpleTheme's Lemonade Light; contrast-tuned citrus indicators."),
    *_simpletheme_presets(),
    Theme("campbell", "Campbell (Windows Terminal)", "#0C0C0C", "#CCCCCC",
          panel="#0C0C0C", muted="#CCCCCC", palette=_CAMPBELL,
          note="Microsoft's documented Campbell scheme."),
)

_THEME_BY_KEY = {theme.key: theme for theme in _THEMES}
_ALIASES = {
    "vintage": "vintage-grandmaster-chessboard",
    "vintage-grandmaster": "vintage-grandmaster-chessboard",
    "grandmaster": "vintage-grandmaster-chessboard",
    "vintage-chessboard": "vintage-grandmaster-chessboard",
    "chessboard": "vintage-grandmaster-chessboard",
    "warm-latte": "warm-latte-paper",
    "matcha": "matcha-latte-cream",
    "cyberpunk": "cyberpunk-neon",
    "nord-dark": "nord-frost",
    "nord-light": "nord-snow-light",
    "lemonade": "lemonade-dark",
    "toyko-dark": "tokyo-dark",
    "toyko-light": "tokyo-light",
    "tokyo-night": "tokyo-dark",
    "tokyo-day": "tokyo-light",
    "solarized": "solarized-dark",
    "solarized-dark": "solarized-dark",
    "solarized-light": "solarized-light",
    "onehalf-dark": "one-half-dark",
    "one-half": "one-half-dark",
    "onehalf-light": "one-half-light",
    "campbell-powershell": "campbell",
    "windows-terminal-campbell": "campbell",
}
_CURRENT_KEY = "default"

_ROLE_NAMES = ("border", "accent", "secondary", "success", "warning",
               "error", "muted", "diff_sign")
_ROLE_MARKERS = {role: "\x1b[38;5;%dm" % (240 + index)
                 for index, role in enumerate(_ROLE_NAMES)}
_MARKER_TO_ROLE = {240 + index: role
                   for index, role in enumerate(_ROLE_NAMES)}
_MARKER_RE = re.compile(r"\x1b\[38;5;(24[0-7])m")
_RESET_RE = re.compile(r"\x1b\[0m")
_DEFAULT_CODES = {
    "border": 36, "accent": 34, "secondary": 35, "success": 32,
    "warning": 33, "error": 31, "muted": 90, "diff_sign": 39,
}

_ANSI16 = (
    (0, (0, 0, 0)), (1, (128, 0, 0)), (2, (0, 128, 0)),
    (3, (128, 128, 0)), (4, (0, 0, 128)), (5, (128, 0, 128)),
    (6, (0, 128, 128)), (7, (192, 192, 192)),
    (8, (128, 128, 128)), (9, (255, 0, 0)), (10, (0, 255, 0)),
    (11, (255, 255, 0)), (12, (0, 0, 255)), (13, (255, 0, 255)),
    (14, (0, 255, 255)), (15, (255, 255, 255)),
)


def _slug(value):
    return re.sub(r"[^a-z0-9]+", "-", str(value or "").strip().casefold()).strip("-")


def theme_names():
    return tuple(theme.name for theme in _THEMES)


def all_themes():
    return _THEMES


def get_theme(value=None):
    if value is None:
        return current_theme()
    slug = _slug(value)
    names = {_slug(theme.name): theme.key for theme in _THEMES}
    key = _ALIASES.get(slug, names.get(slug, slug))
    return _THEME_BY_KEY.get(key)


def current_theme():
    return _THEME_BY_KEY.get(_CURRENT_KEY, DEFAULT_THEME)


def current_key():
    return _CURRENT_KEY


def select_theme(value):
    """Set this process's app-local theme; return None for an unknown name."""
    global _CURRENT_KEY
    theme = get_theme(value)
    if theme is None:
        return None
    _CURRENT_KEY = theme.key
    return theme


def color_role(code):
    return {
        "31": "error", "32": "success", "33": "warning",
        "34": "accent", "35": "secondary", "36": "border",
        "90": "muted",
    }.get(str(code))


def role_marker(role):
    return _ROLE_MARKERS.get(role, _ROLE_MARKERS["border"])


def _color_capability():
    term = os.environ.get("TERM", "").casefold()
    color_term = os.environ.get("COLORTERM", "").casefold()
    if color_term in ("truecolor", "24bit") or os.environ.get("WT_SESSION"):
        return "truecolor"
    if "truecolor" in term or "24bit" in term:
        return "truecolor"
    if "256color" in term:
        return "256"
    return "16"


def _nearest_index(color):
    target = _rgb(color)
    palette = list(_ANSI16)
    for r in range(6):
        for g in range(6):
            for b in range(6):
                palette.append((16 + 36 * r + 6 * g + b,
                                tuple(0 if part == 0 else 55 + 40 * part
                                      for part in (r, g, b))))
    palette.extend((232 + index, (8 + index * 10,) * 3) for index in range(24))
    return min(palette, key=lambda pair: sum(
        (left - right) ** 2 for left, right in zip(target, pair[1])))[0]


def _nearest_ansi16(color):
    target = _rgb(color)
    index = min(_ANSI16, key=lambda pair: sum(
        (left - right) ** 2 for left, right in zip(target, pair[1])))[0]
    return ("%d" % (30 + index) if index < 8
            else "%d" % (90 + index - 8))


def _sgr_for_color(color, background=False):
    if not color:
        return ""
    mode = _color_capability()
    offset = 10 if background else 0
    if mode == "truecolor":
        prefix = "48" if background else "38"
        return "\x1b[%s;2;%d;%d;%dm" % (prefix, *_rgb(color))
    if mode == "256":
        prefix = "48" if background else "38"
        return "\x1b[%s;5;%dm" % (prefix, _nearest_index(color))
    code = _nearest_ansi16(color)
    if background:
        number = int(code)
        code = str(number + offset)
    return "\x1b[%sm" % code


def _role_sgr(role, theme=None):
    theme = theme or current_theme()
    if theme.key == "default":
        return "\x1b[%dm" % _DEFAULT_CODES.get(role, 36)
    if _color_capability() == "16" and role in (
            "border", "accent", "secondary", "success", "warning", "error"):
        # Nearest RGB can turn semantic hues into gray or merge status colors.
        # Keep each role's hue and choose its most readable ANSI intensity.
        normal = _DEFAULT_CODES[role] - 30
        background_code = int(_nearest_ansi16(theme.background))
        background_index = (background_code - 30 if background_code < 90
                            else background_code - 90 + 8)
        background = _hex(_ANSI16[background_index][1])
        index = max((normal, normal + 8), key=lambda candidate: contrast_ratio(
            _hex(_ANSI16[candidate][1]), background))
        code = 30 + index if index < 8 else 90 + index - 8
        return "\x1b[%dm" % code
    return _sgr_for_color(theme.roles.get(role, theme.foreground))


def _base_sgr(theme):
    if theme.key == "default":
        return ""
    return (_sgr_for_color(theme.foreground) +
            _sgr_for_color(theme.background, background=True))


def background_sequence(color_enabled=True):
    """Return the app-local erase/background SGR for the active theme."""
    theme = current_theme()
    if not color_enabled or theme.key == "default":
        return ""
    return _sgr_for_color(theme.background, background=True)


def paint_role(role, text, enabled=True, managed_screen=False):
    """Paint a semantic role, using stable markers inside FooterScreen."""
    if not enabled:
        return text
    theme = current_theme()
    if managed_screen:
        return role_marker(role) + str(text) + "\x1b[0m"
    if theme.key == "default":
        return "\x1b[%dm%s\x1b[0m" % (_DEFAULT_CODES.get(role, 36), text)
    return _role_sgr(role, theme) + str(text) + "\x1b[0m"


def render_line(text, color_enabled=True):
    """Resolve stable role markers and establish a full-screen row surface."""
    if not color_enabled:
        return text
    theme = current_theme()

    def resolve(match):
        role = _MARKER_TO_ROLE[int(match.group(1))]
        return _role_sgr(role, theme)

    text = _MARKER_RE.sub(resolve, str(text))
    if theme.key != "default":
        base = _base_sgr(theme)
        text = _RESET_RE.sub("\x1b[0m" + base, text)
        # Keep the theme's background active for the row erase and its text
        # color active at the editor cursor after the physical frame is drawn.
        return base + text + "\x1b[0m" + base
    return text


def preview_lines(value, color_enabled=True):
    """Build a three-line palette preview without changing current selection."""
    theme = get_theme(value)
    if theme is None:
        return []
    label = theme.name
    bg = theme.background or "terminal default"
    fg = theme.foreground or "terminal default"
    if not color_enabled or not theme.background:
        return [
            "  Preview: %s" % label,
            "  background %s · text %s" % (bg, fg),
            "  %s" % (theme.note or "Default terminal colors"),
        ]
    background = _sgr_for_color(theme.background, background=True)
    foreground = _sgr_for_color(theme.foreground)
    swatch = "\x1b[0m%s%s      \x1b[0m" % (foreground, background)
    indicators = "  ".join(
        _role_sgr(role, theme) + label
        for role, label in (("accent", "info"), ("success", "success"),
                            ("warning", "warning"), ("error", "error")))
    sample = "\x1b[0m%s%s SignalREACH · %s \x1b[0m" % (
        background, foreground, indicators)
    return [
        "  Preview: %s" % label,
        "  %s  background %s · text %s" % (swatch, bg, fg),
        "  %s" % sample,
    ]
