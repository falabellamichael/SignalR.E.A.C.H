"""Windows saved environment credentials work without mutating the process."""

import contextlib
import io
import os
import sys
import unittest
from contextlib import ExitStack
from types import SimpleNamespace
from unittest import mock

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
if TOOLS not in sys.path:
    sys.path.insert(0, TOOLS)

from reach_cli import terminal, commands, credentials, endpoints
from reach_cli import __main__ as entry
from reach_cli.client import ReachClient

REFERENCE = "OWNED_CREDENTIAL_FIXTURE"
SECRET = "owned-persistent-fixture-never-show"
BASE = "https://owned-provider.invalid/v1"


class EnvironmentCredentialTests(unittest.TestCase):
    def test_process_value_wins_and_never_reads_persistent_environment(self):
        with mock.patch.dict(os.environ, {REFERENCE: " process-fixture "}, clear=True), \
                mock.patch.object(credentials.os, "name", "nt"), \
                mock.patch.object(credentials, "_windows_environment_value", return_value=SECRET) as saved:
            before = dict(os.environ)
            self.assertEqual(credentials.environment_value(REFERENCE), "process-fixture")
            self.assertEqual(dict(os.environ), before)
            saved.assert_not_called()

    def test_explicit_empty_or_whitespace_process_value_blocks_saved_fallback(self):
        for value in ("", " \t "):
            with self.subTest(value=repr(value)), \
                    mock.patch.dict(os.environ, {REFERENCE: value}, clear=True), \
                    mock.patch.object(credentials.os, "name", "nt"), \
                    mock.patch.object(credentials, "_windows_environment_value", return_value=SECRET) as saved:
                before = dict(os.environ)
                self.assertEqual(credentials.environment_value(REFERENCE), "")
                self.assertEqual(dict(os.environ), before)
                saved.assert_not_called()

    def test_absent_process_reference_reads_saved_windows_value_without_insertion(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(credentials.os, "name", "nt"), \
                mock.patch.object(credentials, "_windows_environment_value", return_value=SECRET) as saved:
            self.assertEqual(credentials.environment_value(REFERENCE), SECRET)
            saved.assert_called_once_with(REFERENCE)
            self.assertEqual(dict(os.environ), {})

    def test_non_windows_absent_reference_does_not_use_persistent_lookup(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(credentials.os, "name", "posix"), \
                mock.patch.object(credentials, "_windows_environment_value", return_value=SECRET) as saved:
            self.assertEqual(credentials.environment_value(REFERENCE), "")
            saved.assert_not_called()
            self.assertEqual(dict(os.environ), {})

    def test_missing_saved_value_is_empty_and_does_not_modify_process(self):
        with mock.patch.dict(os.environ, {}, clear=True), \
                mock.patch.object(credentials.os, "name", "nt"), \
                mock.patch.object(credentials, "_windows_environment_value", return_value=""):
            self.assertEqual(credentials.environment_value(REFERENCE), "")
            self.assertEqual(dict(os.environ), {})


class _RegistryKey:
    def __init__(self, registry, identity):
        self.registry = registry
        self.identity = identity

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.registry.closed.append(self.identity)


class _Registry:
    HKEY_CURRENT_USER = "user"
    HKEY_LOCAL_MACHINE = "machine"
    KEY_READ = 0x20019
    REG_SZ = 1
    REG_EXPAND_SZ = 2
    REG_BINARY = 3
    REG_DWORD = 4
    REG_MULTI_SZ = 7

    def __init__(self, records):
        self.records = records
        self.opened = []
        self.queried = []
        self.closed = []
        self.expanded = []
        self.expansion_error = None

    def OpenKey(self, hive, path, *_args):
        identity = (hive, path)
        self.opened.append(identity)
        if identity not in self.records:
            raise FileNotFoundError("owned missing registry path")
        record = self.records[identity]
        if isinstance(record, OSError):
            raise record
        return _RegistryKey(self, identity)

    def QueryValueEx(self, key, name):
        self.queried.append((key.identity, name))
        record = self.records[key.identity]
        if isinstance(record, BaseException):
            raise record
        return record

    def ExpandEnvironmentStrings(self, value):
        self.expanded.append(value)
        if self.expansion_error is not None:
            raise self.expansion_error
        return value.replace("%OWNED_SAVED_FIXTURE%", SECRET)


USER_PATH = ("user", "Environment")
MACHINE_PATH = ("machine", r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")


class PersistentWindowsCredentialTests(unittest.TestCase):
    def lookup(self, records):
        registry = _Registry(records)
        output = io.StringIO()
        with mock.patch.dict(sys.modules, {"winreg": registry}), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = credentials._windows_environment_value(REFERENCE)
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(registry.queried, [(identity, REFERENCE) for identity in registry.closed])
        return result, registry

    def test_user_value_overrides_machine_and_closes_registry_key(self):
        result, registry = self.lookup({
            USER_PATH: (SECRET, _Registry.REG_SZ),
            MACHINE_PATH: ("machine-fixture", _Registry.REG_SZ),
        })
        self.assertEqual(result, SECRET)
        self.assertEqual(registry.opened, [USER_PATH])
        self.assertEqual(registry.closed, [USER_PATH])

    def test_missing_user_value_falls_back_to_machine_string(self):
        result, registry = self.lookup({MACHINE_PATH: (SECRET, _Registry.REG_SZ)})
        self.assertEqual(result, SECRET)
        self.assertEqual(registry.opened, [USER_PATH, MACHINE_PATH])
        self.assertEqual(registry.closed, [MACHINE_PATH])

    def test_expandable_string_registry_value_is_accepted(self):
        result, registry = self.lookup({USER_PATH: ("%OWNED_SAVED_FIXTURE%", _Registry.REG_EXPAND_SZ)})
        self.assertEqual(result, SECRET)
        self.assertEqual(registry.closed, [USER_PATH])
        self.assertEqual(registry.expanded, ["%OWNED_SAVED_FIXTURE%"])

    def test_empty_user_value_blocks_machine_fallback(self):
        result, registry = self.lookup({
            USER_PATH: ("", _Registry.REG_SZ),
            MACHINE_PATH: (SECRET, _Registry.REG_SZ),
        })
        self.assertEqual(result, "")
        self.assertEqual(registry.opened, [USER_PATH])

    def test_non_string_user_registry_types_fail_closed(self):
        for record in ((55, _Registry.REG_DWORD), (b"fixture", _Registry.REG_BINARY),
                       (["fixture"], _Registry.REG_MULTI_SZ), (55, _Registry.REG_SZ)):
            with self.subTest(record_type=record[1], value_type=type(record[0]).__name__):
                result, registry = self.lookup({
                    USER_PATH: record, MACHINE_PATH: (SECRET, _Registry.REG_SZ),
                })
                self.assertEqual(result, "")
                self.assertEqual(registry.opened, [USER_PATH])
                self.assertEqual(registry.closed, [USER_PATH])

    def test_registry_expansion_error_returns_empty_without_output(self):
        registry = _Registry({USER_PATH: ("%OWNED_SAVED_FIXTURE%", _Registry.REG_EXPAND_SZ)})
        registry.expansion_error = OSError("owned private fixture expansion error")
        output = io.StringIO()
        with mock.patch.dict(sys.modules, {"winreg": registry}), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(credentials._windows_environment_value(REFERENCE), "")
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(registry.closed, [USER_PATH])

    def test_unset_or_inaccessible_registry_returns_empty_without_output(self):
        for records in ({}, {USER_PATH: PermissionError("owned private fixture"),
                             MACHINE_PATH: PermissionError("owned private fixture")}):
            with self.subTest(unset=not bool(records)):
                result, _registry = self.lookup(records)
                self.assertEqual(result, "")


class CredentialIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.dict(os.environ, {}, clear=True))
        self.stack.enter_context(mock.patch.object(credentials.os, "name", "nt"))
        self.lookup = self.stack.enter_context(mock.patch.object(
            credentials, "_windows_environment_value",
            side_effect=lambda name: SECRET if name == REFERENCE else ""))

    def test_saved_endpoint_and_client_resolve_same_persistent_reference(self):
        record = {"url": BASE, "key_env": REFERENCE}
        self.assertEqual(endpoints.credential_for(record), SECRET)
        client = ReachClient(BASE, key_env=REFERENCE)
        self.assertEqual(client.key, SECRET)
        self.assertEqual(client.key_ref, "env:" + REFERENCE)
        self.assertEqual(client._headers()["Authorization"], "Bearer " + SECRET)
        self.assertEqual(record, {"url": BASE, "key_env": REFERENCE})
        self.assertEqual(dict(os.environ), {})

    def test_saved_reference_does_not_become_global_or_anonymous_endpoint_credential(self):
        self.assertEqual(endpoints.credential_for({"url": BASE}), "")
        client = ReachClient(BASE)
        self.assertEqual(client.key, "")
        self.assertNotIn("Authorization", client._headers())
        self.assertEqual(dict(os.environ), {})

    def test_explicit_blank_reference_keeps_client_and_endpoint_anonymous(self):
        with mock.patch.dict(os.environ, {REFERENCE: ""}):
            self.assertEqual(endpoints.credential_for({"key_env": REFERENCE}), "")
            self.assertEqual(ReachClient(BASE, key_env=REFERENCE).key, "")
        self.assertNotIn(mock.call(REFERENCE), self.lookup.call_args_list)

    def startup(self):
        output = io.StringIO()
        captured = []
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output), \
                mock.patch.object(entry, "_endpoint_configuration", return_value=(BASE, None, REFERENCE)), \
                mock.patch.object(entry, "_restore_endpoint_selection"), \
                mock.patch("reach_cli.settings.apply_client_settings"), \
                mock.patch.object(entry, "_run_endpoint_command", side_effect=lambda args, client: captured.append(client) or 0) as runner:
            result = entry.main(["--color", "never", "--key-env", REFERENCE, "endpoints", "list"])
        self.assertNotIn(SECRET, output.getvalue())
        return result, output.getvalue(), captured, runner

    def test_startup_key_env_validation_accepts_saved_windows_value(self):
        result, text, captured, runner = self.startup()
        self.assertEqual(result, 0, text)
        runner.assert_called_once()
        self.assertEqual(captured[0].key, SECRET)
        self.assertTrue(captured[0].explicit_credential)
        self.assertEqual(dict(os.environ), {})

    def test_startup_explicit_empty_key_env_rejects_saved_fallback(self):
        with mock.patch.dict(os.environ, {REFERENCE: ""}):
            result, text, captured, runner = self.startup()
        self.assertEqual(result, 1)
        self.assertIn("is not set", text)
        runner.assert_not_called()
        self.assertEqual(captured, [])
        self.lookup.assert_not_called()

    def test_startup_unset_key_env_reports_only_reference(self):
        self.lookup.side_effect = None
        self.lookup.return_value = ""
        result, text, captured, runner = self.startup()
        self.assertEqual(result, 1)
        self.assertIn(REFERENCE + " is not set", text)
        runner.assert_not_called()
        self.assertEqual(captured, [])
        self.assertEqual(dict(os.environ), {})

    def test_current_target_and_status_recognize_persistent_explicit_reference(self):
        client = SimpleNamespace(base=BASE, endpoint_name=None, key_env=REFERENCE,
                                 explicit_credential=True, key="stale-fixture")
        with mock.patch.object(endpoints, "list_custom", return_value={}):
            self.assertEqual(commands._current_refresh_target(client), (BASE, SECRET, "env:" + REFERENCE))
            self.assertEqual(commands._credential_description(client), "environment %s (set)" % REFERENCE)
        self.assertEqual(dict(os.environ), {})


if __name__ == "__main__":
    unittest.main()
