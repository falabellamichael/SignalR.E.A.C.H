"""Offline coverage for dedicated agent_status JSON and run display ownership."""

import json
import unittest
from tests import test_reach_cli_agent_completion as helpers

chat = helpers.chat
envelope = helpers.envelope
native_read = helpers.native_read
reply = helpers.reply


def dedicated(status="complete", **details):
    return "```json\n%s\n```" % json.dumps(dict(agent_status=status, **details))


class DedicatedCompletionParserTests(unittest.TestCase):
    def test_screenshot_dedicated_key_without_description_is_terminal(self):
        self.assertEqual(chat.parse_tool_blocks(dedicated()),
                         ([], {"agent_status": "complete", "status": "complete"}, False))

    def test_dedicated_key_normalizes_aliases_and_existing_description_fields(self):
        for status in ("complete", "completed", "done", "finished", "success"):
            for field in ("summary", "message"):
                with self.subTest(status=status, field=field):
                    _actions, parsed, invalid = chat.parse_tool_blocks(
                        dedicated(status, **{field: "Read and checked note.txt."}))
                    self.assertFalse(invalid)
                    self.assertEqual(parsed["status"], "complete")
                    self.assertEqual(parsed["summary"], "Read and checked note.txt.")

    def test_dedicated_blocked_retains_reason(self):
        _actions, parsed, _invalid = chat.parse_tool_blocks(
            dedicated("blocked", reason="Choose the required environment."))
        self.assertEqual(parsed["status"], "blocked")
        self.assertEqual(parsed["reason"], "Choose the required environment.")

    def test_unknown_extra_fields_and_conflicting_controls_remain_data(self):
        payloads = [
            {"agent_status": "complete", "invoice_id": "42"},
            {"agent_status": "complete", "status": "blocked"},
            {"agent_status": "complete", "summary": 42},
            {"agent_status": "pondering"},
        ]
        for data in payloads:
            text = "```json\n%s\n```" % json.dumps(data)
            with self.subTest(data=data):
                self.assertEqual(chat.parse_tool_blocks(text), ([], None, False))
                emitted = []
                display = chat._AgentReplyDisplay(emitted.append)
                for char in text:
                    display.feed(char)
                display.finish()
                self.assertEqual("".join(emitted), text)

    def test_quoted_examples_and_substantive_prose_keep_their_original_bytes(self):
        texts = ["Example:\n" + dedicated(), dedicated() + "\nThis is an example.",
                 "````markdown\n" + dedicated() + "\n````",
                 "\n".join("    " + line for line in dedicated().splitlines())]
        for text in texts:
            with self.subTest(text=text):
                self.assertEqual(chat.parse_tool_blocks(text), ([], None, False))
                emitted = []
                display = chat._AgentReplyDisplay(emitted.append)
                for char in text:
                    display.feed(char)
                display.finish()
                self.assertEqual("".join(emitted), text)

    def test_metadata_never_leaks_at_any_stream_boundary(self):
        for text in (dedicated(), dedicated("complete", summary="Verified."),
                     envelope("", language="agent_status")):
            for cut in range(len(text) + 1):
                with self.subTest(text=text, cut=cut):
                    emitted = []
                    display = chat._AgentReplyDisplay(emitted.append)
                    display.feed(text[:cut])
                    display.feed(text[cut:])
                    display.finish()
                    self.assertEqual("".join(emitted), "")


class DedicatedCompletionTurnTests(unittest.TestCase):
    setUp = helpers.AgentCompletionTurnTests.setUp
    client = helpers.AgentCompletionTurnTests.client
    history = helpers.AgentCompletionTurnTests.history

    def assert_single(self):
        visible = self.output.getvalue()
        self.assertEqual(visible.count("agent complete:"), 1, visible)
        self.assertNotIn("```json", visible)
        self.assertNotIn('"agent_status"', visible)
        return visible

    def test_screenshot_following_prior_results_stops_at_first_control(self):
        client = self.client(reply("Sure! How can I assist you today?"), reply(dedicated()))
        history = self.history() + [{"role": "user", "content": "[tool result]\nPrevious task result"}]
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        self.assertEqual(history[-1]["content"], dedicated())
        self.assertIn("agent complete: Sure! How can I assist you today?", self.assert_single())

    def test_native_tool_then_descriptionless_completion_does_not_repeat_or_invent_work(self):
        client = self.client(reply(calls=[native_read()]), reply(dedicated()))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        visible = self.assert_single()
        self.assertIn("The model reported completion without a description.", visible)
        self.assertNotIn("verified", visible.lower())

    def test_canonical_descriptionless_completion_uses_current_run_answer(self):
        client = self.client(reply("Read note.txt and confirmed its fixture content."),
                             reply('```agent_status\n{"status":"complete"}\n```'))
        history = self.history() + [{"role": "user", "content": "[tool result]\nCurrent task"}]
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertIn("agent complete: Read note.txt and confirmed its fixture content.", self.assert_single())

    def test_previous_turn_answer_is_not_reused_as_current_completion_description(self):
        client = self.client(reply(dedicated()))
        history = [{"role": "assistant", "content": "Earlier unrelated work was verified."}] + self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertNotIn("Earlier unrelated work", self.assert_single())

    def test_dedicated_completion_cannot_finish_open_plan(self):
        state = chat.AgentState()
        state.todos = [{"text": "Unfinished fixture work", "status": "pending"}]
        client = self.client(reply(dedicated()), reply(dedicated("blocked", reason="Approval is needed.")))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 2)
        self.assertNotIn("agent complete:", self.output.getvalue())
        self.assertIn("Completion rejected", client.messages[1][-1]["content"])
        self.assertIn("Approval is needed.", self.output.getvalue())

    def test_cancelled_partial_metadata_does_not_publish_completion(self):
        def cancel(on_text):
            on_text(dedicated())
            raise KeyboardInterrupt
        client = self.client(cancel)
        self.assertFalse(chat.run_agent_turn(client, self.history(), chat.AgentState()))
        self.assertNotIn("agent complete:", self.output.getvalue())
        self.assertNotIn('"agent_status"', self.output.getvalue())

    def test_description_is_retained_and_existing_banner_format_is_unchanged(self):
        client = self.client(reply(dedicated(summary="Read and checked note.txt.")))
        self.assertTrue(chat.run_agent_turn(client, self.history(), chat.AgentState()))
        self.assertIn("  \u23f9 agent complete: Read and checked note.txt.", self.assert_single())


if __name__ == "__main__":
    unittest.main()
