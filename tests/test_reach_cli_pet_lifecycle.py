"""Offline lifecycle coverage for the stationary CLI header companion."""

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from reach_cli import chat, chatbox, render, terminal


class FakePetScreen:
    def __init__(self):
        self.activities = []
        self.inputs = []

    def set_pet_activity(self, activity):
        self.activities.append(activity)

    def finish_input(self, text, echo=False):
        self.inputs.append((text, echo))


class QuietIndicator:
    def __init__(self, **kwargs):
        pass

    def start(self):
        pass

    def stop(self):
        pass


def control(status, **details):
    return "```agent_status\n%s\n```" % json.dumps(dict(status=status, **details))


class PetLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.workpath = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.output = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.screen = FakePetScreen()
        self.stack.enter_context(mock.patch.object(chatbox, "active_footer", return_value=self.screen))
        self.stack.enter_context(mock.patch.object(chat, "WaitIndicator", QuietIndicator))
        self.stack.enter_context(mock.patch.object(chat, "_interruptible", side_effect=lambda fn: fn()))
        self.stack.enter_context(mock.patch.object(chat, "banner"))
        self.stack.enter_context(mock.patch.object(chat, "endpoint_notice"))
        self.stack.enter_context(mock.patch.object(chat, "print_footer"))
        self.stack.enter_context(mock.patch.object(chat, "cleanup_owned_processes"))
        self.stack.enter_context(mock.patch.object(terminal, "PAINT", terminal.Paint(False)))
        self.stack.enter_context(mock.patch.object(render, "enabled", return_value=False))
        self.stack.enter_context(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")))

    def client(self, *scripts, agent=False):
        replies = iter(scripts)
        calls = []

        def complete(messages, tools=None, on_text=None, on_thought=None):
            calls.append(list(messages))
            # Waiting must already be visible when the model call starts.
            self.assertEqual(self.screen.activities[-1], "waiting")
            script = next(replies)
            if callable(script):
                return script(on_text, on_thought)
            return script

        return SimpleNamespace(
            base="http://offline.invalid/v1", model="fixture", agent=agent,
            system="Offline pet fixture", workpath=self.workpath, usage={},
            complete=complete, calls=calls,
        )

    @staticmethod
    def streamed(text, thought=""):
        def reply(on_text, on_thought):
            if thought:
                on_thought(thought)
            if text:
                midpoint = max(1, len(text) // 2)
                on_text(text[:midpoint])
                on_text(text[midpoint:])
            return {"content": text, "thought": thought}
        return reply

    def run_chat(self, client, initial=None):
        lines = [None] if initial is not None else ["hello fixture", None]
        with mock.patch.object(chat, "read_user_line", side_effect=lines):
            chat._run_chat_loop(client, client.base, initial)

    def test_chat_waits_then_streams_then_celebrates_once(self):
        client = self.client(self.streamed("Fixture response."))
        self.run_chat(client)
        self.assertEqual(self.screen.activities, ["waiting", "responding", "complete"])
        self.assertEqual(len(client.calls), 1)
        self.assertIn("Fixture response.", self.output.getvalue())

    def test_thought_starts_thinking_before_answer_tokens(self):
        def reply(on_text, on_thought):
            on_thought("Checking the fixture")
            self.assertEqual(self.screen.activities, ["waiting", "thinking"])
            on_text("Verified.")
            return {"content": "Verified.", "thought": "Checking the fixture"}
        self.run_chat(self.client(reply))
        self.assertEqual(self.screen.activities, ["waiting", "thinking", "responding", "complete"])
        self.assertNotIn("Checking the fixture", self.output.getvalue())

    def test_interleaved_tokens_change_phases_without_repainting_every_token(self):
        def reply(on_text, on_thought):
            on_thought("private thought one")
            on_thought("private thought two")
            on_text("First ")
            on_text("answer.")
            on_thought("private late thought")
            on_thought("private late thought continuation")
            return {"content": "First answer.", "thought": "private thought"}
        self.run_chat(self.client(reply))
        self.assertEqual(self.screen.activities,
                         ["waiting", "thinking", "responding", "thinking", "complete"])
        self.assertNotIn("private", self.output.getvalue())

    def test_non_stream_reasoning_only_reply_uses_thinking(self):
        ok, result = chat.stream_reply(self.client({"thought": "Private fixture reasoning"}), [], full=True)
        self.assertTrue(ok)
        self.assertEqual(result["thought"], "Private fixture reasoning")
        self.assertEqual(self.screen.activities, ["waiting", "thinking"])
        self.assertNotIn("Private fixture reasoning", self.output.getvalue())

    def test_retry_backoff_returns_to_waiting_then_resumes_real_stream_phase(self):
        def interrupted(on_text, on_thought):
            on_thought("private interrupted reasoning")
            raise chat.ReachTransientError("fixture retry")

        def sleep(delay):
            self.assertEqual(self.screen.activities[-1], "waiting")

        client = self.client(interrupted, self.streamed("Recovered.", thought="private resumed reasoning"))
        with mock.patch.object(chat, "_sleep", side_effect=sleep):
            self.run_chat(client)
        self.assertEqual(self.screen.activities,
                         ["waiting", "thinking", "waiting", "thinking", "responding", "complete"])

    def test_non_stream_response_and_initial_prompt_use_same_lifecycle(self):
        client = self.client({"content": "Returned without deltas."})
        self.run_chat(client, initial="initial fixture prompt")
        self.assertEqual(self.screen.activities, ["waiting", "responding", "complete"])
        self.assertEqual(self.screen.inputs, [("initial fixture prompt", True)])
        self.assertEqual(client.calls[0][-1]["content"], "initial fixture prompt")

    def test_client_failure_keeps_error_state_without_celebration(self):
        def fail(on_text, on_thought):
            raise RuntimeError("offline fixture failure")
        self.run_chat(self.client(fail))
        self.assertEqual(self.screen.activities[0], "waiting")
        self.assertEqual(self.screen.activities[-1], "error")
        self.assertNotIn("complete", self.screen.activities)
        self.assertNotIn("idle", self.screen.activities)

    def test_ctrl_c_keeps_cancelled_state_and_partial_history(self):
        def cancel(on_text, on_thought):
            on_text("Partial fixture")
            raise KeyboardInterrupt
        client = self.client(cancel)
        self.run_chat(client)
        self.assertEqual(self.screen.activities[:2], ["waiting", "responding"])
        self.assertEqual(self.screen.activities[-1], "cancelled")
        self.assertNotIn("complete", self.screen.activities)
        self.assertNotIn("idle", self.screen.activities)
        self.assertIn("Partial fixture", self.output.getvalue())

    def test_pet_update_failure_does_not_fail_response(self):
        self.screen.set_pet_activity = mock.Mock(side_effect=RuntimeError("paint failed"))
        client = SimpleNamespace(agent=False, model="fixture", complete=lambda *a, **kw: {"content": "ok"})
        ok, result = chat.stream_reply(client, [], full=True)
        self.assertTrue(ok)
        self.assertEqual(result["content"], "ok")

    def test_missing_footer_or_old_footer_emits_identical_plain_bytes(self):
        outputs = []
        for screen in (None, SimpleNamespace(), FakePetScreen()):
            client = SimpleNamespace(agent=False, model="fixture", complete=lambda *a, **kw: {
                "content": "raw text"})
            self.output.seek(0)
            self.output.truncate(0)
            with mock.patch.object(chatbox, "active_footer", return_value=screen):
                self.assertTrue(chat.stream_reply(client, [])[0])
            outputs.append(self.output.getvalue())
        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(outputs[0], outputs[2])
        self.assertNotIn("pet", outputs[0].lower())

    def test_agent_tool_rounds_celebrate_only_validated_final_completion(self):
        call = {"id": "fixture-read", "type": "function", "function": {
            "name": "read", "arguments": '{"path":"fixture.txt"}'}}
        client = self.client(
            {"content": "", "tool_calls": [call]},
            self.streamed(control("complete", summary="Fixture checked.")), agent=True)
        history = [{"role": "user", "content": "read the fixture"}]

        def execute(*args):
            self.assertNotIn("complete", self.screen.activities)
            return [{"role": "tool", "tool_call_id": "fixture-read", "content": "fixture"}]

        with mock.patch.object(chat, "_execute_native", side_effect=execute):
            self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(self.screen.activities, ["waiting", "waiting", "responding", "complete"])
        self.assertEqual(len(client.calls), 2)

    def test_agent_rejected_completion_and_blocked_turn_never_celebrate(self):
        client = self.client(
            self.streamed(control("complete", summary="Premature completion.")),
            self.streamed(control("blocked", reason="Need a fixture decision.")), agent=True)
        state = chat.AgentState()
        state.todos = [{"text": "Unfinished fixture", "status": "pending"}]
        self.assertTrue(chat.run_agent_turn(client, [{"role": "user", "content": "fixture"}], state))
        self.assertNotIn("complete", self.screen.activities)
        self.assertEqual(self.screen.activities[-1], "blocked")
        self.assertIn("Completion rejected", client.calls[1][-1]["content"])

    def test_agent_round_limit_never_celebrates(self):
        client = self.client(self.streamed('```tool\n{"action":"read","path":"fixture.txt"}\n```'), agent=True)
        with mock.patch.object(chat, "MAX_AGENT_ROUNDS", 1), \
                mock.patch.object(chat, "_execute_actions", return_value="[tool result]\nfixture"):
            self.assertTrue(chat.run_agent_turn(client, [{"role": "user", "content": "fixture"}], chat.AgentState()))
        self.assertNotIn("complete", self.screen.activities)
        self.assertEqual(self.screen.activities[-1], "blocked")

    def test_agent_recovery_exhaustion_never_celebrates(self):
        client = self.client(self.streamed("A response without run control."), agent=True)
        history = [{"role": "user", "content": "[tool result]\nfixture"}]
        with mock.patch.object(chat, "MAX_RECOVERY", 0):
            self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertNotIn("complete", self.screen.activities)
        self.assertEqual(self.screen.activities[-1], "blocked")

    def test_agent_tool_cancellation_keeps_cancelled_state(self):
        call = {"id": "fixture-read", "type": "function", "function": {
            "name": "read", "arguments": '{"path":"fixture.txt"}'}}
        client = self.client({"content": "", "tool_calls": [call]}, agent=True)
        with mock.patch.object(chat, "_execute_native", side_effect=KeyboardInterrupt):
            self.assertFalse(chat.run_agent_turn(client, [], chat.AgentState()))
        self.assertEqual(self.screen.activities, ["waiting", "cancelled"])

    def test_native_and_fenced_tools_show_the_current_operation_without_tool_inputs(self):
        actions = [("websearch", "searching"), ("browse", "reading"),
                   ("read", "reading"), ("edit", "writing"),
                   ("write_file", "writing"), ("shell", "running"),
                   ("run_command", "running"), ("todo_write", "checking"),
                   ("search", "checking"), ("git_diff", "checking"),
                   ("process_poll", "checking")]
        for native in (False, True):
            for name, expected in actions:
                with self.subTest(native=native, name=name):
                    self.screen.activities.clear()

                    def execute(tool_name, args, workpath, ctx):
                        self.assertEqual(self.screen.activities, [expected])
                        self.assertEqual(args["private"], "PRIVATE path/prompt/command")
                        return "exit code 0" if name in ("shell", "run_command") else "fixture result"

                    with mock.patch.object(chat, "run_tool", side_effect=execute), \
                            mock.patch.object(chat, "show_tool_call"), \
                            mock.patch.object(chat, "show_tool_result"):
                        if native:
                            chat._execute_native(self.client(), [{"id": "fixture", "function": {
                                "name": name, "arguments": '{"private":"PRIVATE path/prompt/command"}'}}],
                                chat.AgentState())
                        else:
                            chat._execute_actions(self.client(), [{
                                "action": name, "private": "PRIVATE path/prompt/command"}], chat.AgentState())
                    self.assertEqual(self.screen.activities, [expected])

    def test_approval_prompt_blocks_pet_then_resumes_execution_only_if_allowed(self):
        for answer, final in (("y", "running"), ("n", "blocked")):
            with self.subTest(answer=answer):
                self.screen.activities.clear()

                def read_input(prompt):
                    self.assertEqual(self.screen.activities[-1], "blocked")
                    return answer

                def execute(name, args, workpath, ctx):
                    allowed = ctx["approve"]("shell", "private fixture command")
                    self.assertEqual(self.screen.activities[-1], final)
                    return "exit code 0" if allowed else "error: declined by the user"

                with mock.patch.object(chat.terminal, "read_input", side_effect=read_input), \
                        mock.patch.object(chat, "run_tool", side_effect=execute):
                    chat._execute_actions(self.client(), [{"action": "shell", "command": "fixture"}],
                                          chat.AgentState())
                self.assertEqual(self.screen.activities[-1], final)
                self.assertNotIn("complete", self.screen.activities)

    def test_auto_approved_tool_never_claims_it_needs_input(self):
        state = chat.AgentState()
        state.auto_approve = True

        def execute(name, args, workpath, ctx):
            self.assertTrue(ctx["approve"]("shell", "private fixture command"))
            return "exit code 0"

        with mock.patch.object(chat, "run_tool", side_effect=execute):
            chat._execute_actions(self.client(), [{"action": "shell", "command": "fixture"}], state)
        self.assertNotIn("blocked", self.screen.activities)

    def test_failed_tool_shows_error_and_malformed_native_call_does_not_claim_execution(self):
        with mock.patch.object(chat, "run_tool", return_value="error: fixture failure"):
            chat._execute_actions(self.client(), [{"action": "read", "path": "fixture"}], chat.AgentState())
        self.assertEqual(self.screen.activities, ["reading", "error"])
        self.screen.activities.clear()
        with mock.patch.object(chat, "run_tool") as run:
            chat._execute_native(self.client(), [{"id": "fixture", "function": {
                "name": "shell", "arguments": "invalid JSON"}}], chat.AgentState())
        self.assertEqual(self.screen.activities, ["checking"])
        run.assert_not_called()

    def test_structured_command_exit_status_sets_pet_error_and_preserves_result(self):
        for code, phases in ((0, ["running"]), (17, ["running", "error"]),
                             (-1, ["running", "error"])):
            with self.subTest(code=code):
                self.screen.activities.clear()
                result = "exit code %d\nPrivate command output" % code
                with mock.patch.object(chat, "run_tool", return_value=result):
                    messages = chat._execute_native(self.client(), [{"id": "fixture", "function": {
                        "name": "run_command", "arguments": '{"argv":["fixture"]}'}}], chat.AgentState())
                self.assertEqual(self.screen.activities, phases)
                self.assertEqual(messages[0]["content"], result)

    def test_normal_chat_restores_saved_pet_before_starting_footer(self):
        client = SimpleNamespace(pet="cat", pet_motion=True)

        def footer_session(restored):
            self.assertEqual(restored.pet, "owl")
            self.assertIs(restored.pet_motion, False)
            return contextlib.nullcontext()

        with mock.patch.object(terminal, "load_session_config", return_value={
                "pet": "owl", "pet_motion": False}), \
                mock.patch.object(chatbox, "footer_session", side_effect=footer_session), \
                mock.patch.object(chat, "_run_chat_loop", return_value="fixture-result"):
            self.assertEqual(chat.run_chat(client, "offline"), "fixture-result")

    def test_saved_pet_motion_requires_a_boolean_and_missing_pet_is_preserved(self):
        client = SimpleNamespace(pet="bulldog", pet_motion=False)
        with mock.patch.object(terminal, "load_session_config", return_value={"pet_motion": "true"}), \
                mock.patch.object(chatbox, "footer_session", return_value=contextlib.nullcontext()), \
                mock.patch.object(chat, "_run_chat_loop"):
            chat.run_chat(client, "offline")
        self.assertEqual(client.pet, "bulldog")
        self.assertIs(client.pet_motion, False)

    @staticmethod
    def web_results():
        return {"results": [{"title": "Offline fixture", "url": "https://fixture.invalid",
                             "snippet": "Fixture source text"}], "rich": ""}

    def test_web_slash_command_finishes_response_and_celebrates_once(self):
        client = self.client(self.streamed("Grounded fixture answer. [1]"))

        def fetch(url):
            self.assertEqual(self.screen.activities[-1], "reading")
            return "Fixture source text"

        def search(query):
            self.assertEqual(self.screen.activities[-1], "searching")
            return self.web_results()

        with mock.patch.object(chat, "search_web", side_effect=search), \
                mock.patch.object(chat, "fetch_text", side_effect=fetch), \
                mock.patch.object(chat, "read_user_line", side_effect=["/web fixture", None]):
            chat._run_chat_loop(client, client.base)
        self.assertEqual(self.screen.activities[:3], ["searching", "reading", "waiting"])
        self.assertEqual(self.screen.activities[-2:], ["responding", "complete"])
        self.assertEqual(self.screen.activities.count("complete"), 1)
        self.assertEqual(len(client.calls), 1)

    def test_cancelled_web_reply_keeps_cancelled_state_without_celebration(self):
        def cancel(on_text, on_thought):
            on_text("Partial grounded fixture")
            raise KeyboardInterrupt
        client = self.client(cancel)
        with mock.patch.object(chat, "search_web", return_value=self.web_results()):
            # The pre-existing web API returns the stream's ok flag after Ctrl-C.
            self.assertTrue(chat.run_web_answer(client, "fixture", fetch_pages=False))
        self.assertEqual(self.screen.activities[0], "searching")
        self.assertIn("responding", self.screen.activities)
        self.assertEqual(self.screen.activities[-1], "cancelled")
        self.assertNotIn("complete", self.screen.activities)
        self.assertNotIn("idle", self.screen.activities)

    def test_web_no_results_ends_waiting_without_calling_model(self):
        client = self.client()
        with mock.patch.object(chat, "search_web", return_value={"results": [], "rich": ""}):
            self.assertFalse(chat.run_web_answer(client, "fixture"))
        self.assertEqual(self.screen.activities, ["searching", "error"])
        self.assertEqual(client.calls, [])

    def test_web_search_and_fetch_failure_or_cancellation_end_waiting(self):
        for stage in ("search", "fetch"):
            for exception, expected in ((RuntimeError("offline fixture"), "error"),
                                        (KeyboardInterrupt(), "cancelled")):
                with self.subTest(stage=stage, expected=expected):
                    self.screen.activities.clear()
                    client = self.client()
                    search = mock.patch.object(chat, "search_web", **(
                        {"side_effect": exception} if stage == "search" else
                        {"return_value": self.web_results()}))
                    with search, mock.patch.object(chat, "fetch_text", side_effect=exception):
                        with self.assertRaises(type(exception)):
                            chat.run_web_answer(client, "fixture")
                    phases = ["searching", "reading"] if stage == "fetch" else ["searching"]
                    self.assertEqual(self.screen.activities, phases + [expected])
                    self.assertEqual(client.calls, [])

    def test_failed_web_reply_keeps_error_state_without_celebration(self):
        def fail(on_text, on_thought):
            raise RuntimeError("offline web fixture failure")
        client = self.client(fail)
        with mock.patch.object(chat, "search_web", return_value=self.web_results()):
            self.assertFalse(chat.run_web_answer(client, "fixture", fetch_pages=False))
        self.assertEqual(self.screen.activities[0], "searching")
        self.assertEqual(self.screen.activities[-1], "error")
        self.assertNotIn("complete", self.screen.activities)
        self.assertNotIn("idle", self.screen.activities)


if __name__ == "__main__":
    unittest.main()
