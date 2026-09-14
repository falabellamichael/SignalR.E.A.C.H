"""Terminal rendering: ANSI colours, spinners, status lines, banner."""

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




def banner(client, base, mode):
    width = 66
    print(c_cyan("┌" + "─" * width + "┐"))
    print(
        c_cyan("│")
        + c_bold(c_yellow("  ⚡ SignalR.E.A.C.H CLI"))
        + c_dim("  v" + VERSION)
        + (" " * (width - 32))
        + c_cyan("│")
    )
    print(
        c_cyan("│")
        + c_dim("  REACH = RAG Endpoint & AI Chat Host — keyless gpt-4o/5, Claude")
        + " " * (width - 72)
        + c_cyan("│")
    )
    print(c_cyan("├") + "─" * width + "┤")
    model = client.model or "(auto — set with /model)"
    print(
        c_cyan("│")
        + "  "
        + c_green("endpoint ")
        + c_dim(base)
        + (" " * max(1, width - 16 - len(base)))
        + c_cyan("│")
    )
    print(
        c_cyan("│")
        + "  "
        + c_green("model    ")
        + c_bold(model)
        + (" " * max(1, width - 15 - len(model)))
        + c_cyan("│")
    )
    print(c_cyan("└") + "─" * width + "┘")
    print(c_dim("  /help for commands · /web <question> for grounded search\n"))




def print_footer(client, cited=False):
    parts = ["%s ms" % round(client.last_latency_ms)]
    if client.usage.get("completion"):
        parts.append("%s tok" % client.usage["completion"])
    if cited:
        parts.append("grounded")
    print(c_cyan("  └─") + c_dim("  " + " · ".join(parts)))
    print()



def response_label():
    """Inline label for an AI response: left rule + 'ai ▸' (no newline).

    Separated from response_open so the waiting indicator can re-emit the
    label after clearing its animated line.
    """
    return c_cyan("  │ ") + c_bold(c_magenta("ai ▸") + " ")


def response_open():
    """Opening rule for an AI response: blank line, border, 'ai ▸' label.
    The streamed body continues right after this."""
    sys.stdout.write("\n" + response_label())
    sys.stdout.flush()



def response_indent():
    """Left-rule prefix for continuation lines of a streamed reply."""
    return c_cyan("  │ ")




def spinner(message):
    sys.stdout.write("\r" + c_cyan(spinner_char()) + " " + message + "   ")
    sys.stdout.flush()




def spinner_clear():
    sys.stdout.write("\r" + " " * 60 + "\r")
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
            self.CR + self._prefix + glyph + " " + c_dim(label) + "  "
        )
        sys.stdout.flush()

    def start(self):
        if not sys.stdout.isatty():
            return
        self._started = True
        self._thread.start()

    def _clear(self):
        sys.stdout.write(
            self.CR + self._prefix + " " * 80 + self.CR + self._prefix
        )
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
    print(c_dim("  " + message))




def enable_ansi():
    if os.environ.get("NO_COLOR"):
        return False
    if not sys.stdout.isatty():
        return False
    if os.name == "nt":
        os.system("")  # enable VT processing on Windows consoles
    return True
