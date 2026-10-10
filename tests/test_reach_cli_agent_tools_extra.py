"""Local fixtures cover real execution, approval and workspace containment."""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))
from reach_cli import agent_tools as tools
from reach_cli import agent_tools_extra as extra


class _WorkspaceFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.calls = []
        self.ctx = {"approve": lambda name, detail: self.calls.append((name, detail)) or True,
                    "todos": [], "processes": {}, "selected_tools": set()}
        self.addCleanup(extra.cleanup_owned_processes, str(self.root), self.ctx)
        (self.root / "note.txt").write_text("old old\nUnicode: \u96ea\n", encoding="utf-8")
        (self.root / "settings.json").write_text(json.dumps({"scripts": {"test": "python -m unittest"}, "api_key": "fixture-only", "nested": {"client_secret": "fixture-only"}}), encoding="utf-8")

    def run_tool(self, name, **args):
        return tools.run_tool(name, args, str(self.root), self.ctx)


class WorkspaceToolsTests(_WorkspaceFixture):
    def test_file_info_and_sha256(self):
        info = json.loads(self.run_tool("file_info", path="note.txt"))
        self.assertEqual(info["type"], "file")
        self.assertGreater(info["size_bytes"], 0)
        result = self.run_tool("hash_file", path="note.txt")
        self.assertRegex(result, r"^sha256 [a-f0-9]{64}  note.txt$")
        self.assertFalse(self.calls)

    def test_batch_read_individual_errors_and_unicode(self):
        result = self.run_tool("batch_read", paths=["note.txt", "missing.txt", "settings.json"])
        self.assertIn("\u96ea", result)
        self.assertIn("error: no such file", result)
        self.assertNotIn("fixture-only", result)
        self.assertIn("[redacted]", result)

    def test_read_json_pointer_and_redacted_valid_json(self):
        self.assertEqual(json.loads(self.run_tool("read_json", path="settings.json", pointer="/scripts/test")), "python -m unittest")
        data = json.loads(self.run_tool("read_json", path="settings.json"))
        self.assertEqual(data["api_key"], "[redacted]")
        self.assertEqual(data["nested"]["client_secret"], "[redacted]")
        self.assertIn("redacted", self.run_tool("read_json", path="settings.json", pointer="/api_key"))

    def test_read_json_escaped_keys_arrays_and_invalid_pointer(self):
        (self.root / "array.json").write_text('{"a/b":{"~name":["one","two"]}}', encoding="utf-8")
        self.assertEqual(json.loads(self.run_tool("read_json", path="array.json", pointer="/a~1b/~0name/1")), "two")
        for pointer in ("scripts", "/a~1b/~0name/-1", "/missing"):
            self.assertTrue(self.run_tool("read_json", path="array.json", pointer=pointer).startswith("error:"))

    def test_write_file_explicit_overwrite_and_expected_hash(self):
        self.assertIn("file exists", self.run_tool("write_file", path="note.txt", content="new"))
        digest = self.run_tool("hash_file", path="note.txt").split()[1]
        self.assertIn("wrote", self.run_tool("write_file", path="note.txt", content="new\n", overwrite=True, expected_sha256=digest))
        self.assertEqual((self.root / "note.txt").read_text(encoding="utf-8"), "new\n")
        self.assertIn("file changed", self.run_tool("write_file", path="note.txt", content="bad", overwrite=True, expected_sha256=digest))
        self.assertEqual(len(self.calls), 1)

    def test_write_file_rechecks_creation_during_approval(self):
        def approve(*_):
            (self.root / "new.txt").write_text("user work", encoding="utf-8")
            return True
        self.ctx["approve"] = approve
        self.assertIn("refusing overwrite", self.run_tool("write_file", path="new.txt", content="agent"))
        self.assertEqual((self.root / "new.txt").read_text(), "user work")

    def test_write_file_rechecks_expected_hash_during_approval(self):
        digest = self.run_tool("hash_file", path="note.txt").split()[1]
        def approve(*_):
            (self.root / "note.txt").write_text("user work", encoding="utf-8")
            return True
        self.ctx["approve"] = approve
        self.assertIn("changed during approval", self.run_tool("write_file", path="note.txt", content="agent", overwrite=True, expected_sha256=digest))
        self.assertEqual((self.root / "note.txt").read_text(), "user work")

    def test_write_file_atomic_create_never_overwrites_late_destination(self):
        original_write = extra._atomic_write
        def write(target, content, overwrite=True):
            Path(target).write_text("user work", encoding="utf-8")
            return original_write(target, content, overwrite=overwrite)
        with mock.patch.object(extra, "_atomic_write", side_effect=write):
            self.assertTrue(self.run_tool("write_file", path="late.txt", content="agent").startswith("error:"))
        self.assertEqual((self.root / "late.txt").read_text(), "user work")

    def test_write_json_single_approval_and_append_preserves_unicode(self):
        self.assertIn("wrote", self.run_tool("write_json", path="new.json", data={"emoji": "\u2603"}))
        self.assertEqual(self.calls[0][0], "write_json")
        self.assertEqual(json.loads((self.root / "new.json").read_text(encoding="utf-8")), {"emoji": "\u2603"})
        self.assertIn("appended", self.run_tool("append_file", path="note.txt", content="tail\n"))
        self.assertTrue((self.root / "note.txt").read_text(encoding="utf-8").endswith("tail\n"))
        self.assertEqual([name for name, _ in self.calls], ["write_json", "append_file"])

    def test_append_preserves_edits_made_during_approval(self):
        def approve(*_):
            (self.root / "note.txt").write_text("user work\n", encoding="utf-8")
            return True
        self.ctx["approve"] = approve
        self.run_tool("append_file", path="note.txt", content="tail\n")
        self.assertEqual((self.root / "note.txt").read_text(), "user work\ntail\n")

    def test_replace_all_requires_exact_count(self):
        self.assertIn("found 2", self.run_tool("replace_all", path="note.txt", search="old", replace="new", expected_count=1))
        self.assertFalse(self.calls)
        self.assertIn("replaced 2", self.run_tool("replace_all", path="note.txt", search="old", replace="new", expected_count=2))
        self.assertTrue((self.root / "note.txt").read_text(encoding="utf-8").startswith("new new"))

    def test_replace_all_rechecks_during_approval(self):
        def approve(*_):
            (self.root / "note.txt").write_text("user work", encoding="utf-8")
            return True
        self.ctx["approve"] = approve
        result = self.run_tool("replace_all", path="note.txt", search="old", replace="new", expected_count=2)
        self.assertIn("changed during approval", result)
        self.assertEqual((self.root / "note.txt").read_text(), "user work")

    def test_mkdir_copy_move_remove_regular_files_and_empty_directory(self):
        self.assertIn("created directory", self.run_tool("mkdir", path="sub/child"))
        self.assertTrue(self.run_tool("copy", source="note.txt", destination="sub/copy.txt").startswith("copied "))
        self.assertTrue(self.run_tool("move", source="sub/copy.txt", destination="sub/moved.txt").startswith("moved "))
        self.assertFalse((self.root / "sub/copy.txt").exists())
        self.assertIn("removed", self.run_tool("remove", path="sub/moved.txt"))
        self.assertIn("removed", self.run_tool("remove", path="sub/child"))
        self.assertIn("removed", self.run_tool("remove", path="sub"))
        self.assertTrue((self.root / "note.txt").exists())

    def test_remove_nonempty_directory_and_root_never_allowed(self):
        self.run_tool("mkdir", path="sub")
        (self.root / "sub/user.txt").write_text("preserve", encoding="utf-8")
        self.calls.clear()
        self.assertIn("recursive removal", self.run_tool("remove", path="sub"))
        self.assertTrue(self.run_tool("remove", path=".").startswith("error:"))
        self.assertFalse(self.calls)
        self.assertTrue((self.root / "sub/user.txt").exists())

    def test_copy_move_do_not_overwrite_existing_destinations(self):
        for name in ("copy", "move"):
            self.assertIn("destination already exists", self.run_tool(name, source="note.txt", destination="settings.json"))
        self.assertFalse(self.calls)

    def test_copy_move_exclusive_creation_preserves_late_user_destination(self):
        original_pair = extra._pair
        for name in ("copy", "move"):
            destination = name + "-late.txt"
            calls = [0]
            def pair(workpath, args):
                result = original_pair(workpath, args)
                calls[0] += 1
                if calls[0] == 2:
                    (self.root / destination).write_text("user work", encoding="utf-8")
                return result
            with mock.patch.object(extra, "_pair", side_effect=pair):
                result = self.run_tool(name, source="note.txt", destination=destination)
            self.assertTrue(result.startswith("error:"))
            self.assertEqual((self.root / destination).read_text(), "user work")
            self.assertTrue((self.root / "note.txt").exists())

    def test_compare_identical_diff_and_binary(self):
        shutil.copyfile(self.root / "note.txt", self.root / "copy.txt")
        self.assertEqual(self.run_tool("compare_files", left="note.txt", right="copy.txt"), "files are identical")
        (self.root / "copy.txt").write_text("new\n", encoding="utf-8")
        self.assertIn("--- note.txt", self.run_tool("compare_files", left="note.txt", right="copy.txt"))
        self.assertIn("SHA-256", self.run_tool("compare_files", left="note.txt", right="copy.txt", binary=True))

    def test_all_mutations_denied_leave_files_unchanged(self):
        self.ctx["approve"] = lambda *_: False
        original = (self.root / "note.txt").read_bytes()
        operations = [("write_file", {"path": "new.txt", "content": "x"}),
                      ("write_json", {"path": "new.json", "data": {}}),
                      ("append_file", {"path": "note.txt", "content": "x"}),
                      ("replace_all", {"path": "note.txt", "search": "old", "replace": "new", "expected_count": 2}),
                      ("mkdir", {"path": "new"}), ("copy", {"source": "note.txt", "destination": "copy.txt"}),
                      ("move", {"source": "note.txt", "destination": "moved.txt"}), ("remove", {"path": "note.txt"}),
                      ("edit", {"path": "note.txt", "search": "old", "replace": "new"})]
        for name, args in operations:
            with self.subTest(name=name):
                self.assertIn("denied by the user", self.run_tool(name, **args))
        self.assertEqual((self.root / "note.txt").read_bytes(), original)
        self.assertEqual(set(os.listdir(self.root)), {"note.txt", "settings.json"})

    def test_path_traversal_absolute_control_and_windows_stream_rejected(self):
        for path in ("../outside", "/outside", "C:/outside", "note.txt:stream", "x/../../outside", "bad\x00name"):
            for name, args in (("read", {"path": path}), ("file_info", {"path": path}),
                               ("write_file", {"path": path, "content": "no"}),
                               ("read_json", {"path": path}), ("mkdir", {"path": path})):
                with self.subTest(name=name, path=path):
                    self.assertTrue(self.run_tool(name, **args).startswith("error:"))
        self.assertFalse(self.calls)

    def test_invalid_old_scope_and_glob_pattern_are_errors(self):
        for name, args in (("list", {"path": "../outside"}), ("search", {"pattern": "x", "path": "../outside"}),
                           ("glob", {"pattern": "../*.txt"}), ("glob", {"pattern": "C:/outside/*"})):
            self.assertTrue(self.run_tool(name, **args).startswith("error:"))

    def test_glob_patterns_preserve_recursive_scoped_and_hidden_semantics(self):
        (self.root / "sub").mkdir()
        (self.root / "sub/child.txt").write_text("child", encoding="utf-8")
        (self.root / ".hidden.txt").write_text("hidden", encoding="utf-8")
        self.assertEqual(self.run_tool("glob", pattern="*.txt"), "note.txt")
        self.assertEqual(self.run_tool("glob", pattern="**/*.txt"), "note.txt\nsub/child.txt")
        self.assertEqual(self.run_tool("glob", pattern="*.txt", path="sub"), "sub/child.txt")
        self.assertEqual(self.run_tool("glob", pattern=".hidden*"), ".hidden.txt")

    def test_directory_reparse_points_never_traversed_by_glob_list_search(self):
        (self.root / "link").mkdir()
        (self.root / "link/hidden.txt").write_text("fixture sentinel", encoding="utf-8")
        original = tools.os.lstat
        def linked(path, *args, **kwargs):
            result = original(path, *args, **kwargs)
            if os.path.basename(path) == "link":
                return mock.Mock(st_file_attributes=0x400, st_mode=result.st_mode)
            return result
        with mock.patch.object(tools.os, "lstat", side_effect=linked):
            self.assertNotIn("hidden.txt", self.run_tool("glob", pattern="**/*.txt"))
            self.assertNotIn("fixture sentinel", self.run_tool("search", pattern="sentinel"))
            self.assertNotIn("hidden.txt", self.run_tool("list"))

    def test_symlink_escape_rejected_and_never_read_or_written(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        (Path(outside.name) / "outside.txt").write_text("outside sentinel", encoding="utf-8")
        try:
            os.symlink(outside.name, self.root / "link", target_is_directory=True)
        except OSError as exc:
            if os.name == "nt" and getattr(exc, "winerror", None) == 1314:
                self.skipTest("Windows symlink privilege is unavailable")
            raise
        for name, args in (("read", {"path": "link/outside.txt"}), ("batch_read", {"paths": ["link/outside.txt"]}),
                           ("write_file", {"path": "link/new.txt", "content": "no"}),
                           ("copy", {"source": "note.txt", "destination": "link/new.txt"}),
                           ("move", {"source": "link/outside.txt", "destination": "moved.txt"}),
                           ("edit", {"path": "link/outside.txt", "search": "outside", "replace": "wrong"})):
            with self.subTest(name=name):
                self.assertIn("error:", self.run_tool(name, **args))
        self.assertNotIn("outside sentinel", self.run_tool("search", pattern="sentinel"))
        self.assertNotIn("outside.txt", self.run_tool("glob", pattern="**/*.txt"))
        self.assertEqual((Path(outside.name) / "outside.txt").read_text(), "outside sentinel")
        self.assertFalse((Path(outside.name) / "new.txt").exists())

    def test_terminal_controls_and_fixture_credentials_redacted(self):
        text = '\x1b[2J\x1b]0;bad\x07Authorization: Bearer fixture-only\nAPI_KEY="fixture-only"\nMY_SECRET=fixture-only\nhttps://user:fixture-only@example.test/?api_key=fixture-only&ok=1'
        result = extra.safe_text(text)
        self.assertNotIn("\x1b", result)
        self.assertNotIn("fixture-only", result)
        self.assertIn("[redacted]", result)
        self.assertIn("ok=1", result)
        self.assertNotIn("\u202e", extra.safe_text("visible\u202ehidden"))

    def test_dotenv_all_values_redacted_in_read_search_and_batch(self):
        (self.root / ".env").write_text("CUSTOM_NAME=fixture-only\nAPI_KEY=fixture-only\n", encoding="utf-8")
        for name, args in (("read", {"path": ".env"}), ("search", {"pattern": "fixture", "path": ".env"}),
                           ("batch_read", {"paths": [".env"]})):
            self.assertNotIn("fixture-only", self.run_tool(name, **args))

    def test_bounded_text_and_output(self):
        (self.root / "large.txt").write_text("x" * (extra.FILE_LIMIT + 1), encoding="utf-8")
        self.assertIn("2 MiB", self.run_tool("read", path="large.txt"))
        self.assertIn("2 MiB", self.run_tool("batch_read", paths=["large.txt"]))
        result = extra.safe_text("x" * 50000)
        self.assertLess(len(result), 40100)
        self.assertIn("truncated", result)


class OwnedExecutionTests(_WorkspaceFixture):
    def command(self, code):
        return [sys.executable, "-u", "-c", code]

    def test_run_command_executes_without_shell_interpolation_and_redacts(self):
        result = self.run_tool("run_command", argv=self.command("import sys; print(sys.argv[1]); print('API_KEY=fixture-only')") + ["literal; & $(text)"], timeout=5)
        self.assertIn("exit code 0", result)
        self.assertIn("literal; & $(text)", result)
        self.assertNotIn("fixture-only", result)
        self.assertEqual([name for name, _ in self.calls], ["run_command"])

    def test_run_command_denied_does_not_start_child(self):
        self.ctx["approve"] = lambda *_: False
        with mock.patch.object(extra.subprocess, "Popen", side_effect=AssertionError("unapproved execution")):
            self.assertIn("denied", self.run_tool("run_command", argv=self.command("pass")))
            self.assertIn("denied", self.run_tool("process_start", argv=self.command("pass")))

    def test_credential_flag_pairs_are_redacted_in_approval_not_changed_in_argv(self):
        argv = self.command("import sys; print(len(sys.argv))") + ["--api-key", "fixture-only", "--token=fixture-only"]
        self.assertIn("exit code 0", self.run_tool("run_command", argv=argv, timeout=5))
        self.assertNotIn("fixture-only", self.calls[0][1])
        self.assertIn("[redacted]", self.calls[0][1])
        self.assertEqual(argv[-2:], ["fixture-only", "--token=fixture-only"])

    def test_run_command_nonzero_error_timeout_and_validation(self):
        self.assertIn("exit code 3", self.run_tool("run_command", argv=self.command("raise SystemExit(3)"), timeout=5))
        started = time.monotonic()
        self.assertIn("timed out", self.run_tool("run_command", argv=self.command("import time; time.sleep(10)"), timeout=0.05))
        self.assertLess(time.monotonic() - started, 3)
        for args in ({"argv": "echo x"}, {"argv": []}, {"argv": ["bad\x00"]},
                     {"argv": self.command("pass"), "timeout": 181}, {"argv": self.command("pass"), "cwd": "../outside"}):
            self.assertTrue(self.run_tool("run_command", **args).startswith("error:"))

    def test_process_lifecycle_owned_only_and_bounded_output(self):
        started = json.loads(self.run_tool("process_start", argv=self.command("import time; print('ready', flush=True); print('x'*100000, flush=True); time.sleep(10)")))
        handle = started["handle"]
        self.assertTrue(handle.startswith("proc-"))
        for _ in range(100):
            item = self.ctx["processes"][handle]
            with item.lock:
                enough = item.dropped > 0
            if enough:
                break
            time.sleep(0.01)
        self.assertTrue(enough)
        status = json.loads(self.run_tool("process_poll", handle=handle))
        self.assertTrue(status["running"])
        self.assertGreater(status["discarded_characters"], 0)
        self.assertLessEqual(status["output_characters"], extra.PROCESS_BUFFER)
        self.assertEqual(len(json.loads(self.run_tool("process_list"))), 1)
        self.assertLess(len(self.run_tool("process_output", handle=handle)), 40100)
        self.assertIn("stopped owned process", self.run_tool("process_stop", handle=handle))
        self.assertFalse(json.loads(self.run_tool("process_poll", handle=handle))["running"])

    def test_process_natural_completion_and_nonblocking_poll(self):
        handle = json.loads(self.run_tool("process_start", argv=self.command("print('done')")))["handle"]
        status = json.loads(self.run_tool("process_poll", handle=handle, wait_seconds=2))
        self.assertFalse(status["running"])
        self.assertEqual(status["exit_code"], 0)
        self.ctx["processes"][handle].reader.join(timeout=1)
        self.assertIn("done", self.run_tool("process_output", handle=handle))
        self.assertTrue(self.run_tool("process_poll", handle=handle, wait_seconds=3).startswith("error:"))

    def test_arbitrary_pid_unknown_handle_and_other_workpath_rejected(self):
        for name in ("process_poll", "process_output", "process_stop"):
            self.assertIn("arbitrary PIDs", self.run_tool(name, handle=str(os.getpid())))
        handle = json.loads(self.run_tool("process_start", argv=self.command("import time; time.sleep(10)")))["handle"]
        with tempfile.TemporaryDirectory() as unrelated:
            result = tools.run_tool("process_stop", {"handle": handle}, unrelated, self.ctx)
        self.assertIn("different workpath", result)
        self.assertTrue(self.ctx["processes"][handle].process.poll() is None)

    def test_owned_stop_denial_and_cleanup_do_not_affect_unrelated_process(self):
        unrelated = subprocess.Popen(self.command("import time; time.sleep(10)"), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(lambda: unrelated.poll() is None and unrelated.terminate())
        self.addCleanup(lambda: unrelated.wait(timeout=3))
        handle = json.loads(self.run_tool("process_start", argv=self.command("import time; time.sleep(10)")))["handle"]
        self.ctx["approve"] = lambda *_: False
        self.assertIn("denied", self.run_tool("process_stop", handle=handle))
        self.assertIsNone(self.ctx["processes"][handle].process.poll())
        self.assertEqual(extra.cleanup_owned_processes(str(self.root), self.ctx), [])
        self.assertFalse(self.ctx["processes"])
        self.assertIsNone(unrelated.poll())
        unrelated.terminate()
        unrelated.wait(timeout=3)

    def test_keyboard_interrupt_cleans_owned_command_and_propagates(self):
        instance = mock.Mock()
        instance.process.wait.side_effect = KeyboardInterrupt
        with mock.patch.object(extra, "_OwnedProcess", return_value=instance):
            with self.assertRaises(KeyboardInterrupt):
                self.run_tool("run_command", argv=self.command("pass"))
        instance.stop.assert_called_once()

    def test_process_stdin_is_disabled(self):
        result = self.run_tool("run_command", argv=self.command("import sys; print(repr(sys.stdin.read()))"), timeout=5)
        self.assertIn("''", result)

    def test_session_exit_cleans_owned_process_from_prior_workpath(self):
        handle = json.loads(self.run_tool("process_start", argv=self.command("import time; time.sleep(10)")))["handle"]
        item = self.ctx["processes"][handle]
        with tempfile.TemporaryDirectory() as next_workpath:
            self.assertEqual(extra.cleanup_owned_processes(next_workpath, self.ctx), [])
        self.assertFalse(self.ctx["processes"])
        self.assertIsNotNone(item.process.poll())

    def test_parent_exit_does_not_release_owned_descendants_before_stop(self):
        child_code = "import time; from pathlib import Path; time.sleep(0.7); Path('late-marker.txt').write_text('wrong')"
        parent_code = "import subprocess,sys; subprocess.Popen([sys.executable,'-c',%r]); print('parent done',flush=True)" % child_code
        handle = json.loads(self.run_tool("process_start", argv=self.command(parent_code)))["handle"]
        status = json.loads(self.run_tool("process_poll", handle=handle, wait_seconds=2))
        self.assertFalse(status["running"])
        self.assertIn("stopped owned process", self.run_tool("process_stop", handle=handle))
        time.sleep(0.8)
        self.assertFalse((self.root / "late-marker.txt").exists())

    def test_run_command_cleanup_stops_descendants_after_parent_exits(self):
        child_code = "import time; from pathlib import Path; time.sleep(0.5); Path('late-marker.txt').write_text('wrong')"
        parent_code = "import subprocess,sys; subprocess.Popen([sys.executable,'-c',%r]); print('parent done',flush=True)" % child_code
        result = self.run_tool("run_command", argv=self.command(parent_code), timeout=5)
        self.assertIn("exit code 0", result)
        time.sleep(0.6)
        self.assertFalse((self.root / "late-marker.txt").exists())

    @unittest.skipUnless(os.name == "nt", "Windows private-job gate")
    def test_windows_target_never_runs_if_job_containment_fails(self):
        with mock.patch.object(extra, "_WindowsJob", side_effect=OSError("fixture job denied")):
            result = self.run_tool("run_command", argv=self.command("from pathlib import Path; Path('must-not-run.txt').write_text('wrong')"))
        self.assertIn("error: fixture job denied", result)
        self.assertFalse((self.root / "must-not-run.txt").exists())

    @unittest.skipUnless(os.name == "nt", "Mock POSIX ownership from Windows")
    def test_posix_waitid_records_completion_without_reaping(self):
        process = object.__new__(extra._OwnedPosixProcess)
        process.returncode, process.pid, process.reaped, process.args = None, 12345, False, ["owned"]
        info = mock.Mock(si_code=1, si_status=7)
        with mock.patch.object(extra.os, "waitid", return_value=info, create=True) as waitid, \
             mock.patch.object(extra.os, "P_PID", 1, create=True), \
             mock.patch.object(extra.os, "WEXITED", 4, create=True), \
             mock.patch.object(extra.os, "WNOHANG", 1, create=True), \
             mock.patch.object(extra.os, "WNOWAIT", 0x1000000, create=True), \
             mock.patch.object(extra.os, "CLD_EXITED", 1, create=True), \
             mock.patch.object(extra.os, "waitpid", return_value=(12345, 7), create=True) as waitpid:
            self.assertEqual(process.poll(), 7)
            waitid.assert_called_once_with(1, 12345, 0x1000005)
            waitpid.assert_not_called()
            self.assertEqual(process.wait(timeout=0), 7)
            process.reap()
            process.reap()
            waitpid.assert_called_once_with(12345, 0)
            self.assertTrue(process.reaped)


class GitInspectionTests(_WorkspaceFixture):
    def setUp(self):
        super().setUp()
        if not shutil.which("git"):
            self.skipTest("Git is not available")
        def git(*args):
            done = subprocess.run(["git", *args], cwd=str(self.root), stdin=subprocess.DEVNULL, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr)
        self.git = git
        git("init", "-q")
        git("add", "note.txt")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture commit")

    def test_all_six_git_inspections_use_local_repo_without_approval(self):
        self.assertIn("settings.json", self.run_tool("git_status"))
        self.assertIn("fixture commit", self.run_tool("git_log", count=3))
        self.assertIn("old old", self.run_tool("git_show", revision="HEAD", path="note.txt"))
        self.assertIn("fixture commit", self.run_tool("git_branches"))
        self.assertIn("Fixture", self.run_tool("git_blame", path="note.txt", start_line=1, end_line=2))
        (self.root / "note.txt").write_text("changed\n", encoding="utf-8")
        self.assertIn("+changed", self.run_tool("git_diff", path="note.txt"))
        self.assertFalse(self.calls)

    def test_git_inspection_does_not_change_index_or_worktree(self):
        original = (self.root / ".git/index").read_bytes()
        before = (self.root / "note.txt").read_bytes()
        self.run_tool("git_status")
        self.run_tool("git_diff")
        self.run_tool("git_log")
        self.assertEqual((self.root / ".git/index").read_bytes(), original)
        self.assertEqual((self.root / "note.txt").read_bytes(), before)

    def test_git_option_injection_path_escape_and_limits_rejected(self):
        for name, args in (("git_show", {"revision": "--output=outside"}),
                           ("git_diff", {"revision": "--ext-diff"}),
                           ("git_log", {"count": 51}), ("git_show", {"path": "../outside"}),
                           ("git_blame", {"path": "note.txt", "end_line": 1000})):
            self.assertTrue(self.run_tool(name, **args).startswith("error:"))

    def test_git_missing_or_not_repo_has_actionable_error(self):
        with mock.patch.object(extra.subprocess, "run", side_effect=FileNotFoundError):
            self.assertIn("Git is not installed", self.run_tool("git_status"))
        with tempfile.TemporaryDirectory() as empty:
            result = tools.run_tool("git_status", {}, empty, self.ctx)
        self.assertTrue(result.startswith("error:"))
        self.assertIn("Git inspection failed", result)


if __name__ == "__main__":
    unittest.main()
