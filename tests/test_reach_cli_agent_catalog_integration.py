"""Executable lazy/native/fenced catalog integration, with no provider calls."""

import json
from pathlib import Path
import unittest
from unittest import mock

from tests import test_reach_cli_agent_completion as helpers

chat = helpers.chat
reply = helpers.reply
envelope = helpers.envelope


def native(name, arguments, ident="fixture_call"):
    return {"id": ident, "type": "function", "function": {
        "name": name, "arguments": json.dumps(arguments)}}


class RecordingClient(helpers.ScriptClient):
    def __init__(self, steps, workpath):
        super().__init__(steps, workpath)
        self.schemas = []

    def complete(self, messages, tools=None, on_text=None):
        self.schemas.append(tools)
        return super().complete(messages, tools, on_text)


class CatalogIntegrationTests(unittest.TestCase):
    setUp = helpers.AgentCompletionTurnTests.setUp
    history = helpers.AgentCompletionTurnTests.history

    def client(self, *steps):
        return RecordingClient(steps, str(self.work))

    def test_native_discovery_then_extra_executes_real_fixture_read(self):
        (self.work / "fixture.json").write_text('{"value":42}', encoding="utf-8")
        client = self.client(
            reply(calls=[native("tool_discover", {"names": ["read_json"]}, "discover")]),
            reply(calls=[native("read_json", {"path": "fixture.json", "pointer": "/value"}, "read")]),
            reply(envelope("Read fixture value 42.")))
        history, state = self.history(), chat.AgentState()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        first = {schema["function"]["name"] for schema in client.schemas[0]}
        second = {schema["function"]["name"] for schema in client.schemas[1]}
        self.assertNotIn("read_json", first)
        self.assertIn("tool_discover", first)
        self.assertIn("read_json", second)
        self.assertLessEqual(len(second), 16)
        self.assertEqual(state.selected_tools, {"read_json"})
        self.assertEqual([m["content"] for m in history if m.get("tool_call_id") == "read"], ["42"])
        system = next(m["content"] for m in client.messages[1] if m["role"] == "system")
        self.assertIn("ADDITIONAL ACTIVE TOOLS", system)
        self.assertIn("- read_json:", system)
        self.assertNotIn("- git_blame:", system)

    def test_discovered_native_write_obeys_actual_approval_denial_and_allowance(self):
        for allowed in (False, True):
            with self.subTest(allowed=allowed):
                target = "approved.txt" if allowed else "denied.txt"
                client = self.client(
                    reply(calls=[native("tool_discover", {"names": ["write_file"]})]),
                    reply(calls=[native("write_file", {"path": target, "content": "fixture"})]),
                    reply(envelope("The tool result was handled.")))
                state, history = chat.AgentState(), self.history()
                with mock.patch.object(state, "approve", return_value=allowed) as approve:
                    self.assertTrue(chat.run_agent_turn(client, history, state))
                approve.assert_called_once()
                self.assertEqual((self.work / target).exists(), allowed)
                if allowed:
                    self.assertEqual((self.work / target).read_text(encoding="utf-8"), "fixture")
                else:
                    self.assertIn("denied", next(m["content"] for m in history
                        if m["role"] == "tool" and "denied" in m["content"]))

    def test_approved_native_edit_preserves_existing_newline_bytes(self):
        cases = (
            ("lf.txt", b"alpha\nbeta\ngamma\n", b"alpha\nBETA\ngamma\n"),
            ("mixed.txt", b"alpha\r\nbeta\ngamma\r\n", b"alpha\r\nBETA\ngamma\r\n"),
        )
        for name, original, expected in cases:
            with self.subTest(name=name):
                target = self.work / name
                target.write_bytes(original)
                client = self.client(
                    reply(calls=[native("edit", {"path": name, "search": "beta", "replace": "BETA"})]),
                    reply(envelope("The edit was applied.")))
                state, history = chat.AgentState(), self.history()
                with mock.patch.object(state, "approve", return_value=True) as approve:
                    self.assertTrue(chat.run_agent_turn(client, history, state))
                approve.assert_called_once()
                self.assertEqual(target.read_bytes(), expected)

    def test_approved_native_edit_create_keeps_requested_lf_bytes(self):
        client = self.client(
            reply(calls=[native("edit", {"path": "created.txt", "search": "",
                                         "replace": "first\nsecond\n"})]),
            reply(envelope("The file was created.")))
        state, history = chat.AgentState(), self.history()
        with mock.patch.object(state, "approve", return_value=True) as approve:
            self.assertTrue(chat.run_agent_turn(client, history, state))
        approve.assert_called_once()
        self.assertEqual((self.work / "created.txt").read_bytes(), b"first\nsecond\n")

    def test_approved_native_edit_matches_normalized_multiline_search(self):
        cases = (
            ("crlf.txt", b"head\r\nbeta\r\ngamma\r\ntail\r\n",
             "beta\ngamma", "BETA\nGAMMA",
             b"head\r\nBETA\r\nGAMMA\r\ntail\r\n"),
            ("mixed.txt", b"pre\r\none\ntwo\r\npost\n",
             "one\ntwo\n", "ONE\nTWO\n",
             b"pre\r\nONE\nTWO\r\npost\n"),
            ("mostly-crlf.txt", b"pre\none\r\ntwo\r\nthree\npost\r\n",
             "one\ntwo\nthree\n", "ONE\nTWO\nTHREE\n",
             b"pre\nONE\r\nTWO\r\nTHREE\r\npost\r\n"),
        )
        for name, original, search, replace, expected in cases:
            with self.subTest(name=name):
                target = self.work / name
                target.write_bytes(original)
                client = self.client(
                    reply(calls=[native("read", {"path": name}, "read_" + name)]),
                    reply(calls=[native("edit", {"path": name, "search": search,
                                                 "replace": replace}, "edit_" + name)]),
                    reply(envelope("The edit was applied.")))
                state, history = chat.AgentState(), self.history()
                with mock.patch.object(state, "approve", return_value=True) as approve:
                    self.assertTrue(chat.run_agent_turn(client, history, state))
                approve.assert_called_once()
                read_result = next(m["content"] for m in history
                                   if m.get("tool_call_id") == "read_" + name)
                self.assertNotIn("\r", read_result)
                self.assertEqual(target.read_bytes(), expected)

    def test_approved_native_edit_uses_local_crlf_for_exact_search(self):
        original = b"head\r\nbeta\r\ntail\r\n"
        cases = (
            ("single", "beta", "BETA\nNEXT",
             b"head\r\nBETA\r\nNEXT\r\ntail\r\n"),
            ("multiline", "beta\r\ntail", "BETA\nNEXT",
             b"head\r\nBETA\r\nNEXT\r\n"),
            ("linebreak", "\n", "\nNEXT\n",
             b"head\r\nNEXT\r\nbeta\r\ntail\r\n"),
        )
        for name, search, replace, expected in cases:
            with self.subTest(name=name):
                target = self.work / (name + ".txt")
                target.write_bytes(original)
                client = self.client(
                    reply(calls=[native("edit", {"path": target.name,
                                                 "search": search, "replace": replace})]),
                    reply(envelope("The edit was applied.")))
                state, history = chat.AgentState(), self.history()
                with mock.patch.object(state, "approve", return_value=True) as approve:
                    self.assertTrue(chat.run_agent_turn(client, history, state))
                approve.assert_called_once()
                self.assertEqual(target.read_bytes(), expected)

    def test_approved_native_edit_does_not_split_one_crlf_into_two_newlines(self):
        target = self.work / "one-linebreak.txt"
        original = b"a\r\nb\r\n"
        target.write_bytes(original)
        client = self.client(
            reply(calls=[native("edit", {"path": target.name,
                                         "search": "a\n\nb", "replace": "A\n\nB"})]),
            reply(envelope("The requested span was not found.")))
        state, history = chat.AgentState(), self.history()
        with mock.patch.object(state, "approve", return_value=True) as approve:
            self.assertTrue(chat.run_agent_turn(client, history, state))
        approve.assert_called_once()
        self.assertEqual(target.read_bytes(), original)
        result = next(m["content"] for m in history if m.get("role") == "tool")
        self.assertIn("search text not found", result)

    def test_approved_native_edit_prefers_raw_match_before_newline_fallback(self):
        target = self.work / "two-matches.txt"
        target.write_bytes(b"same\r\nmore\nsame\nmore\n")
        client = self.client(
            reply(calls=[native("edit", {"path": target.name,
                                         "search": "same\nmore", "replace": "SAME\nMORE"})]),
            reply(envelope("The edit was applied.")))
        state, history = chat.AgentState(), self.history()
        with mock.patch.object(state, "approve", return_value=True) as approve:
            self.assertTrue(chat.run_agent_turn(client, history, state))
        approve.assert_called_once()
        self.assertEqual(target.read_bytes(), b"same\r\nmore\nSAME\nMORE\n")

    def test_fenced_discovery_and_execution_share_active_state_without_native_schemas(self):
        client = self.client(
            reply('```tool\n{"action":"tool_discover","names":["hash_file"]}\n```'),
            reply('```tool\n{"action":"hash_file","path":"note.txt"}\n```'),
            reply(envelope("Read the fixture hash.")))
        client.supports_tools = False
        state, history = chat.AgentState(), self.history()
        self.assertTrue(chat.run_agent_turn(client, history, state))
        self.assertEqual(client.schemas, [None, None, None])
        self.assertEqual(state.selected_tools, {"hash_file"})
        self.assertTrue(any("SHA-256" in m["content"] or len(m["content"]) > 64
                            for m in history if m["role"] == "user" and m["content"].startswith("[tool result]")))
        self.assertIn("- hash_file:", client.messages[1][0]["content"])

    def test_small_explicit_native_limit_keeps_discovery_and_selected_tool(self):
        client = self.client()
        state = chat.AgentState()
        state.selected_tools.add("hash_file")
        client.tool_limit = 2
        names = [schema["function"]["name"] for schema in chat._agent_tool_schemas(client, state)]
        self.assertEqual(names, ["tool_discover", "hash_file"])
        client.tool_limit = 100
        state.selected_tools.update(chat.TOOLS)
        self.assertEqual(len(chat._agent_tool_schemas(client, state)), 16)

    def test_native_and_fenced_batches_share_owned_process_dictionary(self):
        state, observed = chat.AgentState(), []

        def inspect_ctx(name, args, workpath, ctx):
            observed.append(ctx)
            ctx["processes"]["owned-fixture"] = "owned-state"
            return "fixture result"

        with mock.patch.object(chat, "run_tool", side_effect=inspect_ctx):
            chat._execute_native(self.client(), [native("read", {"path": "note.txt"})], state)
            chat._execute_actions(self.client(), [{"action": "read", "path": "note.txt"}], state)
        self.assertIs(observed[0]["processes"], observed[1]["processes"])
        self.assertIs(observed[0]["selected_tools"], state.selected_tools)
        self.assertEqual(state.processes, {"owned-fixture": "owned-state"})

    def test_one_shot_and_repl_exit_clean_only_owned_session_context(self):
        client = self.client(reply(envelope("Done.")))
        with mock.patch.object(chat, "cleanup_owned_processes") as cleanup:
            self.assertTrue(chat.run_ask(client, "Fixture question"))
        cleanup.assert_called_once()
        self.assertEqual(cleanup.call_args.args[0], str(self.work))
        self.assertEqual(cleanup.call_args.args[1]["processes"], {})
        with mock.patch.object(chat, "cleanup_owned_processes") as cleanup, \
                mock.patch.object(chat, "banner"), mock.patch.object(chat, "endpoint_notice"), \
                mock.patch.object(chat, "ReplSession"), \
                mock.patch.object(chat, "handle_slash", return_value=type("Quit", (), {"quit": True})()):
            chat._run_chat_loop(client, client.base, "/exit")
        cleanup.assert_called_once()
        self.assertEqual(cleanup.call_args.args[0], str(self.work))


class NativeCapabilityFallbackTests(unittest.TestCase):
    def client(self, *steps):
        return RecordingClient(steps, "")

    def test_clear_unsupported_request_retries_once_and_keeps_provider_model(self):
        for status in (400, 422):
            with self.subTest(status=status):
                client = self.client(helpers.ReachApiError("Model does not support tools", status=status),
                                     reply("fenced protocol available"))
                endpoint = client.base, client.model
                ok, result = chat.request_reply(client, [], tools=[{"type": "function"}])
                self.assertTrue(ok)
                self.assertEqual(result["content"], "fenced protocol available")
                self.assertEqual(client.schemas, [[{"type": "function"}], None])
                self.assertEqual((client.base, client.model), endpoint)
                self.assertEqual(client._unsupported_tools_endpoint, endpoint)
                self.assertIsNone(chat._agent_tool_schemas(client, chat.AgentState()))
                client.base = "http://another-fixture.invalid/v1"
                self.assertTrue(chat._agent_tool_schemas(client, chat.AgentState()))

    def test_generic_auth_rate_model_and_schema_errors_do_not_trigger_fallback(self):
        cases = [(401, "tools are not supported"), (403, "tools are not supported"),
                 (429, "tools are not supported"), (500, "tools are not supported"),
                 (400, "invalid model name"), (422, "tool argument is invalid"),
                 (400, "invalid tool schema has unsupported enum type")]
        for status, text in cases:
            with self.subTest(status=status, text=text):
                client = self.client(helpers.ReachApiError(text, status=status))
                ok, _result = chat.request_reply(client, [], tools=[{"type": "function"}])
                self.assertFalse(ok)
                self.assertEqual(len(client.schemas), 1)

    def test_two_rejections_cannot_retry_in_a_loop(self):
        error = helpers.ReachApiError("Unsupported parameter: tools", status=400)
        client = self.client(error, error)
        self.assertFalse(chat.request_reply(client, [], tools=[{}])[0])
        self.assertEqual(client.schemas, [[{}], None])

    def test_started_stream_or_partial_tool_call_cannot_fallback(self):
        def started(on_text):
            on_text("partial answer")
            raise helpers.ReachApiError("tools are not supported", status=400)
        error = helpers.ReachApiError("tools are not supported", status=400)
        error.partial = {"tool_calls": [native("read", {"path": "note.txt"})]}
        for step in (started, error):
            with self.subTest(step=step):
                client = self.client(step)
                self.assertFalse(chat.request_reply(client, [], tools=[{}], on_text=lambda _text: None)[0])
                self.assertEqual(client.schemas, [[{}]])

    def test_explicit_text_only_capability_sends_no_schemas(self):
        client = self.client(reply("text only"))
        client.supports_tools = False
        self.assertTrue(chat.request_reply(client, [], tools=[{}])[0])
        self.assertEqual(client.schemas, [None])


if __name__ == "__main__":
    unittest.main()
