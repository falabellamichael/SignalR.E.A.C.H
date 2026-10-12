"""Companion commands preserve session preferences in plain and live CLI modes."""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest import mock


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from reach_cli import terminal, commands, session  # noqa: E402


class PetCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="reach-pet-", dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.path = os.path.join(self.temp.name, "config.json")
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"model": "keep-model", "layout": "full",
                       "custom_field": {"keep": True}}, handle)
        environment = mock.patch.dict(os.environ, {"REACH_CLI_CONFIG": self.path})
        environment.start()
        self.addCleanup(environment.stop)
        self.client = SimpleNamespace(pet="cat", pet_motion=True)

    def invoke(self, line, footer=None):
        output = io.StringIO()
        with redirect_stdout(output), \
                mock.patch.object(terminal, "PAINT", terminal.Paint(False)), \
                mock.patch("reach_cli.chatbox.active_footer", return_value=footer):
            result = commands.handle_slash(line, self.client, [])
        return result, output.getvalue()

    def config_data(self):
        with open(self.path, encoding="utf-8") as handle:
            return json.load(handle)

    def test_listing_shows_active_pet_choices_and_shortcut_without_saving(self):
        self.client.pet = "owl"
        self.client.pet_motion = False
        before = self.config_data()
        result, output = self.invoke("/pet")
        self.assertTrue(result.success)
        self.assertIn("owl", output)
        self.assertIn("paused", output)
        for choice in ("cat", "owl", "bulldog", "next", "pause", "resume", "Ctrl+T"):
            self.assertIn(choice, output)
        self.assertEqual(self.config_data(), before)

    def test_plain_command_updates_and_saves_selection_preserving_other_fields(self):
        result, _output = self.invoke("/pet OWL")
        self.assertTrue(result.success)
        self.assertEqual(self.client.pet, "owl")
        self.assertTrue(self.client.pet_motion)
        data = self.config_data()
        self.assertEqual(data["pet"], "owl")
        self.assertTrue(data["pet_motion"])
        self.assertEqual(data["model"], "keep-model")
        self.assertEqual(data["layout"], "full")
        self.assertEqual(data["custom_field"], {"keep": True})

    def test_next_cycles_all_three_companions_and_keeps_paused_preference(self):
        self.client.pet_motion = False
        for expected in ("owl", "bulldog", "cat"):
            with self.subTest(expected=expected):
                result, _output = self.invoke("/pet next")
                self.assertTrue(result.success)
                self.assertEqual(self.client.pet, expected)
                self.assertEqual(self.config_data()["pet"], expected)
                self.assertFalse(self.client.pet_motion)
                self.assertFalse(self.config_data()["pet_motion"])

    def test_live_selection_and_motion_update_footer_and_saved_session(self):
        footer = mock.Mock()
        for argument, expected_pet, expected_motion in (
                ("bulldog", "bulldog", True),
                ("pause", "bulldog", False),
                ("resume", "bulldog", True)):
            with self.subTest(argument=argument):
                footer.reset_mock()
                result, _output = self.invoke("/pet " + argument, footer)
                self.assertTrue(result.success)
                footer.select_pet.assert_called_once_with(expected_pet)
                footer.set_pet_motion.assert_called_once_with(expected_motion)
                self.assertEqual(self.client.pet, expected_pet)
                self.assertEqual(self.client.pet_motion, expected_motion)
                saved = session.load_session_config(self.path)
                self.assertEqual(saved["pet"], expected_pet)
                self.assertEqual(saved["pet_motion"], expected_motion)

    def test_invalid_choice_does_not_change_client_footer_or_config(self):
        self.invoke("/pet owl")
        self.invoke("/pet pause")
        before = self.config_data()
        footer = mock.Mock()
        for argument in ("dragon", "cat owl", "paused"):
            with self.subTest(argument=argument):
                result, output = self.invoke("/pet " + argument, footer)
                self.assertFalse(result.success)
                self.assertIn("usage: /pet", output)
                self.assertEqual(self.client.pet, "owl")
                self.assertFalse(self.client.pet_motion)
                self.assertEqual(self.config_data(), before)
        footer.select_pet.assert_not_called()
        footer.set_pet_motion.assert_not_called()

    def test_save_failure_reports_live_setting_without_claiming_it_persisted(self):
        with mock.patch.object(commands, "save_session_config", return_value=False):
            result, output = self.invoke("/pet owl")
        self.assertTrue(result.success)
        self.assertEqual(self.client.pet, "owl")
        self.assertIn("applied for this session", output)
        self.assertIn("could not save", output)
        self.assertNotIn("pet", self.config_data())

    def test_older_client_without_pet_attributes_gets_command_defaults(self):
        self.client = SimpleNamespace()
        result, _output = self.invoke("/pet next")
        self.assertTrue(result.success)
        self.assertEqual(self.client.pet, "owl")
        self.assertTrue(self.client.pet_motion)


class PetSessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="reach-pet-session-", dir=ROOT)
        self.addCleanup(self.temp.cleanup)
        self.path = os.path.join(self.temp.name, "config.json")
        self.args = SimpleNamespace(base=None, model=None, workpath=None)

    def test_saved_selection_and_pause_restore_into_a_new_client(self):
        self.assertTrue(session.save_session_config(
            pet="OWL", pet_motion=False, path=self.path))
        client = SimpleNamespace(pet="cat", pet_motion=True)
        saved = session.apply_saved_session(client, self.args, path=self.path)
        self.assertEqual(saved, {"pet": "owl", "pet_motion": False})
        self.assertEqual(client.pet, "owl")
        self.assertFalse(client.pet_motion)
        self.assertTrue(session.save_session_config(model="other-model", path=self.path))
        saved = session.load_session_config(self.path)
        self.assertEqual(saved["pet"], "owl")
        self.assertFalse(saved["pet_motion"])

    def test_no_saved_preferences_default_only_missing_client_attributes(self):
        empty = SimpleNamespace()
        existing = SimpleNamespace(pet="bulldog", pet_motion=False)
        with redirect_stdout(io.StringIO()):
            session.apply_saved_session(empty, self.args, path=self.path)
            session.apply_saved_session(existing, self.args, path=self.path)
        self.assertEqual(empty.pet, "cat")
        self.assertTrue(empty.pet_motion)
        self.assertEqual(existing.pet, "bulldog")
        self.assertFalse(existing.pet_motion)

    def test_malformed_saved_preferences_are_ignored(self):
        for pet, motion in (("dragon", "false"), ([], 0)):
            with self.subTest(pet=pet):
                with open(self.path, "w", encoding="utf-8") as handle:
                    json.dump({"pet": pet, "pet_motion": motion}, handle)
                self.assertEqual(session.load_session_config(self.path), {})

    def test_invalid_save_and_corrupt_config_do_not_overwrite_settings(self):
        self.assertTrue(session.save_session_config(
            pet="bulldog", pet_motion=False, path=self.path))
        with open(self.path, encoding="utf-8") as handle:
            before = handle.read()
        self.assertFalse(session.save_session_config(pet="dragon", path=self.path))
        self.assertFalse(session.save_session_config(pet_motion="false", path=self.path))
        with open(self.path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), before)
        with open(self.path, "w", encoding="utf-8") as handle:
            handle.write("{broken")
        self.assertFalse(session.save_session_config(pet="cat", path=self.path))
        with open(self.path, encoding="utf-8") as handle:
            self.assertEqual(handle.read(), "{broken")


if __name__ == "__main__":
    unittest.main()
