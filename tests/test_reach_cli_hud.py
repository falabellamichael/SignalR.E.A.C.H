"""Top HUD, live telemetry, and explicit mini-terminal interaction tests."""

import io
import os
import re
import sys
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))

from reach_cli import terminal, splash, footer, footer_input, hud, chatbox  # noqa: E402
from reach_cli.footer_input import EditBuffer  # noqa: E402
from reach_cli.mini_terminal import MiniTerminal, safe_output  # noqa: E402
from reach_cli.system_telemetry import SystemTelemetry  # noqa: E402


_CSI = re.compile(r"\x1b\[[?0-9;]*[ -/]*[@-~]")


def frame_rows(output):
    frame = output.rsplit("\x1b[?25l\x1b[H", 1)[-1]
    return {
        int(row): splash.strip_ansi(text)
        for row, text in re.findall(r"\x1b\[(\d+);1H(.*?)\x1b\[K", frame, re.S)
    }


class MutableTTY(io.StringIO):
    def __init__(self, columns=120, rows=30):
        super().__init__()
        self.columns, self.rows = columns, rows

    def isatty(self):
        return True

    def fileno(self):
        return 91

    def get_size(self):
        return os.terminal_size((self.columns, self.rows))

    def resize(self, columns, rows):
        self.columns, self.rows = columns, rows


class FixedTelemetry:
    def __init__(self):
        self.value = {"cpu_pct": 27.0, "gpu_pct": None,
                      "gpu_status": "nvidia-smi unavailable",
                      "ram_used": 50, "ram_total": 100}

    def start(self):
        pass

    def stop(self):
        pass

    def snapshot(self):
        return dict(self.value)


class HudRenderTests(unittest.TestCase):
    def test_panel_is_centered_compact_and_gpu_unavailability_is_truthful(self):
        metrics = {"cpu_pct": 21, "gpu_pct": None,
                   "ram_used": 75, "ram_total": 100}
        rows = hud.render_header(
            120, model="model-x", endpoint="https://person:secret@example.test:8443/v1?token=x",
            mode="chat", cwd="project", branch="main", telemetry=metrics,
            terminal={"status": "idle", "focused": False}, max_rows=5)
        geometry = hud.panel_geometry(120)
        self.assertEqual(geometry["width"], 60)
        self.assertEqual(geometry["left"], 30)
        self.assertEqual(len(rows), 5)
        text = "\n".join(rows)
        self.assertIn("GPU n/a", text)
        self.assertIn("CPU 21%", text)
        self.assertIn("RAM 75%", text)
        self.assertIn("example.test:8443", text)
        self.assertNotIn("secret", text)
        self.assertNotIn("token=x", text)

    def test_narrow_panel_obeys_row_budget_and_clips(self):
        for columns in (1, 20, 40, 60):
            with self.subTest(columns=columns):
                rows = hud.render_header(
                    columns, model="very-long-model-name", endpoint="https://example.test",
                    telemetry={}, terminal=None, max_rows=3)
                self.assertLessEqual(len(rows), 3)
                for row in rows:
                    self.assertLessEqual(hud.display_width(row), columns)

    def test_windows_gpu_engine_sample_has_truthful_label(self):
        rows = hud.render_header(
            120, telemetry={"cpu_pct": 21, "gpu_pct": 12.35,
                            "gpu_metric": "3D engine utilization",
                            "ram_used": 75, "ram_total": 100})
        self.assertIn("GPU 3D 12%", "\n".join(rows))

    def test_gpu_memory_fallback_is_labeled_as_vram(self):
        rows = hud.render_header(
            120, telemetry={"cpu_pct": 21, "gpu_pct": None,
                            "gpu_memory_used": 6990,
                            "gpu_memory_total": 12244,
                            "ram_used": 75, "ram_total": 100})
        text = "\n".join(rows)
        self.assertIn("VRAM 6.8/12.0G", text)
        self.assertNotIn("GPU n/a", text)

    def test_sensitive_command_preview_is_redacted(self):
        terminal = MiniTerminal()
        terminal.focus()
        terminal.set_draft("tool --api-key sk-secret-token")
        rows = hud.render_header(120, telemetry={}, terminal=terminal)
        text = "\n".join(rows)
        self.assertNotIn("sk-secret-token", text)

    def test_display_filter_removes_c1_and_bidi_but_keeps_unicode(self):
        source = ("café e\u0301 👩\u200d💻 \u009b31mred\u009d52;clipboard\u009c "
                  "\x1b]0;fixture title\x07 hidden\u202e.txt")
        clean = safe_output(source)
        for control in ("\u009b", "\u009d", "\u009c", "\u202e", "\x1b"):
            self.assertNotIn(control, clean)
        self.assertNotIn("fixture title", clean)
        self.assertNotIn("52;clipboard", clean)
        self.assertIn("café", clean)
        self.assertIn("e\u0301", clean)
        self.assertIn("👩\u200d💻", clean)

    def test_hud_metadata_filter_preserves_ordinary_unicode(self):
        rows = hud.render_header(
            120, model="café e\u0301 👩\u200d💻\u202e.txt\u009b31m",
            telemetry={"cpu_pct": 12, "gpu_pct": None,
                       "ram_used": 2, "ram_total": 4})
        text = "\n".join(rows)
        self.assertNotIn("\u202e", text)
        self.assertNotIn("\u009b", text)
        self.assertIn("café", text)
        self.assertIn("👩\u200d💻", text)


class TelemetryTests(unittest.TestCase):
    def test_snapshot_does_not_wait_for_a_slow_gpu_probe(self):
        entered = threading.Event()

        def slow_gpu():
            entered.set()
            time.sleep(0.15)
            return {"available": False, "reason": "probe unavailable"}

        sampler = SystemTelemetry(cpu_reader=lambda: 30,
                                  ram_reader=lambda: {"used": 5, "total": 10},
                                  gpu_reader=slow_gpu)
        thread = threading.Thread(target=sampler.sample_once)
        thread.start()
        self.assertTrue(entered.wait(0.05))
        started = time.monotonic()
        sample = sampler.snapshot()
        self.assertLess(time.monotonic() - started, 0.05)
        self.assertIsNone(sample["gpu_pct"])
        thread.join(timeout=1)

    def test_fake_missing_gpu_stays_missing(self):
        sampler = SystemTelemetry(cpu_reader=lambda: 12.5,
                                  ram_reader=lambda: {"used": 3, "total": 4},
                                  gpu_reader=lambda: {"available": False,
                                                      "reason": "not installed"})
        sample = sampler.sample_once()
        self.assertEqual(sample["cpu_pct"], 12.5)
        self.assertIsNone(sample["gpu_pct"])
        self.assertEqual(sample["gpu_status"], "not installed")


class MiniTerminalTests(unittest.TestCase):
    def test_no_runner_before_submit_and_cancel_invalidates_request(self):
        mini = MiniTerminal()
        calls = []
        mini.focus()
        mini.set_draft("echo should-not-run")
        self.assertEqual(calls, [])
        request = mini.request_submit()
        self.assertIsNotNone(request)
        mini.cancel()
        self.assertFalse(mini.execute_submitted(
            request["id"], lambda command: calls.append(command)))
        self.assertEqual(calls, [])
        self.assertEqual(mini.snapshot()["status"], "cancelled")

    def test_denial_is_reported_without_running_command(self):
        mini = MiniTerminal()
        called = []
        mini.focus()
        mini.set_draft("echo approved-only")
        request = mini.request_submit()

        def runner(command):
            self.assertEqual(command, "echo approved-only")
            mini.set_status("denied")
            return "shell command denied by the user"

        self.assertFalse(mini.execute_submitted(request["id"], runner))
        self.assertEqual(called, [])
        self.assertEqual(mini.snapshot()["status"], "denied")
        self.assertEqual(mini.snapshot()["output"], "Command denied.")

    def test_only_current_submission_runs_and_result_is_bounded(self):
        mini = MiniTerminal()
        mini.focus()
        mini.set_draft("echo intentional")
        request = mini.request_submit()
        self.assertTrue(mini.execute_submitted(
            request["id"], lambda command: "ran " + command))
        snapshot = mini.snapshot()
        self.assertEqual(snapshot["status"], "complete")
        self.assertEqual(snapshot["output"], "ran echo intentional")
        self.assertFalse(snapshot["focused"])


class PinnedHudTests(unittest.TestCase):
    def setUp(self):
        self.old_layout = splash.layout_mode()
        self.old_paint = terminal.PAINT
        splash.set_layout("full")
        terminal.PAINT = terminal.Paint(False)
        self.addCleanup(splash.set_layout, self.old_layout)
        self.addCleanup(setattr, terminal, "PAINT", self.old_paint)
        self.tty = MutableTTY()
        self.client = SimpleNamespace(
            model="hud-test", base="https://user:secret@example.test:8443/v1?token=secret",
            agent=False, workpath="", session_totals={}, last_turn=None,
        )

    def make_screen(self):
        with patch.object(footer, "SystemTelemetry", FixedTelemetry):
            screen = footer.FooterScreen(self.client, self.tty, size=self.tty.get_size)
        self.addCleanup(screen.close)
        return screen

    def test_header_stays_at_top_across_stream_scroll_and_repeated_resize(self):
        screen = self.make_screen()
        screen.start()
        rows = frame_rows(self.tty.getvalue())
        self.assertEqual(screen.snapshot()["geometry"]["header_rows"], 5)
        self.assertIn("SIGNAL-REACH", rows[1])
        self.assertIn("CPU 27%", "\n".join(rows.values()))
        self.assertIn("GPU n/a", "\n".join(rows.values()))
        self.assertNotIn("secret", "\n".join(rows.values()))

        screen.set_input("draft remains", cursor=6)
        screen.write("stream-one\nstream-two\n")
        screen.scroll_lines(1)
        for size in ((80, 24), (40, 12), (120, 30), (40, 8), (120, 30)):
            self.tty.resize(*size)
            screen.flush()
            screen.write("stream-%s\n" % size[0])
            geometry = screen.snapshot()["geometry"]
            frame = frame_rows(self.tty.getvalue())
            header_height = geometry["header_rows"]
            self.assertGreaterEqual(header_height, 0)
            self.assertLessEqual(header_height, 5)
            if header_height:
                self.assertIn("SIGNAL-REACH", "\n".join(frame[row]
                                                            for row in range(1, header_height + 1)))
            self.assertEqual(screen.snapshot()["text"], "draft remains")
            self.assertEqual(screen.snapshot()["cursor"], 6)
            self.assertGreaterEqual(geometry["footer_top"], header_height)
            self.assertLessEqual(geometry["footer_top"] + geometry["footer_rows"], size[1])

    def test_chatbox_only_runs_a_deliberately_submitted_command(self):
        tty = MutableTTY(columns=100, rows=24)
        with patch.object(footer, "SystemTelemetry", FixedTelemetry):
            screen = footer.FooterScreen(self.client, tty, size=tty.get_size)
        screen.start()
        old_screen = chatbox._SCREEN
        chatbox._SCREEN = screen
        self.addCleanup(setattr, chatbox, "_SCREEN", old_screen)
        self.addCleanup(screen.close)
        ran = []
        screen.set_mini_runner(lambda command: ran.append(command) or "done")

        batches = [
            [("text", "chat draft"), ("left", ""), ("left", ""),
             ("terminal_toggle", ""), ("text", "echo abandoned"),
             ("interrupt", ""), ("terminal_toggle", ""),
             ("text", "echo deliberate"), ("enter", "")],
            [("enter", "")],
        ]

        def fake_read_line(on_change, history=(), initial="", on_scroll=None,
                           fresh=False, on_key=None, initial_cursor=None):
            editor = EditBuffer(initial, history)
            if initial_cursor is not None:
                editor.cursor = initial_cursor
            return footer_input._drive(
                editor, on_change, batches.pop(0), on_scroll, on_key)

        with patch.object(footer_input, "read_line", fake_read_line):
            submitted = chatbox.read_boxed(self.client)

        self.assertEqual(submitted, ["chat draft"])
        self.assertEqual(ran, ["echo deliberate"])
        self.assertNotIn("echo deliberate", screen.snapshot()["transcript"])
        self.assertEqual(screen.mini_terminal.snapshot()["status"], "complete")


if __name__ == "__main__":
    unittest.main()
