"""Provider termination metadata must survive both CLI transport paths."""

import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest import mock

TOOLS = os.environ.get("REACH_CLI_TEST_TOOLS") or str(Path(__file__).resolve().parents[1] / "tools")
sys.path.insert(0, TOOLS)

from reach_cli.client import ReachClient, ReachTransientError  # noqa: E402


class Response:
    def __init__(self, lines=(), body=None):
        self.lines = lines
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return json.dumps(self.body).encode("utf-8")

    def __iter__(self):
        for line in self.lines:
            if isinstance(line, Exception):
                raise line
            yield line.encode("utf-8")


def event(delta=None, **choice):
    choice["delta"] = delta or {}
    return "data: " + json.dumps({"choices": [choice]}) + "\n"


class FinishReasonTests(unittest.TestCase):
    def setUp(self):
        self.client = ReachClient("http://fixture.invalid/v1", model="fixture")
        self.messages = [{"role": "user", "content": "Read the fixture."}]

    def complete(self, response, stream=True, **kwargs):
        with mock.patch("urllib.request.urlopen", return_value=response) as request:
            result = self.client.complete(self.messages, stream=stream, **kwargs)
        request.assert_called_once()
        return result

    def test_streamed_protocol_reasons_survive_usage_and_done(self):
        for reason in ("stop", "tool_calls", "function_call", "length", "content_filter"):
            with self.subTest(reason=reason):
                result = self.complete(Response([
                    event({"content": "Answer"}, finish_reason=None),
                    event(finish_reason=reason),
                    'data: {"choices": [], "usage": {"total_tokens": 7}}\n',
                    "data: [DONE]\n",
                ]))
                self.assertEqual(result["content"], "Answer")
                self.assertEqual(result["finish_reason"], reason)
                self.assertEqual(self.client.usage["total"], 7)

    def test_json_protocol_reasons_are_taken_from_choice(self):
        for reason in ("stop", "tool_calls", "function_call", "length", "content_filter"):
            with self.subTest(reason=reason):
                result = self.complete(Response(body={"choices": [{
                    "finish_reason": reason,
                    "message": {"content": "Answer", "finish_reason": "untrusted nested value"},
                }]}), stream=False)
                self.assertEqual(result["content"], "Answer")
                self.assertEqual(result["finish_reason"], reason)

    def test_missing_and_null_reasons_preserve_legacy_result_shape(self):
        for fields in ({}, {"finish_reason": None}):
            for stream in (True, False):
                with self.subTest(stream=stream, fields=fields):
                    response = (Response([event({"content": "Answer"}, **fields), "data: [DONE]\n"])
                                if stream else Response(body={"choices": [dict(
                                    message={"content": "Answer"}, **fields)]}))
                    self.assertEqual(self.complete(response, stream=stream), {
                        "content": "Answer", "tool_calls": [], "thought": ""})

    def test_unknown_nonnull_reasons_are_fixed_labels_never_endpoint_text(self):
        for reason in ("unexpected private endpoint text", "", 0, False, [], {"stop": True}):
            for stream in (True, False):
                with self.subTest(reason=reason, stream=stream):
                    response = (Response([event({"content": "Answer"}, finish_reason=reason)])
                                if stream else Response(body={"choices": [{
                                    "message": {"content": "Answer"}, "finish_reason": reason}]}))
                    result = self.complete(response, stream=stream)
                    self.assertEqual(result["finish_reason"], "unknown")
                    self.assertNotIn("private endpoint", json.dumps(result))

    def test_complete_looking_tool_arguments_keep_truncation_metadata(self):
        call = {"id": "fixture_read", "type": "function", "function": {
            "name": "read", "arguments": '{"path":"note.txt"}'}}
        for reason in ("length", "content_filter"):
            for stream in (True, False):
                with self.subTest(reason=reason, stream=stream):
                    message = {"tool_calls": [call], "content": ""}
                    response = (Response([event(message, finish_reason=reason), "data: [DONE]\n"])
                                if stream else Response(body={"choices": [{
                                    "message": message, "finish_reason": reason}]}))
                    result = self.complete(response, stream=stream)
                    self.assertEqual(result["finish_reason"], reason)
                    self.assertEqual(json.loads(result["tool_calls"][0]["function"]["arguments"]),
                                     {"path": "note.txt"})

    def test_later_stop_cannot_clear_truncation_filter_or_unknown_reason(self):
        for reason in ("length", "content_filter", "unrecognized"):
            with self.subTest(reason=reason):
                result = self.complete(Response([
                    event({"content": "Partial"}, finish_reason=reason),
                    event(finish_reason="stop"), "data: [DONE]\n",
                ]))
                self.assertEqual(result["finish_reason"],
                                 "unknown" if reason == "unrecognized" else reason)

    def test_empty_filtered_replies_keep_the_reason_in_failure_context(self):
        for stream in (True, False):
            with self.subTest(stream=stream):
                response = (Response([event(finish_reason="content_filter"), "data: [DONE]\n"])
                            if stream else Response(body={"choices": [{
                                "message": {}, "finish_reason": "content_filter"}]}))
                with self.assertRaises(ReachTransientError) as caught:
                    self.complete(response, stream=stream)
                self.assertEqual(caught.exception.partial["finish_reason"], "content_filter")

    def test_incomplete_stream_without_finish_still_raises_with_partial_text(self):
        with self.assertRaises(ReachTransientError) as caught:
            self.complete(Response([event({"content": "Partial"})]))
        self.assertEqual(caught.exception.status, "cut")
        self.assertEqual(caught.exception.partial["content"], "Partial")
        self.assertNotIn("finish_reason", caught.exception.partial)

    def test_transport_fault_after_finish_marker_still_raises(self):
        for reason in ("stop", "length", "content_filter"):
            with self.subTest(reason=reason):
                with self.assertRaises(ReachTransientError) as caught:
                    self.complete(Response([event({"content": "Partial"}, finish_reason=reason),
                                            ConnectionResetError("fixture reset")]))
                self.assertEqual(caught.exception.status, "cut")
                self.assertEqual(caught.exception.partial["content"], "Partial")
                self.assertEqual(caught.exception.partial["finish_reason"], reason)

    def test_explicit_stop_can_end_without_done_sentinel(self):
        result = self.complete(Response([event({"content": "Answer"}, finish_reason="stop")]))
        self.assertEqual(result["finish_reason"], "stop")

    def test_cancellation_does_not_invent_stop_reason(self):
        cancelled = threading.Event()
        cancelled.set()
        result = self.complete(Response([event({"content": "Never read"}, finish_reason="stop")]),
                               cancelled=cancelled)
        self.assertEqual(result, {"content": "", "tool_calls": [], "thought": ""})

    def test_incomplete_partial_controls_cannot_be_promoted_by_a_clean_retry(self):
        from reach_cli import chat
        from tests.test_reach_cli_agent_completion import ScriptClient, native_read

        shapes = (
            ("fenced_tool", '```tool\n{"action":"read","path":"note.txt"}\n```\n', []),
            ("fenced_status", '```agent_status\n{"status":"complete"}\n```\n', []),
            ("native_call", "", [native_read()]),
        )
        for reason in ("length", "content_filter", "unknown"):
            for shape, content, calls in shapes:
                with self.subTest(reason=reason, shape=shape):
                    partial = {"content": content, "tool_calls": calls, "finish_reason": reason}
                    clean_retry = {"content": "This retry must not be consumed.",
                                   "tool_calls": [], "finish_reason": "stop"}
                    client = ScriptClient([
                        ReachTransientError("fixture stream reset", partial=partial, status="cut"),
                        clean_retry,
                    ])
                    with mock.patch.object(chat, "_sleep") as sleep:
                        ok, result = chat.request_reply(client, self.messages)
                    self.assertFalse(ok)
                    self.assertEqual(result["finish_reason"], reason)
                    self.assertEqual(result["content"], content)
                    self.assertEqual(result["tool_calls"], [])
                    self.assertEqual(len(client.messages), 1)
                    self.assertEqual(next(client.steps), clean_retry)
                    sleep.assert_not_called()

    def test_ordinary_transport_cut_still_retries_and_keeps_streamed_text(self):
        from reach_cli import chat
        from tests.test_reach_cli_agent_completion import ScriptClient

        client = ScriptClient([
            ReachTransientError("fixture stream reset", partial={
                "content": "Partial ", "tool_calls": []}, status="cut"),
            {"content": "answer.", "tool_calls": [], "finish_reason": "stop"},
        ])
        with mock.patch.object(chat, "_sleep"):
            ok, result = chat.request_reply(client, self.messages)
        self.assertTrue(ok)
        self.assertEqual(result["content"], "Partial answer.")
        self.assertEqual(result["finish_reason"], "stop")
        self.assertEqual(len(client.messages), 2)
        self.assertEqual(client.messages[1][-2], {"role": "assistant", "content": "Partial "})


if __name__ == "__main__":
    unittest.main()
