"""Permission commands use the shared approval settings without extra prompts."""

import contextlib
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from reach_cli import chat, commands, session, settings, terminal
from reach_cli.agent_tools import TOOLS
from reach_cli.client import ReachClient


class PermissionTests(unittest.TestCase):
    def setUp(self):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        directory = stack.enter_context(tempfile.TemporaryDirectory())
        self.path = str(Path(directory) / "config.json")
        stack.enter_context(mock.patch.object(session, "session_config_path", return_value=self.path))
        self.output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        stack.enter_context(mock.patch.object(chat, "_set_pet_activity"))
        self.client = ReachClient("http://fixture.invalid/v1", model="fixture")
        self.client._session_permission_choices = set()
        settings.apply_client_settings(self.client)
        self.state = chat.AgentState()
        self.state.configure(self.client)

    def command(self, text):
        return commands.handle_slash(text, self.client, [])

    def test_autopilot_approves_every_catalog_tool_without_input(self):
        with mock.patch.object(terminal, "read_input", side_effect=AssertionError("unexpected prompt")):
            self.assertTrue(self.command("/permission autopilot").success)
            settings.apply_client_settings(self.client)
            self.state.configure(self.client)
            for name, tool in TOOLS.items():
                if tool.get("approval"):
                    with self.subTest(tool=name):
                        self.assertTrue(self.state.approve(name, "fixture"))
        self.assertTrue(chat.autopilot_enabled(self.client))
        self.assertFalse(self.client.cli_settings["conversation"]["reviewEdits"])

    def test_prompt_revokes_autopilot_and_always_grant(self):
        self.command("/permission autopilot")
        self.state.configure(self.client)
        self.state.auto_approve = True
        self.assertTrue(self.command("/permission prompt").success)
        self.state.configure(self.client)
        with mock.patch.object(terminal, "read_input", return_value="n") as ask:
            self.assertFalse(self.state.approve("shell", "fixture"))
            self.assertFalse(self.state.approve("edit", "fixture"))
        self.assertEqual(ask.call_count, 2)
        self.assertFalse(chat.autopilot_enabled(self.client))

    def test_status_and_invalid_argument_do_not_change_permissions(self):
        with mock.patch.object(settings, "save_cli_settings") as save:
            self.assertTrue(self.command("/permission").success)
            self.assertFalse(self.command("/permission nonsense").success)
        save.assert_not_called()
        self.assertIn("/permission autopilot", self.output.getvalue())
        self.assertIn("/permission", commands.command_tokens())

    def test_failed_save_does_not_grant_permissions(self):
        with mock.patch.object(settings, "save_cli_settings", side_effect=settings.SettingsError("failed")):
            self.assertFalse(self.command("/permission autopilot").success)
        self.assertFalse(chat.autopilot_enabled(self.client))

    def test_autopilot_prompt_and_legacy_edits(self):
        self.command("/permission autopilot")
        self.client.agent = True
        with tempfile.TemporaryDirectory() as directory:
            self.client.workpath = directory
            self.assertIn("Permission mode: autopilot", chat.build_system(self.client))
            block = {"path": "new.txt", "search": "", "replace": "hello"}
            with mock.patch.object(chat, "parse_edit_blocks", return_value=[block]), \
                    mock.patch.object(terminal, "read_input", side_effect=AssertionError("unexpected prompt")):
                self.assertEqual(chat.review_and_apply_edits(
                    directory, "fixture", auto_yes=chat.autopilot_enabled(self.client)), 1)
            self.assertEqual((Path(directory) / "new.txt").read_text(), "hello")


if __name__ == "__main__":
    unittest.main()
