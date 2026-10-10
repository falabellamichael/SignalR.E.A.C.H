"""Regression tests for settings imports and live facade dependencies."""

import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import reachd
from reachd import settings
from reachd import settings_schema


class SettingsModuleCompatibilityTests(unittest.TestCase):
    def test_package_and_settings_expose_the_same_schema_and_error(self):
        self.assertIs(reachd.DEFAULT_SETTINGS, settings.DEFAULT_SETTINGS)
        self.assertIs(settings.DEFAULT_SETTINGS, settings_schema.DEFAULT_SETTINGS)
        self.assertIs(reachd.SettingsError, settings.SettingsError)
        config = copy.deepcopy(settings.DEFAULT_SETTINGS)
        config["port"] = 1
        for validate in (reachd.validate_settings, settings.validate_settings):
            with self.subTest(validate=validate), self.assertRaisesRegex(
                    settings.SettingsError, "port must be between 1024 and 65535"):
                validate(config)

    def test_validation_uses_the_current_facade_defaults(self):
        defaults = copy.deepcopy(settings.DEFAULT_SETTINGS)
        defaults["operator_label"] = ""
        config = copy.deepcopy(defaults)
        config["operator_label"] = "Fixture"
        with self.assertRaisesRegex(settings.SettingsError, "operator_label"):
            settings.validate_settings(config)
        with patch.object(settings, "DEFAULT_SETTINGS", defaults):
            settings.validate_settings(config)

    def test_patched_url_policy_controls_validation_and_persistence(self):
        config = copy.deepcopy(settings.DEFAULT_SETTINGS)
        config["system"]["host_bind"] = False
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            with patch.object(settings, "_require_local_url",
                              side_effect=settings.SettingsError("fixture URL policy")):
                with self.assertRaisesRegex(settings.SettingsError, "fixture URL policy"):
                    settings.validate_settings(config)
                with self.assertRaisesRegex(settings.SettingsError, "fixture URL policy"):
                    settings.save_config(config, path)
            self.assertFalse(path.exists())
            self.assertFalse(path.with_suffix(".tmp").exists())

    def test_validation_uses_the_current_facade_model_validator(self):
        config = copy.deepcopy(settings.DEFAULT_SETTINGS)
        with patch.object(settings, "_validate_model_spec",
                          side_effect=settings.SettingsError("fixture model policy")) as check:
            with self.assertRaisesRegex(settings.SettingsError, "fixture model policy"):
                settings.validate_settings(config)
        self.assertEqual(check.call_count, len(config["models"]))

    def test_saved_overrides_and_removed_aliases_survive_loading(self):
        defaults_before = copy.deepcopy(settings.DEFAULT_SETTINGS)
        saved = {
            "request": {"max_messages": 12},
            "models": {"gpt-4o": {"upstream": "fixture/saved-model", "max_tokens_cap": 77}},
            "_removed_models": ["gpt-4o-mini"],
            "access": {
                "key_required": True,
                "access_key": "fixture-legacy",
                "keys": [{"id": "key_fixture", "name": "Fixture", "key": "fixture-client",
                          "enabled": True, "rate_limit_rpm": 0}],
            },
            "system": {
                "host_bind": False,
                "security_revision": settings.SECURITY_REVISION,
                "admin_token": "fixture-admin",
            },
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "config.json"
            serialized = json.dumps(saved)
            path.write_text(serialized, encoding="utf-8")
            with patch.object(settings, "find_omniroute_key", return_value=None):
                config = settings.load_config(path)
            self.assertEqual(path.read_text(encoding="utf-8"), serialized)
        settings.validate_settings(config)
        self.assertEqual(config["request"]["max_messages"], 12)
        self.assertEqual(config["request"]["default_stream"],
                         defaults_before["request"]["default_stream"])
        self.assertEqual(config["models"]["gpt-4o"]["upstream"], "fixture/saved-model")
        self.assertEqual(config["models"]["gpt-4o"]["max_tokens_cap"], 77)
        self.assertNotIn("gpt-4o-mini", config["models"])
        self.assertIn("gemini-chat", config["models"])
        self.assertEqual(config["access"]["access_key"], "fixture-legacy")
        self.assertEqual(config["access"]["keys"][0]["key"], "fixture-client")
        self.assertEqual(settings.DEFAULT_SETTINGS, defaults_before)


if __name__ == "__main__":
    unittest.main()
