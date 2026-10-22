"""Run in the pinned vLLM container; no model loading or GPU inference needed."""

import importlib.util
import json
from types import SimpleNamespace
import unittest


HAS_VLLM = importlib.util.find_spec("vllm") is not None
if HAS_VLLM:
    from vllm.entrypoints.openai.chat_completion.protocol import ChatCompletionRequest
    from vllm.tool_parsers.minicpm5xml_tool_parser import (
        MiniCPM5XMLToolParser, _build_tool_maps, _parse_function_block,
    )


@unittest.skipUnless(HAS_VLLM, "Run inside the pinned MiniCPM vLLM container")
class MiniCPMRaycastParserTests(unittest.TestCase):
    def request(self, *, metadata=True, required=True):
        properties = {"location": {"type": "string"}, "query": {"type": "string"}}
        needed = ["location", "query"]
        if metadata:
            properties["__raycast_tool_call_description"] = {"type": "string"}
            if required:
                needed.append("__raycast_tool_call_description")
        return ChatCompletionRequest(model="test", messages=[], tools=[{
            "type": "function", "function": {"name": "weather__get-weather",
                "parameters": {"type": "object", "properties": properties, "required": needed}}}])

    def block(self, description=None, *, location=True):
        return ('<function name="weather__get-weather">'
                + ('<param name="location">Toronto</param>' if location else '')
                + '<param name="query">current</param>'
                + ('' if description is None else
                   '<param name="__raycast_tool_call_description">' + description + '</param>')
                + '</function>')

    def parse(self, request, block):
        return _parse_function_block(block, *_build_tool_maps(request.tools))

    def test_omitted_required_display_label_does_not_reject_valid_tool_inputs(self):
        result = self.parse(self.request(), self.block())
        self.assertIsNotNone(result)
        self.assertEqual(result["parameters"], {"location": "Toronto", "query": "current",
                         "__raycast_tool_call_description": "Get weather"})

    def test_explicit_description_is_preserved(self):
        result = self.parse(self.request(), self.block("Check Toronto weather"))
        self.assertEqual(result["parameters"]["__raycast_tool_call_description"], "Check Toronto weather")

    def test_missing_required_business_input_still_rejects_the_call(self):
        self.assertIsNone(self.parse(self.request(), self.block(location=False)))

    def test_other_clients_and_optional_metadata_keep_their_arguments(self):
        for request in (self.request(metadata=False), self.request(required=False)):
            with self.subTest(request=request):
                result = self.parse(request, self.block())
                self.assertEqual(result["parameters"], {"location": "Toronto", "query": "current"})

    def test_schema_is_not_mutated(self):
        request = self.request()
        before = request.model_dump_json()
        self.parse(request, self.block())
        self.assertEqual(request.model_dump_json(), before)

    def test_streamed_call_closes_json_and_never_emits_xml_as_content(self):
        for size in (1, 7, 10000):
            with self.subTest(chunk_size=size):
                parser = MiniCPM5XMLToolParser(SimpleNamespace())
                request = self.request()
                text = self.block()
                previous = ""
                arguments = ""
                content = ""
                names = []
                # MiniCPM's <function tag opener is a single special token.
                opener = "<function"
                chunks = [opener] + [text[offset:offset + size]
                                     for offset in range(len(opener), len(text), size)]
                for delta_text in chunks:
                    current = previous + delta_text
                    delta = parser.extract_tool_calls_streaming(previous, current, delta_text,
                                                               [], [], [], request)
                    previous = current
                    if delta is None:
                        continue
                    content += delta.content or ""
                    for call in delta.tool_calls or []:
                        function = call.function
                        if isinstance(function, dict):
                            arguments += function.get("arguments") or ""
                            if function.get("name"):
                                names.append(function["name"])
                        else:
                            arguments += function.arguments or ""
                            if function.name:
                                names.append(function.name)
                self.assertEqual(content, "")
                self.assertEqual(names, ["weather__get-weather"])
                self.assertEqual(json.loads(arguments), {"location": "Toronto", "query": "current",
                                 "__raycast_tool_call_description": "Get weather"})


if __name__ == "__main__":
    unittest.main()
