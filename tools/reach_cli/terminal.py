"""Terminal rendering: colours, spinners, and the CLI's public surface.

Slash commands live in ``commands``, the splash and footer in ``splash``,
readline input in ``prompt``, and the saved session in ``session``. The names
below stay importable from this module.
"""

import os
import sys
import threading
import time

VERSION = "1.0.0"




class Paint:
    def __init__(self, enabled):
        self.on = enabled

    def __call__(self, code, text):
        if not self.on:
            return text
        return "\x1b[%sm%s\x1b[0m" % (code, text)


PAINT = Paint(False)
# Set when --color always forces paint, including over NO_COLOR.
COLOR_FORCED = False




def c_red(t):
    return PAINT("31", t)




def c_green(t):
    return PAINT("32", t)




def c_yellow(t):
    return PAINT("33", t)




def c_blue(t):
    return PAINT("34", t)




def c_magenta(t):
    return PAINT("35", t)




def c_cyan(t):
    return PAINT("36", t)




def c_bold(t):
    return PAINT("1", t)




def c_dim(t):
    return PAINT("2", t)




def c_inverse(t):
    return PAINT("7", t)




def spinner_char():
    return "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[int(time.time() * 10) % 10]




def response_label():
    """Inline label for an AI response: left rule + 'ai ▸' (no newline).

    Separated from response_open so the waiting indicator can re-emit the
    label after clearing its animated line.
    """
    return margin_pad() + c_cyan("  │ ") + c_bold(c_magenta("ai ▸") + " ")


def response_open():
    """Opening rule for an AI response: blank line, border, 'ai ▸' label.
    The streamed body continues right after this."""
    sys.stdout.write("\n" + response_label())
    sys.stdout.flush()



def response_indent():
    """Left-rule prefix for continuation lines of a streamed reply."""
    return margin_pad() + c_cyan("  │ ")




def spinner(message):
    sys.stdout.write("\r" + margin_pad() + c_cyan(spinner_char()) + " " + message + "   ")
    sys.stdout.flush()




def spinner_clear():
    sys.stdout.write("\r\x1b[2K")
    sys.stdout.flush()


class WaitIndicator:
    """Animated waiting line while a blocking call is in progress.

    Renders ``prefix + spinner + message + elapsed seconds`` on the current
    line until stop(). The first stop() clears back to ``prefix`` so the
    caller can stream tokens in place. Non-interactive stdout renders
    nothing, keeping piped output clean.
    """

    CR = chr(13)

    def __init__(self, prefix="", message="waiting for the model"):
        self._prefix = prefix
        self._message = message
        self._stop = threading.Event()
        self._started = False
        self._stopped = False
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self):
        started = time.time()
        while not self._stop.is_set():
            self._frame(time.time() - started)
            self._stop.wait(0.1)

    def _frame(self, elapsed):
        glyph = spinner_char() if PAINT.on else "."
        label = "%s… %ds" % (self._message, int(elapsed))
        sys.stdout.write(
            self.CR + (self._prefix or margin_pad())
            + glyph + " " + c_dim(label) + "  "
        )
        sys.stdout.flush()

    def start(self):
        if not sys.stdout.isatty():
            return
        self._started = True
        self._thread.start()

    def _clear(self):
        sys.stdout.write(self.CR + "\x1b[2K" + self._prefix)
        sys.stdout.flush()

    def stop(self):
        if self._stopped:
            return
        self._stopped = True
        self._stop.set()
        if self._started:
            self._thread.join(timeout=1.0)
        if sys.stdout.isatty():
            self._clear()




def spin_while(message, seconds):
    """Animated wait for local work (page fetches are quick)."""
    deadline = time.time() + seconds
    while time.time() < deadline:
        spinner(message)
        time.sleep(0.08)
    spinner_clear()




def status_line(message):
    print(margin_pad() + c_dim("  " + message))


def tprint(*args, sep=" "):
    """print() aligned under the content margin (transcript lines)."""
    pad = margin_pad()
    print(pad + sep.join(str(a) for a in args).replace("\n", "\n" + pad))




def enable_ansi():
    if os.environ.get("NO_COLOR"):
        return False
    if not sys.stdout.isatty():
        return False
    if os.name == "nt":
        os.system("")  # enable VT processing on Windows consoles
    return True




# Re-exported so existing imports (banner, read_prompt, print_footer,
# handle_slash, and the helpers tests and chat already use) keep working.
from .commands import (  # noqa: E402
    COMMANDS,
    HANDLERS,
    HELP_SECTIONS,
    LOCAL_ENDPOINT_URL,
    ReplSession,
    SlashResult,
    command_tokens,
    copy_to_clipboard,
    handle_slash,
    print_help,
    repl_commands,
    suggest_command,
)
from .splash import (  # noqa: E402
    banner,
    char_width,
    content_margin,
    content_width,
    display_width,
    git_branch,
    layout_mode,
    margin_pad,
    plain_header,
    print_footer,
    render_banner_lines,
    render_footer,
    set_layout,
    strip_ansi,
)
from .session import (  # noqa: E402
    apply_saved_session,
    history_file_path,
    load_session_config,
    save_session_config,
    session_config_path,
)
from .prompt import (  # noqa: E402
    complete_token,
    load_readline,
    read_prompt,
    reset_prompt_interrupt,
    reset_readline_state,
)


def read_input(message=""):
    """Use the active pinned editor for approvals, with plain input fallback."""
    from .chatbox import read_inline_input
    return read_inline_input(message)
