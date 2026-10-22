"""Context budgets, schema integrity, history boundaries, and relay wiring."""

import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from reachd.context_compression import (
    ContextCompressionError, SUMMARY_TOKENS, _CACHE_LOCK, _SUMMARY_CACHE,
    _history_split, compact_schema, prepare_gpu_context,
    llama_context_limit,
)
from reachd.chat import chat_execute
from reachd.model_routes import dispatch
from tests.test_reachd_access import RelayFixture


class NativeFixture:
    def __init__(self, limit=16000, *, finish="stop"):
        self.limit = limit
        self.finish = finish
        self.requests = []

    def __call__(self, url, payload, timeout):
        self.requests.append((url, copy.deepcopy(payload)))
        count = 256 + len(json.dumps(payload, ensure_ascii=False)) // 4
        if url.endswith("/tokenize"):
            return {"count": count, "max_model_len": self.limit}
        if count + payload["max_tokens"] + 256 > self.limit:
            raise AssertionError("Summary request itself exceeded context")
        if payload.get("tools"):
            raise AssertionError("Compression must never request tool execution")
        return {"choices": [{"message": {"role": "assistant", "content":
                "Reference notes: retain ALPHA4826, the user's goal, and pending work."},
                "finish_reason": self.finish}]}

    @property
    def generations(self):
        return [body for url, body in self.requests if url.endswith("/v1/chat/completions")]


class ContextCompressionTests(unittest.TestCase):
    def setUp(self):
        with _CACHE_LOCK:
            _SUMMARY_CACHE.clear()

    def payload(self, messages=None, **extra):
        return {"model": "google/gemma-4-12B-it-qat-q4_0-unquantized",
                "messages": messages or [{"role": "user", "content": "Hello"}],
                "chat_template_kwargs": {"enable_thinking": True}, **extra}

    def prepare(self, payload, native, **options):
        return prepare_gpu_context("gpu/gemma-4-12b-qat", payload,
                                   {"context_window": 65536}, request_json=native, **options)

    def history(self, size=52000):
        return [{"role": "system", "content": "Keep all explicit user constraints."},
                {"role": "developer", "content": "Never send mail without approval."},
                {"role": "user", "content": "Investigate the project; preserve ALPHA4826."},
                {"role": "assistant", "content": "Earlier observed data: " + "x" * size},
                {"role": "user", "content": "Continue with the pending read only."}]

    def test_small_requests_are_untouched_and_need_no_extra_network_calls(self):
        payload = self.payload()
        native = NativeFixture()
        result, report = self.prepare(payload, native)
        self.assertIs(result, payload)
        self.assertIsNone(report)
        self.assertEqual(native.requests, [])

    def test_llama_chat_counter_preserves_tools_media_and_uses_actual_slot_context(self):
        payload = self.payload([{"role": "user", "content": [{"type": "text", "text": "Describe this"},
            {"type": "image_url", "image_url": {"url": "https://example.invalid/image.png"}}]}],
            tools=[{"type": "function", "function": {"name": "inspect", "parameters": {"type": "object"}}}])
        calls = []
        def native(url, body, timeout):
            calls.append((url, copy.deepcopy(body)))
            if url.endswith("/tokenize"):
                return {"tokens": []}
            if url.endswith("/props"):
                return {"model_alias": payload["model"], "default_generation_settings": {"n_ctx": 262144}}
            self.assertTrue(url.endswith("/chat/completions/input_tokens"))
            self.assertEqual(body["messages"], payload["messages"])
            self.assertEqual(body["tools"], payload["tools"])
            return {"input_tokens": 2048}
        result, report = self.prepare(payload, native)
        self.assertIs(result, payload)
        self.assertIsNone(report)
        self.assertEqual(len(calls), 3)

    def test_llama_counter_rejects_wrong_model_invalid_limit_and_invalid_count(self):
        payload = self.payload([{"role": "user", "content": "x" * 40000}])
        for model, maximum, count in (("wrong-model", 262144, 1),
                                      (payload["model"], True, 1), (payload["model"], 262144, True)):
            def native(url, body, timeout):
                if url.endswith("/tokenize"):
                    return {"tokens": []}
                if url.endswith("/props"):
                    return {"model_alias": model, "default_generation_settings": {"n_ctx": maximum}}
                return {"input_tokens": count}
            with self.subTest(model=model, maximum=maximum, count=count), self.assertRaises(ContextCompressionError):
                self.prepare(payload, native)

    def test_llama_live_limit_still_prevents_oversized_protected_inputs(self):
        payload = self.payload([{"role": "user", "content": "x" * 40000}])
        def native(url, body, timeout):
            if url.endswith("/tokenize"):
                return {"tokens": []}
            if url.endswith("/props"):
                return {"model_alias": payload["model"], "default_generation_settings": {"n_ctx": 8192}}
            return {"input_tokens": 9000}
        with self.assertRaisesRegex(ContextCompressionError, "still need 9000"):
            self.prepare(payload, native)

    def test_slot_context_metadata_never_uses_a_training_window_or_boolean(self):
        self.assertIsNone(llama_context_limit({"model_alias": "test", "n_ctx_train": 262144}, "test"))
        self.assertIsNone(llama_context_limit({"model_alias": "test", "default_generation_settings": {"n_ctx": True}}, "test"))
        self.assertEqual(llama_context_limit({"model_alias": "test,other", "default_generation_settings": {"n_ctx": 131072}}, "test"), 131072)

    def test_non_gpu_routes_are_not_compressed(self):
        payload = self.payload(self.history())
        native = NativeFixture()
        result, report = prepare_gpu_context("bridge/chatgpt-chat", payload, {}, request_json=native)
        self.assertIs(result, payload)
        self.assertIsNone(report)
        self.assertEqual(native.requests, [])

    def test_schema_compression_preserves_properties_validation_and_literal_values(self):
        schema = {"type": "object", "description": "Verbose documentation", "required": ["description"],
                  "properties": {"description": {"type": "string", "description": "A field's docs",
                                                  "pattern": "^keep", "minLength": 4},
                                 "title": {"enum": [{"description": "literal value", "title": "literal"}]},
                                 "examples": {"default": {"description": "keep data"}},
                                 "child": {"$ref": "#/$defs/description"}},
                  "$defs": {"description": {"type": "object", "description": "More docs",
                                              "properties": {"title": {"type": "number"}}}},
                  "additionalProperties": False}
        original = copy.deepcopy(schema)
        result = compact_schema(schema)
        self.assertEqual(schema, original)
        self.assertNotIn("description", result)
        self.assertEqual(result["required"], ["description"])
        self.assertEqual(result["properties"]["description"],
                         {"type": "string", "pattern": "^keep", "minLength": 4})
        self.assertEqual(result["properties"]["title"], schema["properties"]["title"])
        self.assertEqual(result["properties"]["examples"], schema["properties"]["examples"])
        self.assertEqual(result["properties"]["child"]["$ref"], "#/$defs/description")
        self.assertIn("description", result["$defs"])
        self.assertEqual(result["additionalProperties"], False)

    def test_schema_alone_can_fit_without_summarizing_or_removing_tools(self):
        tool = {"type": "function", "function": {"name": "read_file", "description": "Read a file.",
                "strict": True, "parameters": {"type": "object", "required": ["path"],
                "properties": {"path": {"type": "string", "description": "documentation " * 4000}},
                "additionalProperties": False}}}
        payload = self.payload(tools=[tool], tool_choice={"type": "function", "function": {"name": "read_file"}},
                               parallel_tool_calls=False)
        original = copy.deepcopy(payload)
        native = NativeFixture(limit=16000)
        result, report = self.prepare(payload, native)
        self.assertEqual(payload, original)
        self.assertEqual(len(result["tools"]), 1)
        for key in ("name", "description", "strict"):
            self.assertEqual(result["tools"][0]["function"][key], tool["function"][key])
        for key in ("required", "additionalProperties"):
            self.assertEqual(result["tools"][0]["function"]["parameters"][key], tool["function"]["parameters"][key])
        self.assertEqual(result["tool_choice"], original["tool_choice"])
        self.assertEqual(result["parallel_tool_calls"], False)
        self.assertTrue(report["schema_docs_compacted"])
        self.assertEqual(native.generations, [])
        self.assertLessEqual(report["after_tokens"] + report["reserved_tokens"] + 256, native.limit)

    def test_history_summary_keeps_instructions_goals_current_turn_and_tool_pairs(self):
        messages = self.history()
        calls = [{"id": "pending-42", "type": "function", "function": {"name": "read_file",
                  "arguments": '{"path":"D:/project/file.txt"}'}}]
        messages += [{"role": "assistant", "content": None, "tool_calls": calls},
                     {"role": "tool", "tool_call_id": "pending-42", "content": "ALPHA4826"}]
        payload = self.payload(messages)
        original = copy.deepcopy(payload)
        native = NativeFixture()
        result, report = self.prepare(payload, native)
        self.assertEqual(payload, original)
        self.assertEqual(result["messages"][:3], original["messages"][:3])
        self.assertEqual(result["messages"][-3:], original["messages"][-3:])
        self.assertIn("ALPHA4826", result["messages"][3]["content"])
        self.assertEqual(result["messages"][3]["role"], "assistant")
        self.assertEqual(report["history_messages_summarized"], 1)
        self.assertEqual(len(native.generations), 1)
        self.assertNotIn("max_tokens", result)

    def test_summary_cache_is_scoped_to_the_authenticated_caller(self):
        payload = self.payload(self.history())
        native = NativeFixture()
        self.prepare(payload, native, namespace="customer-a")
        _, cached = self.prepare(payload, native, namespace="customer-a")
        self.assertEqual(len(native.generations), 1)
        self.assertEqual(cached["summary_cache_hits"], 1)
        self.prepare(payload, native, namespace="customer-b")
        self.assertEqual(len(native.generations), 2)

    def test_pending_and_cross_boundary_tool_calls_are_not_separated(self):
        messages = self.history()
        call = {"role": "assistant", "tool_calls": [{"id": "cross", "type": "function",
                "function": {"name": "read", "arguments": "{}"}}], "content": None}
        messages.insert(-1, call)
        messages.append({"role": "tool", "tool_call_id": "cross", "content": "result"})
        _, history, recent = _history_split(messages)
        self.assertNotIn(call, history)
        self.assertEqual(recent[0], call)
        messages.pop()
        _, history, recent = _history_split(messages)
        self.assertNotIn(call, history)
        self.assertEqual(recent[0], call)

    def test_large_current_tool_result_is_summarized_without_changing_ids_or_call_inputs(self):
        call = {"role": "assistant", "content": None, "tool_calls": [{"id": "read-42",
                "type": "function", "function": {"name": "read", "arguments": '{"id":"EXACT-ID"}'}}]}
        messages = [{"role": "user", "content": "Summarize the read result."}, call,
                    {"role": "tool", "tool_call_id": "read-42", "name": "read", "content": "x" * 60000}]
        payload = self.payload(messages)
        native = NativeFixture()
        result, report = self.prepare(payload, native)
        self.assertEqual(result["messages"][:2], messages[:2])
        self.assertEqual(result["messages"][2]["tool_call_id"], "read-42")
        self.assertEqual(result["messages"][2]["name"], "read")
        self.assertIn("ALPHA4826", result["messages"][2]["content"])
        self.assertEqual(report["tool_results_summarized"], 1)
        self.assertEqual(payload["messages"][2]["content"], "x" * 60000)

    def test_large_current_user_input_is_never_silently_truncated(self):
        payload = self.payload([{"role": "user", "content": "x" * 70000}])
        original = copy.deepcopy(payload)
        native = NativeFixture()
        with self.assertRaisesRegex(ContextCompressionError, "saved chat is unchanged"):
            self.prepare(payload, native)
        self.assertEqual(payload, original)
        self.assertEqual(native.generations, [])

    def test_explicit_output_limit_is_reserved_and_preserved(self):
        payload = self.payload(self.history(size=40000), max_tokens=8192)
        native = NativeFixture()
        result, report = self.prepare(payload, native)
        self.assertEqual(result["max_tokens"], 8192)
        self.assertEqual(report["reserved_tokens"], 8192)
        self.assertLessEqual(report["after_tokens"] + 8192 + 256, native.limit)

    def test_incomplete_summary_does_not_replace_history(self):
        payload = self.payload(self.history())
        original = copy.deepcopy(payload)
        with self.assertRaisesRegex(ContextCompressionError, "did not complete"):
            self.prepare(payload, NativeFixture(finish="length"))
        self.assertEqual(payload, original)

    def test_hierarchical_summary_requests_stay_within_native_context(self):
        payload = self.payload(self.history(size=180000))
        native = NativeFixture()
        result, report = self.prepare(payload, native)
        self.assertGreater(len(native.generations), 1)
        self.assertLessEqual(len(native.generations), 7)
        self.assertLessEqual(report["after_tokens"] + 4096 + 256, native.limit)
        for generation in native.generations:
            self.assertEqual(generation["max_tokens"], SUMMARY_TOKENS)
            self.assertFalse(generation["chat_template_kwargs"]["enable_thinking"])
        self.assertEqual(result["messages"][-1], payload["messages"][-1])

    def test_media_requests_use_native_count_even_for_a_short_url(self):
        payload = self.payload([{"role": "user", "content": [{"type": "image_url",
                               "image_url": {"url": "https://example.invalid/image.png"}}]}])
        native = NativeFixture()
        result, report = self.prepare(payload, native)
        self.assertIs(result, payload)
        self.assertIsNone(report)
        self.assertEqual(len(native.requests), 1)

    def test_invalid_native_token_count_fails_without_modifying_input(self):
        payload = self.payload(self.history())
        original = copy.deepcopy(payload)
        with self.assertRaisesRegex(ContextCompressionError, "measure"):
            self.prepare(payload, lambda *args: {"count": None, "max_model_len": 16000})
        self.assertEqual(payload, original)


class CompressionRelayTests(RelayFixture):
    def execute(self, *, stream=False, metered=False):
        h = MagicMock()
        h.headers = {"X-Reach-Metered": "provider-v1"} if metered else {}
        h._client_ip.return_value = "127.0.0.1"
        h.key_limits.return_value = (None, 0, 0)
        h._auth_key_id = "fixture-key-id"
        payload = {"model": "gemma-4-12b-qat", "messages": [{"role": "user", "content": "Hello"}],
                   "stream": stream}
        h._read_body.return_value = json.dumps(payload).encode()
        return h

    def test_prepared_payload_and_headers_reach_the_normal_streaming_path(self):
        h = self.execute(stream=True)
        report = {"before_tokens": 70000, "after_tokens": 40000, "reserved_tokens": 4096,
                  "schema_docs_compacted": True, "history_messages_summarized": 0,
                  "tool_results_summarized": 0}
        def prepare(selector, payload, spec, **kwargs):
            self.assertEqual(kwargs["namespace"], "fixture-key-id")
            return {**payload, "messages": [{"role": "user", "content": "Preserved request"}]}, report
        with patch("reachd.chat.prepare_gpu_context", side_effect=prepare), \
                patch("reachd.chat.net.urlopen", return_value=MagicMock()) as send:
            result = chat_execute(h, catalog="gpu")
        self.assertIsNotNone(result)
        sent = json.loads(send.call_args.args[0].data)
        self.assertEqual(sent["messages"][0]["content"], "Preserved request")
        self.assertEqual(result[1]["rl_headers"]["X-Reach-Context"], "compressed")
        self.state.gate.release()

    def test_compression_failure_releases_the_streaming_gate_without_generation(self):
        h = self.execute(stream=True)
        with patch("reachd.chat.prepare_gpu_context", side_effect=ContextCompressionError("too large")), \
                patch("reachd.chat.net.urlopen") as send:
            self.assertIsNone(chat_execute(h, catalog="gpu"))
        send.assert_not_called()
        self.assertEqual(self.state.gate._active, 0)
        self.assertEqual(h._json.call_args.args[1]["error"]["code"], "context_length_exceeded")

    def test_operator_opt_out_and_metered_requests_keep_the_existing_contract(self):
        for metered, enabled in ((False, False), (True, True)):
            with self.subTest(metered=metered):
                self.state.cfg["request"]["context_compression"] = enabled
                h = self.execute(metered=metered)
                with patch("reachd.chat.prepare_gpu_context") as prepare, \
                        patch("reachd.chat.net.urlopen", return_value=MagicMock()):
                    self.assertIsNotNone(chat_execute(h, catalog="gpu"))
                prepare.assert_not_called()


if __name__ == "__main__":
    unittest.main()
