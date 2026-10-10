"""Offline tests for the `signalreach` command (tools/reach/command.py)."""
import contextlib
import io
import os
import sys
import tempfile
import types
import unittest
import unittest.mock
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
sys.path.insert(0, str(TOOLS))

from reach import command  # noqa: E402


def _run(fn, *a):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = fn(*a)
    return code, out.getvalue()


class UpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        (self.tmp / "tools").mkdir()
        (self.tmp / "tools" / "reach.py").write_text("")
        self.patches = [unittest.mock.patch.object(command, "CONFIG_DIR", self.tmp),
                        unittest.mock.patch.object(command, "runtime_port", lambda: 20777),
                        unittest.mock.patch.object(command, "_start_tray_if_installed", lambda: None),
                        unittest.mock.patch.object(command.time, "sleep", lambda s: None)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_already_running_starts_nothing(self):
        spawn = unittest.mock.Mock(return_value=False)
        with unittest.mock.patch.object(command, "port_open", lambda p: True), \
                unittest.mock.patch("reach.supervisor.ensure_supervisor_running", spawn):
            code, out = _run(command.up)
        self.assertEqual(code, 0)
        self.assertIn("already running on http://127.0.0.1:20777/v1", out)
        self.assertNotIn("starting", out)

    def test_starts_supervisor_like_logon_task_and_waits(self):
        state = {"calls": 0}

        def port_open(port):
            state["calls"] += 1
            return port == 20777 and state["calls"] > 3
        spawn = unittest.mock.Mock(return_value=True)
        with unittest.mock.patch.object(command, "port_open", port_open), \
                unittest.mock.patch("reach.supervisor.ensure_supervisor_running", spawn):
            code, out = _run(command.up)
        self.assertEqual(code, 0)
        spawn.assert_called_once()
        self.assertIn("✓ SignalREACH relay listening on http://127.0.0.1:20777/v1", out)

    def test_runtime_missing_is_reported(self):
        (self.tmp / "tools" / "reach.py").unlink()
        with unittest.mock.patch.object(command, "port_open", lambda p: False):
            code, out = _run(command.up)
        self.assertEqual(code, 1)
        self.assertIn("install-runtime", out)


class DispatchTests(unittest.TestCase):
    def test_no_args_is_up(self):
        with unittest.mock.patch.object(command, "up", return_value=0) as up:
            self.assertEqual(command.main([]), 0)
        up.assert_called_once()

    def test_cli_and_chat_open_reach_cli(self):
        with unittest.mock.patch.object(command, "open_cli", return_value=0) as cli:
            command.main(["cli", "ask", "hi"])
            command.main(["chat"])
        self.assertEqual(cli.call_args_list[0].args[0], ["ask", "hi"])
        self.assertEqual(cli.call_args_list[1].args[0], ["chat"])

    def test_other_commands_pass_through_to_reach_py(self):
        seen = []

        def fake_main():
            seen.append(list(sys.argv))
        with unittest.mock.patch("reach.cli.main", fake_main):
            self.assertEqual(command.main(["status"]), 0)
            command.main(["stop"])
        self.assertEqual(seen, [["signalreach", "status"], ["signalreach", "stop"]])

    def test_ctrl_c_exits_130_without_traceback(self):
        with unittest.mock.patch.object(command, "up", side_effect=KeyboardInterrupt):
            code, _ = _run(command.main, [])
        self.assertEqual(code, 130)


class ShimTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.bin = self.tmp / "bin"
        self.config = self.tmp / "cfg"
        self.src = self.tmp / "checkout" / "tools"
        (self.src / "reach_cli").mkdir(parents=True)
        for name in ("signalreach.py", "reach-cli.py"):
            (self.src / name).write_text("# " + name)
        (self.src / "reach_cli" / "chat.py").write_text("")
        self.patches = [unittest.mock.patch.object(command, "CONFIG_DIR", self.config),
                        unittest.mock.patch.object(command, "bin_dir", lambda: self.bin),
                        unittest.mock.patch.object(command, "resolve_interpreter",
                                                   lambda: "/usr/bin/python3"),
                        unittest.mock.patch.object(command, "ensure_on_path", lambda f: True)]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_targets_checkout_without_runtime(self):
        path = command.install_shim(self.src, quiet=True)
        self.assertIn(str(self.src / "signalreach.py"), path.read_text())

    def test_targets_runtime_copy_and_is_idempotent(self):
        (self.config / "tools" / "reach").mkdir(parents=True)
        first = command.install_shim(self.src, quiet=True).read_text()
        second = command.install_shim(self.src, quiet=True).read_text()
        self.assertEqual(first, second)
        self.assertIn(str(self.config / "tools" / "signalreach.py"), first)
        self.assertTrue((self.config / "tools" / "reach-cli.py").is_file())
        self.assertTrue((self.config / "tools" / "reach_cli" / "chat.py").is_file())
        self.assertEqual(len(list(self.bin.iterdir())), 1)

    def test_windows_cmd_text(self):
        with unittest.mock.patch.object(command.os, "name", "nt"):
            text = command.shim_text(r"C:\Py\python.exe", r"C:\L\SignalREACH\tools\signalreach.py")
        self.assertEqual(text, '@echo off\r\n"C:\\Py\\python.exe" '
                               '"C:\\L\\SignalREACH\\tools\\signalreach.py" %*\r\n')


class UserPathTests(unittest.TestCase):
    def test_path_contains_ignores_trailing_slash(self):
        sep = os.pathsep
        self.assertTrue(command.path_contains("/a%s/b/bin/" % sep, "/b/bin"))
        self.assertFalse(command.path_contains("/a%s/b" % sep, "/b/bin"))

    def test_windows_user_path_appended_once(self):
        store = {"Path": ("C:\\Tools", 2)}
        fake = types.SimpleNamespace(
            HKEY_CURRENT_USER=1, KEY_READ=1, KEY_SET_VALUE=2, REG_EXPAND_SZ=2,
            OpenKey=lambda *a: "key", CloseKey=lambda k: None,
            QueryValueEx=lambda k, n: store[n],
            SetValueEx=lambda k, n, r, kind, v: store.__setitem__(n, (v, kind)))
        folder = "C:\\Users\\m\\AppData\\Local\\SignalREACH\\bin"
        with unittest.mock.patch.dict(sys.modules, {"winreg": fake}), \
                unittest.mock.patch.object(command.os, "name", "nt"), \
                unittest.mock.patch.object(command.os, "pathsep", ";"), \
                unittest.mock.patch.dict(command.os.environ, {"PATH": "C:\\Tools"}), \
                unittest.mock.patch.object(command, "_norm", lambda e: e.strip().rstrip("\\").lower()), \
                unittest.mock.patch.object(command, "_broadcast_environment_change", lambda: None):
            self.assertTrue(command.ensure_on_path(folder))
            self.assertTrue(command.ensure_on_path(folder))
        self.assertEqual(store["Path"][0], "C:\\Tools;" + folder)


if __name__ == "__main__":
    unittest.main()
