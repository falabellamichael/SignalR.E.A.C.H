"""Offline regressions for repeated bookkeeping and per-turn recovery.

These tests exercise the real agent loop and todo normalization. The exact
response script forbids an unbounded extra model request, and fixture setup
rejects network access. A completed checklist alone is never a success claim.
"""

import copy
import json
import unittest
from unittest import mock

from tests import test_reach_cli_agent_completion as fixtures
from reach_cli import chat
from reach_cli.client import ReachApiError, ReachTransientError

envelope, native_read, reply = fixtures.envelope, fixtures.native_read, fixtures.reply


def native_tool(name, args, call_id):
    return {"id": call_id, "type": "function", "function": {
        "name": name, "arguments": json.dumps(args)}}


def todo_reply(index, *, fenced=False, status="completed", text="Greeted user and ready to assist", with_prose=False):
    # Equivalent aliases are accepted by the actual todo tool. Call ids,
    # key order, and prose should not manufacture progress.
    if index % 2:
        item = {"state": "done" if status == "completed" else status, "content": text}
    else:
        item = {"text": text, "status": status}
    args = {"todos": [item]}
    prose = (("I'm ready. What would you like to work on?"
              if index % 2 else "Let me know what you'd like me to do.") if with_prose else "")
    if fenced:
        return reply(prose + "\n```tool\n" + json.dumps(dict(action="todo_write", **args)) + "\n```")
    return reply(prose, [native_tool("todo_write", args, "changed_%d" % index)])


class AgentProgressTurnTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.AgentCompletionTurnTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.output = self.fixture.output

    def client(self, *steps):
        return self.fixture.client(*steps)

    def history(self, content="hello"):
        return [{"role": "user", "content": content}]

    def paused_substantive_turn(self):
        client = self.client(reply(calls=[native_read()]),
                             *(reply("Still working on the verification.") for _ in range(3)))
        history, state = self.history("Read and verify note.txt"), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 4)
        self.assertEqual(self.output.getvalue().count("agent paused:"), 1)
        self.output.seek(0)
        self.output.truncate(0)
        return client, history, state

    def assert_paused(self, client, history):
        visible = self.output.getvalue()
        self.assertLessEqual(len(client.messages), 5, visible)
        self.assertEqual(visible.count("agent paused:"), 1, visible)
        self.assertNotIn("agent complete", visible)
        self.assertNotIn("round limit reached", visible)
        self.assertTrue(any(m.get("role") == "user" and
                            str(m.get("content", "")).startswith("[run control]")
                            for m in history))

    def assert_native_results_paired(self, history):
        for index, message in enumerate(history):
            calls = message.get("tool_calls")
            if message.get("role") != "assistant" or not calls:
                continue
            results = history[index + 1:index + 1 + len(calls)]
            self.assertEqual([result.get("role") for result in results], ["tool"] * len(calls))
            self.assertEqual([result.get("tool_call_id") for result in results],
                             [call.get("id") for call in calls])

    def test_repeated_completed_native_plan_pauses_without_success(self):
        client = self.client(*(todo_reply(i) for i in range(6)))
        history, state = self.history(), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assert_paused(client, history)
        self.assertEqual(state.todos, [{"text": "Greeted user and ready to assist", "status": "completed"}])
        self.assert_native_results_paired(history)

    def test_native_greeting_with_completed_plan_finishes_directly(self):
        client = self.client(todo_reply(0, with_prose=True))
        history, state = self.history(), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 1)
        self.assertNotIn("agent paused:", self.output.getvalue())
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("Let me know what you'd like me to do."), 1)
        self.assert_native_results_paired(history)

    def test_plain_greeting_after_fenced_bookkeeping_finishes_without_recovery(self):
        client = self.client(todo_reply(0, fenced=True), reply("I'm ready. What would you like to work on?"))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        self.assertFalse(any("without an action" in str(m.get("content")) for m in history))
        self.assertNotIn("agent paused:", self.output.getvalue())

    def test_repeated_completed_fenced_plan_has_the_same_guard(self):
        client = self.client(*(todo_reply(i, fenced=True) for i in range(6)))
        history, state = self.history(), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assert_paused(client, history)
        self.assertTrue(any(m.get("role") == "user" and
                            str(m.get("content", "")).startswith("[tool result]") for m in history))

    def test_switching_protocol_does_not_hide_repeated_bookkeeping(self):
        client = self.client(*(todo_reply(i, fenced=bool(i % 2)) for i in range(6)))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assert_paused(client, history)
        self.assert_native_results_paired(history)

    def test_rephrasing_completed_plan_is_not_work_progress(self):
        steps = [todo_reply(i, text="Greeting confirmed in phrasing %d" % i) for i in range(6)]
        client = self.client(*steps)
        history, state = self.history(), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assert_paused(client, history)
        self.assertTrue(all(item["status"] == "completed" for item in state.todos))

    def test_reordering_native_ids_and_bookkeeping_calls_cannot_mask_repetition(self):
        steps = []
        for index in range(6):
            calls = [todo_reply(index)["tool_calls"][0],
                     native_tool("todo_read", {}, "read_%d" % index)]
            if index % 2:
                calls.reverse()
            steps.append(reply(calls=calls))
        client = self.client(*steps)
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assert_paused(client, history)
        self.assert_native_results_paired(history)

    def test_native_final_todo_and_status_are_applied_in_one_request(self):
        text = envelope("Greeting complete.", language="agent_status")
        final = todo_reply(0)
        final["content"] = text
        client = self.client(final)
        history, state = self.history(), chat.AgentState()
        state.todos = [{"text": "Greeted user and ready to assist", "status": "in_progress"}]
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 1)
        self.assertEqual(state.todos[0]["status"], "completed")
        self.assertEqual(self.output.getvalue().count("agent complete"), 1)
        self.assert_native_results_paired(history)

    def test_fenced_final_todo_is_executed_before_status_checks_the_plan(self):
        tool = '```tool\n' + json.dumps({"action": "todo_write", "todos": [
            {"text": "Greeted user and ready to assist", "status": "completed"}]}) + '\n```'
        text = tool + "\n" + envelope("Greeting complete.", language="agent_status")
        client = self.client(reply(text))
        history, state = self.history(), chat.AgentState()
        state.todos = [{"text": "Greeted user and ready to assist", "status": "in_progress"}]
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 1)
        self.assertEqual(state.todos[0]["status"], "completed")
        self.assertEqual(self.output.getvalue().count("agent complete"), 1)
        self.assertTrue(any(m.get("role") == "user" and
                            str(m.get("content", "")).startswith("[tool result]") for m in history))

    def test_failed_todo_batch_cannot_accept_accompanying_completion(self):
        final = envelope("This must not become success.", language="agent_status")
        blocked = envelope("The plan could not be updated.", "blocked", language="agent_status")
        for fenced in (False, True):
            with self.subTest(fenced=fenced):
                self.output.seek(0)
                self.output.truncate(0)
                if fenced:
                    first = reply('```tool\n{"action":"todo_write","todos":42}\n```\n' + final)
                else:
                    first = reply(final, [native_tool("todo_write", {"todos": 42}, "invalid")])
                client = self.client(first, reply(blocked))
                history = self.history()
                self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
                self.assertEqual(len(client.messages), 2)
                self.assertNotIn("agent complete", self.output.getvalue())
                self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)
                self.assertTrue(any("error:" in str(m.get("content")) for m in history))
                self.assert_native_results_paired(history)

    def test_substantive_tool_result_is_observed_before_completion(self):
        premature = envelope("Unobserved result must not complete.", language="agent_status")
        checked = envelope("The actual read result was checked.")
        client = self.client(reply(premature, [native_read()]), reply(checked))
        history = self.history("Read and check note.txt")
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        results = [m for m in history if m.get("role") == "tool"]
        self.assertEqual(len(results), 1)
        self.assertIn("local fixture", results[0]["content"])
        self.assertIn(results[0], client.messages[1])
        self.assertEqual(self.output.getvalue().count("agent complete"), 1)
        self.assertNotIn("Unobserved result must not complete.", self.output.getvalue())

    def test_blocked_status_prevents_unsafe_native_batch_and_closes_pairs(self):
        blocked = envelope("Awaiting the user's decision.", "blocked", language="agent_status")
        calls = [native_tool("write_file", {"path": "must-not-exist.txt", "content": "no"}, "blocked_write")]
        client = self.client(reply(blocked, calls))
        history = self.history("Prepare a file only if approved")
        with mock.patch.object(chat, "run_tool", wraps=chat.run_tool) as tools:
            self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        tools.assert_not_called()
        self.assertFalse((self.fixture.work / "must-not-exist.txt").exists())
        self.assertEqual(len(client.messages), 1)
        self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assert_native_results_paired(history)

    def test_repeated_rejected_completion_on_open_plan_pauses_honestly(self):
        client = self.client(*(reply(envelope("Must not report success.")) for _ in range(6)))
        history, state = self.history(), chat.AgentState()
        state.todos = [{"text": "Verify remaining work", "status": "pending"}]
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assert_paused(client, history)
        self.assertEqual(len(client.messages), 3)
        self.assertEqual(state.todos, [{"text": "Verify remaining work", "status": "pending"}])

    def test_unlimited_round_budget_still_bounds_repeated_open_plan(self):
        client = self.client(*(todo_reply(i, status="in_progress", text="Verify requested work") for i in range(6)))
        client.cli_settings = {"budgets": {"maxRounds": 0}}
        history, state = self.history(), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assert_paused(client, history)
        self.assertEqual(state.todos, [{"text": "Verify requested work", "status": "in_progress"}])
        self.assert_native_results_paired(history)

    def test_revisiting_pending_and_completed_snapshots_is_not_fresh_progress(self):
        steps = [todo_reply(index, status="pending" if index % 2 == 0 else "completed",
                            text="Verify the requested change") for index in range(6)]
        client = self.client(*steps)
        client.cli_settings = {"budgets": {"maxRounds": 0}}
        history, state = self.history("Verify the requested change"), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assert_paused(client, history)
        self.assert_native_results_paired(history)
        self.assertEqual(len(state.todos), 1)

    def test_reordering_flapping_plan_items_does_not_make_new_snapshots(self):
        steps = []
        for index in range(6):
            items = [{"text": "Check " + name, "status": "pending" if index % 2 == 0 else "completed"}
                     for name in ("alpha", "beta")]
            if index // 2 % 2:
                items.reverse()
            steps.append(reply(calls=[native_tool("todo_write", {"todos": items}, "flap_%d" % index)]))
        client = self.client(*steps)
        client.cli_settings = {"budgets": {"maxRounds": 0}}
        history = self.history("Check alpha and beta")
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assert_paused(client, history)
        self.assertEqual(len(client.messages), 5)
        self.assert_native_results_paired(history)

    def test_request_evidence_ends_at_real_user_prompt_but_survives_control_messages(self):
        for result in ({"role": "tool", "tool_call_id": "fixture", "content": "old result"},
                       {"role": "user", "content": "[tool result]\nold result"}):
            with self.subTest(role=result["role"]):
                history = [{"role": "user", "content": "Read the fixture"}, result,
                           {"role": "user", "content": "[run control] Observe and finish."}]
                self.assertTrue(chat._current_request_has_results(history))
                history.append({"role": "user", "content": "hello"})
                self.assertFalse(chat._current_request_has_results(history))
                history += [{"role": "system", "content": "Refreshed system instructions"},
                            {"role": "assistant", "content": "Hello!"}]
                self.assertFalse(chat._current_request_has_results(history))

    def test_explicit_finish_after_bookkeeping_repetition_is_accepted_once(self):
        client = self.client(todo_reply(0), todo_reply(1),
                             reply(envelope("Greeting finished; awaiting the user's task.")))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 3)
        self.assertNotIn("agent paused:", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("agent complete"), 1)
        self.assert_native_results_paired(history)

    def test_fresh_user_turn_can_repeat_an_action_after_a_pause(self):
        client = self.client(*(todo_reply(i) for i in range(6)))
        history, state = self.history(), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assert_paused(client, history)
        prior_count = len(client.messages)
        self.output.seek(0)
        self.output.truncate(0)
        client.steps = iter([todo_reply(99), reply(envelope("The new request finished."))])
        history.append({"role": "user", "content": "Please verify that greeting again."})
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages) - prior_count, 2)
        self.assertNotIn("agent paused:", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("agent complete"), 1)
        self.assert_native_results_paired(history)

    def test_continue_after_substantive_pause_keeps_completion_evidence(self):
        for fenced in (False, True):
            with self.subTest(fenced=fenced):
                self.output.seek(0)
                self.output.truncate(0)
                first = (reply('```tool\n{"action":"read","path":"note.txt"}\n```')
                         if fenced else reply(calls=[native_read()]))
                client = self.client(first, *(reply("Still working on the verification.") for _ in range(3)))
                history, state = self.history("Read and verify note.txt"), chat.AgentState()
                self.assertTrue(chat.run_agent_turn(client, history, state))
                self.assertEqual(len(client.messages), 4)
                self.assertEqual(self.output.getvalue().count("agent paused:"), 1)
                self.assertEqual(state.todos, [])
                prior_count = len(client.messages)
                self.output.seek(0)
                self.output.truncate(0)
                history.append({"role": "user", "content": "continue"})
                client.steps = iter(reply("Still working on the verification.") for _ in range(3))
                self.assertTrue(chat.run_agent_turn(client, history, state))
                self.assertEqual(len(client.messages) - prior_count, 3)
                self.assertEqual(self.output.getvalue().count("agent paused:"), 1)
                self.assertNotIn("agent complete", self.output.getvalue())
                self.assert_native_results_paired(history)

    def test_fresh_hello_after_substantive_pause_clears_resume_evidence(self):
        client = self.client(reply(calls=[native_read()]),
                             *(reply("Still working on the verification.") for _ in range(3)))
        history, state = self.history("Read and verify note.txt"), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 4)
        self.assertEqual(self.output.getvalue().count("agent paused:"), 1)
        prior_count = len(client.messages)
        self.output.seek(0)
        self.output.truncate(0)
        history.append({"role": "user", "content": "hello"})
        client.steps = iter([reply("Hello! What would you like to do?")])
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages) - prior_count, 1)
        self.assertNotIn("agent paused:", self.output.getvalue())
        # A later 'continue' must not revive evidence superseded by hello.
        prior_count = len(client.messages)
        history.append({"role": "user", "content": "continue"})
        client.steps = iter([reply("Ready when you are.")])
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages) - prior_count, 1)
        self.assertNotIn("agent paused:", self.output.getvalue())

    def test_continue_after_round_limit_observes_prior_tool_result_before_finishing(self):
        client = self.client(reply(calls=[native_read()]))
        client.cli_settings = {"budgets": {"maxRounds": 1}}
        history, state = self.history("Read and verify note.txt"), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 1)
        self.assertIn("round limit reached", self.output.getvalue())
        self.output.seek(0)
        self.output.truncate(0)
        history.append({"role": "user", "content": "continue"})
        client.cli_settings = {"budgets": {"maxRounds": 0}}
        client.steps = iter([reply("Still working on the verification."),
                             reply(envelope("The previous read result was verified."))])
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 3)
        self.assertIn("without an action", client.messages[-1][-1]["content"])
        self.assertEqual(self.output.getvalue().count("agent complete"), 1)
        self.assertNotIn("agent paused:", self.output.getvalue())
        self.assert_native_results_paired(history)

    def test_failed_continue_preserves_substantive_evidence_for_next_continue(self):
        client, history, state = self.paused_substantive_turn()
        history.append({"role": "user", "content": "continue"})
        client.steps = iter([ReachApiError("auth failed", status=401)])
        self.assertFalse(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 5)
        self.assertNotIn("agent complete", self.output.getvalue())
        self.output.seek(0)
        self.output.truncate(0)
        history.append({"role": "user", "content": "continue"})
        client.steps = iter(reply("Still working on the verification.") for _ in range(3))
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 8)
        self.assertEqual(self.output.getvalue().count("agent paused:"), 1)
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assert_native_results_paired(history)

    def test_cancelled_continue_preserves_substantive_evidence_for_next_continue(self):
        client, history, state = self.paused_substantive_turn()
        history.append({"role": "user", "content": "continue"})
        client.steps = iter([KeyboardInterrupt()])
        self.assertFalse(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 5)
        self.assertNotIn("agent complete", self.output.getvalue())
        self.output.seek(0)
        self.output.truncate(0)
        history.append({"role": "user", "content": "continue"})
        client.steps = iter(reply("Still working on the verification.") for _ in range(3))
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 8)
        self.assertEqual(self.output.getvalue().count("agent paused:"), 1)
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assert_native_results_paired(history)

    def test_fresh_hello_after_failed_or_cancelled_continue_clears_old_evidence(self):
        for error in (ReachApiError("auth failed", status=401), KeyboardInterrupt()):
            with self.subTest(error=type(error).__name__):
                self.output.seek(0)
                self.output.truncate(0)
                client, history, state = self.paused_substantive_turn()
                history.append({"role": "user", "content": "continue"})
                client.steps = iter([error])
                self.assertFalse(chat.run_agent_turn(client, history, state))
                self.assertEqual(len(client.messages), 5)
                self.output.seek(0)
                self.output.truncate(0)
                history.append({"role": "user", "content": "hello"})
                client.steps = iter([reply("Hello! What would you like to do?")])
                self.assertTrue(chat.run_agent_turn(client, history, state))
                self.assertEqual(len(client.messages), 6)
                self.assertNotIn("agent paused:", self.output.getvalue())
                history.append({"role": "user", "content": "continue"})
                client.steps = iter([reply("Ready when you are.")])
                self.assertTrue(chat.run_agent_turn(client, history, state))
                self.assertEqual(len(client.messages), 7)
                self.assertNotIn("agent paused:", self.output.getvalue())

    def test_fresh_prose_does_not_recover_from_previous_turn_native_result(self):
        call = native_read()
        history = [{"role": "user", "content": "Read the fixture"},
                   {"role": "assistant", "content": "", "tool_calls": [call]},
                   {"role": "tool", "tool_call_id": call["id"], "content": "local fixture"},
                   {"role": "assistant", "content": envelope("Read finished.")},
                   {"role": "user", "content": "hello"}]
        old_history = copy.deepcopy(history)
        client = self.client(reply("Hello! What would you like to do?"))
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 1)
        self.assertFalse(any("without an action" in str(m.get("content")) for m in history))
        self.assertTrue(all(message in history for message in old_history))

    def test_fresh_prose_does_not_recover_from_previous_turn_fenced_result(self):
        history = [{"role": "user", "content": "Read the fixture"},
                   {"role": "assistant", "content": '```tool\n{"action":"read","path":"note.txt"}\n```'},
                   {"role": "user", "content": "[tool result]\ntool read: local fixture"},
                   {"role": "assistant", "content": envelope("Read finished.")},
                   {"role": "user", "content": "hello"}]
        client = self.client(reply("Hello! What would you like to do?"))
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 1)
        self.assertFalse(any("without an action" in str(m.get("content")) for m in history))

    def test_evolving_plan_is_not_stopped_as_a_duplicate(self):
        items = [{"text": "Verify distinct item %d" % i, "status": "pending"}
                 for i in range(6)]
        steps = [reply(calls=[native_tool("todo_write", {"todos": copy.deepcopy(items)}, "initial")])]
        for index in range(6):
            items[index]["status"] = "completed"
            steps.append(reply(calls=[native_tool("todo_write", {"todos": copy.deepcopy(items)},
                                                   "advance_%d" % index)]))
        steps.append(reply(envelope("All requested verification finished.")))
        client = self.client(*steps)
        self.assertTrue(chat.run_agent_turn(client, self.history("Verify several changes"), chat.AgentState()))
        self.assertEqual(len(client.messages), len(steps))
        self.assertNotIn("agent paused:", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("agent complete"), 1)

    def test_changed_read_observations_are_real_progress(self):
        steps = [reply(calls=[native_read("read_%d" % i)]) for i in range(6)]
        steps += [reply(envelope("The evolving fixture was verified."))]
        client = self.client(*steps)
        observations = ["version %d\n" % i for i in range(6)]
        with mock.patch.object(chat, "run_tool", side_effect=observations):
            self.assertTrue(chat.run_agent_turn(client, self.history("Observe fixture changes"), chat.AgentState()))
        self.assertEqual(len(client.messages), len(steps))
        self.assertNotIn("agent paused:", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("agent complete"), 1)

    def test_cancelled_repeated_tool_preserves_cancel_and_never_pauses_or_completes(self):
        client = self.client(todo_reply(0), todo_reply(1), reply(envelope("Must not be consumed.")))
        history = self.history()
        real_run = chat.run_tool
        count = 0

        def stop_second(*args, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                raise KeyboardInterrupt
            return real_run(*args, **kwargs)

        with mock.patch.object(chat, "run_tool", side_effect=stop_second):
            self.assertFalse(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        self.assertEqual(self.output.getvalue().count("stopped"), 1)
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assertNotIn("agent paused:", self.output.getvalue())
        self.assert_native_results_paired(history)

    def test_failed_partial_duplicate_response_never_runs_its_tool(self):
        partial = todo_reply(1)
        partial["tool_calls"][0]["function"]["arguments"] = '{"todos":['
        client = self.client(todo_reply(0),
                             ReachTransientError("cut", partial=partial, status="cut"),
                             ReachApiError("auth failed", status=401))
        history = self.history()
        real_run = chat.run_tool
        with mock.patch.object(chat, "run_tool", wraps=real_run) as tools:
            self.assertFalse(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 3)
        self.assertEqual(tools.call_count, 1)
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assertNotIn("agent paused:", self.output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
