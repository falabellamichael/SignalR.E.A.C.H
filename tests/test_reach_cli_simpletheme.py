"""Source-backed SimpleTheme CLI palette regressions."""

import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))
from reach_cli import themes


class SimpleThemeTests(unittest.TestCase):
    def test_source_palettes_and_aliases(self):
        cases = (
            ("Vintage Grandmaster Chessboard", "vintage-chessboard", "#181614", "#FFFFFF",
             ("#EBE1CE", "#E8DEC8", "#CBB898", "#D8CCB8", "#F5EEDC")),
            ("Warm Latte & Paper", "warm-latte", "#FAF4ED", "#000000",
             ("#D7827E", "#1D4ED8", "#047857", "#B45309", "#B91C1C")),
            ("Matcha Latte Cream", "matcha", "#F7FEE7", "#000000",
             ("#4D7C0F", "#15803D", "#047857", "#B45309", "#3F6212")),
            ("Cyberpunk Neon", "cyberpunk", "#08080C", "#FFFFFF",
             ("#FFE600", "#00F0FF", "#B829FF", "#FFE600", "#FF007F")),
            ("Nord Frost", "nord-dark", "#2E3440", "#FFFFFF",
             ("#88C0D0", "#88C0D0", "#8FBCBB", "#A3BE8C", "#81A1C1")),
            ("Nord Snow Light", "nord-light", "#ECEFF4", "#000000",
             ("#5E81AC", "#81A1C1", "#88C0D0", "#8FBCBB", "#5E81AC")),
        )
        old = themes.current_key()
        self.addCleanup(themes.select_theme, old)
        for name, alias, background, foreground, inks in cases:
            with self.subTest(theme=name):
                theme = themes.get_theme(name)
                self.assertIs(themes.get_theme(alias), theme)
                self.assertEqual((theme.background, theme.foreground), (background, foreground))
                self.assertEqual(tuple(theme.palette[k] for k in
                                       ("blue", "green", "cyan", "yellow", "magenta")), inks)
                self.assertEqual(theme.palette["red"], "#E11D48")
                self.assertGreaterEqual(themes.contrast_ratio(foreground, background), 4.5)
                for color in theme.roles.values():
                    self.assertGreaterEqual(themes.contrast_ratio(color, background), 4.5)
                self.assertIs(themes.select_theme(alias), theme)
                for capability in ("truecolor", "256", "16"):
                    with mock.patch.object(themes, "_color_capability", return_value=capability):
                        preview = "\n".join(themes.preview_lines(name))
                        for label in (name, "info", "success", "warning", "error"):
                            self.assertIn(label, preview)
                        if capability == "16":
                            self.assertEqual(len({themes._role_sgr(role, theme) for role in
                                                 ("accent", "secondary", "border", "success", "warning", "error")}), 6)
                self.assertFalse(any("\x1b" in line for line in themes.preview_lines(name, False)))
        self.assertIs(themes.get_theme("chessboard"), themes.get_theme("vintage-chessboard"))


if __name__ == "__main__":
    unittest.main()
