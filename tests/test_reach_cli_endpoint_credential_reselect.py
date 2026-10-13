"""Reselecting the active endpoint keeps its explicit credential override."""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from reach_cli import terminal, commands, discovery, endpoints, picker
from reach_cli.client import ReachClient


class _Discovery:
    def refresh(self, base, key="", key_ref="", timeout=3):
        return {"status": "loading", "models": []}

    def snapshot(self, base, key_ref="", key=None):
        return {"status": "idle", "models": [], "stale": False, "error": ""}


class EndpointCredentialReselectTests(unittest.TestCase):
    override = "fixture-explicit-override-never-print"
    stored = "fixture-stored-credential-never-print"
    builtin = "fixture-builtin-credential-never-print"
    office_url = "https://office.fixture.invalid/v1"
    subscription_url = "https://subscription.fixture.invalid/v1"

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="reach-credential-reselect-")
        self.addCleanup(directory.cleanup)
        self.path = os.path.join(directory.name, "config.json")
        patch = mock.patch.dict(os.environ, {
            "REACH_CLI_CONFIG": self.path,
            "REACH_KEY": self.builtin,
            "RESELECT_OVERRIDE_KEY": self.override,
            "RESELECT_STORED_KEY": self.stored,
        })
        patch.start()
        self.addCleanup(patch.stop)
        patch = mock.patch.object(discovery, "MODEL_DISCOVERY", _Discovery())
        patch.start()
        self.addCleanup(patch.stop)
        with open(self.path, "w", encoding="utf-8") as handle:
            json.dump({"custom_endpoints": {
                "office": {"url": self.office_url, "key_env": "RESELECT_STORED_KEY"},
                "office-alt": {"url": self.office_url, "key_env": "RESELECT_STORED_KEY"},
                "anonymous": {"url": "https://anonymous.fixture.invalid/v1"},
            }}, handle)

    def client(self, base, name, mode):
        credentials = ({"key_env": "RESELECT_OVERRIDE_KEY"} if mode == "env"
                       else {"key": self.override})
        client = ReachClient(base, model="fixture-selected-model", **credentials)
        client.endpoint_name = name
        client.explicit_credential = True
        terminal.save_session_config(endpoint=base, endpoint_name=name or "",
                                     model=client.model)
        return client

    def select(self, client, choice, use_picker=False):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), \
                mock.patch.object(picker, "available", return_value=use_picker), \
                mock.patch.object(picker, "choose", return_value=choice), \
                mock.patch("reach_cli.client.discover_public_url",
                           side_effect=AssertionError("selection must not resolve the public pointer")):
            result = commands.handle_slash("/endpoint" if use_picker else "/endpoint " + choice,
                                           client, [])
        self.assertTrue(result.success)
        text = output.getvalue()
        for credential in (self.override, self.stored, self.builtin):
            self.assertNotIn(credential, text)
            with open(self.path, encoding="utf-8") as handle:
                self.assertNotIn(credential, handle.read())
        return result

    def assert_transport_key(self, client, expected):
        response = io.BytesIO(b'{"data":[{"id":"fixture-model"}]}')
        base = self.subscription_url if client.base in ("public", "subscription") else client.base
        with mock.patch.object(client, "resolve_base", return_value=base), \
                mock.patch("urllib.request.urlopen", return_value=response) as transport:
            self.assertEqual(client.models(), ["fixture-model"])
        request = transport.call_args.args[0]
        self.assertEqual(request.full_url, base + "/models")
        self.assertEqual(request.get_header("Authorization"), "Bearer " + expected if expected else None)

    def assert_override(self, client, mode, result):
        self.assertEqual(client.key, self.override)
        self.assertEqual(client.key_env, "RESELECT_OVERRIDE_KEY" if mode == "env" else None)
        self.assertEqual(client.key_ref, "env:RESELECT_OVERRIDE_KEY" if mode == "env" else "explicit")
        self.assertTrue(client.explicit_credential)
        self.assertEqual(client.model, "fixture-selected-model")
        self.assertEqual(result.refresh_target[1:], (client.key, client.key_ref))
        self.assert_transport_key(client, self.override)

    def test_named_custom_reselection_keeps_explicit_key_and_environment_overrides(self):
        for mode in ("key", "env"):
            for use_picker in (False, True):
                with self.subTest(mode=mode, picker=use_picker):
                    client = self.client(self.office_url, "office", mode)
                    result = self.select(client, "office", use_picker=use_picker)
                    self.assert_override(client, mode, result)
                    self.assertEqual(endpoints.get_custom("office")["key_env"], "RESELECT_STORED_KEY")

    def test_subscription_reselection_keeps_overrides_across_aliases_and_resolved_urls(self):
        for mode in ("key", "env"):
            for base in ("public", "subscription", self.subscription_url):
                for choice in ("subscription", "public"):
                    with self.subTest(mode=mode, base=base, choice=choice):
                        client = self.client(base, "subscription", mode)
                        result = self.select(client, choice, use_picker=choice == "subscription")
                        self.assert_override(client, mode, result)
                        self.assertEqual(client.endpoint_name, "subscription")

    def test_unnamed_url_reselection_retains_explicit_override(self):
        for mode in ("key", "env"):
            with self.subTest(mode=mode):
                url = "https://manual.fixture.invalid/v1"
                client = self.client(url, None, mode)
                self.assert_override(client, mode, self.select(client, url))

    def test_switching_to_another_named_endpoint_uses_its_saved_credential(self):
        for mode in ("key", "env"):
            with self.subTest(mode=mode):
                client = self.client(self.subscription_url, "subscription", mode)
                result = self.select(client, "office")
                self.assertEqual(client.key, self.stored)
                self.assertEqual(client.key_env, "RESELECT_STORED_KEY")
                self.assertFalse(client.explicit_credential)
                self.assertEqual(result.refresh_target[1], self.stored)
                self.assert_transport_key(client, self.stored)

    def test_other_custom_name_at_same_url_uses_that_records_credential(self):
        client = self.client(self.office_url, "office", "env")
        self.select(client, "office-alt")
        self.assertEqual(client.endpoint_name, "office-alt")
        self.assertFalse(client.explicit_credential)
        self.assert_transport_key(client, self.stored)

    def test_switching_to_anonymous_or_local_endpoint_drops_explicit_credential(self):
        for target in ("anonymous", "local"):
            with self.subTest(target=target):
                client = self.client(self.office_url, "office", "env")
                self.select(client, target)
                self.assertEqual(client.key, "")
                self.assertIsNone(client.key_env)
                self.assertFalse(client.explicit_credential)
                self.assert_transport_key(client, "")


if __name__ == "__main__":
    unittest.main()
