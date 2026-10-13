"""Offline regressions for the extra bookkeeping rounds after a final answer.

Use the real agent loop and file/todo tools. The scripted client rejects an
unexpected request and the shared fixture forbids network access.
"""

import json
import unittest
from unittest import mock

from tests import test_reach_cli_agent_completion as fixtures
from tests.test_reach_cli_finish_reason import Response, event
from reach_cli import chat
from reach_cli.client import ReachClient, ReachApiError, ReachTransientError


ANSWER = (
    "The local fixture contains `local fixture`.\n\n"
    "I read note.txt from the selected workpath and verified its contents. "
    "It is a single-line text file."
)
BLOCKED = fixtures.envelope("The remaining verification is unavailable.", "blocked")


def finished(text=ANSWER, reason="stop", calls=()):
    result = fixtures.reply(text, calls)
    result["finish_reason"] = reason
    return result


def completed_plan(fenced=False):
    args = {"todos": [{"text": "Read and summarize note.txt", "status": "completed"}]}
    if fenced:
        return fixtures.reply("```tool\n" + json.dumps(dict(action="todo_write", **args)) + "\n```")
    return fixtures.reply(calls=[{
        "id": "final_plan", "type": "function", "function": {
            "name": "todo_write", "arguments": json.dumps(args)}}])


class AgentAnswerStopTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.AgentCompletionTurnTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.output = self.fixture.output

    def client(self, *steps):
        return self.fixture.client(*steps)

    def history(self):
        return [{"role": "user", "content": "Read and summarize note.txt."}]

    def assert_answer_once(self, history):
        visible = self.output.getvalue()
        for paragraph in ANSWER.split("\n\n"):
            self.assertEqual(visible.count(paragraph), 1, visible)
        self.assertEqual(sum(message.get("content") == ANSWER for message in history), 1)
        self.assertNotIn("agent paused:", visible)
        self.assertNotIn("agent round limit", visible)
        self.assertFalse(any("without an action" in str(message.get("content"))
                             for message in history))

    def test_final_answer_after_read_does_not_request_redundant_plan_or_status(self):
        for fenced in (False, True):
            with self.subTest(fenced=fenced):
                self.output.seek(0)
                self.output.truncate(0)
                read = (fixtures.reply('```tool\n{"action":"read","path":"note.txt"}\n```')
                        if fenced else fixtures.reply(calls=[fixtures.native_read()]))
                client = self.client(read, finished(), completed_plan(), completed_plan(),
                                     fixtures.reply(fixtures.envelope("Already answered.")))
                history, state = self.history(), chat.AgentState()
                self.assertTrue(chat.run_agent_turn(client, history, state))
                self.assertEqual(len(client.messages), 2, self.output.getvalue())
                self.assertEqual(state.todos, [])
                self.assert_answer_once(history)

    def test_clean_final_answer_with_completed_plan_has_no_extra_request(self):
        client = self.client(fixtures.reply(calls=[fixtures.native_read()]), finished())
        state = chat.AgentState()
        state.todos = [{"text": "Read and summarize note.txt", "status": "completed"}]
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 2)
        self.assert_answer_once(history)

    def test_open_plan_can_close_once_after_the_delivered_final_answer(self):
        for fenced in (False, True):
            with self.subTest(fenced=fenced):
                self.output.seek(0)
                self.output.truncate(0)
                client = self.client(fixtures.reply(calls=[fixtures.native_read()]),
                                     finished(), completed_plan(fenced=fenced))
                state = chat.AgentState()
                state.todos = [{"text": "Read and summarize note.txt", "status": "in_progress"}]
                history = self.history()
                self.assertTrue(chat.run_agent_turn(client, history, state))
                self.assertEqual(len(client.messages), 3, self.output.getvalue())
                self.assertEqual(state.todos[0]["status"], "completed")
                for paragraph in ANSWER.split("\n\n"):
                    self.assertEqual(self.output.getvalue().count(paragraph), 1)
                self.assertNotIn("agent paused:", self.output.getvalue())
                if not fenced:
                    self.assertEqual(history[-1]["role"], "tool")
                    self.assertEqual(history[-1]["tool_call_id"], "final_plan")

    def test_open_plan_does_not_accept_prose_stop_as_task_completion(self):
        client = self.client(fixtures.reply(calls=[fixtures.native_read()]),
                             finished(), fixtures.reply(BLOCKED))
        state = chat.AgentState()
        state.todos = [{"text": "Verify the remaining work", "status": "pending"}]
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 3)
        self.assertEqual(state.todos[0]["status"], "pending")
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)

    def test_final_answer_and_last_plan_update_can_finish_in_the_same_response(self):
        for fenced in (False, True):
            with self.subTest(fenced=fenced):
                self.output.seek(0)
                self.output.truncate(0)
                plan = completed_plan(fenced=fenced)
                last = finished(ANSWER + ("\n" + plan["content"] if fenced else ""),
                                calls=plan["tool_calls"])
                client = self.client(fixtures.reply(calls=[fixtures.native_read()]), last)
                state = chat.AgentState()
                state.todos = [{"text": "Read and summarize note.txt", "status": "in_progress"}]
                history = self.history()
                self.assertTrue(chat.run_agent_turn(client, history, state))
                self.assertEqual(len(client.messages), 2)
                self.assertEqual(state.todos[0]["status"], "completed")
                for paragraph in ANSWER.split("\n\n"):
                    self.assertEqual(self.output.getvalue().count(paragraph), 1)
                self.assertNotIn("agent paused:", self.output.getvalue())

    def test_final_answer_with_failed_same_response_plan_update_cannot_complete(self):
        for fenced in (False, True):
            with self.subTest(fenced=fenced):
                self.output.seek(0)
                self.output.truncate(0)
                tool = '```tool\n{"action":"todo_write","todos":42}\n```'
                calls = [{"id": "failed_plan", "type": "function", "function": {
                    "name": "todo_write", "arguments": '{"todos": 42}'}}]
                last = finished(ANSWER + ("\n" + tool if fenced else ""),
                                calls=() if fenced else calls)
                client = self.client(fixtures.reply(calls=[fixtures.native_read()]),
                                     last, fixtures.reply(BLOCKED))
                state = chat.AgentState()
                state.todos = [{"text": "Read and summarize note.txt", "status": "in_progress"}]
                self.assertTrue(chat.run_agent_turn(client, self.history(), state))
                self.assertEqual(len(client.messages), 3)
                self.assertEqual(state.todos[0]["status"], "in_progress")
                self.assertNotIn("agent complete", self.output.getvalue())
                self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)

    def test_completed_checklist_alone_does_not_invent_a_delivered_answer(self):
        client = self.client(fixtures.reply(calls=[fixtures.native_read()]),
                             completed_plan(), fixtures.reply(BLOCKED))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 3)
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)

    def test_new_substantive_work_invalidates_the_earlier_answer_before_plan_close(self):
        final_answer = "I checked the fixture again; it still contains `local fixture`."
        client = self.client(fixtures.reply(calls=[fixtures.native_read("first_read")]),
                             finished(), fixtures.reply(calls=[fixtures.native_read("second_read")]),
                             completed_plan(), finished(final_answer))
        state = chat.AgentState()
        state.todos = [{"text": "Read and summarize note.txt", "status": "in_progress"}]
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 5)
        self.assertEqual(history[-1]["content"], final_answer)
        self.assertEqual(self.output.getvalue().count(final_answer), 1)

    def test_failed_final_plan_update_does_not_accept_the_previous_answer(self):
        invalid_plan = fixtures.reply(calls=[{
            "id": "bad_plan", "type": "function", "function": {
                "name": "todo_write", "arguments": '{"todos": 42}'}}])
        client = self.client(fixtures.reply(calls=[fixtures.native_read()]),
                             finished(), invalid_plan, fixtures.reply(BLOCKED))
        state = chat.AgentState()
        state.todos = [{"text": "Read and summarize note.txt", "status": "in_progress"}]
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 4)
        self.assertEqual(state.todos[0]["status"], "in_progress")
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)

    def test_length_filter_and_missing_finish_metadata_do_not_claim_final_answer(self):
        for reason in ("length", "content_filter", "unrecognized_provider_reason", None):
            with self.subTest(reason=reason):
                self.output.seek(0)
                self.output.truncate(0)
                answer = finished(reason=reason) if reason else fixtures.reply(ANSWER)
                client = self.client(fixtures.reply(calls=[fixtures.native_read()]),
                                     answer, fixtures.reply(BLOCKED))
                history = self.history()
                self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
                self.assertNotIn("agent complete", self.output.getvalue())
                if reason is None:
                    self.assertEqual(len(client.messages), 3)
                    self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)
                else:
                    self.assertEqual(len(client.messages), 2)
                    self.assertEqual(self.output.getvalue().count("agent paused:"), 1)

    def test_invalid_tool_output_cannot_be_accepted_as_a_clean_final_answer(self):
        malformed = ANSWER + '\n```tool\n{"action": "read", broken}\n```'
        client = self.client(fixtures.reply(calls=[fixtures.native_read()]),
                             finished(malformed), fixtures.reply(BLOCKED))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 3)
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)

    def test_unfinished_or_malformed_control_is_not_a_final_prose_answer(self):
        controls = [
            '```tool\n{"action": "read", "path": "note.txt"}',
            '```tool\n{"path": "note.txt"}\n```',
            '```agent_status\n{"status": "complete", "summary": "Still unfinished"}',
            '```agent_status\n{"status": "unknown"}\n```',
        ]
        for control in controls:
            with self.subTest(control=control):
                self.output.seek(0)
                self.output.truncate(0)
                client = self.client(fixtures.reply(calls=[fixtures.native_read()]),
                                     finished(ANSWER + "\n" + control), fixtures.reply(BLOCKED))
                self.assertTrue(chat.run_agent_turn(client, self.history(), chat.AgentState()))
                self.assertEqual(len(client.messages), 3)
                self.assertNotIn("agent complete", self.output.getvalue())
                self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)

    def test_control_examples_inside_code_remain_a_valid_final_answer(self):
        texts = [
            "Use the following literal example:\n````markdown\n"
            '```agent_status\n{"status":"example"}\n```\n````',
            'An indented example:\n    ```tool\n    {"path":"example"}\n    ```',
            'Use the following literal example:\n````markdown\n'
            '```tool\n{"action":"read","path":"note.txt"}\n```\n````',
        ]
        for text in texts:
            with self.subTest(text=text):
                self.output.seek(0)
                self.output.truncate(0)
                client = self.client(fixtures.reply(calls=[fixtures.native_read()]), finished(text))
                history = self.history()
                with mock.patch.object(chat, "run_tool", wraps=chat.run_tool) as run_tool:
                    self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
                self.assertEqual(run_tool.call_count, 1)  # only the first real read
                self.assertEqual(run_tool.call_args.args[:2], ("read", {"path": "note.txt"}))
                self.assertEqual(len(client.messages), 2)
                self.assertEqual(history[-1]["content"], text)
                self.assertNotIn("agent paused:", self.output.getvalue())

    def test_thought_without_visible_answer_does_not_complete_from_clean_stop(self):
        answer = finished("")
        answer["thought"] = "The read result has been considered."
        client = self.client(fixtures.reply(calls=[fixtures.native_read()]),
                             answer, fixtures.reply(BLOCKED))
        self.assertTrue(chat.run_agent_turn(client, self.history(), chat.AgentState()))
        self.assertEqual(len(client.messages), 3)
        self.assertNotIn("agent complete", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)

    def test_native_call_with_stop_still_runs_and_its_result_must_be_observed(self):
        client = self.client(finished("I will read the fixture.", calls=[fixtures.native_read()]),
                             finished())
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        results = [message for message in client.messages[1] if message.get("role") == "tool"]
        self.assertEqual(len(results), 1)
        self.assertIn("local fixture", results[0]["content"])
        self.assert_answer_once(history)

    def test_failed_stream_with_final_looking_partial_does_not_complete(self):
        client = self.client(fixtures.reply(calls=[fixtures.native_read()]),
                             ReachTransientError("cut", partial=finished(), status="cut"),
                             ReachApiError("auth failed", status=401))
        with mock.patch.object(chat, "_set_pet_activity") as activity:
            self.assertFalse(chat.run_agent_turn(client, self.history(), chat.AgentState()))
        self.assertEqual(len(client.messages), 3)
        self.assertNotIn(mock.call("complete"), activity.call_args_list)
        self.assertNotIn("agent complete", self.output.getvalue())

    def test_real_http_client_stops_after_observing_read_and_delivering_final_answer(self):
        for stream in (True, False):
            with self.subTest(stream=stream):
                self.output.seek(0)
                self.output.truncate(0)
                client = ReachClient("http://fixture.invalid/v1", model="fixture", no_stream=not stream)
                client.agent = True
                client.workpath = str(self.fixture.work)
                call = fixtures.native_read()
                if stream:
                    responses = [
                        Response([event({"tool_calls": [call]}),
                                  event(finish_reason="tool_calls"), "data: [DONE]\n"]),
                        Response([event({"content": ANSWER[:24]}),
                                  event({"content": ANSWER[24:]}),
                                  event(finish_reason="stop"), "data: [DONE]\n"]),
                    ]
                else:
                    responses = [Response(body={"choices": [{
                        "message": message, "finish_reason": reason}]})
                        for message, reason in (({"content": "", "tool_calls": [call]}, "tool_calls"),
                                                ({"content": ANSWER}, "stop"))]
                history = self.history()
                with mock.patch("urllib.request.urlopen", side_effect=responses) as request:
                    self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
                self.assertEqual(request.call_count, 2)
                payloads = [json.loads(item.args[0].data.decode("utf-8"))
                            for item in request.call_args_list]
                self.assertEqual([payload["stream"] for payload in payloads], [stream, stream])
                results = [message for message in payloads[1]["messages"] if message["role"] == "tool"]
                self.assertEqual(len(results), 1)
                self.assertEqual(results[0]["tool_call_id"], call["id"])
                self.assertIn("local fixture", results[0]["content"])
                self.assert_answer_once(history)

    def test_real_http_client_does_not_execute_truncated_or_filtered_tool_call(self):
        for reason in ("length", "content_filter"):
            for stream in (True, False):
                with self.subTest(reason=reason, stream=stream):
                    self.output.seek(0)
                    self.output.truncate(0)
                    client = ReachClient("http://fixture.invalid/v1", model="fixture", no_stream=not stream)
                    client.agent = True
                    client.workpath = str(self.fixture.work)
                    message = {"content": "", "tool_calls": [fixtures.native_read()]}
                    response = (Response([event(message), event(finish_reason=reason), "data: [DONE]\n"])
                                if stream else Response(body={"choices": [{
                                    "message": message, "finish_reason": reason}]}))
                    history = self.history()
                    with mock.patch("urllib.request.urlopen", side_effect=[response]) as request:
                        with mock.patch.object(chat, "run_tool") as run_tool:
                            self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
                    request.assert_called_once()
                    run_tool.assert_not_called()
                    self.assertNotIn("agent complete", self.output.getvalue())
                    self.assertEqual(self.output.getvalue().count("agent paused:"), 1)
                    self.assertFalse(any(message.get("tool_calls") for message in history))


if __name__ == "__main__":
    unittest.main()
