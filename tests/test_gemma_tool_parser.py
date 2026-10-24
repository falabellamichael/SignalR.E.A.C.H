"""Exercise the pinned parser without importing GPU/vLLM dependencies."""

import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "docker/gpu"))
from patch_gemma_tool_parser import patch_source


class GemmaToolParserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = (ROOT / "tests/fixtures/gemma4_literal_parser.py.txt").read_text(encoding="utf-8")

    def parser(self, patched=True):
        source = patch_source(self.source) if patched else self.source
        namespace = {"init_logger": __import__("logging").getLogger}
        exec(compile(source, "gemma4_literal_fixture.py", "exec"), namespace)
        return namespace["_parse_gemma4_args"]

    def test_nested_numbers_booleans_and_null_keep_native_types(self):
        raw = 'query:{limit:3,score:-1.25,enabled:true,empty:null},values:[1,false,null,{count:2}]'
        self.assertEqual(self.parser(False)(raw)["query"]["limit"], "3")
        self.assertEqual(self.parser()(raw), {"query": {"limit": 3, "score": -1.25, "enabled": True, "empty": None},
                                              "values": [1, False, None, {"count": 2}]})

    def test_delimited_strings_are_not_changed_to_scalars(self):
        for value in ["3", "true", "false", "null", "00123", "1e3"]:
            with self.subTest(value=value):
                self.assertEqual(self.parser()('value:<|"|>' + value + '<|"|>'), {"value": value})

    def test_invalid_and_nonfinite_literals_remain_strings(self):
        for value in ["READY", "01", "NaN", "Infinity", "-Infinity", "1e999"]:
            with self.subTest(value=value):
                self.assertEqual(self.parser()('value:' + value), {"value": value})
        self.assertEqual(self.parser()('value:1e3'), {"value": 1000.0})

    def test_partial_streaming_values_are_withheld_until_stable(self):
        parse = self.parser()
        for value in ["3", "true", "null", "1e3", "108."]:
            with self.subTest(value=value):
                self.assertEqual(parse('value:' + value, partial=True), {})
        self.assertEqual(parse('value:3,next:', partial=True), {"value": 3})
        self.assertEqual(parse('value:[1,true,null],next:', partial=True), {"value": [1, True, None]})

    def test_patch_is_idempotent_and_unknown_sources_are_rejected(self):
        result = patch_source(self.source)
        self.assertEqual(patch_source(result), result)
        with self.assertRaises(RuntimeError):
            patch_source(self.source.replace('            items.append(raw_val)', '            items.append(str(raw_val))'))


if __name__ == "__main__":
    unittest.main()
