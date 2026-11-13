import ast
import copy
import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1] / "docker" / "gpu"


class Lfm3ToolParserTests(unittest.TestCase):
    def test_whitespace_bound_does_not_rewrite_tool_schema_or_string_values(self):
        tree = ast.parse((ROOT / "lfm3_tool_parser.py").read_text(encoding="utf-8"))
        node = next(node for node in tree.body if isinstance(node, ast.FunctionDef)
                    and node.name == "bound_schema_whitespace")
        namespace = {}
        exec(compile(ast.Module(body=[node], type_ignores=[]), "lfm3_tool_parser.py", "exec"), namespace)
        schema = {"type": "object", "properties": {"body": {"type": "string",
                  "const": "Line one.\n\nLine two."}},
                  "examples": [{"type": "json_schema", "max_whitespace_cnt": 99}]}
        original = copy.deepcopy(schema)
        tag = {"type": "structural_tag", "format": {"type": "sequence", "elements": [
            {"type": "tag", "content": {"type": "json_schema", "json_schema": schema,
                                         "max_whitespace_cnt": None}},
            {"type": "tag", "content": {"type": "json_schema", "json_schema": True}},
        ]}}
        namespace["bound_schema_whitespace"](tag)
        for item in tag["format"]["elements"]:
            self.assertEqual(item["content"]["max_whitespace_cnt"], 1)
        self.assertEqual(schema, original)

    def test_both_deployments_require_native_tool_parser_and_keep_graphs(self):
        spec = importlib.util.spec_from_file_location("lfm3_launch", ROOT / "launch_services.py")
        launch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(launch)
        for key in ("lfm3", "lfm3-omni"):
            with self.subTest(model=key):
                flags = launch.SERVICES[key][-1]
                self.assertIn("--enable-auto-tool-choice", flags)
                self.assertEqual(flags[flags.index("--tool-call-parser") + 1], "lfm3_xml")
                self.assertEqual(flags[flags.index("--tool-parser-plugin") + 1], "/app/lfm3_tool_parser.py")
                self.assertEqual(flags[flags.index("--tool-strict-level") + 1], "parameter")
                self.assertEqual(launch.chat_decode_config(key)["cudagraph_mode"], "FULL_DECODE_ONLY")
                self.assertEqual(launch.CHAT_CONTEXT_WINDOWS[key], 128000)


if __name__ == "__main__":
    unittest.main()
