"""Offline persistence regressions using synthetic conversations and provider stubs."""

import argparse
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock
import uuid

TOOLS = Path(__file__).resolve().parents[1] / "tools"
sys.path.insert(0, str(TOOLS))
from reach_cli import chat, session, state, terminal
from reach_cli.client import ReachClient
from reach_cli.commands import ReplSession


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "config.json"
        self.directory = self.root / "sessions"
        self.env = mock.patch.dict(os.environ, {
            "REACH_CLI_CONFIG": str(self.config), "REACH_CLI_STATE_DIR": str(self.directory),
            "REACH_CLI_HISTORY": str(self.root / "history")})
        self.env.start()
        self.addCleanup(self.env.stop)
        self.output = io.StringIO()
        redirect = contextlib.redirect_stdout(self.output)
        redirect.__enter__()
        self.addCleanup(redirect.__exit__, None, None, None)

    def client(self):
        client = ReachClient("http://127.0.0.1:20777/v1", key="fixture-private-key")
        client.workpath = str(self.root)
        client.endpoint_name = "local"
        return client

    def save(self, client=None, messages=None, status="idle", scope=None):
        client = client or self.client()
        store = state.ConversationStore(client, new=True)
        repl = ReplSession()
        repl.remember("synthetic question")
        histories = {scope: messages if messages is not None else [
            {"role": "user", "content": "synthetic question"},
            {"role": "assistant", "content": "synthetic answer"}]}
        self.assertTrue(store.checkpoint(histories, {}, repl, scope, status))
        return store, histories, repl

    def read(self, store):
        return json.loads(Path(store.path).read_text(encoding="utf-8"))

    def test_text_preferences_and_retry_restore_without_execution_or_permissions(self):
        client = self.client()
        client.agent = True
        client.no_stream = True
        client.system = "synthetic system"
        client.auto_approve = True
        client.processes = {"danger": "never serialize"}
        first, _, _ = self.save(client)
        fresh = self.client()
        second = state.ConversationStore(fresh)
        second.apply_preferences(argparse.Namespace(agent=False, no_stream=False, system=None))
        histories, scoped, repl = {}, {}, ReplSession()
        with mock.patch.object(ReachClient, "chat", side_effect=AssertionError("paid request")), \
                mock.patch.object(chat, "run_tool", side_effect=AssertionError("execution")):
            self.assertTrue(second.restore(histories, scoped, repl))
        self.assertEqual(histories[None][-1]["content"], "synthetic answer")
        self.assertEqual(repl.last_prompt, "synthetic question")
        self.assertTrue(fresh.agent)
        self.assertTrue(fresh.no_stream)
        self.assertEqual(fresh.system, "synthetic system")
        self.assertNotIn("auto_approve", self.read(first))
        self.assertNotIn("processes", self.read(first))
        self.assertFalse(chat.AgentState().auto_approve)
        self.assertEqual(chat.AgentState().processes, {})

    def test_restored_permission_policy_requires_new_explicit_session_choice(self):
        from reach_cli import settings
        self.config.write_text(json.dumps({"settings": {"conversation": {
            "approvals": "auto-all", "reviewEdits": False}}}))
        self.save()
        client = self.client()
        state.ConversationStore(client).apply_preferences()
        self.assertEqual(client.cli_settings["conversation"]["approvals"], "prompt")
        self.assertTrue(client.cli_settings["conversation"]["reviewEdits"])
        settings.save_cli_settings(client, "budgets", {"maxRounds": 3})
        self.assertEqual(client.cli_settings["conversation"]["approvals"], "prompt")
        settings.save_cli_settings(client, "conversation", {"approvals": "auto-all"})
        self.assertEqual(client.cli_settings["conversation"]["approvals"], "auto-all")
        fresh = self.client()
        state.ConversationStore(fresh, new=True).apply_preferences()
        self.assertEqual(fresh.cli_settings["conversation"]["approvals"], "prompt")

    def test_oversized_checkpoint_keeps_the_last_good_file(self):
        store, histories, repl = self.save()
        before = Path(store.path).read_bytes()
        with mock.patch.object(state, "MAX_BYTES", 10):
            self.assertFalse(store.checkpoint(histories, {}, repl))
        self.assertEqual(Path(store.path).read_bytes(), before)

    def test_explicit_preferences_win(self):
        self.save()
        fresh = self.client()
        fresh.agent, fresh.no_stream, fresh.system = True, True, "explicit system"
        store = state.ConversationStore(fresh)
        store.apply_preferences(argparse.Namespace(agent=True, no_stream=True, system="explicit system"))
        self.assertTrue(fresh.agent)
        self.assertTrue(fresh.no_stream)
        self.assertEqual(fresh.system, "explicit system")

    def test_missing_corrupt_future_and_old_state(self):
        self.assertIsNone(state.load_last_state())
        store, _, _ = self.save()
        older = self.read(store)
        older.pop("version")
        older["history"] = older.pop("conversations")[0]["messages"]
        Path(store.path).write_text(json.dumps(older), encoding="utf-8")
        corrupt = self.directory / (uuid.uuid4().hex + ".json")
        corrupt.write_text("{broken", encoding="utf-8")
        future = self.directory / (uuid.uuid4().hex + ".json")
        future.write_text(json.dumps({**older, "version": 99, "updated_ns": time.time_ns()}), encoding="utf-8")
        self.assertEqual(state.load_last_state()["conversations"][0]["messages"][-1]["content"], "synthetic answer")
        self.assertEqual(corrupt.read_text(), "{broken")
        self.assertEqual(json.loads(future.read_text())["version"], 99)
        Path(store.path).write_text("[]", encoding="utf-8")
        self.assertIsNone(state.load_last_state())

    def test_interrupted_response_keeps_partial_but_no_tool_control(self):
        store, _, _ = self.save(status="running", messages=[{"role": "user", "content": "synthetic question"}])
        store.partial("partial answer\n```tool\n{\"name\":\"shell\",\"args\":{\"command\":\"never run\"}}\n```", final=True)
        histories, repl = {}, ReplSession()
        restored = state.ConversationStore(self.client())
        self.assertTrue(restored.restore(histories, {}, repl))
        self.assertIn("partial answer", str(histories))
        self.assertNotIn("never run", str(histories))
        self.assertIn("Interrupted activity", str(histories))
        store.partial("before cut\n```tool\n{unfinished", final=True)
        self.assertEqual(state.load_last_state()["activity"]["partial"], "before cut")

    def test_secrets_tools_system_and_pending_controls_are_omitted(self):
        client = self.client()
        messages = [
            {"role": "system", "content": "private Studio context"},
            {"role": "user", "content": "say fixture-private-key and token=fixture-token"},
            {"role": "assistant", "content": "answer", "tool_calls": [{"danger": "pending"}]},
            {"role": "tool", "content": "RAW_SECRET_TOOL_OUTPUT"},
            {"role": "user", "content": "[tool result] RAW_SECRET_TOOL_OUTPUT"},
            {"role": "user", "content": "[run control] do more"}]
        store, _, _ = self.save(client, messages)
        store.partial("fixture-priv", final=True)
        saved = Path(store.path).read_text(encoding="utf-8")
        for excluded in ("fixture-private-key", "fixture-token", "RAW_SECRET_TOOL_OUTPUT", "private Studio", "tool_calls", "fixture-priv"):
            self.assertNotIn(excluded, saved)

    def test_atomic_write_failure_preserves_previous_checkpoint(self):
        store, histories, repl = self.save()
        before = Path(store.path).read_bytes()
        histories[None].append({"role": "user", "content": "next question"})
        with mock.patch.object(session.os, "replace", side_effect=PermissionError("fixture")):
            self.assertFalse(store.checkpoint(histories, {}, repl))
        self.assertEqual(Path(store.path).read_bytes(), before)
        self.assertEqual(list(self.directory.glob("*.tmp")), [])

    def test_custom_system_and_both_retry_contexts_redact_known_secrets(self):
        client = self.client()
        secret = "synthetic-environment-secret-value"
        prose = "ordinary text fixture-private-key %s token=synthetic-field-token" % secret
        client.system = prose + " password=synthetic-password"
        repl, addressed = ReplSession(), ReplSession()
        repl.remember(prose)
        addressed.remember(prose)
        scope = ("persona", "redaction-fixture")
        histories = {None: [{"role": "user", "content": prose}],
                     scope: [{"role": "assistant", "content": prose}]}
        with mock.patch.dict(os.environ, {"SYNTHETIC_API_TOKEN": secret}):
            store = state.ConversationStore(client, new=True)
            self.assertTrue(store.checkpoint(histories, {scope: addressed}, repl))
            saved = self.read(store)
            raw = Path(store.path).read_text(encoding="utf-8")
            for value in (client.key, secret, "synthetic-field-token", "synthetic-password"):
                self.assertNotIn(value, raw)
            for value in (saved["preferences"]["system"], saved["last_prompt"],
                          saved["conversations"][1]["last_prompt"]):
                self.assertIn("ordinary text", value)
                self.assertIn("[redacted]", value)

    def test_clear_and_new_session_save_empty_and_do_not_resurrect_previous_text(self):
        self.save()
        fresh = self.client()
        store = state.ConversationStore(fresh)
        histories, repl = {}, ReplSession()
        store.restore(histories, {}, repl)
        terminal.handle_slash("/clear", fresh, histories[None], repl)
        self.assertTrue(store.checkpoint(histories, {}, repl))
        self.assertEqual(state.load_last_state()["conversations"][0]["messages"], [])
        self.assertEqual(state.load_last_state()["last_prompt"], "")
        self.save()
        empty = state.ConversationStore(self.client(), new=True)
        self.assertIsNone(empty.restored)
        self.assertTrue(empty.checkpoint({None: []}, {}, ReplSession()))
        self.assertEqual(state.load_last_state()["conversations"][0]["messages"], [])

    def test_scopes_and_workspaces_stay_separate(self):
        store, _, _ = self.save(scope=("persona", "synthetic-id"))
        histories, scoped, repl = {}, {}, ReplSession()
        self.assertTrue(state.ConversationStore(self.client()).restore(histories, scoped, repl))
        self.assertIn(("persona", "synthetic-id"), histories)
        self.assertNotIn(None, histories)
        self.assertIsNone(state.load_last_state(workpath=str(self.root / "other")))

    def test_unavailable_model_fallback_offline_and_explicit_override(self):
        client = self.client()
        client.model = client._restored_model = "gone"
        self.assertFalse(state.validate_restored_model(client, {"status": "error", "models": []}))
        self.assertEqual(client.model, "gone")
        self.assertFalse(state.validate_restored_model(client, {"status": "ready", "stale": True, "models": ["new"]}))
        self.assertTrue(state.validate_restored_model(client, {"status": "ready", "models": ["new"]}))
        self.assertIsNone(client.model)
        client.endpoint_name = "custom"
        client.model = client._restored_model = "gone"
        self.assertTrue(state.validate_restored_model(client, {"status": "ready", "models": ["first", "second"]}))
        self.assertEqual(client.model, "first")
        client.model = client._restored_model = "gone"
        self.assertTrue(state.validate_restored_model(client, {"status": "ready", "models": []}))
        self.assertTrue(client._restored_model_blocked)
        client.model = "explicit"
        self.assertFalse(state.validate_restored_model(client, {"status": "ready", "models": ["new"]}))
        self.assertEqual(client.model, "explicit")

    def test_concurrent_windows_fork_and_old_window_exit_does_not_steal_latest(self):
        first, histories, repl = self.save()
        second = state.ConversationStore(self.client())
        other, other_repl = {}, ReplSession()
        second.restore(other, {}, other_repl)
        other[None].append({"role": "user", "content": "second window"})
        second.checkpoint(other, {}, other_repl)
        first.checkpoint(histories, {}, repl, activity=False)
        self.assertNotEqual(first.path, second.path)
        self.assertEqual(state.load_last_state()["conversations"][0]["messages"][-1]["content"], "second window")
        self.assertNotIn("second window", Path(first.path).read_text())

    def test_concurrent_configuration_updates_merge_and_process_exit_releases_lock(self):
        code = """import sys, time
from reach_cli import endpoints, session
for n in range(6):
    endpoints.add_custom(sys.argv[1] + str(n), 'http://127.0.0.1:9999/v1')
    session.save_session_config(theme='default')
"""
        env = dict(os.environ, PYTHONPATH=str(TOOLS))
        workers = [subprocess.Popen([sys.executable, "-c", code, prefix], env=env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE) for prefix in ("a", "b", "c")]
        try:
            for worker in workers:
                stdout, stderr = worker.communicate(timeout=20)
                self.assertEqual(worker.returncode, 0, stderr.decode())
        finally:
            for worker in workers:
                if worker.poll() is None:
                    worker.kill()
                    worker.wait()
        config = json.loads(self.config.read_text())
        self.assertEqual(len(config["custom_endpoints"]), 18)
        self.assertEqual(config["theme"], "default")
        lock_code = "from reach_cli.config_lock import file_lock; import os;\nwith file_lock(%r): os._exit(0)" % str(self.config)
        subprocess.run([sys.executable, "-c", lock_code], env=env, check=True, timeout=10)
        self.assertTrue(session.save_session_config(model="after-crash"))

    def test_actual_loop_restores_passively_then_next_user_turn_uses_history(self):
        self.save()
        client = self.client()
        client.conversation_store = state.ConversationStore(client)
        with mock.patch.object(chat, "banner"), mock.patch.object(chat, "endpoint_notice"), \
                mock.patch.object(chat, "read_user_line", return_value=None), \
                mock.patch.object(chat, "stream_reply", side_effect=AssertionError("auto request")), \
                mock.patch.object(chat, "run_tool", side_effect=AssertionError("auto tool")):
            chat._run_chat_loop(client, client.base)
        self.assertIn("synthetic answer", self.output.getvalue())
        held = []
        def reply(_client, messages, full=False):
            held.extend(messages)
            return True, {"content": "next answer", "stopped": False}
        client = self.client()
        client.conversation_store = state.ConversationStore(client)
        with mock.patch.object(chat, "banner"), mock.patch.object(chat, "endpoint_notice"), \
                mock.patch.object(chat, "print_footer"), \
                mock.patch.object(chat, "read_user_line", side_effect=["next question", None]), \
                mock.patch.object(chat, "stream_reply", side_effect=reply):
            chat._run_chat_loop(client, client.base)
        self.assertEqual([m["content"] for m in held if m["role"] == "user"], ["synthetic question", "next question"])
        self.assertEqual(state.load_last_state()["conversations"][0]["messages"][-1]["content"], "next answer")

    def test_stream_callbacks_checkpoint_partial_and_flush_nonstream_answer(self):
        client = self.client()
        store, _, _ = self.save(client, status="running")
        client.conversation_store = store
        def request(_client, _messages, **kwargs):
            kwargs["on_text"]("streamed text")
            return True, {"content": "streamed text complete", "stopped": True}
        with mock.patch.object(chat, "request_reply", side_effect=request), \
                mock.patch.object(chat, "_interruptible", side_effect=lambda fn: fn()), \
                mock.patch.object(chat, "WaitIndicator"), mock.patch.object(chat.render, "enabled", return_value=False):
            chat.stream_reply(client, [], full=True)
        self.assertEqual(state.load_last_state()["activity"]["partial"], "streamed text complete")

    def test_abrupt_process_exit_recovers_checkpoint_without_resuming(self):
        code = """import os, sys
from reach_cli.client import ReachClient
from reach_cli.terminal import ReplSession
from reach_cli.state import ConversationStore
c = ReachClient('http://127.0.0.1:20777/v1'); c.workpath = sys.argv[1]
s = ConversationStore(c, new=True)
s.checkpoint({None: [{'role':'user','content':'abrupt synthetic question'}]}, {}, ReplSession(), status='running')
s.partial('abrupt partial answer', final=True)
os._exit(0)
"""
        subprocess.run([sys.executable, "-c", code, str(self.root)],
                       env=dict(os.environ, PYTHONPATH=str(TOOLS)), check=True, timeout=10)
        histories = {}
        with mock.patch.object(chat, "run_tool", side_effect=AssertionError("execution")):
            state.ConversationStore(self.client()).restore(histories, {}, ReplSession())
        self.assertIn("abrupt partial answer", str(histories))
        self.assertIn("Interrupted activity", str(histories))

    def test_entrypoint_automatically_restores_and_flags_override(self):
        from reach_cli import __main__ as entry
        self.config.write_text(json.dumps({"endpoint": "http://127.0.0.1:20777/v1", "endpoint_name": "local",
                                          "model": "saved-model", "workpath": str(self.root)}))
        self.save()
        held = []
        with mock.patch.object(entry, "run_chat", side_effect=lambda client, base: held.append(client)), \
                mock.patch.object(entry, "run_ask", return_value=True), \
                mock.patch.object(entry.ReachClient, "_reachable", return_value=True), \
                mock.patch.object(entry, "_paint_enabled", return_value=False):
            self.assertEqual(entry.main(["chat"]), 0)
            self.assertEqual(entry.main(["chat", "--new-session", "--model", "explicit-model"]), 0)
        self.assertEqual(held[0].model, "saved-model")
        self.assertEqual(held[0].workpath, str(self.root))
        self.assertIsNotNone(held[0].conversation_store.restored)
        self.assertEqual(held[1].model, "explicit-model")
        self.assertIsNone(held[1].conversation_store.restored)

    def test_loop_clear_after_interruption_and_idle_exit_order(self):
        client = self.client()
        client.conversation_store = state.ConversationStore(client, new=True)
        with mock.patch.object(chat, "banner"), mock.patch.object(chat, "endpoint_notice"), \
                mock.patch.object(chat, "read_user_line", side_effect=["question", "/clear", None]), \
                mock.patch.object(chat, "stream_reply", return_value=(True, {"content": "partial", "stopped": True})):
            chat._run_chat_loop(client, client.base)
        saved = state.load_last_state()
        self.assertEqual(saved["activity"]["status"], "idle")
        self.assertEqual(saved["conversations"][0]["messages"], [])
        first, histories, repl = self.save()
        newer, _, _ = self.save(messages=[{"role": "user", "content": "newer window"}])
        client.conversation_store = first
        with mock.patch.object(chat, "banner"), mock.patch.object(chat, "endpoint_notice"), \
                mock.patch.object(chat, "read_user_line", return_value="/exit"):
            chat._run_chat_loop(client, client.base)
        self.assertEqual(state.load_last_state()["conversations"][0]["messages"][-1]["content"], "newer window")

    def test_explicit_different_endpoint_clears_previous_model_for_next_launch(self):
        from reach_cli import __main__ as entry
        self.config.write_text(json.dumps({"endpoint_name": "local", "endpoint": "local", "model": "previous-model"}))
        with mock.patch.object(entry, "run_chat") as run, \
                mock.patch("reach_cli.picker.available", return_value=False):
            self.assertEqual(entry.main(["chat", "--base", "http://127.0.0.1:9999/v1"]), 0)
        self.assertIsNone(run.call_args.args[0].model)
        self.assertNotIn("model", json.loads(self.config.read_text()))

    def test_stream_exception_preserves_received_partial(self):
        client = self.client()
        store = client.conversation_store = state.ConversationStore(client, new=True)
        def broken_reply(_client, _messages, **kwargs):
            store.partial("partial before error", final=True)
            raise RuntimeError("synthetic stream failure")
        with mock.patch.object(chat, "banner"), mock.patch.object(chat, "endpoint_notice"), \
                mock.patch.object(chat, "read_user_line", side_effect=["question", None]), \
                mock.patch.object(chat, "stream_reply", side_effect=broken_reply):
            chat._run_chat_loop(client, client.base)
        saved = state.load_last_state()
        self.assertEqual(saved["conversations"][0]["messages"][-1]["content"], "partial before error")
        self.assertEqual(saved["activity"]["status"], "interrupted")


if __name__ == "__main__":
    unittest.main()
