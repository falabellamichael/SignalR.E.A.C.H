import concurrent.futures
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from unittest import mock

from reach_cli import endpoints, session


class EndpointRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "nested" / "config.json"

    def read(self):
        return json.loads(self.path.read_text(encoding="utf-8"))

    def write(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(data), encoding="utf-8")

    def add(self, name="team", url="https://models.example/custom/v1", key_env=None):
        return endpoints.add_custom(name, url, key_env=key_env, path=self.path)

    def test_crud_same_config_preserves_other_fields_and_no_auth_values(self):
        self.write({"endpoint": "local", "model": "existing", "workpath": "work",
                    "layout": "footer", "future": {"keep": [1, True]}})
        with mock.patch.dict(os.environ, {"TEAM_API_KEY": "fixture-secret"}):
            result = self.add("Team", key_env="TEAM_API_KEY")
            self.assertEqual(endpoints.credential_for(result), "fixture-secret")
        self.assertEqual(result, {"url": "https://models.example/custom/v1", "key_env": "TEAM_API_KEY"})
        self.assertEqual(endpoints.list_custom(self.path), {"team": result})
        self.assertEqual(endpoints.get_custom("TEAM", self.path), result)
        self.assertNotIn("fixture-secret", self.path.read_text())
        changed = endpoints.edit_custom("team", url="http://localhost:1234/api", path=self.path)
        self.assertEqual(changed["url"], "http://localhost:1234/api")
        self.assertEqual(changed["key_env"], "TEAM_API_KEY")
        changed = endpoints.edit_custom("team", key_env=None, path=self.path)
        self.assertNotIn("key_env", changed)
        self.assertEqual(endpoints.remove_custom("team", path=self.path), changed)
        self.assertEqual(self.read()["custom_endpoints"], {})
        self.assertEqual(self.read()["future"], {"keep": [1, True]})
        self.assertEqual(self.read()["model"], "existing")

    def test_missing_and_duplicate_names_have_actionable_errors(self):
        self.add()
        with self.assertRaisesRegex(endpoints.EndpointError, "already exists"):
            self.add("TEAM")
        for operation in (endpoints.get_custom, endpoints.select_custom, endpoints.edit_custom,
                          endpoints.remove_custom):
            with self.subTest(operation=operation.__name__), self.assertRaisesRegex(
                    endpoints.EndpointError, "/endpoints"):
                operation("missing", path=self.path)

    def test_reserved_and_invalid_names_cannot_modify_config(self):
        self.add()
        original = self.path.read_bytes()
        for name in list(endpoints.RESERVED_NAMES) + ["LOCAL", "Subscription", "Public", "",
                "1team", "a/b", "a b", "a\n", "a" * 65, "équipe", "../team", "team;echo"]:
            for operation in (lambda: self.add(name),
                    lambda: endpoints.edit_custom(name, url="https://other.example", path=self.path),
                    lambda: endpoints.remove_custom(name, path=self.path)):
                with self.subTest(name=name), self.assertRaises(endpoints.EndpointError):
                    operation()
                self.assertEqual(self.path.read_bytes(), original)

    def test_valid_urls_normalize_without_changing_path(self):
        for source, expected in (
                (" HTTPS://MODELS.Example:443/a/api/v1/ ", "https://models.example:443/a/api/v1"),
                ("http://127.0.0.1:1234/v1", "http://127.0.0.1:1234/v1"),
                ("http://[::1]:1234/v1", "http://[::1]:1234/v1"),
                ("https://münich.example/custom", "https://xn--mnich-kva.example/custom"),
                ("http://localhost", "http://localhost"),
                ("https://models.example/path%20space", "https://models.example/path%20space"),
                ("https://models.example/%F0%9F%98%80", "https://models.example/%F0%9F%98%80")):
            with self.subTest(source=source):
                self.assertEqual(endpoints.normalize_url(source), expected)

    def test_unsafe_urls_rejected_without_echoing_secrets_or_controls(self):
        bad = ["", "file:///tmp/file", "https:///v1", "https://", "https://:443/v1",
               "https://models.example:0/v1", "https://models.example:65536/v1",
               "https://models.example:invalid/v1", "https://models.example:/v1",
               "https://[invalid]/v1", "https://.bad/v1", "https://-bad/v1",
               "https://bad..name/v1", "https://host/a b", "https://user:secret@models.example/v1",
               "https://secret@models.example/v1", "https://models.example/v1?key=secret",
               "https://models.example/v1?", "https://models.example/v1#secret",
               "https://models.example/v1#", "https://models.example/\x1bsecret",
               "https://models.example/\x85secret", "https://models.example/\x7fsecret",
               "https://models.example/%0asecret", "https://models.example/%1bsecret",
               "https://models.example/%C2%85secret", "https://models.example/%80secret",
               "https://models.example/%250asecret", "https://models.example/\u202esecret",
               "https://models.example/%2525252525252525251bsecret",
               "https://models.example/\\secret", "https://models.example/%5csecret",
               "https://models.example/%no", "http://bad%40host/v1"]
        for url in bad:
            with self.subTest(url=repr(url)), self.assertRaises(endpoints.EndpointError) as raised:
                endpoints.normalize_url(url)
            self.assertNotIn("secret", str(raised.exception))
            self.assertNotIn("\x1b", str(raised.exception))

    def test_bracketed_non_ipv6_host_is_rejected_on_older_urlsplit(self):
        # Python 3.8 accepts this shape and reports "invalid" as the hostname.
        parts = types.SimpleNamespace(
            scheme="https", netloc="[invalid]", hostname="invalid",
            username=None, password=None, port=None, path="/v1")
        with mock.patch.object(endpoints.urllib.parse, "urlsplit", return_value=parts):
            with self.assertRaises(endpoints.EndpointError):
                endpoints.normalize_url("https://[invalid]/v1")

    def test_credential_reference_validation_and_isolation(self):
        with mock.patch.dict(os.environ, {"REACH_KEY": "built-in-only", "TEAM_API_KEY": " team-fixture "}):
            self.assertEqual(endpoints.credential_for({"url": "https://example.test"}), "")
            self.assertEqual(endpoints.credential_for({"key_env": "MISSING_ENV_FIXTURE"}), "")
            self.assertEqual(endpoints.credential_for({"key_env": "TEAM_API_KEY"}), "team-fixture")
        for reference in ("sk-actual-secret", "ENV=actual-secret", "NAME with spaces", "A\nB", "1BAD", 7):
            with self.subTest(reference=reference), self.assertRaises(endpoints.EndpointError) as raised:
                self.add(key_env=reference)
            self.assertNotIn("actual-secret", str(raised.exception))

    def test_strict_crud_never_replaces_corrupt_or_incompatible_config(self):
        cases = ["{invalid", "[]", '{"custom_endpoints":{},"custom_endpoints":{}}',
                 '{"custom_endpoints":{},"future":NaN}', json.dumps({"endpoint_name": []}),
                 json.dumps({"custom_endpoints": []}),
                 json.dumps({"custom_endpoints": {"team": "https://example.test"}}),
                 json.dumps({"custom_endpoints": {"team": {"url": "https://example.test", "key": "fixture-secret"}}}),
                 json.dumps({"custom_endpoints": {"local": {"url": "https://example.test"}}}),
                 json.dumps({"custom_endpoints": {"team": {"url": "https://example.test"}, "TEAM": {"url": "https://example.test"}}})]
        self.path.parent.mkdir(parents=True)
        for content in cases:
            self.path.write_text(content, encoding="utf-8")
            original = self.path.read_bytes()
            for operation in (lambda: endpoints.list_custom(self.path), lambda: self.add("new"),
                    lambda: endpoints.edit_custom("team", url="https://other.test", path=self.path),
                    lambda: endpoints.remove_custom("team", path=self.path)):
                with self.subTest(content=content), self.assertRaises(endpoints.EndpointError):
                    operation()
                self.assertEqual(self.path.read_bytes(), original)

    def test_active_edit_and_remove_update_selection_atomically(self):
        self.add(key_env="TEAM_API_KEY")
        endpoints.select_custom("team", self.path)
        session.save_session_config(model="team-model", path=self.path)
        endpoints.edit_custom("team", url="https://other.example/v1", path=self.path)
        current = self.read()
        self.assertEqual(current["endpoint"], "https://other.example/v1")
        self.assertEqual(current["endpoint_name"], "team")
        self.assertNotIn("model", current)
        session.save_session_config(model="second-model", path=self.path)
        endpoints.remove_custom("team", self.path)
        current = self.read()
        self.assertEqual(current["endpoint"], "local")
        self.assertEqual(current["endpoint_name"], "local")
        self.assertNotIn("model", current)

    def test_inactive_remove_preserves_subscription_even_same_custom_url(self):
        self.add(url="https://subscription.example/v1")
        session.save_session_config(endpoint="https://subscription.example/v1", endpoint_name="subscription",
                                    model="subscription-model", path=self.path)
        endpoints.remove_custom("team", self.path)
        current = self.read()
        self.assertEqual(current["endpoint_name"], "subscription")
        self.assertEqual(current["model"], "subscription-model")

    def test_legacy_saved_url_active_removal_falls_back_but_local_is_protected(self):
        self.add()
        session.save_session_config(endpoint="https://models.example/custom/v1", model="old", path=self.path)
        endpoints.remove_custom("team", self.path)
        self.assertEqual(self.read()["endpoint_name"], "local")
        self.add(url=endpoints.LOCAL_ENDPOINT_URL)
        session.save_session_config(endpoint=endpoints.LOCAL_ENDPOINT_URL, model="local-model", path=self.path)
        endpoints.remove_custom("team", self.path)
        self.assertEqual(self.read()["model"], "local-model")

    def test_regular_session_saves_preserve_registry_unknown_fields_and_clear_identity(self):
        self.write({"future": {"do": "not remove"}})
        self.add()
        endpoints.select_custom("team", self.path)
        self.assertTrue(session.save_session_config(model="model", workpath="work", layout="footer", path=self.path))
        current = self.read()
        self.assertEqual(current["endpoint_name"], "team")
        self.assertEqual(current["future"], {"do": "not remove"})
        self.assertIn("team", current["custom_endpoints"])
        self.assertTrue(session.save_session_config(endpoint="http://other.example/v1", path=self.path))
        self.assertNotIn("endpoint_name", self.read())
        self.assertTrue(session.save_session_config(endpoint_name="TEAM", clear_model=True, path=self.path))
        self.assertEqual(self.read()["endpoint_name"], "team")
        self.assertNotIn("model", self.read())
        self.assertTrue(session.save_session_config(endpoint_name="", path=self.path))
        self.assertNotIn("endpoint_name", self.read())

    def test_concurrent_registry_and_regular_saves_do_not_lose_records(self):
        self.write({"future": "preserved"})
        def operation(index):
            self.add(name="team%d" % index, url="https://models.example/%d/v1" % index)
            self.assertTrue(session.save_session_config(model="model%d" % index, path=self.path))
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as workers:
            list(workers.map(operation, range(40)))
        self.assertEqual(len(endpoints.list_custom(self.path)), 40)
        self.assertEqual(self.read()["future"], "preserved")
        self.assertFalse(list(self.path.parent.glob("*.tmp")))

    def test_failed_atomic_replace_preserves_original_and_cleans_temporary(self):
        self.add()
        original = self.path.read_bytes()
        with mock.patch("reach_cli.session.os.replace", side_effect=PermissionError("fixture failure")):
            with self.assertRaisesRegex(endpoints.EndpointError, "permissions"):
                self.add("other")
            self.assertFalse(session.save_session_config(model="new", path=self.path))
        self.assertEqual(self.path.read_bytes(), original)
        self.assertFalse(list(self.path.parent.glob("*.tmp")))

    def test_registry_results_are_copies_not_shared_state(self):
        self.add()
        records = endpoints.list_custom(self.path)
        records["team"]["url"] = "https://mutated.test"
        self.assertEqual(endpoints.get_custom("team", self.path)["url"], "https://models.example/custom/v1")

    def test_apply_saved_named_custom_resolves_env_without_network_or_global_key(self):
        self.add(key_env="TEAM_API_KEY")
        endpoints.select_custom("team", self.path)
        session.save_session_config(model="team-model", path=self.path)
        client = types.SimpleNamespace(base="local", model=None, key="built-in-only")
        args = types.SimpleNamespace(base=None, model=None, workpath=None, key=None)
        with mock.patch.dict(os.environ, {"TEAM_API_KEY": "fixture-team", "REACH_KEY": "built-in-only"}), \
                mock.patch("urllib.request.urlopen", side_effect=AssertionError("network forbidden")):
            session.apply_saved_session(client, args, self.path)
        self.assertEqual(client.base, "https://models.example/custom/v1")
        self.assertEqual(client.key, "fixture-team")
        self.assertEqual(client.endpoint_name, "team")
        self.assertEqual(client.model, "team-model")
        endpoints.edit_custom("team", key_env=None, path=self.path)
        with mock.patch.dict(os.environ, {"REACH_KEY": "built-in-only"}):
            session.apply_saved_session(client, args, self.path)
        self.assertEqual(client.key, "")

    def test_missing_saved_custom_uses_local_without_stale_auth_or_model(self):
        self.write({"endpoint_name": "deleted", "endpoint": "https://old.test", "model": "old-model"})
        client = types.SimpleNamespace(base="https://old.test", model="old-model", key="old-secret")
        args = types.SimpleNamespace(base=None, model=None, workpath=None)
        output = io.StringIO()
        with redirect_stdout(output):
            session.apply_saved_session(client, args, self.path)
        self.assertEqual(client.base, "local")
        self.assertEqual(client.key, "")
        self.assertIsNone(client.model)
        self.assertIn("Check /endpoints", output.getvalue())
        self.assertNotIn("old-secret", output.getvalue())

    def test_saved_legacy_url_and_explicit_flags_still_work(self):
        session.save_session_config(endpoint="https://legacy.example/v1", model="saved", path=self.path)
        client = types.SimpleNamespace(base="local", model=None, key="explicit")
        args = types.SimpleNamespace(base=None, model=None, workpath=None, key="explicit")
        session.apply_saved_session(client, args, self.path)
        self.assertEqual(client.base, "https://legacy.example/v1")
        self.add()
        endpoints.select_custom("team", self.path)
        args.base = "https://explicit.example/v1"
        client.base = args.base
        session.apply_saved_session(client, args, self.path)
        self.assertEqual(client.base, args.base)
        self.assertEqual(client.key, "explicit")

    def test_builtin_saved_names_preserve_subscription_policy_and_clear_local_key(self):
        client = types.SimpleNamespace(base="old", key="subscription-fixture", model=None)
        args = types.SimpleNamespace(base=None, model=None, workpath=None)
        with mock.patch.dict(os.environ, {"REACH_KEY": "subscription-fixture"}):
            for name in ("public", "subscription"):
                session.save_session_config(endpoint="https://old-pointer.example", endpoint_name=name, path=self.path)
                session.apply_saved_session(client, args, self.path)
                self.assertEqual(client.base, "subscription")
                self.assertEqual(client.endpoint_name, "subscription")
                self.assertEqual(client.key, "subscription-fixture")
        session.save_session_config(endpoint="local", endpoint_name="local", path=self.path)
        session.apply_saved_session(client, args, self.path)
        self.assertEqual(client.base, "local")
        self.assertEqual(client.key, "")


if __name__ == "__main__":
    unittest.main()
