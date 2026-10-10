"""The advertised catalog must match executable tools and stay compact."""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))
from reach_cli import agent_tools as tools


class AgentCatalogTests(unittest.TestCase):
    def test_all_36_tools_have_callable_implementation_and_native_schema(self):
        self.assertEqual(len(tools.TOOLS), 36)
        self.assertEqual(set(tools.TOOL_PARAMETERS), set(tools.TOOLS))
        schemas = tools.tool_schemas(tools.TOOLS)
        self.assertEqual(len(schemas), 36)
        for schema in schemas:
            function = schema["function"]
            self.assertTrue(callable(tools.TOOLS[function["name"]]["run"]))
            self.assertEqual(schema["type"], "function")
            self.assertEqual(function["parameters"]["type"], "object")
            for required in function["parameters"].get("required", []):
                self.assertIn(required, function["parameters"]["properties"])

    def test_default_native_and_fallback_help_only_core(self):
        self.assertEqual(len(tools.tool_schemas()), 11)
        self.assertIn("tool_discover", tools.DEFAULT_TOOL_NAMES)
        self.assertIn("tool_discover", tools.tool_help_text())
        self.assertNotIn('"action": "process_start"', tools.tool_help_text())
        self.assertNotIn("git_status", {item["function"]["name"] for item in tools.tool_schemas()})

    def test_full_catalog_categories_and_approvals_are_honest(self):
        records = tools.tool_catalog()
        self.assertEqual({item["category"] for item in records},
                         {"files", "git", "execution", "processes", "web", "planning", "discovery"})
        self.assertEqual(sum(item["approval"] for item in records), 13)
        self.assertEqual(len(tools.tool_catalog(category="git")), 6)
        self.assertTrue(all(not item["approval"] for item in tools.tool_catalog(category="git")))
        self.assertEqual(len(tools.tool_catalog(category="processes")), 5)

    def test_discovery_selects_exact_names_without_execution(self):
        ctx = {"selected_tools": set(), "approve": lambda *_: self.fail("discovery requested approval")}
        result = json.loads(tools.run_tool("tool_discover", {"names": ["git_status", "git_diff"]}, ".", ctx))
        self.assertEqual(ctx["selected_tools"], {"git_status", "git_diff"})
        self.assertEqual(result["activated"], ["git_status", "git_diff"])
        schemas = tools.tool_schemas(tools.DEFAULT_TOOL_NAMES + tuple(sorted(ctx["selected_tools"])))
        self.assertEqual(len(schemas), 13)

    def test_discovery_replaces_and_caps_selection(self):
        ctx = {"selected_tools": {"process_start"}}
        result = json.loads(tools.run_tool("tool_discover", {"category": "git"}, ".", ctx))
        self.assertEqual(len(result["tools"]), 6)
        self.assertEqual(len(ctx["selected_tools"]), 5)
        self.assertNotIn("process_start", ctx["selected_tools"])
        self.assertEqual(len(tools.tool_schemas(tools.DEFAULT_TOOL_NAMES + tuple(ctx["selected_tools"]))), 16)

    def test_empty_discovery_only_lists_without_replacing_selection(self):
        ctx = {"selected_tools": {"git_status"}}
        result = json.loads(tools.run_tool("tool_discover", {}, ".", ctx))
        self.assertEqual(result["total_available"], 36)
        self.assertEqual(result["activated"], [])
        self.assertEqual(ctx["selected_tools"], {"git_status"})

    def test_discovery_unknown_name_is_actionable_and_preserves_selection(self):
        ctx = {"selected_tools": {"git_status"}}
        result = tools.run_tool("tool_discover", {"names": ["arbitrary_pid_kill"]}, ".", ctx)
        self.assertTrue(result.startswith("error:"))
        self.assertIn("unknown tool names", result)
        self.assertEqual(ctx["selected_tools"], {"git_status"})

    def test_discovery_can_inspect_without_activation(self):
        ctx = {"selected_tools": set()}
        result = json.loads(tools.run_tool("tool_discover", {"query": "process", "activate": False}, ".", ctx))
        self.assertGreater(result["matched"], 0)
        self.assertFalse(ctx["selected_tools"])

    def test_search_help_and_defensive_catalog_copy(self):
        lines = tools.help_lines("git diff")
        self.assertEqual(len(lines), 1)
        self.assertIn("git_diff", lines[0])
        self.assertIn("read/state", lines[0])
        self.assertEqual(tools.help_lines("nonexistentmagictool"), [])
        records = tools.tool_catalog(names=["read"])
        records[0]["parameters"]["properties"]["path"]["type"] = "bad"
        self.assertEqual(tools.TOOL_PARAMETERS["read"][0]["path"]["type"], "string")

    def test_explicit_schema_list_deduplicates_and_ignores_unknown(self):
        result = tools.tool_schemas(["read", "read", "not_a_tool", "git_status"])
        self.assertEqual([item["function"]["name"] for item in result], ["read", "git_status"])

    def test_bad_catalog_arguments_return_errors(self):
        for args in ({"query": []}, {"category": 3}, {"names": "git_status"}, {"names": [3]}):
            with self.subTest(args=args):
                self.assertTrue(tools.run_tool("tool_discover", args, ".", {}).startswith("error:"))

    def test_write_previews_do_not_include_content_or_credentials(self):
        for name in ("write_file", "write_json", "append_file", "replace_all"):
            self.assertEqual(tools.format_args(name, {"path": "config.json", "content": "fixture-password"}), "config.json")
        self.assertNotIn("fixture-secret", tools.format_args("shell", {"command": "tool --api-key fixture-secret"}))


if __name__ == "__main__":
    unittest.main()
