"""The SimpleRAG panel's one-click "Start Endpoint" contract.

The REACH page can be served from an app-owned localhost origin, from a file://
document (Origin: null), or run inside a VS Code webview. The control server on
127.0.0.1:20778 is what the button calls, so its origin guard has to accept the
renderer's own shapes and refuse the open web. These tests drive the REAL
handler over loopback rather than asserting against a copy of the rule.
"""
import http.client
import json
import os
import pathlib
import sys
import tempfile
import threading
import unittest
import unittest.mock
from http.server import ThreadingHTTPServer

TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
TOOLS = os.path.join(os.path.dirname(TESTS_DIR), "tools")
sys.path.insert(0, TOOLS)

from reach import supervisor  # noqa: E402

# Origins the panel legitimately sends.
PANEL_ORIGINS = [
    None,                        # local CLI caller
    "",                          # fetch() with no Origin (same-origin/local)
    "null",                      # file:// page OR sandboxed webview
    "vscode-webview://abc123",   # VS Code built-in browser
    "http://127.0.0.1:5173",     # app-served page
    "http://localhost:8791",
]

# Origins that must stay refused: the control port drives the host's relay.
HOSTILE_ORIGINS = [
    "https://evil.example",
    "https://unbent-semicolon-hermit.ngrok-free.dev",
    "file://",
    "http://127.0.0.1",          # no port
    "http://user:pass@127.0.0.1:20778",
    "https://127.0.0.1:20778",   # https, not the local http origin
]


class AllowedOriginTests(unittest.TestCase):
    def test_panel_origins_are_accepted(self):
        for origin in PANEL_ORIGINS:
            self.assertTrue(supervisor._allowed_origin(origin),
                            "%r must be allowed to start the endpoint" % origin)

    def test_open_web_origins_are_refused(self):
        for origin in HOSTILE_ORIGINS:
            self.assertFalse(supervisor._allowed_origin(origin),
                             "%r must never drive the local control port" % origin)


class ControlHandlerTests(unittest.TestCase):
    """Drive the real handler on an ephemeral port."""

    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), supervisor.ControlHandler)
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, method, path, origin=None, action=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {}
        if origin is not None:
            headers["Origin"] = origin
        if action is not None:
            headers["X-Reach-Action"] = action
        try:
            conn.request(method, path, headers=headers)
            resp = conn.getresponse()
            return resp.status, dict(resp.getheaders()), resp.read().decode("utf-8")
        finally:
            conn.close()

    def test_preflight_succeeds_for_a_file_page(self):
        # This is the exact failure that made the button dead: the preflight for
        # a file:// page (Origin: null) was answered 403, so the POST never ran.
        status, headers, _ = self.request("OPTIONS", "/start", origin="null")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"), "null")
        self.assertIn("X-Reach-Action", headers.get("Access-Control-Allow-Headers", ""))

    def test_preflight_succeeds_for_a_webview(self):
        status, headers, _ = self.request("OPTIONS", "/start",
                                          origin="vscode-webview://abc123")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Access-Control-Allow-Origin"),
                         "vscode-webview://abc123")

    def test_preflight_refuses_the_open_web(self):
        status, _, _ = self.request("OPTIONS", "/start", origin="https://evil.example")
        self.assertEqual(status, 403)

    def test_start_runs_for_panel_origins(self):
        for origin in ["null", "vscode-webview://abc123", "http://127.0.0.1:5173"]:
            with self.subTest(origin=origin), \
                    unittest.mock.patch.object(supervisor, "ensure_endpoint",
                                               return_value={"ok": True, "public_url": "https://x/v1"}) as call:
                status, headers, body = self.request("POST", "/start", origin=origin,
                                                     action="start")
                self.assertEqual(status, 200, body)
                self.assertTrue(json.loads(body)["ok"])
                call.assert_called_once()
                self.assertEqual(headers.get("Access-Control-Allow-Origin"), origin)

    def test_start_still_requires_the_action_header(self):
        # CORS alone must not be enough: a cross-origin page cannot set this
        # header without a successful preflight for that exact origin.
        status, _, body = self.request("POST", "/start", origin="null")
        self.assertEqual(status, 403)
        self.assertIn("not allowed", body)

    def test_start_from_the_open_web_is_refused_and_explained(self):
        with unittest.mock.patch.object(supervisor, "ensure_endpoint") as call:
            status, _, body = self.request("POST", "/start",
                                           origin="https://evil.example", action="start")
            self.assertEqual(status, 403)
            self.assertIn("origin is not allowed", body)
            call.assert_not_called()

    def test_failed_start_reports_503_with_a_reason(self):
        with unittest.mock.patch.object(supervisor, "ensure_endpoint",
                                        return_value={"ok": False, "error": "Tunnel did not start; check tunnel.log"}):
            status, _, body = self.request("POST", "/start", origin="null", action="start")
            self.assertEqual(status, 503)
            self.assertIn("tunnel.log", body)

    def test_status_is_readable_by_the_panel(self):
        # reach-core.js probes this to tell the truth about the button.
        with unittest.mock.patch.object(supervisor, "port_open", return_value=True), \
                unittest.mock.patch.object(supervisor, "public_url_from_server",
                                           return_value="https://x/v1"):
            status, headers, body = self.request("GET", "/status", origin="null")
            self.assertEqual(status, 200)
            self.assertTrue(json.loads(body)["relay"])
            self.assertEqual(headers.get("Access-Control-Allow-Origin"), "null")

    def test_shutdown_is_cli_only(self):
        # A web page must never be able to stop the host's relay.
        status, _, _ = self.request("POST", "/shutdown", origin="null", action="shutdown")
        self.assertEqual(status, 403)
        status, _, _ = self.request("POST", "/shutdown", origin="https://evil.example",
                                    action="shutdown")
        self.assertEqual(status, 403)

    def test_restart_serves_the_panel_button(self):
        # The Status panel's Restart was POSTing /_reach/restart to the RELAY,
        # which has no such route (404) — the button did nothing. Relay
        # lifecycle belongs to the process manager, so it lives here now.
        with unittest.mock.patch.object(supervisor, "restart_endpoint",
                                        return_value={"ok": True, "public_url": "https://x/v1"}) as call:
            status, headers, body = self.request("POST", "/restart", origin="null",
                                                 action="restart")
            self.assertEqual(status, 200, body)
            self.assertTrue(json.loads(body)["ok"])
            call.assert_called_once()
            self.assertEqual(headers.get("Access-Control-Allow-Origin"), "null")

    def test_restart_requires_the_action_header_and_an_allowed_origin(self):
        with unittest.mock.patch.object(supervisor, "restart_endpoint") as call:
            status, _, _ = self.request("POST", "/restart", origin="null")
            self.assertEqual(status, 403)
            status, _, _ = self.request("POST", "/restart",
                                        origin="https://evil.example", action="restart")
            self.assertEqual(status, 403)
            call.assert_not_called()

    def test_restart_failure_is_reported(self):
        with unittest.mock.patch.object(supervisor, "restart_endpoint",
                                        return_value={"ok": False, "error": "Relay did not start; check reach.log"}):
            status, _, body = self.request("POST", "/restart", origin="null", action="restart")
            self.assertEqual(status, 503)
            self.assertIn("reach.log", body)

    def test_unknown_routes_are_refused(self):
        status, _, _ = self.request("GET", "/", origin="null")
        self.assertEqual(status, 404)


class EndpointBringUpTests(unittest.TestCase):
    """ensure_endpoint must be idempotent; restart_endpoint must actually reload."""

    def test_ensure_leaves_a_healthy_relay_untouched(self):
        cli = unittest.mock.Mock()
        with unittest.mock.patch.object(supervisor, "_last_published_url", "https://x/v1"), \
                unittest.mock.patch.object(supervisor, "publish") as publish, \
                unittest.mock.patch.object(supervisor, "port_open", return_value=True), \
                unittest.mock.patch.object(supervisor, "start_server") as start, \
                unittest.mock.patch.object(supervisor, "public_url_from_server",
                                           return_value="https://x/v1"), \
                unittest.mock.patch.object(supervisor, "_load_cli", return_value=cli):
            result = supervisor.ensure_endpoint()
        self.assertTrue(result["ok"])
        start.assert_not_called()
        cli.stop_server.assert_not_called()
        publish.assert_not_called()

    def test_restart_stops_the_healthy_relay_first(self):
        cli = unittest.mock.Mock()
        # Port is up before the stop, free after it — _bring_up must notice and
        # start the relay again.
        with unittest.mock.patch.object(supervisor, "_last_published_url", None), \
                unittest.mock.patch.object(supervisor, "_last_publish_attempt", None), \
                unittest.mock.patch.object(supervisor, "publish", return_value=True), \
                unittest.mock.patch.object(supervisor, "port_open",
                                        side_effect=[True, False]), \
                unittest.mock.patch.object(supervisor, "time") as clock, \
                unittest.mock.patch.object(supervisor, "start_server") as start, \
                unittest.mock.patch.object(supervisor, "public_url_from_server",
                                           return_value="https://x/v1"), \
                unittest.mock.patch.object(supervisor, "_load_cli", return_value=cli):
            clock.monotonic.return_value = 1000.0
            result = supervisor.restart_endpoint()
        self.assertTrue(result["ok"])
        cli.stop_server.assert_called_once()
        clock.sleep.assert_called_once()
        start.assert_called_once()

    def test_start_reports_a_relay_that_will_not_start(self):
        with unittest.mock.patch.object(supervisor, "port_open", return_value=False), \
                unittest.mock.patch.object(supervisor, "start_server", return_value=False):
            result = supervisor.ensure_endpoint()
        self.assertFalse(result["ok"])
        self.assertIn("reach.log", result["error"])

    def test_start_reports_a_tunnel_that_will_not_start(self):
        with unittest.mock.patch.object(supervisor, "port_open", return_value=True), \
                unittest.mock.patch.object(supervisor, "public_url_from_server", return_value=None), \
                unittest.mock.patch.object(supervisor, "start_tunnel", return_value=False):
            result = supervisor.ensure_endpoint()
        self.assertFalse(result["ok"])
        self.assertIn("tunnel.log", result["error"])

    def test_publish_is_reported_so_the_panel_can_explain_a_stale_pointer(self):
        # Reset the real module globals: sibling tests run ensure_endpoint for
        # real and would otherwise leave a published URL plus a live cooldown.
        with unittest.mock.patch.object(supervisor, "_last_published_url", None), \
                unittest.mock.patch.object(supervisor, "_last_publish_attempt", None), \
                unittest.mock.patch.object(supervisor, "port_open", return_value=True), \
                unittest.mock.patch.object(supervisor, "public_url_from_server",
                                           return_value="https://x/v1"), \
                unittest.mock.patch.object(supervisor, "publish", return_value=True) as publish:
            result = supervisor.ensure_endpoint()
        self.assertEqual(result["published"], "published")
        publish.assert_called_once()

    def test_a_repeat_start_does_not_republish_inside_the_cooldown(self):
        with unittest.mock.patch.object(supervisor, "_last_published_url", "https://x/v1"), \
                unittest.mock.patch.object(supervisor, "_last_publish_attempt", 0.0), \
                unittest.mock.patch.object(supervisor, "time") as clock, \
                unittest.mock.patch.object(supervisor, "port_open", return_value=True), \
                unittest.mock.patch.object(supervisor, "public_url_from_server",
                                           return_value="https://x/v1"), \
                unittest.mock.patch.object(supervisor, "publish") as publish:
            clock.monotonic.return_value = 10.0
            result = supervisor.ensure_endpoint()
        self.assertEqual(result["published"], "skipped")
        publish.assert_not_called()

    def test_a_failed_publish_is_reported_rather_than_hidden(self):
        with unittest.mock.patch.object(supervisor, "_last_published_url", None), \
                unittest.mock.patch.object(supervisor, "_last_publish_attempt", None), \
                unittest.mock.patch.object(supervisor, "port_open", return_value=True), \
                unittest.mock.patch.object(supervisor, "public_url_from_server",
                                           return_value="https://x/v1"), \
                unittest.mock.patch.object(supervisor, "publish", return_value=False):
            result = supervisor.ensure_endpoint()
        self.assertEqual(result["published"], "failed")


class AccountServiceTests(unittest.TestCase):
    """The account service behind wallet sign-in.

    A relay whose account service is down answers 503 for every wallet route,
    which reads as a REACH bug in the UI. These pin the supervision contract.
    """

    def test_ready_requires_both_the_config_and_the_key(self):
        with tempfile.TemporaryDirectory() as tmp, \
                unittest.mock.patch.object(supervisor, "accounts_dir",
                                           return_value=pathlib.Path(tmp)):
            base = pathlib.Path(tmp)
            self.assertFalse(supervisor.accounts_ready())
            (base / "accounts.json").write_text("{}", encoding="utf-8")
            self.assertFalse(supervisor.accounts_ready(), "config alone is not enough")
            (base / "upstream.key").write_text("k", encoding="utf-8")
            self.assertTrue(supervisor.accounts_ready())

    def test_unprovisioned_is_a_silent_noop(self):
        with unittest.mock.patch.object(supervisor, "port_open", return_value=False), \
                unittest.mock.patch.object(supervisor, "accounts_ready", return_value=False), \
                unittest.mock.patch.object(supervisor, "accounts_task_present", return_value=False), \
                unittest.mock.patch.object(supervisor.subprocess, "Popen") as popen, \
                unittest.mock.patch.object(supervisor.subprocess, "run") as run:
            self.assertEqual(supervisor.ensure_accounts_running(), "unconfigured")
            popen.assert_not_called()
            run.assert_not_called()

    def test_already_running_is_left_alone(self):
        with unittest.mock.patch.object(supervisor, "port_open", return_value=True), \
                unittest.mock.patch.object(supervisor.subprocess, "Popen") as popen, \
                unittest.mock.patch.object(supervisor.subprocess, "run") as run:
            self.assertEqual(supervisor.ensure_accounts_running(), "running")
            popen.assert_not_called()
            run.assert_not_called()

    def test_the_host_task_is_adopted_not_replaced(self):
        # A host that provisioned the service keeps its own scheduled task. It
        # carries the entitlements database, so adopting the task is the only
        # safe action: starting a service over a different config would answer
        # from an empty database and silently zero an allowance.
        with unittest.mock.patch.object(supervisor, "port_open", return_value=False), \
                unittest.mock.patch.object(supervisor, "accounts_task_present", return_value=True), \
                unittest.mock.patch.object(supervisor, "_start_accounts_task",
                                           return_value=True) as start_task, \
                unittest.mock.patch.object(supervisor.subprocess, "Popen") as popen:
            self.assertEqual(supervisor.ensure_accounts_running(), "started")
            start_task.assert_called_once()
            popen.assert_not_called()

    def test_a_failing_task_is_reported(self):
        with unittest.mock.patch.object(supervisor, "port_open", return_value=False), \
                unittest.mock.patch.object(supervisor, "accounts_task_present", return_value=True), \
                unittest.mock.patch.object(supervisor, "_start_accounts_task", return_value=False), \
                unittest.mock.patch.object(supervisor.subprocess, "Popen") as popen:
            self.assertEqual(supervisor.ensure_accounts_running(), "task_failed")
            popen.assert_not_called()

    def test_a_plugin_checkout_alone_never_starts_a_service(self):
        # An RCH checkout is present but the operator's private config is not:
        # that is NOT authorization to start something on the account port.
        with tempfile.TemporaryDirectory() as tmp:
            host = pathlib.Path(tmp)
            (host / "RCH" / "scripts").mkdir(parents=True)
            (host / "RCH" / "scripts" / "accounts-host.mjs").write_text("// x", encoding="utf-8")
            with unittest.mock.patch.object(supervisor, "port_open", return_value=False), \
                    unittest.mock.patch.object(supervisor, "accounts_task_present", return_value=False), \
                    unittest.mock.patch.object(supervisor, "accounts_ready", return_value=False), \
                    unittest.mock.patch.object(supervisor, "_host_plugin_path", return_value=host), \
                    unittest.mock.patch.object(supervisor.subprocess, "Popen") as popen:
                self.assertEqual(supervisor.ensure_accounts_running(), "unconfigured")
                popen.assert_not_called()

    def test_a_self_provisioned_service_uses_its_own_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            host = pathlib.Path(tmp)
            (host / "RCH" / "scripts").mkdir(parents=True)
            (host / "RCH" / "scripts" / "accounts-host.mjs").write_text("// x", encoding="utf-8")
            with unittest.mock.patch.object(supervisor, "port_open", return_value=False), \
                    unittest.mock.patch.object(supervisor, "accounts_task_present", return_value=False), \
                    unittest.mock.patch.object(supervisor, "accounts_ready", return_value=True), \
                    unittest.mock.patch.object(supervisor, "_host_plugin_path", return_value=host), \
                    unittest.mock.patch.object(supervisor, "resolve_node", return_value="node"), \
                    unittest.mock.patch.object(supervisor, "ACCOUNT_LOG_PATH",
                                               pathlib.Path(tmp) / "service.log"), \
                    unittest.mock.patch.object(supervisor.subprocess, "Popen") as popen:
                self.assertEqual(supervisor.ensure_accounts_running(), "started")
            command = popen.call_args[0][0]
            self.assertEqual(command[0], "node")
            self.assertTrue(command[1].endswith("accounts-host.mjs"))
            self.assertTrue(command[2].endswith("accounts.json"))
            self.assertTrue(command[3].endswith("upstream.key"))

    def test_loading_the_cli_does_not_recurse(self):
        # _load_cli -> _runtime_dir -> _host_plugin_path -> _load_cli hung the
        # interpreter outright (RecursionError at the C stack limit): the tools
        # directory must be resolved without asking the CLI. Asserting that
        # _load_cli never calls _runtime_dir pins it without touching sys.path.
        original = supervisor._cli_module
        try:
            with unittest.mock.patch.object(supervisor, "_cli_module", None), \
                    unittest.mock.patch.object(supervisor, "_runtime_dir",
                                               side_effect=AssertionError("recursion")):
                cli = supervisor._load_cli()
        finally:
            supervisor._cli_module = original
        self.assertTrue(hasattr(cli, "cmd_start"))

    def test_host_plugin_path_is_read_from_the_config_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            host = pathlib.Path(tmp)
            (host / "RCH" / "scripts").mkdir(parents=True)
            (host / "RCH" / "scripts" / "accounts-host.mjs").write_text("// x", encoding="utf-8")
            config = pathlib.Path(tmp) / "config.json"
            config.write_text(json.dumps({"host_plugin_path": str(host)}), encoding="utf-8")
            with unittest.mock.patch.object(supervisor, "CONFIG_PATH", config):
                self.assertEqual(supervisor._host_plugin_path(), host)
            # A path without RCH is not a usable host, and must not raise.
            bad = pathlib.Path(tmp) / "config2.json"
            bad.write_text(json.dumps({"host_plugin_path": str(pathlib.Path(tmp) / "nope")}),
                           encoding="utf-8")
            with unittest.mock.patch.object(supervisor, "CONFIG_PATH", bad):
                self.assertIsNone(supervisor._host_plugin_path())


class SupervisorLifecycleTests(unittest.TestCase):
    def test_start_is_a_noop_when_already_running(self):
        with unittest.mock.patch.object(supervisor, "port_open", return_value=True), \
                unittest.mock.patch.object(supervisor.subprocess, "Popen") as popen:
            self.assertFalse(supervisor.ensure_supervisor_running())
            popen.assert_not_called()

    def test_cli_start_brings_up_the_one_click_control(self):
        # `reach.py start` must leave the button working: a closed control port
        # is what made the panel's Start fail with a generic network error.
        import reach.cli as cli
        args = type("Args", (), {"tunnel": "none", "no_publish": True})()
        with unittest.mock.patch.object(cli, "start_server"), \
                unittest.mock.patch.object(cli, "start_tunnel"), \
                unittest.mock.patch.object(cli, "ensure_supervisor_running",
                                           return_value=True) as ensure, \
                unittest.mock.patch.object(cli, "_report_account_service"):
            cli.cmd_start(args)
            ensure.assert_called_once()

    def test_cli_stop_stops_the_supervisor_first(self):
        # Order matters: the watchdog revives the relay within 20s, so stopping
        # the relay before the supervisor makes `stop` a silent no-op.
        import reach.cli as cli
        order = []
        with unittest.mock.patch.object(cli, "stop_supervisor",
                                       side_effect=lambda: order.append("supervisor")), \
                unittest.mock.patch.object(cli, "stop_server",
                                           side_effect=lambda: order.append("server")), \
                unittest.mock.patch.object(cli, "stop_tunnel",
                                           side_effect=lambda: order.append("tunnel")):
            cli.cmd_stop(None)
        self.assertEqual(order, ["supervisor", "server", "tunnel"])

    def test_cli_reports_the_account_service_so_a_503_is_attributable(self):
        import reach.cli as cli
        for state, expected in [("running", "running"), ("started", "started"),
                                ("task_failed", "could not start"),
                                ("unconfigured", "not provisioned")]:
            with self.subTest(state=state), \
                    unittest.mock.patch.object(cli, "ensure_accounts_running",
                                               return_value=state), \
                    unittest.mock.patch("builtins.print") as output:
                cli._report_account_service()
            printed = " ".join(str(call.args[0]) for call in output.call_args_list)
            self.assertIn(expected, printed)

    def test_status_reports_a_running_account_service(self):
        # A host that provisioned the service owns a task for it, so a running
        # port must never be reported as "not provisioned".
        import reach.cli as cli
        with unittest.mock.patch.object(cli, "port_open", return_value=True), \
                unittest.mock.patch.object(cli, "accounts_ready", return_value=False), \
                unittest.mock.patch.object(cli, "accounts_task_present", return_value=True), \
                unittest.mock.patch("builtins.print") as output:
            cli.cmd_status(None)
        printed = " ".join(str(call.args[0]) for call in output.call_args_list)
        self.assertIn("running (loopback 127.0.0.1:20978)", printed)
        self.assertNotIn("not provisioned", printed)

    def test_start_spawns_when_the_control_port_is_closed(self):
        with unittest.mock.patch.object(supervisor, "port_open", return_value=False), \
                unittest.mock.patch.object(supervisor, "resolve_pythonw", return_value=sys.executable), \
                unittest.mock.patch.object(supervisor, "CONFIG_DIR", pathlib.Path(TESTS_DIR)), \
                unittest.mock.patch.object(supervisor.subprocess, "Popen") as popen:
            # The installed script path does not exist here, so it declines
            # rather than spawning a broken command.
            self.assertFalse(supervisor.ensure_supervisor_running())
            popen.assert_not_called()

    def test_start_spawns_the_installed_script(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = pathlib.Path(tmp) / "tools" / "reach.py"
            script.parent.mkdir(parents=True)
            script.write_text("# stand-in for the installed CLI\n", encoding="utf-8")
            with unittest.mock.patch.object(supervisor, "port_open", return_value=False), \
                    unittest.mock.patch.object(supervisor, "resolve_pythonw", return_value=sys.executable), \
                    unittest.mock.patch.object(supervisor, "CONFIG_DIR", pathlib.Path(tmp)), \
                    unittest.mock.patch.object(supervisor, "LOG_PATH", pathlib.Path(tmp) / "reach.log"), \
                    unittest.mock.patch.object(supervisor.subprocess, "Popen") as popen:
                self.assertTrue(supervisor.ensure_supervisor_running())
                popen.assert_called_once()
                command = popen.call_args[0][0]
                self.assertEqual(command[0], sys.executable)
                self.assertTrue(command[1].endswith("reach.py"))
                self.assertEqual(command[2], "supervise")

    def test_stop_is_a_noop_when_nothing_is_listening(self):
        with unittest.mock.patch.object(supervisor, "port_open", return_value=False):
            self.assertFalse(supervisor.stop_supervisor())


if __name__ == "__main__":
    unittest.main()