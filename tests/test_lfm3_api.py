"""Unit tests for the LFM3-Omni FastAPI translation layer and its private route.

The serving module imports torch, numpy, FastAPI, and pydantic at load time.
CI installs none of those, so the translation cases skip cleanly there. The
private-route contract does not need the serving module and always runs.
"""
import importlib.util
import json
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

from reachd import model_routes


def _load_lfm3():
    sys.modules.setdefault("torch", types.ModuleType("torch"))
    sys.modules.setdefault("numpy", types.ModuleType("numpy"))
    try:
        import fastapi  # noqa: F401
        import pydantic  # noqa: F401
    except ImportError:
        return None
    spec = importlib.util.spec_from_file_location(
        "lfm3_api", ROOT / "docker" / "gpu" / "lfm3_api.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


lfm3 = _load_lfm3()
_needs_lfm3 = unittest.skipUnless(
    lfm3 is not None, "fastapi and pydantic are required to load the LFM3 serving API")


@_needs_lfm3
class TestTokenizeContract(unittest.TestCase):
    def test_chat_count_includes_tools_and_context_limit(self):
        from unittest.mock import Mock
        processor = Mock()
        processor.apply_chat_template.return_value = {
            "input_ids": types.SimpleNamespace(shape=(1, 37))}
        tools = [{"type": "function", "function": {"name": "weather"}}]
        with patch.dict(lfm3.STATE, {"model": object(), "processor": processor}):
            result = lfm3.tokenize(lfm3.TokenizeRequest(
                messages=[{"role": "user", "content": "hi"}], tools=tools))
        self.assertEqual(result["count"], 37)
        self.assertEqual(result["max_model_len"], 32768)
        self.assertEqual(processor.apply_chat_template.call_args.kwargs["tools"], tools)

    def test_plain_prompt_count_has_context_limit(self):
        from unittest.mock import Mock
        processor = Mock()
        processor.tokenizer.return_value = types.SimpleNamespace(input_ids=[1, 2, 3])
        with patch.dict(lfm3.STATE, {"model": object(), "processor": processor}):
            result = lfm3.tokenize(lfm3.TokenizeRequest(prompt="hi"))
        self.assertEqual(result, {"tokens": 3, "count": 3, "max_model_len": 32768})


@_needs_lfm3
class TestToolCallTranslation(unittest.TestCase):
    def test_openai_tool_call_to_template_entry(self):
        call = {"id": "call_1", "type": "function",
                "function": {"name": "get_weather",
                             "arguments": "{\"city\": \"Paris\"}"}}
        entry = lfm3.parse_tool_call_entry(call)
        self.assertEqual(entry["function"]["name"], "get_weather")
        self.assertEqual(entry["function"]["arguments"], {"city": "Paris"})

    def test_tool_call_arguments_must_be_object(self):
        call = {"function": {"name": "f", "arguments": "[1,2]"}}
        with self.assertRaises(Exception):
            lfm3.parse_tool_call_entry(call)

    def test_parse_generated_tool_call_xml(self):
        text = ('checking <tool_call><function=get_weather>{"city": "Rome"}'
                '</function></tool_call> done')
        clean, calls = lfm3.parse_generated_tool_calls(text)
        self.assertEqual(clean, "checking  done")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["type"], "function")
        self.assertEqual(calls[0]["function"]["name"], "get_weather")
        self.assertEqual(json.loads(calls[0]["function"]["arguments"]),
                         {"city": "Rome"})
        self.assertTrue(calls[0]["id"].startswith("call_"))

    def test_parse_generated_tool_calls_none(self):
        clean, calls = lfm3.parse_generated_tool_calls("plain answer")
        self.assertEqual(clean, "plain answer")
        self.assertEqual(calls, [])

    def test_coerce_tool_arguments_decodes_schema_objects(self):
        text = ('<tool_call><function=create-automation>'
                '<parameter=name>morning brief</parameter>'
                '<parameter=target>{"kind": "reminder", "hour": 9}</parameter>'
                '</function></tool_call>')
        _, calls = lfm3.parse_generated_tool_calls(text)
        tools = [{"type": "function", "function": {
            "name": "create-automation",
            "parameters": {"properties": {
                "name": {"type": "string"},
                "target": {"type": "object"}}}}}]
        lfm3.coerce_tool_arguments(calls, tools)
        args = json.loads(calls[0]["function"]["arguments"])
        self.assertEqual(args["target"], {"kind": "reminder", "hour": 9})
        self.assertEqual(args["name"], "morning brief")

    def test_coerce_tool_arguments_extracts_embedded_json(self):
        text = ('<tool_call><function=f><parameter=items>'
                'here: [1, 2] done</parameter></function></tool_call>')
        _, calls = lfm3.parse_generated_tool_calls(text)
        tools = [{"type": "function", "function": {
            "name": "f", "parameters": {"properties": {
                "items": {"type": "array"}}}}}]
        lfm3.coerce_tool_arguments(calls, tools)
        args = json.loads(calls[0]["function"]["arguments"])
        self.assertEqual(args["items"], [1, 2])

    def test_coerce_tool_arguments_leaves_prose(self):
        text = ('<tool_call><function=f><parameter=target>'
                'a plain description</parameter></function></tool_call>')
        _, calls = lfm3.parse_generated_tool_calls(text)
        tools = [{"type": "function", "function": {
            "name": "f", "parameters": {"properties": {
                "target": {"type": "object"}}}}}]
        lfm3.coerce_tool_arguments(calls, tools)
        args = json.loads(calls[0]["function"]["arguments"])
        self.assertEqual(args["target"], "a plain description")


@_needs_lfm3
class TestStopTruncation(unittest.TestCase):
    def test_string_stop(self):
        self.assertEqual(lfm3.truncate_stops("hello world end", "world"),
                         "hello ")

    def test_list_stop_picks_earliest(self):
        self.assertEqual(
            lfm3.truncate_stops("aa STOP1 bb STOP2 cc", ["STOP2", "STOP1"]),
            "aa ")

    def test_no_stop(self):
        self.assertEqual(lfm3.truncate_stops("text", None), "text")


@_needs_lfm3
class TestMessageNormalization(unittest.TestCase):
    def test_developer_maps_to_system(self):
        conversation, metas = lfm3.normalize_messages(
            [{"role": "developer", "content": "be brief"},
             {"role": "user", "content": "hi"}])
        self.assertEqual(conversation[0]["role"], "system")
        self.assertEqual(metas, [])

    def test_tool_call_entries_normalized(self):
        conversation, _ = lfm3.normalize_messages(
            [{"role": "assistant", "content": None, "tool_calls": [
                {"function": {"name": "f", "arguments": "{}"}}]}])
        self.assertEqual(conversation[0]["tool_calls"][0]["function"]["name"], "f")

    def test_tool_role_keeps_call_id(self):
        conversation, _ = lfm3.normalize_messages(
            [{"role": "tool", "tool_call_id": "call_9", "content": "42"}])
        self.assertEqual(conversation[0]["tool_call_id"], "call_9")

    def test_rejects_bad_role(self):
        with self.assertRaises(Exception):
            lfm3.normalize_messages([{"role": "robot", "content": "x"}])

    def test_rejects_empty(self):
        with self.assertRaises(Exception):
            lfm3.normalize_messages([])

    def test_unknown_part_type_rejected(self):
        with self.assertRaises(Exception):
            lfm3.normalize_messages(
                [{"role": "user", "content": [{"type": "smell", "smell": "x"}]}])


@_needs_lfm3
class TestResponseFormat(unittest.TestCase):
    def test_json_object_inserts_system_instruction(self):
        conversation = [{"role": "user", "content": "x"}]
        lfm3.apply_response_format(conversation, {"type": "json_object"})
        self.assertEqual(conversation[0]["role"], "system")
        self.assertIn("JSON", conversation[0]["content"])

    def test_json_schema_embeds_schema(self):
        schema = {"type": "json_schema",
                  "json_schema": {"schema": {"type": "object",
                                            "properties": {"a": {"type": "integer"}}}}}
        conversation = [{"role": "system", "content": "sys"},
                        {"role": "user", "content": "x"}]
        lfm3.apply_response_format(conversation, schema)
        self.assertIn('"a"', conversation[0]["content"])

    def test_text_format_is_noop(self):
        conversation = [{"role": "user", "content": "x"}]
        lfm3.apply_response_format(conversation, {"type": "text"})
        self.assertEqual(len(conversation), 1)

    def test_unknown_format_rejected(self):
        with self.assertRaises(Exception):
            lfm3.apply_response_format([{"role": "user", "content": "x"}],
                                       {"type": "yaml"})


@_needs_lfm3
class TestGenerationKwargs(unittest.TestCase):
    def _request(self, **fields):
        base = {"messages": [{"role": "user", "content": "x"}]}
        base.update(fields)
        return lfm3.ChatRequest(**base)

    def test_modalities_audio_maps_generation_mode(self):
        request = self._request(modalities=["audio"])
        self.assertEqual(request.modalities, ["audio"])

    def test_generation_mode_validation(self):
        request = self._request(generation_mode="bogus")
        with self.assertRaises(Exception):
            lfm3.build_generation_kwargs(request)

    def test_presence_penalty_rejected(self):
        request = self._request(presence_penalty=1.0)
        with self.assertRaises(Exception):
            lfm3.build_generation_kwargs(request)

    def test_max_tokens_budget_cap(self):
        request = self._request(max_tokens=10**9)
        with self.assertRaises(Exception):
            lfm3.build_generation_kwargs(request)


@_needs_lfm3
class TestModelAlias(unittest.TestCase):
    def test_aliases_accepted(self):
        for alias in (None, "lfm3-omni-2b", "LiquidAI/LFM3-Omni-2B",
                      "lfm3", "lfm3-omni"):
            lfm3.check_model_alias(alias)

    def test_unknown_model_rejected(self):
        with self.assertRaises(Exception):
            lfm3.check_model_alias("gpt-4o")


class TestPrivateRoute(unittest.TestCase):
    def test_lfm3_route_is_fixed_loopback(self):
        route = model_routes.private_route("gpu/lfm3-omni-2b")
        self.assertEqual(route["url"],
                         "http://127.0.0.1:18005/v1/chat/completions")
        self.assertEqual(route["model"], "LiquidAI/LFM3-VL-2B")

    def test_dispatch_keeps_tools_and_skips_thinking_kwarg(self):
        state = types.SimpleNamespace(key="k", bridge_url="", omniroute_url="")
        payload = {"model": "x", "messages": [],
                   "tools": [{"type": "function", "function": {"name": "f"}}],
                   "stream": False}
        url, data, headers, circuit = model_routes.dispatch(
            "gpu/lfm3-omni-2b", payload, state, {})
        self.assertEqual(url, "http://127.0.0.1:18005/v1/chat/completions")
        self.assertEqual(data["model"], "LiquidAI/LFM3-VL-2B")
        self.assertIn("tools", data)
        self.assertEqual(data["chat_template_kwargs"], {"enable_thinking": True})
        self.assertEqual(data["temperature"], 0.1)
        self.assertEqual(data["top_k"], 50)
        self.assertEqual(data["repetition_penalty"], 1.1)

    def test_dispatch_lfm3_stream_adds_usage(self):
        state = types.SimpleNamespace(key="k", bridge_url="", omniroute_url="")
        _, data, _, _ = model_routes.dispatch(
            "gpu/lfm3-omni-2b",
            {"model": "x", "messages": [], "stream": True}, state, {})
        self.assertEqual(data["stream_options"]["include_usage"], True)

    def test_context_window_advertised(self):
        defaults = model_routes.deployment_defaults({})
        self.assertEqual(defaults["lfm3-omni-2b"]["context_window"], 131072)
        self.assertEqual(defaults["lfm3-vl-2b"]["context_window"], 131072)
        self.assertTrue(defaults["lfm3-omni-2b"]["allow_tools"])
        self.assertTrue(defaults["lfm3-vl-2b"]["allow_tools"])
        self.assertTrue(defaults["lfm3-omni-2b"]["enabled"])
        self.assertTrue(defaults["lfm3-vl-2b"]["enabled"])

    def test_gemma_still_gets_thinking_kwarg(self):
        state = types.SimpleNamespace(key="k", bridge_url="", omniroute_url="")
        _, data, _, _ = model_routes.dispatch(
            "gpu/gemma-4-12b-qat", {"model": "x", "messages": []}, state, {})
        self.assertEqual(data["chat_template_kwargs"], {"enable_thinking": True})

    def test_unknown_gpu_selector_rejected(self):
        with self.assertRaises(ValueError):
            model_routes.private_route("gpu/not-a-model")


if __name__ == "__main__":
    unittest.main()
