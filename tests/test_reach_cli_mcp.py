"""CLI MCP discovery, schema and permission boundaries."""
import json
import os
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))
from reach_cli import agent_tools


class McpTests(unittest.TestCase):
    def test_catalog_discovery_never_contacts_studio(self):
        ctx = {"approve": Mock(side_effect=AssertionError), "selected_tools": set()}
        result = json.loads(agent_tools.run_tool("tool_discover", {"category": "mcp"}, ".", ctx))
        self.assertEqual(set(result["activated"]), {"mcp_discover", "mcp_call"})

    def test_remote_discovery_filters_and_preserves_schema(self):
        bridge = Mock()
        tool = {"name": "roblox__list", "description": "List studios", "inputSchema": {"type": "object"}}
        bridge.call.return_value = {"tools": [tool, {"name": "blender__list"}]}
        ctx = {"approve": lambda *_: True, "mcp_bridge": bridge}
        result = json.loads(agent_tools.run_tool("mcp_discover", {"query": "roblox"}, ".", ctx))
        self.assertEqual(result["tools"], [tool])
        bridge.call.assert_called_once_with("mcp.tools")

    def test_denied_calls_and_discovery_do_not_contact_bridge(self):
        for name, args in (("mcp_discover", {}), ("mcp_call", {"name": "a__b", "arguments": {}})):
            bridge = Mock()
            result = agent_tools.run_tool(name, args, ".", {"approve": lambda *_: False, "mcp_bridge": bridge})
            self.assertIn("denied by the user", result)
            bridge.call.assert_not_called()

    def test_call_forwards_arguments_after_approval(self):
        bridge = Mock()
        bridge.call.return_value = {"ok": True, "text": "studios"}
        approve = Mock(return_value=True)
        args = {"name": "roblox__list", "arguments": {"studio_id": "one"}}
        result = json.loads(agent_tools.run_tool("mcp_call", args, ".", {"approve": approve, "mcp_bridge": bridge}))
        self.assertTrue(result["ok"])
        approve.assert_called_once()
        bridge.call.assert_called_once_with("mcp.call", args)

    def test_invalid_arguments_and_bridge_errors_are_tool_errors(self):
        bridge = Mock()
        ctx = {"approve": lambda *_: True, "mcp_bridge": bridge}
        result = agent_tools.run_tool("mcp_call", {"name": "a__b", "arguments": []}, ".", ctx)
        self.assertTrue(result.startswith("error:"))
        bridge.call.assert_not_called()
        bridge.call.side_effect = ValueError("Restart updated Studio")
        self.assertIn("Restart updated Studio", agent_tools.run_tool("mcp_discover", {}, ".", ctx))


if __name__ == "__main__":
    unittest.main()
