"""Command presentation stays byte-compatible while painting each view once."""

import contextlib
import io
import json
import os
import sys
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))
from reach_cli import terminal, commands, discovery, footer, splash


class _Sink(io.StringIO):
    def __init__(self, tty=False):
        super().__init__()
        self.tty = tty
        self.writes = 0

    def write(self, text):
        self.writes += 1
        return super().write(text)

    def isatty(self):
        return self.tty


class _UnbatchedPresentation:
    """Reference formatting and write policy from the unchanged terminal helper."""

    def line(self, *args, sep=" "):
        terminal.tprint(*args, sep=sep)

    def blank(self):
        print()

    def flush(self):
        pass


class _Cache:
    def snapshot(self, base, key_ref="", key=None):
        return {"status": "error", "models": ["mock-a", "mock-b"], "stale": True,
                "error": "Model discovery failed (HTTP 503); cached models were retained."}

    def refresh(self, base, key="", key_ref="", timeout=3):
        return self.snapshot(base, key_ref=key_ref, key=key)


class _FrozenTelemetry:
    """Stable HUD metadata; these presentation tests never sample the host."""

    def start(self):
        pass

    def stop(self):
        pass

    def snapshot(self):
        return {"at": 1000.0, "cpu_pct": 25.0, "gpu_pct": 50.0,
                "gpu_name": "fixture", "gpu_memory_used": 1024.0,
                "gpu_memory_total": 4096.0, "gpu_status": "available",
                "ram_used": 3.0 * 1024 ** 3, "ram_total": 8.0 * 1024 ** 3}


class _CountingScreen(footer.FooterScreen):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.command_writes = 0

    def write(self, text):
        self.command_writes += 1
        return super().write(text)


class CommandBatchingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="reach-command-batch-")
        self.addCleanup(self.directory.cleanup)
        config = os.path.join(self.directory.name, "config.json")
        with open(config, "w", encoding="utf-8") as handle:
            json.dump({"custom_endpoints": {
                "office": {"url": "http://127.0.0.1:31991/v1"},
                "backup": {"url": "http://127.0.0.1:31992/v1"},
            }}, handle)
        env = mock.patch.dict(os.environ, {"REACH_CLI_CONFIG": config})
        env.start()
        self.addCleanup(env.stop)
        cache = mock.patch.object(discovery, "MODEL_DISCOVERY", _Cache())
        cache.start()
        self.addCleanup(cache.stop)
        self.client = SimpleNamespace(base="http://127.0.0.1:31991/v1",
                                      endpoint_name="office", key="", model="mock-a",
                                      agent=True, workpath=self.directory.name,
                                      session_totals={}, last_turn=None)
        self.paint = terminal.PAINT
        self.layout = splash.layout_mode()
        self.addCleanup(setattr, terminal, "PAINT", self.paint)
        self.addCleanup(splash.set_layout, self.layout)

    def render(self, line, unbatched=False, sink=None):
        sink = sink or _Sink()
        presentation = mock.patch.object(commands, "_Presentation", _UnbatchedPresentation) if unbatched else contextlib.nullcontext()
        with contextlib.redirect_stdout(sink), presentation:
            result = commands.handle_slash(line, self.client, [])
        self.assertTrue(result.success)
        return sink

    def test_whole_views_match_plain_and_ansi_bytes_in_both_margin_modes(self):
        for colored in (False, True):
            terminal.PAINT = terminal.Paint(colored)
            for layout in ("center", "full"):
                splash.set_layout(layout)
                for line in ("/help", "/settings", "/endpoint list", "/endpoints"):
                    with self.subTest(colored=colored, layout=layout, line=line):
                        with mock.patch.object(splash, "terminal_columns", return_value=140):
                            expected = self.render(line, unbatched=True, sink=_Sink(tty=True))
                            actual = self.render(line, sink=_Sink(tty=True))
                        self.assertEqual(actual.getvalue(), expected.getvalue())
                        self.assertEqual(actual.writes, 1)
                        self.assertGreater(expected.writes, 15)

    def test_formatter_preserves_multiline_separator_and_unindented_blank_line(self):
        terminal.PAINT = terminal.Paint(True)
        splash.set_layout("center")
        expected, actual = _Sink(tty=True), _Sink(tty=True)
        with mock.patch.object(splash, "terminal_columns", return_value=140):
            with contextlib.redirect_stdout(expected):
                reference = _UnbatchedPresentation()
                reference.line("first\nsecond", terminal.c_dim("value"), sep=" | ")
                reference.blank()
            with contextlib.redirect_stdout(actual):
                output = commands._Presentation()
                output.line("first\nsecond", terminal.c_dim("value"), sep=" | ")
                output.blank()
                output.flush()
        self.assertEqual(actual.getvalue(), expected.getvalue())
        self.assertEqual(actual.writes, 1)

    def test_public_help_and_model_preview_each_write_once(self):
        for callback in (commands.print_help, lambda: commands._print_discovery((self.client.base, "", ""))):
            expected, actual = _Sink(), _Sink()
            with contextlib.redirect_stdout(expected), mock.patch.object(commands, "_Presentation", _UnbatchedPresentation):
                callback()
            with contextlib.redirect_stdout(actual):
                callback()
            self.assertEqual(actual.getvalue(), expected.getvalue())
            self.assertEqual(actual.writes, 1)
            self.assertGreater(expected.writes, 1)

    def screen_result(self, line, unbatched):
        tty = _Sink(tty=True)
        screen = _CountingScreen(self.client, tty, size=(140, 30))
        # Newer footers have a live HUD. Freeze its input, retaining real paint.
        if hasattr(screen, "_telemetry"):
            screen._telemetry = _FrozenTelemetry()
        # The sink is real; only its background native-input poll is unnecessary.
        screen._watch = lambda: None
        try:
            self.assertTrue(screen.start())
            screen.set_input("draft 世界", 5)
            screen.command_writes = 0
            started = time.perf_counter()
            with mock.patch.object(splash, "terminal_columns", return_value=140):
                self.render(line, unbatched=unbatched, sink=screen)
            elapsed = (time.perf_counter() - started) * 1000
            return {"snapshot": screen.snapshot(), "display": tuple(screen._last_display),
                    "writes": screen.command_writes, "elapsed_ms": elapsed}
        finally:
            screen.close()

    def test_actual_footer_sink_preserves_transcript_styles_geometry_and_cursor(self):
        terminal.PAINT = terminal.Paint(True)
        splash.set_layout("center")
        for line in ("/help", "/settings", "/endpoints"):
            with self.subTest(line=line):
                before = self.screen_result(line, unbatched=True)
                after = self.screen_result(line, unbatched=False)
                self.assertEqual(after["snapshot"], before["snapshot"])
                self.assertEqual(after["display"], before["display"])
                self.assertEqual(after["writes"], 1)
                self.assertGreater(before["writes"], 15)


if __name__ == "__main__":
    unittest.main()
