"""Keyboard choices painted by the same screen owner as the chat editor."""

import sys


def available():
    from .chatbox import editor_available
    return bool(sys.stdin.isatty() and sys.stdout.isatty() and editor_available())


def choose(title, choices, current=None, quick_pick=False):
    """Return a choice value on Enter, or None on Escape/Ctrl-C/EOF.

    Each choice is (value, label, detail). Menus never write into the chat
    transcript or replace its draft. Standalone commands use a temporary
    alternate screen and restore the terminal on every exit path.
    """
    if not choices or not available():
        return None
    from .chatbox import active_footer
    from .footer import FooterScreen
    from .footer_input import read_keys

    choices = tuple(choices)
    values = [choice[0] for choice in choices]
    selected = values.index(current) if current in values else 0
    result = None
    screen = active_footer()
    owned = screen is None
    if owned:
        screen = FooterScreen(None, sys.stdout)

    def paint():
        screen.set_menu(title, choices, selected=selected, current=current)

    def keypress(key, value):
        nonlocal selected, result
        if quick_pick and key == "text":
            key = {"j": "down", "k": "up", "q": "escape"}.get(str(value).lower(), key)
            if key != "text":
                value = ""
        page = max(1, min(10, screen.snapshot()["geometry"].get("transcript_rows", 10) - 4))
        if key in ("up", "left", "scroll_up"):
            selected = (selected - max(1, int(value or 1))) % len(choices)
        elif key in ("down", "right", "tab", "scroll_down"):
            selected = (selected + max(1, int(value or 1))) % len(choices)
        elif key == "home":
            selected = 0
        elif key in ("end", "scroll_live"):
            selected = len(choices) - 1
        elif key == "scroll_page_up":
            selected = max(0, selected - page)
        elif key == "scroll_page_down":
            selected = min(len(choices) - 1, selected + page)
        elif key == "enter":
            result = values[selected]
            return True
        elif key == "escape":
            return True
        elif quick_pick and key == "text" and str(value) in "123456789" and len(str(value)) == 1:
            index = int(value) - 1
            if index < len(choices):
                result = values[index]
                return True
        elif key != "resize":
            return False
        paint()
        return False

    try:
        if owned and not screen.start():
            return None
        paint()
        read_keys(keypress)
        return result
    except (KeyboardInterrupt, EOFError):
        return None
    finally:
        try:
            screen.clear_menu()
        finally:
            if owned:
                screen.close()
