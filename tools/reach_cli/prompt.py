"""Readline prompt: history, completion, and multi-line input."""

import os

from .commands import command_tokens
from .session import history_file_path
from .splash import display_width, truncate_display
from .terminal import c_bold, c_cyan, c_dim, c_green, c_magenta, c_red, c_yellow

_READLINE_READY = False
_READLINE = None
_UNSAFE_READLINE_HISTORY = False
_INTERRUPT_ARMED = False


def reset_prompt_interrupt():
    global _INTERRUPT_ARMED
    _INTERRUPT_ARMED = False


def reset_readline_state():
    global _READLINE_READY, _READLINE, _UNSAFE_READLINE_HISTORY
    _READLINE_READY = False
    _READLINE = None
    _UNSAFE_READLINE_HISTORY = False


def load_readline():
    """GNU readline, or pyreadline3 on Windows. None when neither imports."""
    try:
        import readline
        return readline
    except ImportError:
        pass
    if os.name == "nt":
        try:
            import pyreadline3 as readline
            return readline
        except ImportError:
            return None
    return None


def _install_readline(readline_mod):
    global _READLINE_READY, _READLINE
    if readline_mod is None:
        return False
    if _READLINE_READY and _READLINE is readline_mod:
        return True
    try:
        readline_mod.parse_and_bind("set editing-mode emacs")
        readline_mod.parse_and_bind("tab: complete")
        readline_mod.parse_and_bind('"\\C-r": reverse-search-history')
        readline_mod.set_completer(_readline_complete)
        readline_mod.set_completer_delims(" \t\n")
        readline_mod.set_history_length(1000)
        path = history_file_path()
        if path and os.path.isfile(path):
            readline_mod.read_history_file(path)
        _READLINE = readline_mod
        _READLINE_READY = True
        return True
    except Exception:
        return False


def _persist_readline(readline_mod):
    if readline_mod is None or _UNSAFE_READLINE_HISTORY:
        return
    try:
        path = history_file_path()
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        readline_mod.write_history_file(path)
    except Exception:
        pass


def _readline_complete(text, state):
    try:
        mod = load_readline()
        buffer = mod.get_line_buffer() if mod is not None else ""
        matches = complete_token(text, buffer)
    except Exception:
        return None
    if state < len(matches):
        return matches[state]
    return None


def complete_token(text, buffer):
    """Tab matches: /commands from the registry, or paths after /workpath."""
    text = "" if text is None else str(text)
    buffer = "" if buffer is None else str(buffer)
    stripped = buffer.lstrip()
    if stripped.startswith("/workpath ") or stripped.startswith("/workpath\t"):
        return _complete_paths(text)
    if text.startswith("/") or stripped.startswith("/"):
        return [token for token in command_tokens() if token.startswith(text)]
    return []


def _complete_paths(text):
    raw = "" if text is None else str(text)
    try:
        expanded = os.path.expanduser(raw)
        if raw.endswith("/") or raw.endswith(os.sep):
            directory = expanded or "."
            stem = ""
            typed_dir = raw
        elif raw == "":
            directory = "."
            stem = ""
            typed_dir = ""
        else:
            directory = os.path.dirname(expanded) or "."
            stem = os.path.basename(expanded)
            leaf = os.path.basename(raw)
            typed_dir = raw[:len(raw) - len(leaf)]
        names = os.listdir(directory)
    except Exception:
        return []
    matches = []
    for name in sorted(names):
        if name.startswith(".") and not stem.startswith("."):
            continue
        if stem and not name.startswith(stem):
            continue
        full = os.path.join(directory, name)
        try:
            suffix = "/" if os.path.isdir(full) else ""
        except OSError:
            suffix = ""
        matches.append(typed_dir + name + suffix)
    return matches


def prompt_rule(client):
    """Top rule framing the input line: ``┌─ model · endpoint · mode · dir@br ─┐``."""
    from .chatbox import client_meta, session_meta  # lazy: prompt <- terminal <- chatbox
    model, endpoint, details = client_meta(client)
    text = " · ".join(p for p in (model, endpoint, details) if p)
    if display_width(text) > 60:
        text = truncate_display(text, 60)
    line = c_cyan("┌─ ") + c_magenta(model) + c_dim(
        text[len(model):]) + c_cyan(" ───┐")
    stats = session_meta(client)
    if stats:
        line += c_dim("  " + stats)
    from .splash import margin_pad
    return margin_pad() + line


def _interrupt_armed(session):
    if session is not None and getattr(session, "interrupt_armed", None) is not None:
        return bool(session.interrupt_armed)
    return _INTERRUPT_ARMED


def _set_interrupt(session, value):
    global _INTERRUPT_ARMED
    _INTERRUPT_ARMED = bool(value)
    if session is not None:
        try:
            session.interrupt_armed = bool(value)
        except Exception:
            pass


def read_prompt(client=None, session=None):
    """Read the next user turn. The chat loop should call this instead of input().

    Returns a string to handle (empty means ask again) or None to leave the
    REPL. None means EOF or the second Ctrl-C, and ``bye.`` is already
    printed — the caller should not print it again.

    A trailing backslash continues onto the next line. Two trailing
    backslashes are a literal backslash and do not continue. Readline, when
    it imports, persists ``~/.reach_cli_history``, completes /commands and
    /workpath paths on Tab, and binds Ctrl-R to reverse-search. pyreadline3
    is the optional Windows module. With neither installed, input() is used.
    """
    try:
        return _read_prompt(client, session)
    except Exception as exc:
        print(c_red("  ✗ %s" % exc))
        return ""


def _read_prompt(client, session):
    from . import terminal as term
    readline_mod = term.load_readline()
    if use_chatbox():
        return _read_boxed(client, session, None)
    _install_readline(readline_mod)
    print(prompt_rule(client))
    chunks = []
    first = True
    while True:
        prompt = c_bold(c_green("you ▸ ")) if first else c_dim("... ")
        try:
            line = input(prompt)
        except KeyboardInterrupt:
            if _interrupt_armed(session):
                _set_interrupt(session, False)
                print(c_dim("\n  bye."))
                return None
            _set_interrupt(session, True)
            print(c_yellow("\n  Ctrl-C again to quit · /exit or Ctrl-D also quits"))
            return ""
        except EOFError:
            _set_interrupt(session, False)
            if chunks:
                break
            print(c_dim("\n  bye."))
            return None
        if not isinstance(line, str):
            line = "" if line is None else str(line)
        _set_interrupt(session, False)
        if line.endswith("\\\\"):
            chunks.append(line[:-1])
            break
        if line.endswith("\\"):
            chunks.append(line[:-1])
            first = False
            continue
        chunks.append(line)
        break
    text = "\n".join(chunks)
    _remember_history(text, readline_mod)
    return text


def use_chatbox():
    """Only one editor may own cursor movement and resizing on a TTY."""
    import sys
    from . import terminal as term
    try:
        from .chatbox import editor_available
        return bool(term.PAINT.on and sys.stdin.isatty() and sys.stdout.isatty()
                    and editor_available())
    except Exception:
        return False


def _read_boxed(client, session, readline_mod):
    from .chatbox import read_boxed
    try:
        chunks = read_boxed(client)
    except KeyboardInterrupt:
        if _interrupt_armed(session):
            _set_interrupt(session, False)
            print(c_dim("\n  bye."))
            return None
        _set_interrupt(session, True)
        print(c_yellow("  Ctrl-C again to quit \u00b7 /exit or Ctrl-D also quits"))
        return ""
    except EOFError:
        _set_interrupt(session, False)
        print(c_dim("\n  bye."))
        return None
    _set_interrupt(session, False)
    text = "\n".join(chunks)
    _remember_history(text, readline_mod)
    return text


def _remember_history(text, readline_mod):
    """Persist the turn. Readline writes its own file; input() appends a line."""
    if not isinstance(text, str) or not text.strip():
        return
    from .input_privacy import sanitize_endpoint_command
    global _UNSAFE_READLINE_HISTORY
    visible = sanitize_endpoint_command(text)
    if visible != text and readline_mod is not None and _READLINE_READY:
        try:
            # input() has already added the submitted lines to GNU readline.
            # Change only this submission, preserving older history entries.
            raw_lines, safe_lines = text.splitlines(), visible.splitlines()
            length = readline_mod.get_current_history_length()
            if len(raw_lines) != len(safe_lines) or length < len(raw_lines):
                raise ValueError("cannot safely replace submitted history")
            for offset, (raw, safe) in enumerate(zip(reversed(raw_lines), reversed(safe_lines))):
                index = length - offset
                if readline_mod.get_history_item(index) != raw:
                    raise ValueError("cannot identify submitted history")
                readline_mod.replace_history_item(index - 1, safe)
        except Exception:
            # An embedding's readline shim may lack replacement operations.
            # Never serialize its unsafe in-memory entry in this session.
            _UNSAFE_READLINE_HISTORY = True
    text = visible
    if readline_mod is not None and _READLINE_READY and not _UNSAFE_READLINE_HISTORY:
        _persist_readline(readline_mod)
        return
    try:
        path = history_file_path()
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)
        flat = " ".join(part.strip() for part in text.splitlines() if part.strip())
        if not flat:
            return
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(flat + "\n")
    except Exception:
        pass
