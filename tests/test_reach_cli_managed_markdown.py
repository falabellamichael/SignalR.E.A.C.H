"""Original Markdown lines reflow through the actual managed reply pipeline."""
import contextlib
import os
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))
from reach_cli import chat, chatbox, footer, render, splash, terminal, themes
from reach_cli.pets import TerminalPet
from tests.test_reach_cli_footer_screen import MutableTTY
from tests.test_reach_cli_hud import FixedTelemetry


class ManagedMarkdownTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.addCleanup(splash.set_layout, splash.layout_mode())
        self.addCleanup(themes.select_theme, themes.current_key())
        splash.set_layout("full")
        themes.select_theme("default")
        self.stack.enter_context(patch.object(terminal, "PAINT", terminal.Paint(True)))
        self.stack.enter_context(patch.object(footer, "SystemTelemetry", FixedTelemetry))
        self.stack.enter_context(patch.object(footer, "client_meta", return_value=("fixture", "local", "chat")))
        self.tty = MutableTTY(42, 44)
        self.client = SimpleNamespace(model="fixture", base="local", agent=False,
                                      session_totals={}, last_turn=None, workpath="")
        self.screen = footer.FooterScreen(self.client, self.tty, size=self.tty.get_size)
        self.screen.pet = TerminalPet(clock=lambda: 0, motion=False)
        self.screen._active = True
        self.screen._draw()
        self.addCleanup(self.screen.close)

    def stream(self, text, thought=""):
        def complete(messages, tools=None, on_text=None, on_thought=None):
            if thought:
                on_thought(thought)
            for index in range(0, len(text), 7):
                on_text(text[index:index+7])
            return {"content": text, "thought": thought}
        self.client.complete = complete
        with patch.object(chatbox, "active_footer", return_value=self.screen), \
                patch.object(chat, "WaitIndicator"), \
                patch.object(chat, "_FollowUpCollector"), \
                patch.object(chat, "_interruptible", side_effect=lambda fn: fn()), \
                contextlib.redirect_stdout(self.screen):
            ok, result = chat.stream_reply(self.client, [], full=True)
        self.assertTrue(ok)
        self.assertEqual(result["content"], text)

    def rows(self):
        return [splash.strip_ansi(text) for _, _, text in self.screen._visual_rows]

    def resize(self, columns):
        self.tty.resize(columns, 44)
        self.screen.refresh_header()
        self.assertTrue(all(footer._glyph_width(row) <= columns for row in self.rows()), self.rows())

    def test_historical_command_recombines_on_wide_resize_and_rewraps_narrow(self):
        command = 'grep -oE "ipcMain.handle" studio/main.mjs | sort -u | wc -l'
        self.stream("```bash\n" + command + "\n```\n")
        narrow = self.rows()
        self.assertTrue(any("↳" in row for row in narrow))
        self.assertTrue(any("studio/main.mjs" in row for row in narrow))
        self.resize(100)
        wide = self.rows()
        self.assertTrue(any(command in row for row in wide), wide)
        self.assertFalse(any("↳" in row for row in wide))
        borders = [row for row in wide if "┌─ bash" in row or "└─" in row]
        self.assertEqual(len(borders), 2)
        self.assertEqual([footer._glyph_width(row) for row in borders], [99, 99])
        self.resize(42)
        self.assertEqual(self.rows(), narrow)

    def test_historical_paragraph_uses_actual_gutter_room_and_recombines(self):
        sentence = "Read the documentation carefully before continuing with the example."
        self.stream(sentence + "\n")
        self.assertTrue(any("documentation" in row for row in self.rows()))
        self.resize(100)
        self.assertTrue(any(sentence in row for row in self.rows()), self.rows())
        self.assertEqual(sum(line.markdown is not None for line in self.screen._lines), 1)

    def test_bullet_and_numbered_continuations_keep_hanging_indentation(self):
        self.stream("- Read the documentation carefully before continuing with the example.\n"
                    "12. Check the documentation thoroughly before running this command.\n")
        rows = self.rows()
        self.assertTrue(any(row.startswith("  │   ") and "continuing" in row for row in rows), rows)
        self.assertTrue(any(row.startswith("  │     ") and "running" in row for row in rows), rows)

    def test_thought_mark_survives_source_reflow_and_keeps_its_hover_target(self):
        self.stream("The documentation needs a careful review before continuing.\n", thought="offline thought")
        self.resize(30)
        self.resize(90)
        index, row = next((i, text) for i, text in enumerate(self.rows()) if chat.THOUGHT_GLYPH in text)
        state, geometry = self.screen._scroll_state, self.screen._geometry
        shown = min(state["visible_rows"], state["total_rows"]-state["top"])
        y = geometry["transcript_top"] + state["visible_rows"]-shown+index-state["top"]
        x = footer._glyph_width(row[:row.index(chat.THOUGHT_GLYPH)])
        hit = self.screen._thought_at(x, y)
        self.assertIsNotNone(hit)
        self.assertEqual("".join(hit[0]["parts"]), "offline thought")

    def test_code_first_with_thought_puts_the_box_in_a_consistent_gutter(self):
        self.stream("```python\n    return documentation\n```\n", thought="offline thought")
        self.resize(60)
        rows = self.rows()
        borders = [row for row in rows if "┌─ python" in row or "└─" in row]
        self.assertEqual([footer._glyph_width(row) for row in borders], [59, 59])
        self.assertTrue(any(row.startswith("  │ │     return documentation") for row in rows), rows)
        self.assertTrue(any(chat.THOUGHT_GLYPH in row for row in rows))

    def test_code_tabs_flags_and_combining_text_fit_native_cell_budget(self):
        self.stream("```text\n\tflags = '🇨🇦'  # e\u0301 and 漢字\n```\n")
        for columns in (12, 18, 30, 62):
            self.resize(columns)

    def test_resize_preserves_draft_and_code_source_inside_open_disclosure(self):
        token = self.screen.begin_tool_call("  > read", ["some details"])
        self.stream("```json\n{\"documentation\": \"carefully reviewed\"}\n```\n")
        self.screen.set_input("draft stays", 5)
        self.screen._follow_tail = False
        self.screen._scroll_anchor = (token.tool["index"], 0)
        self.screen._draw()
        index = next(i for i, (line, offset, _text) in enumerate(self.screen._visual_rows)
                     if self.screen._lines[line] is token and offset == 0)
        state, geometry = self.screen._scroll_state, self.screen._geometry
        shown = min(state["visible_rows"], state["total_rows"]-state["top"])
        y = geometry["transcript_top"] + state["visible_rows"]-shown+index-state["top"]
        self.screen.click((2, y))
        for columns in (70, 35, 42):
            self.resize(columns)
            state = self.screen.snapshot()
            self.assertEqual(state["text"], "draft stays")
            self.assertEqual(state["cursor"], 5)
            self.assertTrue(token.tool["expanded"])
            self.assertIn("some details", "\n".join(self.rows()))

    def test_scroll_anchor_stays_on_original_code_token_when_width_changes(self):
        self.tty.resize(42, 14)
        self.screen.refresh_header()
        self.stream("```text\n" + " ".join("item%03d" % i for i in range(150)) + "\n```\n")
        index = next(i for i, (_, _, text) in enumerate(self.screen._visual_rows)
                     if "item060" in splash.strip_ansi(text))
        self.screen._follow_tail = False
        self.screen._scroll_anchor = self.screen._visual_rows[index][:2]
        self.screen._draw()
        self.tty.resize(70, 14)
        self.screen.refresh_header()
        top = self.screen._scroll_state["top"]
        row = splash.strip_ansi(self.screen._visual_rows[top][2])
        self.assertIn("item060", row, row)
        for line_index, offset, _text in self.screen._visual_rows:
            self.assertLessEqual(offset, len(self.screen._lines[line_index].cells))


if __name__ == "__main__":
    unittest.main()
