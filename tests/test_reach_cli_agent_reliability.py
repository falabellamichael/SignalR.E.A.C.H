"""Offline CLI reliability regressions; no provider calls or shell actions.

The scripted HTTP responses exercise the real client and agent history. Tools
only read an isolated fixture or request a denied/cancelled edit in that fixture.
REACH_CLI_TEST_TOOLS permits running the same regressions against a baseline.
"""

import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest import mock

TOOLS = os.environ.get("REACH_CLI_TEST_TOOLS") or str(Path(__file__).resolve().parents[1] / "tools")
sys.path.insert(0, TOOLS)

from reach_cli import __main__ as cli, chat, terminal  # noqa: E402
from reach_cli.client import ReachClient, ReachApiError, ReachTransientError  # noqa: E402


def native(name, arguments, call_id="call_1"):
    return {"id": call_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)}}


def complete_text(summary="verified locally"):
    return '```agent_status\n' + json.dumps({"status": "complete", "summary": summary}) + '\n```'


class Response:
    def __init__(self, content=None, calls=None, tokens=None):
        self.body = {"choices": [{"message": {"content": content, "tool_calls": calls or []}}]}
        if tokens is not None:
            self.body["usage"] = {"total_tokens": tokens}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.body).encode("utf-8")


class Provider:
    """An exact script: extra requests fail loudly instead of using a network."""

    def __init__(self, *steps):
        self.steps = iter(steps)
        self.payloads = []

    def __call__(self, request, timeout=None):
        self.payloads.append(json.loads(request.data))
        try:
            step = next(self.steps)
        except StopIteration:
            raise AssertionError("unexpected extra provider request")
        if isinstance(step, BaseException):
            raise step
        return step


class ScriptClient:
    """Direct stream fixture for transport cuts, retries, and display changes."""

    def __init__(self, steps):
        self.steps = iter(steps)
        self.messages = []
        self.base = "http://fixture.invalid/v1"
        self.model = "fixture"

    def complete(self, messages, tools=None, on_text=None):
        self.messages.append(copy.deepcopy(messages))
        step = next(self.steps)
        if callable(step):
            return step(on_text)
        if isinstance(step, ReachTransientError):
            if on_text and step.partial.get("content"):
                on_text(step.partial["content"])
            raise step
        if isinstance(step, BaseException):
            raise step
        if on_text and step.get("content"):
            on_text(step["content"])
        return step


class ReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        (self.work / "note.txt").write_text("local fixture\n", encoding="utf-8")
        self.client = ReachClient("http://fixture.invalid/v1", model="fixture", no_stream=True)
        self.client.workpath = str(self.work)
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.dict(os.environ, {
            "REACH_CLI_CONFIG": str(self.work / "config.json"),
            "REACH_CLI_HISTORY": str(self.work / "history"),
        }))
        self.stack.enter_context(mock.patch.object(terminal, "PAINT", terminal.Paint(False)))
        self.stack.enter_context(mock.patch.object(chat, "_sleep", lambda delay: None))
        self.stack.enter_context(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")))
        self.stack.enter_context(mock.patch.object(chat, "banner"))
        self.stack.enter_context(mock.patch.object(chat, "endpoint_notice", return_value=False))
        self.stack.enter_context(mock.patch.object(chat, "print_footer"))
        self.output = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def run_repl(self, inputs, provider, initial_prompt=None):
        lines = iter(inputs)
        with mock.patch.object(chat, "read_user_line", side_effect=lambda *a: next(lines)), \
                mock.patch("urllib.request.urlopen", provider):
            if initial_prompt is None:
                chat.run_chat(self.client, self.client.base)
            else:
                chat.run_chat(self.client, self.client.base, initial_prompt=initial_prompt)

    def test_explicit_chat_prompt_stays_interactive(self):
        args = cli.build_parser().parse_args(["chat", "-p", " hello "])
        self.assertEqual(cli._resolve_invocation(args), ("chat", "hello", None))
        args = cli.build_parser().parse_args(["-p", "hello"])
        self.assertEqual(cli._resolve_invocation(args), ("ask", "hello", None))

    def test_main_dispatches_explicit_chat_with_initial_prompt(self):
        with mock.patch.object(cli, "run_chat") as repl, \
                mock.patch.object(cli, "run_ask") as ask, \
                mock.patch.object(ReachClient, "resolve_base", return_value=self.client.base):
            self.assertEqual(cli.main(["chat", "-p", "hello", "--no-color"]), 0)
        ask.assert_not_called()
        self.assertEqual(repl.call_args.kwargs, {"initial_prompt": "hello"})

    def test_initial_prompt_and_followup_keep_conversation(self):
        provider = Provider(Response("hello back"), Response("second answer"))
        self.run_repl(["follow up", None], provider, initial_prompt="hello")
        second = provider.payloads[1]["messages"]
        self.assertEqual(second[-3:], [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hello back"},
            {"role": "user", "content": "follow up"},
        ])
        self.assertEqual(self.client.session_totals["turns"], 2)

    def test_exhausted_partial_is_failure_with_recovery_context(self):
        failures = [ReachTransientError("cut", {"content": "partial ", "tool_calls": []}, status="cut")]
        failures += [ReachTransientError("busy", status=503)] * (chat.MAX_ATTEMPTS - 1)
        client = ScriptClient(failures)
        ok, result = chat.request_reply(client, [{"role": "user", "content": "hi"}])
        self.assertFalse(ok)
        self.assertEqual(result["content"], "partial ")
        self.assertEqual(result["attempts"], chat.MAX_ATTEMPTS)
        self.assertEqual(client.messages[1][-2]["content"], "partial ")
        self.assertEqual(client.model, "fixture")

    def test_terminal_failure_after_partial_is_still_failure(self):
        client = ScriptClient([
            ReachTransientError("cut", {"content": "partial", "tool_calls": []}, status="cut"),
            ReachApiError("auth failed", status=401),
        ])
        ok, result = chat.request_reply(client, [{"role": "user", "content": "hi"}])
        self.assertFalse(ok)
        self.assertEqual(result["content"], "partial")
        self.assertEqual(result["reason"], "auth rejected (401)")
        self.assertEqual(len(client.messages), 2)

    def test_failed_partial_preserved_on_followup(self):
        replies = iter([(False, {"content": "unfinished", "tool_calls": []}),
                        (True, {"content": "recovered", "tool_calls": []})])
        snapshots = []

        def reply(client, history, **kwargs):
            snapshots.append(copy.deepcopy(history))
            return next(replies)

        with mock.patch.object(chat, "stream_reply", side_effect=reply):
            self.run_repl(["first", "continue", None], Provider())
        self.assertEqual(snapshots[1][-3:], [
            {"role": "user", "content": "first"},
            {"role": "assistant", "content": "unfinished"},
            {"role": "user", "content": "continue"},
        ])

    def test_empty_failure_retry_sends_last_prompt_and_recovers(self):
        provider = Provider(Response(), Response("recovered"))
        with mock.patch.object(chat, "MAX_ATTEMPTS", 1):
            self.run_repl(["try this", "/retry", None], provider)
        self.assertEqual(provider.payloads[1]["messages"][-1], {"role": "user", "content": "try this"})
        self.assertEqual(sum(m.get("content") == "try this" for m in provider.payloads[1]["messages"]), 1)

    def test_partial_tool_block_never_executes_when_request_failed(self):
        self.client.agent = True
        history = [{"role": "user", "content": "read the fixture"}]
        block = '```tool\n{"action": "read", "path": "note.txt"}\n```'
        with mock.patch.object(chat, "stream_reply", return_value=(False, {"content": block})), \
                mock.patch.object(chat, "run_tool") as tool:
            ok = chat.run_agent_turn(self.client, history, chat.AgentState())
        self.assertFalse(ok)
        tool.assert_not_called()
        self.assertEqual(history[-1], {"role": "assistant", "content": block})

    def test_native_tool_result_id_content_and_followup_context(self):
        self.client.agent = True
        provider = Provider(
            Response(calls=[native("read", {"path": "note.txt"}, "read_42")]),
            Response(complete_text()), Response(complete_text("followup handled")))
        self.run_repl(["read note.txt", "what did it say?", None], provider)
        result = next(m for m in provider.payloads[1]["messages"] if m["role"] == "tool")
        self.assertEqual(result["tool_call_id"], "read_42")
        self.assertIn("local fixture", result["content"])
        self.assertIn(result, provider.payloads[2]["messages"])
        self.assertEqual(provider.payloads[2]["messages"][-1]["content"], "what did it say?")

    def test_invalid_native_arguments_return_error_then_repair(self):
        self.client.agent = True
        invalid = native("read", {}, "bad_1")
        invalid["function"]["arguments"] = "{cut"
        provider = Provider(Response(calls=[invalid]),
                            Response(calls=[native("read", {"path": "note.txt"}, "good_1")]),
                            Response(complete_text()))
        history = [{"role": "user", "content": "read"}]
        with mock.patch("urllib.request.urlopen", provider):
            self.assertTrue(chat.run_agent_turn(self.client, history, chat.AgentState()))
        results = [m for m in history if m["role"] == "tool"]
        self.assertTrue(results[0]["content"].startswith("error:"))
        self.assertIn("local fixture", results[1]["content"])
        self.assertEqual([m["tool_call_id"] for m in results], ["bad_1", "good_1"])

    def test_denied_edit_returns_result_without_modifying_fixture(self):
        self.client.agent = True
        provider = Provider(Response(calls=[native("edit", {
            "path": "note.txt", "search": "local fixture", "replace": "modified"})]),
            Response(complete_text("denial acknowledged")))
        history = [{"role": "user", "content": "edit"}]
        with mock.patch("urllib.request.urlopen", provider), mock.patch("builtins.input", return_value="n"):
            self.assertTrue(chat.run_agent_turn(self.client, history, chat.AgentState()))
        self.assertEqual((self.work / "note.txt").read_text(encoding="utf-8"), "local fixture\n")
        self.assertIn("denied by the user", next(m["content"] for m in history if m["role"] == "tool"))

    def test_cancelled_tool_batch_closes_every_call_and_keeps_completed_results(self):
        self.client.agent = True
        calls = [native("read", {"path": "note.txt"}, "read_before"),
                 native("edit", {"path": "note.txt", "search": "local", "replace": "changed"}, "edit_stop"),
                 native("read", {"path": "note.txt"}, "read_after")]
        provider = Provider(Response(calls=calls), Response(complete_text("continued")))
        history = [{"role": "user", "content": "go"}]
        with mock.patch("urllib.request.urlopen", provider), mock.patch("builtins.input", return_value="q"):
            self.assertFalse(chat.run_agent_turn(self.client, history, chat.AgentState()))
            results = [m for m in history if m["role"] == "tool"]
            self.assertEqual([m["tool_call_id"] for m in results], ["read_before", "edit_stop", "read_after"])
            self.assertIn("local fixture", results[0]["content"])
            self.assertTrue(all("stopped" in m["content"] for m in results[1:]))
            history.append({"role": "user", "content": "continue"})
            self.assertTrue(chat.run_agent_turn(self.client, history, chat.AgentState()))
        self.assertEqual((self.work / "note.txt").read_text(encoding="utf-8"), "local fixture\n")
        self.assertIn(results[-1], provider.payloads[1]["messages"])

    def test_turn_totals_publish_once_for_plain_agent_answer(self):
        self.client.agent = True
        provider = Provider(Response("plain answer", tokens=9))
        with mock.patch("urllib.request.urlopen", provider):
            self.assertTrue(chat.run_agent_turn(self.client, [{"role": "user", "content": "hi"}], chat.AgentState()))
        self.assertEqual(self.client.session_totals["turns"], 1)
        self.assertEqual(self.client.session_totals["tokens"], 9)
        self.assertEqual(self.client.session_totals["rounds"], 1)

    def test_failed_web_answer_propagates_failure(self):
        found = {"results": [{"title": "fixture", "url": "https://fixture.invalid", "snippet": "local text"}],
                 "rich": {}}
        with mock.patch.object(chat, "search_web", return_value=found), \
                mock.patch.object(chat, "stream_reply", return_value=(False, "partial")):
            self.assertFalse(chat.run_web_answer(self.client, "fixture", fetch_pages=False))

    def test_cancelled_request_stops_before_retry_or_tool_execution(self):
        event = threading.Event()

        def stop(on_text):
            event.set()
            raise ReachTransientError("cut", {"content": "partial", "tool_calls": []}, status="cut")

        client = ScriptClient([stop])
        ok, result = chat.request_reply(client, [{"role": "user", "content": "go"}], cancelled=event)
        self.assertFalse(ok)
        self.assertTrue(result["stopped"])
        self.assertEqual(result["content"], "partial")
        self.assertEqual(len(client.messages), 1)

    def test_cancel_during_backoff_does_not_start_next_request(self):
        event = threading.Event()
        client = ScriptClient([ReachTransientError("busy", status=503)])
        with mock.patch.object(chat, "_sleep", side_effect=lambda delay: event.set()):
            ok, result = chat.request_reply(client, [{"role": "user", "content": "go"}], cancelled=event)
        self.assertFalse(ok)
        self.assertTrue(result["stopped"])
        self.assertEqual(len(client.messages), 1)

    def test_interrupted_stream_suppresses_late_output_and_worker_retries(self):
        entered, release = threading.Event(), threading.Event()
        worker_result = []
        workers = []

        def delayed(on_text):
            on_text("partial")
            entered.set()
            if not release.wait(2):
                raise AssertionError("test did not release blocked fixture")
            on_text("late output")
            raise ReachTransientError("cut", {"content": "partial late output", "tool_calls": []}, status="cut")

        client = ScriptClient([delayed])

        def interrupt(fn):
            worker = threading.Thread(target=lambda: worker_result.append(fn()))
            workers.append(worker)
            worker.start()
            self.assertTrue(entered.wait(1), "fixture did not start")
            raise KeyboardInterrupt

        try:
            with mock.patch.object(chat, "_interruptible", side_effect=interrupt):
                ok, result = chat.stream_reply(client, [], full=True)
            self.assertTrue(result["stopped"])
            self.assertEqual(result["content"], "partial")
            release.set()
            workers[0].join(1)
            self.assertFalse(workers[0].is_alive())
            self.assertEqual(len(client.messages), 1)
            self.assertTrue(worker_result[0][1]["stopped"])
            self.assertNotIn("late output", self.output.getvalue())
            self.assertEqual(self.output.getvalue().count("stopped"), 1)
        finally:
            release.set()
            for worker in workers:
                worker.join(2)

    def test_cancelled_text_tool_batch_keeps_completed_results(self):
        self.client.agent = True
        block = ('```tool\n{"action": "read", "path": "note.txt"}\n```\n'
                 '```tool\n{"action": "edit", "path": "note.txt", '
                 '"search": "local", "replace": "changed"}\n```')
        provider = Provider(Response(block))
        history = [{"role": "user", "content": "go"}]
        with mock.patch("urllib.request.urlopen", provider), mock.patch("builtins.input", return_value="q"):
            self.assertFalse(chat.run_agent_turn(self.client, history, chat.AgentState()))
        self.assertTrue(history[-1]["content"].startswith("[tool result]"))
        self.assertIn("local fixture", history[-1]["content"])
        self.assertIn("stopped by the user", history[-1]["content"])
        self.assertEqual((self.work / "note.txt").read_text(encoding="utf-8"), "local fixture\n")

    def test_raw_stream_continuation_gutter_tracks_live_margin(self):
        margin = ["wide gutter "]

        def resize(on_text):
            on_text("first\nsecond\n")
            margin[0] = "small gutter "
            on_text("third\n")
            return {"content": "first\nsecond\nthird\n", "tool_calls": []}

        with mock.patch.object(chat, "response_indent", side_effect=lambda: margin[0]):
            ok, text = chat.stream_reply(ScriptClient([resize]), [])
        self.assertTrue(ok)
        self.assertEqual(text, "first\nsecond\nthird\n")
        self.assertIn("wide gutter second", self.output.getvalue())
        self.assertIn("small gutter third", self.output.getvalue())

    def test_explicit_stream_indent_is_preserved_across_resize(self):
        client = ScriptClient([{"content": "first\nsecond\n", "tool_calls": []}])
        with mock.patch.object(chat, "response_indent", return_value="live gutter "):
            chat.stream_reply(client, [], indent="fixed gutter ")
        self.assertIn("fixed gutter second", self.output.getvalue())
        self.assertNotIn("live gutter second", self.output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
