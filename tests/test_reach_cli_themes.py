"""App-local theme catalog, command, color, and footer-state contracts."""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import nullcontext, redirect_stdout
from types import SimpleNamespace
from unittest import mock


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from reach_cli import terminal, themes, commands, footer, chat, chatbox  # noqa: E402
from reach_cli.footer import FooterScreen  # noqa: E402


class _TTY(io.StringIO):
    def __init__(self, columns=80, rows=24):
        super().__init__()
        self.columns = columns
        self.rows = rows

    def isatty(self):
        return True

    def get_size(self):
        return os.terminal_size((self.columns, self.rows))


class ThemeCatalogTests(unittest.TestCase):
    def setUp(self):
        self.old = themes.current_key()
        self.addCleanup(themes.select_theme, self.old)

    def test_supported_schemes_and_readable_text_roles(self):
        self.assertEqual(set(themes.theme_names()), {
            "Default", "Solarized Dark", "Solarized Light (contrast tuned)",
            "One Half Dark", "One Half Light", "Campbell (Windows Terminal)",
            "Tokyo Dark", "Tokyo Light", "Lemonade Dark", "Lemonade Light",
            "Vintage Grandmaster Chessboard", "Warm Latte & Paper",
            "Matcha Latte Cream", "Cyberpunk Neon", "Nord Frost", "Nord Snow Light",
        })
        self.assertEqual(themes.get_theme("Solarized Light (contrast tuned)").key,
                         "solarized-light")
        self.assertEqual(themes.get_theme("Campbell (Windows Terminal)").key,
                         "campbell")
        solarized_dark = themes.get_theme("solarized dark")
        self.assertEqual((solarized_dark.background, solarized_dark.foreground),
                         ("#002B36", "#839496"))
        solarized_light = themes.get_theme("solarized-light")
        self.assertEqual((solarized_light.background, solarized_light.foreground,
                          solarized_light.panel),
                         ("#FDF6E3", "#586E75", "#FDF6E3"))
        self.assertIn("base00 #657B83 (4.13:1)", solarized_light.note)
        self.assertGreaterEqual(
            themes.contrast_ratio(solarized_light.foreground,
                                  solarized_light.background), 4.5)
        for theme in themes.all_themes():
            if not theme.background:
                continue
            for role, color in theme.roles.items():
                with self.subTest(theme=theme.key, role=role):
                    self.assertGreaterEqual(
                        themes.contrast_ratio(color, theme.background), 4.5)

    def test_tokyo_palettes_aliases_and_body_contrast(self):
        for name, alias, key, background, foreground in (
                ("Tokyo Dark", "Toyko Dark", "tokyo-dark", "#1A1B26", "#C0CAF5"),
                ("Tokyo Light", "Toyko Light", "tokyo-light", "#E1E2E7", "#3760BF")):
            with self.subTest(theme=name):
                theme = themes.get_theme(name)
                self.assertIs(themes.get_theme(alias), theme)
                self.assertEqual(theme.key, key)
                self.assertEqual((theme.background, theme.foreground),
                                 (background, foreground))
                self.assertGreaterEqual(
                    themes.contrast_ratio(foreground, background), 4.5)
                self.assertIn(name, "\n".join(themes.preview_lines(key)))

    def test_lemonade_source_palettes_and_alias(self):
        for name, key, background, foreground, palette in (
                ("Lemonade Dark", "lemonade-dark", "#0C0F0A", "#FFFFFF",
                 {"blue": "#FFF017", "green": "#A3E635", "cyan": "#67E8F9",
                  "yellow": "#FACC15", "magenta": "#FB923C", "red": "#E11D48"}),
                ("Lemonade Light", "lemonade-light", "#FEFCE8", "#000000",
                 {"blue": "#CA8A04", "green": "#15803D", "cyan": "#1D4ED8",
                  "yellow": "#B45309", "magenta": "#C2410C", "red": "#E11D48"})):
            with self.subTest(theme=name):
                theme = themes.get_theme(name)
                self.assertIs(themes.get_theme(key), theme)
                self.assertEqual((theme.background, theme.foreground),
                                 (background, foreground))
                self.assertGreaterEqual(
                    themes.contrast_ratio(foreground, background), 4.5)
                for slot, color in palette.items():
                    self.assertEqual(theme.palette[slot], color)
                preview = "\n".join(themes.preview_lines(key))
                for label in (name, "info", "success", "warning", "error"):
                    self.assertIn(label, preview)
                self.assertEqual(themes.select_theme(name).key, key)
        self.assertEqual(themes.select_theme("lemonade").key, "lemonade-dark")
        self.assertNotEqual(themes.get_theme("lemonade-light").roles["accent"],
                            "#CA8A04")

    def test_color_output_uses_palette_background_and_role_colors(self):
        with mock.patch.dict(os.environ, {"COLORTERM": "truecolor", "TERM": "xterm"}):
            themes.select_theme("default")
            cached_role = themes.paint_role(
                "border", "cached", enabled=True, managed_screen=True)
            light = themes.select_theme("solarized-light")
            background = themes.background_sequence()
            rendered = themes.render_line(
                themes.role_marker("border") + "HUD" + "\x1b[0m")
            cached_rendered = themes.render_line(cached_role)
            self.assertEqual(background, "\x1b[48;2;253;246;227m")
            self.assertIn(background, rendered)
            self.assertIn("\x1b[38;2;", rendered)
            self.assertIn("\x1b[38;2;", cached_rendered)
            self.assertIn("HUD", rendered)

            themes.select_theme("campbell")
            campbell = themes.background_sequence()
            self.assertEqual(campbell, "\x1b[48;2;12;12;12m")
            self.assertNotEqual(campbell, background)

    def test_ansi16_indicators_keep_distinct_semantic_hues(self):
        roles = ("accent", "success", "warning", "error", "secondary", "border")
        with mock.patch.object(themes, "_color_capability", return_value="16"):
            for theme in themes.all_themes():
                if not theme.background:
                    continue
                themes.select_theme(theme.key)
                codes = []
                for role in roles:
                    with self.subTest(theme=theme.key, role=role):
                        sgr = themes._role_sgr(role, theme)
                        code = int(sgr[2:-1])
                        normal = themes._DEFAULT_CODES[role]
                        self.assertIn(code, (normal, normal + 60))
                        codes.append(code)
                        self.assertIn(sgr + role, themes.paint_role(role, role))
                        self.assertIn(sgr + role, themes.render_line(
                            themes.paint_role(role, role, managed_screen=True)))
                        self.assertEqual(themes.paint_role(role, role, enabled=False), role)
                self.assertEqual(len(set(codes)), len(roles))
            themes.select_theme("solarized-light")
            self.assertEqual([themes._role_sgr(role) for role in roles],
                             ["\x1b[34m", "\x1b[32m", "\x1b[33m", "\x1b[31m",
                              "\x1b[35m", "\x1b[36m"])

    def test_rich_color_roles_and_default_keep_existing_mapping(self):
        for mode in ("truecolor", "256", "16"):
            with mock.patch.object(themes, "_color_capability", return_value=mode):
                for role, code in themes._DEFAULT_CODES.items():
                    self.assertEqual(themes._role_sgr(role, themes.DEFAULT_THEME),
                                     "\x1b[%dm" % code)
                if mode == "16":
                    continue
                for theme in themes.all_themes():
                    for role, color in theme.roles.items():
                        self.assertEqual(themes._role_sgr(role, theme),
                                         themes._sgr_for_color(color))

    def test_preview_shows_semantic_colors_without_selecting_theme(self):
        themes.select_theme("campbell")
        for mode in ("16", "256", "truecolor"):
            with mock.patch.object(themes, "_color_capability", return_value=mode):
                theme = themes.get_theme("solarized-light")
                preview = "\n".join(themes.preview_lines(theme.key))
                for role, label in (("accent", "info"), ("success", "success"),
                                    ("warning", "warning"), ("error", "error")):
                    self.assertIn(themes._role_sgr(role, theme) + label, preview)
                self.assertEqual(themes.current_key(), "campbell")
                plain = "\n".join(themes.preview_lines(theme.key, color_enabled=False))
                self.assertNotIn("\x1b", plain)

    def test_limited_terminal_and_no_color_fallbacks(self):
        with mock.patch.dict(os.environ, {"TERM": "xterm", "COLORTERM": ""}, clear=False):
            os.environ.pop("WT_SESSION", None)
            themes.select_theme("solarized-dark")
            with mock.patch("reach_cli.themes._color_capability", return_value="16"):
                self.assertIn("\x1b[", themes.background_sequence())
                self.assertIn("\x1b[", themes.render_line("text"))
            with mock.patch.object(terminal, "PAINT", terminal.Paint(False)):
                self.assertEqual(terminal.c_cyan("plain"), "plain")
            self.assertEqual(themes.background_sequence(False), "")
            with mock.patch.dict(os.environ, {"TERM": "dumb", "NO_COLOR": ""}), \
                    mock.patch.object(terminal.sys, "stdout",
                                      SimpleNamespace(isatty=lambda: True)):
                self.assertFalse(terminal.enable_ansi())


class ThemeCommandTests(unittest.TestCase):
    def setUp(self):
        self.old = themes.current_key()
        self.addCleanup(themes.select_theme, self.old)
        themes.select_theme("default")
        self.temp = tempfile.TemporaryDirectory(prefix="reach-theme-", dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.config = os.path.join(self.temp.name, "config.json")
        with open(self.config, "w", encoding="utf-8") as handle:
            json.dump({"model": "keep-model", "layout": "full",
                       "custom_field": {"keep": True}}, handle)
        self.env = mock.patch.dict(os.environ, {"REACH_CLI_CONFIG": self.config})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.client = SimpleNamespace(model="theme-test", base="", agent=False,
                                      workpath=self.temp.name)

    def invoke(self, line):
        output = io.StringIO()
        with mock.patch.object(terminal, "PAINT", terminal.Paint(False)), \
                mock.patch("sys.stdout", output):
            result = commands.handle_slash(line, self.client, [])
        return result, output.getvalue()

    def config_data(self):
        with open(self.config, encoding="utf-8") as handle:
            return json.load(handle)

    def test_list_preview_select_reset_and_config_merge(self):
        listed, listing = self.invoke("/themes")
        self.assertTrue(listed.success)
        self.assertIn("Solarized Light", listing)
        self.assertIn("One Half Dark", listing)

        previewed, preview = self.invoke("/theme preview Solarized Light")
        self.assertTrue(previewed.success)
        self.assertIn("#FDF6E3", preview)
        self.assertEqual(themes.current_key(), "default")
        self.assertNotIn("theme", self.config_data())

        selected, _ = self.invoke("/theme Solarized Light")
        self.assertTrue(selected.success)
        self.assertEqual(themes.current_key(), "solarized-light")
        data = self.config_data()
        self.assertEqual(data["theme"], "solarized-light")
        self.assertEqual(data["model"], "keep-model")
        self.assertEqual(data["layout"], "full")
        self.assertEqual(data["custom_field"], {"keep": True})

        reset, reset_text = self.invoke("/theme reset")
        self.assertTrue(reset.success)
        self.assertIn("reset to Default", reset_text)
        self.assertEqual(self.config_data()["theme"], "default")

    def test_tokyo_commands_preview_and_persist_canonical_names(self):
        _, listing = self.invoke("/themes")
        for name in ("Tokyo Dark", "Tokyo Light"):
            self.assertIn(name, listing)
        for alias, key in (("Toyko Dark", "tokyo-dark"),
                           ("Toyko Light", "tokyo-light")):
            before = themes.current_key()
            result, _ = self.invoke("/theme preview " + alias)
            self.assertTrue(result.success)
            self.assertEqual(themes.current_key(), before)
            result, _ = self.invoke("/theme " + alias)
            self.assertTrue(result.success)
            self.assertEqual(themes.current_key(), key)
            self.assertEqual(self.config_data()["theme"], key)

    def test_unknown_theme_does_not_change_selection_or_saved_value(self):
        commands.save_session_config(theme="campbell")
        themes.select_theme("campbell")
        result, output = self.invoke("/theme missing")
        self.assertFalse(result.success)
        self.assertIn("unknown theme", output)
        self.assertEqual(themes.current_key(), "campbell")
        self.assertEqual(self.config_data()["theme"], "campbell")

    def test_saved_theme_is_restored_before_interactive_loop(self):
        saved = {"theme": "campbell", "layout": "full"}
        with mock.patch.object(terminal, "load_session_config", return_value=saved), \
                mock.patch.object(terminal, "set_theme") as set_theme, \
                mock.patch.object(terminal, "set_layout") as set_layout, \
                mock.patch.object(chatbox, "footer_session",
                                  side_effect=lambda _client: nullcontext()), \
                mock.patch.object(chat, "_run_chat_loop", return_value="ok") as loop:
            result = chat.run_chat(self.client, "http://localhost/v1")
        self.assertEqual(result, "ok")
        set_theme.assert_called_once_with("campbell")
        set_layout.assert_called_once_with("full")
        loop.assert_called_once_with(self.client, "http://localhost/v1", None)


class ThemeFooterTests(unittest.TestCase):
    def setUp(self):
        self.old_theme = themes.current_key()
        self.old_paint = terminal.PAINT
        themes.select_theme("default")
        terminal.PAINT = terminal.Paint(True)
        self.addCleanup(setattr, terminal, "PAINT", self.old_paint)
        self.addCleanup(themes.select_theme, self.old_theme)
        self.tty = _TTY()
        self.client = SimpleNamespace(
            model="theme-test", base="http://127.0.0.1:1/v1", agent=False,
            workpath="", session_totals={}, last_turn=None)

    def test_theme_repaint_colors_full_frame_without_changing_logical_state(self):
        with mock.patch.dict(os.environ, {"COLORTERM": "truecolor", "WT_SESSION": "1"}):
            screen = FooterScreen(self.client, self.tty, size=self.tty.get_size)
            self.addCleanup(screen.close)
            self.assertTrue(screen.start())
            screen.write("".join("history-%03d\n" % index for index in range(100)))
            screen.set_input("draft stays here", 7, chunks=("draft", " stays here"))
            screen.scroll_lines(20)
            before = screen.snapshot()
            output_start = len(self.tty.getvalue())

            output = io.StringIO()
            with mock.patch.object(commands, "save_session_config", return_value=True), \
                    mock.patch.object(chatbox, "active_footer", return_value=screen), \
                    redirect_stdout(output):
                result = commands.handle_slash(
                    "/theme solarized-light", self.client, [])
            self.assertTrue(result.success)
            self.assertIn("Solarized Light", output.getvalue())
            output = self.tty.getvalue()[output_start:]
            after = screen.snapshot()

            self.assertIn("\x1b[48;2;253;246;227m", output)
            for key in ("text", "cursor", "chunks", "transcript", "scroll"):
                self.assertEqual(after[key], before[key], key)

            self.tty.columns = 42
            screen.flush()
            resized = screen.snapshot()
            self.assertEqual((resized["text"], resized["cursor"], resized["chunks"]),
                             (before["text"], before["cursor"], before["chunks"]))


if __name__ == "__main__":
    unittest.main()
