"""Offline regressions for one visible agent completion per user turn.

The screenshot failure was a standalone ```json terminal envelope following
tool results. These scripts reject extra requests and never contact a provider
or execute shell commands. Accepted metadata must stay in conversation history.
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

from reach_cli import chat, terminal  # noqa: E402
from reach_cli.client import ReachClient, ReachApiError, ReachTransientError  # noqa: E402


def envelope(message="Verified the requested work.", status="complete", language="json"):
    return "```%s\n%s\n```" % (language, json.dumps({"status": status, "message": message}))


def reply(text="", calls=()):
    return {"content": text, "tool_calls": list(calls)}


def native_read(call_id="read_fixture"):
    return {"id": call_id, "type": "function", "function": {
        "name": "read", "arguments": json.dumps({"path": "note.txt"})}}


class ScriptClient:
    """Exact response script: an accidental extra model round is a failure."""

    def __init__(self, steps, workpath="", agent=True):
        self.steps = iter(steps)
        self.messages = []
        self.base = "http://fixture.invalid/v1"
        self.model = "fixture"
        self.system = None
        self.agent = agent
        self.workpath = workpath

    def complete(self, messages, tools=None, on_text=None):
        self.messages.append(copy.deepcopy(messages))
        try:
            step = next(self.steps)
        except StopIteration:
            raise AssertionError("unexpected extra model request")
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


class NoWaitIndicator:
    def __init__(self, *args, **kwargs):
        pass

    def start(self):
        pass

    def stop(self):
        pass


class CompletionParserTests(unittest.TestCase):
    def test_screenshot_standalone_json_message_is_completion(self):
        actions, status, invalid = chat.parse_tool_blocks(envelope())
        self.assertEqual(actions, [])
        self.assertFalse(invalid)
        self.assertEqual(status["status"], "complete")
        self.assertEqual(status["summary"], "Verified the requested work.")

    def test_standalone_json_blocked_message_maps_to_reason(self):
        actions, status, invalid = chat.parse_tool_blocks(envelope("Need the local service running.", "blocked"))
        self.assertEqual(actions, [])
        self.assertFalse(invalid)
        self.assertEqual(status["status"], "blocked")
        self.assertEqual(status["reason"], "Need the local service running.")

    def test_existing_agent_status_summary_and_alias_still_work(self):
        text = '```agent_status\n{"status":"done","summary":"Checked locally."}\n```'
        actions, status, invalid = chat.parse_tool_blocks(text)
        self.assertEqual((actions, invalid), ([], False))
        self.assertEqual(status, {"status": "complete", "summary": "Checked locally."})

    def test_user_decision_prompt_requests_blocked_status_with_a_reason(self):
        _actions, status, _invalid = chat.parse_tool_blocks(chat.AGENT_SYSTEM_PROMPT)
        self.assertEqual(status["status"], "blocked")
        self.assertTrue(isinstance(status.get("reason"), str) and status["reason"].strip())
        self.assertNotIn("ask in plain prose and stop", chat.AGENT_SYSTEM_PROMPT.lower())
        self.assertNotIn("do not emit agent_status", chat.AGENT_SYSTEM_PROMPT.lower())

    def test_canonical_agent_status_message_maps_to_summary(self):
        text = envelope("Canonical message was checked.", language="agent_status")
        actions, status, invalid = chat.parse_tool_blocks(text)
        self.assertEqual((actions, invalid), ([], False))
        self.assertEqual(status["status"], "complete")
        self.assertEqual(status["summary"], "Canonical message was checked.")

    def test_compatible_json_rejects_any_present_nonstring_detail(self):
        for field, value in (("reason", {"needed": "permission"}), ("summary", 42),
                             ("message", ["array content"])):
            with self.subTest(field=field):
                data = {"status": "complete", "summary": "Otherwise valid explanation.",
                        "message": "Otherwise valid message.", field: value}
                text = "```json\n%s\n```" % json.dumps(data)
                self.assertEqual(chat.parse_tool_blocks(text), ([], None, False))

    def test_compatible_json_requires_a_separate_closing_fence_line(self):
        text = '```json\n{"status":"complete","message":"Inline close is data."}```'
        self.assertEqual(chat.parse_tool_blocks(text), ([], None, False))

    def test_canonical_inline_close_keeps_existing_parser_acceptance(self):
        text = '```agent_status\n{"status":"complete","message":"Canonical inline close."}```'
        actions, status, invalid = chat.parse_tool_blocks(text)
        self.assertEqual((actions, invalid), ([], False))
        self.assertEqual(status["status"], "complete")
        self.assertEqual(status["summary"], "Canonical inline close.")

    def test_indented_status_and_json_examples_are_not_run_control(self):
        for indent in ("    ", "     ", "\t", " \t", "\t    "):
            for language in ("agent_status", "json"):
                with self.subTest(indent=indent, language=language):
                    text = "\n".join(indent + line for line in envelope("Indented example.", language=language).splitlines())
                    self.assertEqual(chat.parse_tool_blocks(text), ([], None, False))

    def test_outer_code_fences_keep_nested_status_nonterminal_with_longer_closes(self):
        nested = envelope("EXAMPLE", language="agent_status")
        texts = [
            "````markdown\n" + nested + "\n`````\n",
            "~~~~markdown\n" + nested + "\n~~~~~\n",
            ('~~~python\nprint(1)\n~~~~\n~~~~markdown\n~~~\n'
             '```agent_status\n{"status":"complete","summary":"EXAMPLE"}\n```\n~~~~\n'),
        ]
        for text in texts:
            with self.subTest(text=text):
                self.assertEqual(chat.parse_tool_blocks(text), ([], None, False))

    def test_literal_triple_backticks_in_summary_do_not_end_real_control(self):
        summary = "Verified text containing ```literal fence``` safely."
        for language in ("agent_status", "json"):
            with self.subTest(language=language):
                text = "```%s\n%s\n```" % (language, json.dumps({"status": "complete", "summary": summary}))
                actions, status, invalid = chat.parse_tool_blocks(text)
                self.assertEqual((actions, invalid), ([], False))
                self.assertEqual(status["status"], "complete")
                self.assertEqual(status["summary"], summary)

    def test_compatible_json_mixed_case_label_and_longer_close_are_accepted(self):
        for label in ("Json", "JSON", "jSoN"):
            for closing in ("```", "````", "``````"):
                with self.subTest(label=label, closing=closing):
                    text = "```%s\n%s\n%s" % (label, json.dumps({"status": "complete", "summary": "Mixed case checked."}), closing)
                    actions, status, invalid = chat.parse_tool_blocks(text)
                    self.assertEqual((actions, invalid), ([], False))
                    self.assertEqual(status["summary"], "Mixed case checked.")

    def test_json_terminal_envelope_requires_nonempty_explanation(self):
        for data in ({"status": "complete"}, {"status": "complete", "message": "  "},
                     {"status": "complete", "message": 42}, {"status": "complete", "summary": None},
                     {"status": "pondering", "message": "Still thinking."}):
            with self.subTest(data=data):
                text = "```json\n%s\n```" % json.dumps(data)
                self.assertEqual(chat.parse_tool_blocks(text), ([], None, False))

    def test_json_examples_actions_and_business_payloads_are_not_run_control(self):
        terminal_json = envelope()
        texts = [
            "Here is a JSON example:\n" + terminal_json,
            terminal_json + "\nThis is an example, not the result.",
            terminal_json + "\n" + terminal_json,
            '```json\n{"status":"complete","message":"Receipt paid.","invoice_id":"42"}\n```',
            '```json\n{"status":"complete","message":"Read this.","action":"read","path":"note.txt"}\n```',
            '{"status":"complete","message":"A bare object is data."}',
            '```json\n[{"status":"complete","message":"Array data."}]\n```',
            '```json\n{broken JSON}\n```',
        ]
        for text in texts:
            with self.subTest(text=text):
                self.assertEqual(chat.parse_tool_blocks(text), ([], None, False))


class AgentReplyDisplayTests(unittest.TestCase):
    def display(self):
        emitted = []
        return chat._AgentReplyDisplay(emitted.append), emitted

    def test_protocol_envelope_is_hidden_at_every_possible_chunk_split(self):
        texts = [envelope(), '```agent_status\n{"status":"complete","summary":"Checked."}\n```']
        for text in texts:
            for cut in range(len(text) + 1):
                with self.subTest(text=text, cut=cut):
                    display, emitted = self.display()
                    display.feed(text[:cut])
                    display.feed(text[cut:])
                    self.assertEqual("".join(emitted), "")
                    display.finish()
                    self.assertEqual("".join(emitted), "")

    def test_character_chunks_and_delayed_fence_do_not_leak_metadata(self):
        display, emitted = self.display()
        for char in " \n" + envelope("One completion only.") + "\n ":
            display.feed(char)
            self.assertEqual("".join(emitted), "")
        display.finish()
        self.assertEqual("".join(emitted), "")

    def test_plain_prose_line_is_emitted_before_finish(self):
        display, emitted = self.display()
        display.feed("The result is ready.\n")
        self.assertEqual("".join(emitted), "The result is ready.\n")
        display.finish()
        self.assertEqual("".join(emitted), "The result is ready.\n")

    def test_partial_plain_prose_streams_without_a_newline(self):
        display, emitted = self.display()
        display.feed("The ")
        self.assertEqual("".join(emitted), "The ")
        display.feed("result")
        self.assertEqual("".join(emitted), "The result")
        display.feed(" is ready.")
        self.assertEqual("".join(emitted), "The result is ready.")
        display.finish()
        self.assertEqual("".join(emitted), "The result is ready.")

    def test_ordinary_code_body_streams_while_metadata_candidates_stay_hidden(self):
        display, emitted = self.display()
        display.feed("```python\n")
        for char in "print('hello')":
            display.feed(char)
        self.assertEqual("".join(emitted), "```python\nprint('hello')")
        display.feed("\n```\n")
        expected = "```python\nprint('hello')\n```\n"
        self.assertEqual("".join(emitted), expected)
        for char in envelope("Metadata remains hidden.", language="agent_status"):
            display.feed(char)
            self.assertEqual("".join(emitted), expected)
        display.finish()
        self.assertEqual("".join(emitted), expected)

    def test_character_chunks_preserve_prose_bytes_and_detect_status_after_newline(self):
        display, emitted = self.display()
        before = "  First line.\n\tUnicode café 界 🙂 with `inline` code.\n"
        after = "The next explanation is visible without a final newline."
        text = before + envelope("Hidden after prose.", language="agent_status") + "\n" + after
        for char in text:
            display.feed(char)
            self.assertNotIn('"status"', "".join(emitted))
            self.assertNotIn("Hidden after prose.", "".join(emitted))
        self.assertEqual("".join(emitted), before + after)
        display.finish()
        self.assertEqual("".join(emitted), before + after)

    def test_json_examples_and_nonterminal_payloads_remain_visible(self):
        texts = [
            "An example follows:\n" + envelope(),
            envelope() + "\nUse this JSON as an example.",
            '```json\n{"status":"complete","message":"Receipt paid.","invoice_id":"42"}\n```',
            '```json\n{"action":"read","path":"note.txt"}\n```',
            '```json\n{"status":"complete","message":" "}\n```',
            '```json\n{unfinished',
        ]
        for text in texts:
            with self.subTest(text=text):
                display, emitted = self.display()
                for start in range(0, len(text), 3):
                    display.feed(text[start:start + 3])
                display.finish()
                self.assertEqual("".join(emitted), text)

    def test_nonstring_json_details_are_visible_even_with_an_explanation(self):
        for field, value in (("reason", {"needed": "permission"}), ("summary", 42),
                             ("message", ["array content"])):
            with self.subTest(field=field):
                data = {"status": "complete", "summary": "Otherwise valid explanation.",
                        "message": "Otherwise valid message.", field: value}
                text = "```json\n%s\n```" % json.dumps(data)
                display, emitted = self.display()
                for char in text:
                    display.feed(char)
                display.finish()
                self.assertEqual("".join(emitted), text)

    def test_json_inline_close_remains_visible(self):
        text = '```json\n{"status":"complete","message":"Inline close is data."}```'
        display, emitted = self.display()
        for char in text:
            display.feed(char)
        display.finish()
        self.assertEqual("".join(emitted), text)

    def test_canonical_inline_close_is_hidden_and_following_prose_is_preserved(self):
        text = ('```agent_status\n{"status":"complete","message":"Hidden metadata."}```\n'
                'The following explanation remains visible.\n')
        for cut in range(len(text) + 1):
            with self.subTest(cut=cut):
                display, emitted = self.display()
                display.feed(text[:cut])
                display.feed(text[cut:])
                display.finish()
                self.assertEqual("".join(emitted), "The following explanation remains visible.\n")

    def test_indented_status_and_json_examples_keep_exact_bytes(self):
        for indent in ("    ", "     ", "\t", " \t", "\t    "):
            for language in ("agent_status", "json"):
                with self.subTest(indent=indent, language=language):
                    text = "\n".join(indent + line for line in envelope("Indented example.", language=language).splitlines())
                    display, emitted = self.display()
                    for char in text:
                        display.feed(char)
                    display.finish()
                    self.assertEqual("".join(emitted), text)

    def test_outer_code_fences_preserve_nested_status_and_longer_closing_runs(self):
        nested = envelope("EXAMPLE", language="agent_status")
        texts = [
            "````markdown\n" + nested + "\n`````\n",
            "~~~~markdown\n" + nested + "\n~~~~~\n",
            ('~~~python\nprint(1)\n~~~~\n~~~~markdown\n~~~\n'
             '```agent_status\n{"status":"complete","summary":"EXAMPLE"}\n```\n~~~~\n'),
        ]
        for text in texts:
            for chunk_size in (1, 3, len(text)):
                with self.subTest(text=text, chunk_size=chunk_size):
                    display, emitted = self.display()
                    for start in range(0, len(text), chunk_size):
                        display.feed(text[start:start + chunk_size])
                    display.finish()
                    self.assertEqual("".join(emitted), text)

    def test_real_control_with_literal_triple_backticks_in_summary_is_hidden(self):
        summary = "Verified text containing ```literal fence``` safely."
        for language in ("agent_status", "json"):
            text = "```%s\n%s\n```" % (language, json.dumps({"status": "complete", "summary": summary}))
            for cut in range(len(text) + 1):
                with self.subTest(language=language, cut=cut):
                    display, emitted = self.display()
                    display.feed(text[:cut])
                    display.feed(text[cut:])
                    display.finish()
                    self.assertEqual("".join(emitted), "")

    def test_compatible_json_mixed_case_label_and_longer_close_stay_hidden(self):
        for label in ("Json", "JSON", "jSoN"):
            for closing in ("```", "````", "``````"):
                with self.subTest(label=label, closing=closing):
                    text = "```%s\n%s\n%s" % (label, json.dumps({"status": "complete", "summary": "Mixed case checked."}), closing)
                    display, emitted = self.display()
                    for char in text:
                        display.feed(char)
                    display.finish()
                    self.assertEqual("".join(emitted), "")


class AgentCompletionTurnTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.work = Path(self.tmp.name)
        (self.work / "note.txt").write_text("local fixture\n", encoding="utf-8")
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(terminal, "PAINT", terminal.Paint(False)))
        self.stack.enter_context(mock.patch.object(chat.render, "enabled", return_value=False))
        self.stack.enter_context(mock.patch.object(chat, "WaitIndicator", NoWaitIndicator))
        self.stack.enter_context(mock.patch.object(chat, "_sleep", lambda delay: None))
        self.stack.enter_context(mock.patch.object(chat, "_interruptible", side_effect=lambda fn: fn()))
        self.stack.enter_context(mock.patch.object(chat, "print_footer"))
        self.stack.enter_context(mock.patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")))
        self.output = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))

    def client(self, *steps, **kwargs):
        return ScriptClient(steps, str(self.work), **kwargs)

    def history(self):
        return [{"role": "user", "content": "Verify the local fixture."}]

    def assert_single_completion(self, summary):
        visible = self.output.getvalue()
        self.assertEqual(visible.count("agent complete:"), 1, visible)
        self.assertEqual(visible.count(summary), 1, visible)
        self.assertNotIn("```json", visible)
        self.assertNotIn("```agent_status", visible)
        self.assertNotIn('"status"', visible)
        self.assertNotIn('"message"', visible)

    def system_history(self, client):
        history = [
            {"role": "system", "content": "old system prompt"},
            {"role": "user", "content": "Earlier question"},
            {"role": "assistant", "content": "Earlier answer"},
            {"role": "system", "content": "duplicate stale system"},
            {"role": "user", "content": "Read note.txt from the workpath."},
        ]
        chat.set_system_message(history, client)
        return history

    def assert_agent_system(self, client, history):
        system = [m for m in history if m["role"] == "system"]
        self.assertEqual(len(system), 1)
        content = system[0]["content"]
        self.assertIn(chat.AGENT_SYSTEM_PROMPT, content)
        self.assertIn("The workpath is: " + str(self.work), content)
        self.assertIn("note.txt", content)
        self.assertIn(client.system or chat.DEFAULT_IDENTITY, content)

    def test_system_defaults_and_custom_prompts_always_keep_agent_protocol(self):
        for custom in (None, "", "Be brief and explain the result."):
            with self.subTest(custom=custom):
                client = self.client()
                client.system = custom
                history = [
                    {"role": "system", "content": "old prompt"},
                    {"role": "user", "content": "Keep this question"},
                    {"role": "assistant", "content": "Keep this answer"},
                    {"role": "system", "content": "another old prompt"},
                ]
                preserved = [copy.deepcopy(m) for m in history if m["role"] != "system"]
                chat.set_system_message(history, client)
                self.assert_agent_system(client, history)
                self.assertEqual([m for m in history if m["role"] != "system"], preserved)

    def test_real_client_starts_with_optional_prompt_unset_and_keeps_agent_protocol(self):
        client = ReachClient("http://fixture.invalid/v1", model="fixture", no_stream=True, key="fixture-key")
        self.assertIsNone(client.system)
        client.agent = True
        client.workpath = str(self.work)
        history = self.system_history(client)
        previous = copy.deepcopy(history)
        terminal.handle_slash("/system", client, history)
        self.assertIsNone(client.system)
        self.assertEqual(history, previous)
        self.assert_agent_system(client, history)

    def test_bare_and_whitespace_system_inspection_preserve_custom_prompt_and_history(self):
        for command in ("/system", "/system   ", "/system \t "):
            with self.subTest(command=command):
                client = self.client()
                client.system = "Be brief."
                history = self.system_history(client)
                previous = copy.deepcopy(history)
                start = len(self.output.getvalue())
                result = terminal.handle_slash(command, client, history)
                self.assertFalse(result.quit)
                self.assertIsNone(result.prompt)
                self.assertEqual(client.system, "Be brief.")
                self.assertEqual(history, previous)
                self.assertIn("Be brief.", self.output.getvalue()[start:])
                self.assert_agent_system(client, history)

    def test_bare_system_inspection_keeps_default_prompt_and_agent_mode(self):
        client = self.client()
        client.system = None
        history = self.system_history(client)
        previous = copy.deepcopy(history)
        terminal.handle_slash("/system", client, history)
        self.assertIsNone(client.system)
        self.assertTrue(client.agent)
        self.assertEqual(history, previous)
        self.assertIn("default", self.output.getvalue().lower())
        self.assert_agent_system(client, history)

    def test_system_clear_and_reset_restore_defaults_and_preserve_conversation(self):
        for command in ("/system clear", "/system reset"):
            with self.subTest(command=command):
                client = self.client()
                client.system = "Old optional custom prompt."
                history = self.system_history(client)
                preserved = [copy.deepcopy(m) for m in history if m["role"] != "system"]
                base, model, workpath = client.base, client.model, client.workpath
                terminal.handle_slash(command, client, history)
                self.assertIsNone(client.system)
                self.assertTrue(client.agent)
                self.assertEqual((client.base, client.model, client.workpath), (base, model, workpath))
                self.assertEqual([m for m in history if m["role"] != "system"], preserved)
                self.assert_agent_system(client, history)
                self.assertNotIn("Old optional custom prompt.", history[0]["content"])

    def test_legacy_and_explicit_system_set_preserve_literal_text_and_history(self):
        for command, expected in (("/system Be brief.", "Be brief."),
                                  ("/system reset with more detail", "reset with more detail"),
                                  ("/system clear old assumptions", "clear old assumptions"),
                                  ("/system set Be clear and concise.", "Be clear and concise."),
                                  ("/system set clear", "clear"), ("/system set reset", "reset")):
            with self.subTest(command=command):
                client = self.client()
                client.system = "Old optional prompt."
                history = self.system_history(client)
                preserved = [copy.deepcopy(m) for m in history if m["role"] != "system"]
                terminal.handle_slash(command, client, history)
                self.assertEqual(client.system, expected)
                self.assertEqual([m for m in history if m["role"] != "system"], preserved)
                self.assert_agent_system(client, history)

    def test_system_refresh_preserves_native_tool_results_and_completion_metadata(self):
        for command in ("/system clear", "/system reset", "/system Be brief."):
            with self.subTest(command=command):
                client = self.client()
                client.system = "Old optional prompt."
                history = [
                    {"role": "system", "content": "stale prompt"},
                    {"role": "user", "content": "Earlier fixture read"},
                    {"role": "assistant", "content": "", "tool_calls": [native_read("earlier_read")]},
                    {"role": "tool", "tool_call_id": "earlier_read", "content": "local fixture\n"},
                    {"role": "assistant", "content": envelope("Earlier turn was completed.")},
                ]
                preserved = copy.deepcopy(history[1:])
                terminal.handle_slash(command, client, history)
                self.assertEqual([m for m in history if m["role"] != "system"], preserved)
                self.assert_agent_system(client, history)

    def test_empty_system_set_prints_usage_without_mutating_state(self):
        for command in ("/system set", "/system set   ", "/system set \t "):
            with self.subTest(command=command):
                client = self.client()
                client.system = "Keep this custom prompt."
                history = self.system_history(client)
                previous = copy.deepcopy(history)
                start = len(self.output.getvalue())
                terminal.handle_slash(command, client, history)
                self.assertEqual(client.system, "Keep this custom prompt.")
                self.assertEqual(history, previous)
                self.assertIn("usage:", self.output.getvalue()[start:].lower())
                self.assert_agent_system(client, history)

    def test_each_system_variant_allows_real_fixture_read_with_native_and_text_tools(self):
        variants = (("/system", "Be brief."), ("/system   ", "Be brief."),
                    ("/system clear", None), ("/system reset", None),
                    ("/system Read and verify the fixture.", "Read and verify the fixture."),
                    ("/system set clear", "clear"), ("/system set reset", "reset"),
                    ("/system set", "Be brief."))
        for command, expected in variants:
            for transport in ("native", "text"):
                with self.subTest(command=command, transport=transport):
                    text = envelope("Fixture read remained available.")
                    tool_reply = (reply(calls=[native_read()]) if transport == "native" else
                                  reply('```tool\n{"action":"read","path":"note.txt"}\n```'))
                    client = self.client(tool_reply, reply(text))
                    client.system = "Be brief."
                    history = self.system_history(client)
                    preserved = [copy.deepcopy(m) for m in history if m["role"] != "system"]
                    start = len(self.output.getvalue())
                    terminal.handle_slash(command, client, history)
                    self.assertEqual(client.system, expected)
                    self.assertEqual([m for m in history if m["role"] != "system"], preserved)
                    self.assert_agent_system(client, history)
                    with mock.patch.object(chat, "run_tool", wraps=chat.run_tool) as tool:
                        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
                    tool.assert_called_once()
                    name, arguments, root, _ctx = tool.call_args.args
                    self.assertEqual((name, arguments, root), ("read", {"path": "note.txt"}, str(self.work)))
                    self.assertEqual(len(client.messages), 2)
                    self.assert_agent_system(client, client.messages[0])
                    results = [m["content"] for m in history if m["role"] == "tool" or
                               (m["role"] == "user" and m["content"].startswith("[tool result]"))]
                    self.assertEqual(len(results), 1)
                    self.assertIn("local fixture", results[0])
                    self.assertEqual(history[-1]["content"], text)
                    self.assertEqual(self.output.getvalue()[start:].count("agent complete:"), 1)
                    self.assertEqual(client.session_totals["turns"], 1)

    def test_screenshot_reply_after_prior_native_result_does_not_request_recovery(self):
        text = envelope("Fixture verification is complete.")
        client = self.client(reply(text))
        call = native_read()
        history = self.history() + [
            {"role": "assistant", "content": "", "tool_calls": [call]},
            {"role": "tool", "tool_call_id": call["id"], "content": "local fixture\n"},
        ]
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 1)
        self.assertEqual(history[-1], {"role": "assistant", "content": text})
        self.assertFalse(any("without an action" in str(m.get("content")) for m in history))
        self.assert_single_completion("Fixture verification is complete.")

    def test_screenshot_reply_after_prior_text_tool_result_does_not_request_recovery(self):
        text = envelope("The previous tool result was checked.")
        client = self.client(reply(text))
        history = self.history() + [{"role": "user", "content": "[tool result]\ntool read: local fixture"}]
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 1)
        self.assertEqual(history[-1]["content"], text)
        self.assert_single_completion("The previous tool result was checked.")

    def test_native_read_then_json_completion_publishes_once_and_keeps_both_messages(self):
        text = envelope("Read and checked the fixture.")
        client = self.client(reply(calls=[native_read()]), reply(text))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        results = [m for m in history if m["role"] == "tool"]
        self.assertEqual(len(results), 1)
        self.assertIn("local fixture", results[0]["content"])
        self.assertIn(results[0], client.messages[1])
        self.assertEqual(sum(m.get("content") == text for m in history), 1)
        self.assertEqual(client.session_totals["turns"], 1)
        self.assert_single_completion("Read and checked the fixture.")

    def test_text_read_then_completion_publishes_once(self):
        tool = '```tool\n{"action":"read","path":"note.txt"}\n```'
        text = envelope("Text-tool read was checked.")
        client = self.client(reply(tool), reply(text))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        self.assertTrue(any(m["role"] == "user" and m["content"].startswith("[tool result]") for m in history))
        self.assertEqual(history[-1]["content"], text)
        self.assert_single_completion("Text-tool read was checked.")

    def test_existing_agent_status_also_has_one_visible_completion(self):
        text = '```agent_status\n{"status":"complete","summary":"Original protocol checked."}\n```'
        client = self.client(reply(text))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 1)
        self.assertEqual(history[-1]["content"], text)
        self.assert_single_completion("Original protocol checked.")

    def test_canonical_message_and_inline_close_complete_once(self):
        text = '```agent_status\n{"status":"complete","message":"Canonical inline verified."}```'
        client = self.client(reply(text))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(history[-1]["content"], text)
        self.assertEqual(len(client.messages), 1)
        self.assert_single_completion("Canonical inline verified.")

    def test_retry_before_completion_does_not_duplicate_success(self):
        text = envelope("Recovered and verified.")
        client = self.client(ReachTransientError("busy", status=503), reply(text))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        self.assertEqual(history[-1]["content"], text)
        self.assert_single_completion("Recovered and verified.")

    def test_retry_continues_split_envelope_and_publishes_one_completion(self):
        text = envelope("Connection recovered and verification finished.")
        cut = text.index('"message"') + 4
        prefix, suffix = text[:cut], text[cut:]
        client = self.client(ReachTransientError("cut", partial=reply(prefix), status="cut"),
                             reply(suffix))
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        self.assertEqual(client.messages[1][-2], {"role": "assistant", "content": prefix})
        self.assertEqual(history[-1]["content"], text)
        self.assert_single_completion("Connection recovered and verification finished.")

    def test_failed_request_with_terminal_partial_never_reports_success(self):
        text = envelope("This response did not finish successfully.")
        client = self.client(ReachTransientError("cut", partial=reply(text), status="cut"),
                             ReachApiError("auth failed", status=401))
        history = self.history()
        self.assertFalse(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 2)
        self.assertEqual(history[-1]["content"], text)
        self.assertNotIn("agent complete:", self.output.getvalue())

    def test_cancelled_request_with_complete_metadata_never_reports_success(self):
        text = envelope("The user cancelled this response.")

        def cancel(on_text):
            on_text(text)
            raise KeyboardInterrupt

        client = self.client(cancel)
        history = self.history()
        self.assertFalse(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 1)
        self.assertEqual(history[-1]["content"], text)
        self.assertNotIn("agent complete:", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("stopped"), 1)

    def test_cancelled_tool_never_consumes_a_queued_completion(self):
        client = self.client(reply(calls=[native_read()]), reply(envelope("Must never be consumed.")))
        history = self.history()
        with mock.patch.object(chat, "run_tool", side_effect=KeyboardInterrupt):
            self.assertFalse(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 1)
        self.assertIn("stopped", history[-1]["content"])
        self.assertNotIn("agent complete:", self.output.getvalue())

    def test_tool_failure_never_consumes_a_queued_completion(self):
        client = self.client(reply(calls=[native_read()]), reply(envelope("Must never be consumed.")))
        history = self.history()
        with mock.patch.object(chat, "run_tool", side_effect=RuntimeError("fixture failure")):
            self.assertFalse(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(len(client.messages), 1)
        self.assertNotIn("agent complete:", self.output.getvalue())

    def test_open_plan_rejects_json_completion_without_success_then_blocks(self):
        premature = envelope("Premature completion must not be shown.")
        blocked = envelope("Need permission before the remaining item.", "blocked")
        client = self.client(reply(premature), reply(blocked))
        state = chat.AgentState()
        state.todos = [{"content": "Verify the remaining change", "status": "in_progress"}]
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 2)
        self.assertIn("Completion rejected", client.messages[1][-1]["content"])
        self.assertEqual(history[-1]["content"], blocked)
        self.assertEqual(sum(m.get("content") == premature for m in history), 1)
        self.assertEqual(sum(m.get("content") == blocked for m in history), 1)
        self.assertNotIn("agent complete:", self.output.getvalue())
        self.assertEqual(self.output.getvalue().count("agent blocked:"), 1)
        self.assertEqual(self.output.getvalue().count("Need permission before the remaining item."), 1)

    def test_completed_plan_accepts_completion_once(self):
        client = self.client(reply(envelope("All plan items were verified.")))
        state = chat.AgentState()
        state.todos = [{"content": "Verify change", "status": "completed"}]
        self.assertTrue(chat.run_agent_turn(client, self.history(), state))
        self.assert_single_completion("All plan items were verified.")

    def test_metadata_is_filtered_across_separately_delivered_stream_chunks(self):
        text = envelope("Streamed completion was checked.")

        def chunks(on_text):
            for start in range(0, len(text), 2):
                on_text(text[start:start + 2])
                self.assertNotIn('"status"', self.output.getvalue())
                self.assertNotIn("```", self.output.getvalue())
            return reply(text)

        client = self.client(chunks)
        history = self.history()
        self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(history[-1]["content"], text)
        self.assert_single_completion("Streamed completion was checked.")

    def test_json_protocol_is_visible_in_ordinary_chat_mode(self):
        text = envelope("A JSON example in ordinary chat.")
        client = self.client(reply(text), agent=False)
        ok, result = chat.stream_reply(client, self.history(), full=True)
        self.assertTrue(ok)
        self.assertEqual(result["content"], text)
        self.assertIn('"status": "complete"', self.output.getvalue())
        self.assertIn("A JSON example in ordinary chat.", self.output.getvalue())

    def test_agent_raw_prose_tokens_are_visible_before_client_returns(self):
        def partial(on_text):
            on_text("Immediate ")
            self.assertIn("Immediate ", self.output.getvalue())
            on_text("response")
            self.assertIn("Immediate response", self.output.getvalue())
            return reply("Immediate response")

        client = self.client(partial)
        ok, result = chat.stream_reply(client, self.history(), full=True)
        self.assertTrue(ok)
        self.assertEqual(result["content"], "Immediate response")
        self.assertEqual(self.output.getvalue().count("Immediate response"), 1)

    def test_completion_metadata_is_hidden_with_markdown_renderer(self):
        text = envelope("Rendered completion was verified.")
        client = self.client(reply(text))
        history = self.history()
        with mock.patch.object(chat.render, "enabled", return_value=True):
            self.assertTrue(chat.run_agent_turn(client, history, chat.AgentState()))
        self.assertEqual(history[-1]["content"], text)
        self.assert_single_completion("Rendered completion was verified.")

    def test_followup_keeps_prior_metadata_and_completes_once_per_turn(self):
        first = envelope("First request verified.")
        second = envelope("Followup request verified.")
        client = self.client(reply(first), reply(second))
        history, state = self.history(), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        history.append({"role": "user", "content": "Check the followup."})
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(len(client.messages), 2)
        self.assertIn({"role": "assistant", "content": first}, client.messages[1])
        self.assertEqual(history[-1]["content"], second)
        self.assertEqual(self.output.getvalue().count("agent complete:"), 2)
        self.assertEqual(self.output.getvalue().count("First request verified."), 1)
        self.assertEqual(self.output.getvalue().count("Followup request verified."), 1)
        self.assertEqual(client.session_totals["turns"], 2)

    def test_late_protocol_chunks_after_cancel_do_not_render_or_restart(self):
        entered, release = threading.Event(), threading.Event()
        workers, results = [], []
        partial = "```json\n"
        late = json.dumps({"status": "complete", "message": "Late completion must stay hidden."}) + "\n```"

        def delayed(on_text):
            on_text(partial)
            entered.set()
            if not release.wait(2):
                raise AssertionError("fixture worker was not released")
            on_text(late)
            return reply(partial + late)

        client = self.client(delayed)

        def interrupt(fn):
            worker = threading.Thread(target=lambda: results.append(fn()))
            workers.append(worker)
            worker.start()
            self.assertTrue(entered.wait(1), "fixture worker did not start")
            raise KeyboardInterrupt

        try:
            with mock.patch.object(chat, "_interruptible", side_effect=interrupt):
                ok, result = chat.stream_reply(client, self.history(), full=True)
            self.assertTrue(ok)
            self.assertTrue(result["stopped"])
            self.assertEqual(result["content"], partial)
            release.set()
            workers[0].join(1)
            self.assertFalse(workers[0].is_alive())
            self.assertEqual(len(client.messages), 1)
            self.assertNotIn("Late completion", self.output.getvalue())
            self.assertNotIn("agent complete:", self.output.getvalue())
        finally:
            release.set()
            for worker in workers:
                worker.join(2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
