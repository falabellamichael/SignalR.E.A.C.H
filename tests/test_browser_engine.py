"""Interactive browser session, process transport, and local-route contracts."""

import concurrent.futures
import io
import json
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from reachd.browser import BrowserError
from reachd.browser_engine import BrowserEngine, SESSION_TTL, _command_body, allowed_origin
from reachd.handler import RelayHandler


class BrowserSessionTests(unittest.TestCase):
    def setUp(self):
        self.engine = BrowserEngine()
        self.engine._ensure_process = Mock()
        self.engine._command = Mock(side_effect=lambda command: {"tab": command["tab"], "ok": True})

    def session(self):
        return self.engine.request({"action": "session"})["token"]

    def test_sessions_scope_same_named_tabs_and_remap_results(self):
        first, second = self.session(), self.session()
        self.assertNotEqual(first, second)
        for token in (first, second):
            result = self.engine.request({"token": token, "action": "create", "tab": "one"})
            self.assertEqual(result["tab"], "one")
        commands = [call.args[0] for call in self.engine._command.call_args_list]
        self.assertNotEqual(commands[0]["tab"], commands[1]["tab"])
        self.assertTrue(commands[0]["tab"].endswith("-one"))
        with self.assertRaises(BrowserError) as error:
            self.engine.request({"token": second, "action": "frame", "tab": commands[0]["tab"]})
        self.assertIn(error.exception.code, ("invalid_request", "engine_tab_missing"))

    def test_commands_require_valid_session_and_owned_tab(self):
        token = self.session()
        for body, expected in [({"action": "frame", "tab": "one"}, "engine_session_expired"),
                               ({"action": "frame", "tab": "one", "token": token}, "engine_tab_missing")]:
            with self.assertRaises(BrowserError) as error:
                self.engine.request(body)
            self.assertEqual(error.exception.code, expected)
        self.engine._command.assert_not_called()

    def test_global_tab_limit_close_and_failed_create_release_slot(self):
        token = self.session()
        for number in range(8):
            self.engine.request({"token": token, "action": "create", "tab": str(number)})
        with self.assertRaises(BrowserError) as error:
            self.engine.request({"token": self.session(), "action": "create", "tab": "extra"})
        self.assertEqual(error.exception.code, "engine_tab_limit")
        self.engine.request({"token": token, "action": "close", "tab": "0"})
        self.engine._command.side_effect = BrowserError("Failed")
        with self.assertRaises(BrowserError):
            self.engine.request({"token": token, "action": "create", "tab": "replacement"})
        self.assertNotIn("replacement", self.engine._sessions[token]["tabs"])
        self.assertEqual(len(self.engine._sessions[token]["tabs"]), 7)

    def test_expired_sessions_close_their_tabs_before_token_reuse(self):
        token = self.session()
        self.engine.request({"token": token, "action": "create", "tab": "one"})
        self.engine._sessions[token]["touched"] = time.monotonic() - SESSION_TTL - 1
        with self.assertRaises(BrowserError) as error:
            self.engine.request({"token": token, "action": "frame", "tab": "one"})
        self.assertEqual(error.exception.code, "engine_session_expired")
        self.assertEqual(self.engine._command.call_args.args[0]["action"], "close")
        self.assertNotIn(token, self.engine._sessions)

    def test_close_session_disposes_only_its_owned_tabs(self):
        first, second = self.session(), self.session()
        for token in (first, second):
            self.engine.request({"token": token, "action": "create", "tab": "one"})
        first_tab = self.engine._sessions[first]["tabs"]["one"]
        self.engine._command.reset_mock()
        self.assertEqual(self.engine.request({"action": "close_session", "token": first}), {"closed": True})
        self.engine._command.assert_called_once_with({"action": "close", "tab": first_tab})
        self.assertNotIn(first, self.engine._sessions)
        self.assertIn(second, self.engine._sessions)

    def test_command_allowlist_rejects_eval_unsafe_urls_and_unbounded_input(self):
        invalid = [None, [], {"action": {}}, {"action": "eval", "tab": "one", "code": "danger"},
                   {"action": "navigate", "tab": "one", "url": "file:///C:/private"},
                   {"action": "navigate", "tab": "one", "url": "https://user:secret@example.com"},
                   {"action": "frame", "tab": "one", "width": 999999},
                   {"action": "text", "tab": "one", "text": "x" * 16385},
                   {"action": "input", "tab": "one", "events": [{}] * 65},
                   {"action": "input", "tab": "one", "events": [{"type": {}}]},
                   {"action": "input", "tab": "one", "events": [{"type": "keyDown", "modifiers": [{}]}]}]
        for body in invalid:
            with self.subTest(body=str(body)[:100]), self.assertRaises(BrowserError):
                self.engine.request(body)
        self.engine._command.assert_not_called()

    def test_valid_input_removes_unrecognized_fields(self):
        command = _command_body({"action": "input", "tab": "one", "events": [
            {"type": "keyDown", "keyCode": "Enter", "modifiers": ["shift"], "javascript": "ignored"},
            {"type": "mouseWheel", "x": 25, "y": 30, "deltaY": -120}]})
        self.assertEqual(len(command["events"]), 2)
        self.assertNotIn("javascript", command["events"][0])


class BrowserTransportTests(unittest.TestCase):
    def make_process(self):
        engine = BrowserEngine()
        process = Mock()
        process.poll.return_value = None
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                if self.headers.get("Authorization") != "Bearer fixture-secret" or self.headers.get("Origin"):
                    self.send_error(403)
                    return
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if data.get("action") == "crash":
                    process.poll.return_value = 1
                    self.connection.close()
                    return
                value = "x" * (1024 * 1024) if data.get("action") == "large" else data.get("value")
                raw = json.dumps({"id": data["id"], "result": {"echo": value}}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        engine._process = process
        engine._bridge = (server.server_port, "fixture-secret")
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.addCleanup(engine.close)
        return engine, process

    def test_concurrent_responses_are_matched_to_their_request_ids(self):
        engine, _ = self.make_process()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda value: engine._command({"action": "echo", "value": value}), range(24)))
        self.assertEqual([result["echo"] for result in results], list(range(24)))

    def test_large_frame_sized_reply_over_authenticated_loopback(self):
        engine, _ = self.make_process()
        self.assertEqual(len(engine._command({"action": "large"})["echo"]), 1024 * 1024)

    def test_diagnostics_never_return_raw_urls_or_page_content(self):
        engine = BrowserEngine()
        process = Mock()
        process.stderr = io.BytesIO(b"TypeError: https://example.com/?token=secret private page data\n"
                                    b" at render (D:\\SimpleREACH\\server\\browser-engine\\main.cjs:44:7)\n")
        engine._process = process
        engine._read_diagnostics(process)
        self.assertIn("main.cjs:44:7", engine._diagnostic)
        self.assertNotIn("secret", engine._diagnostic)
        self.assertNotIn("example.com", engine._diagnostic)
        self.assertNotIn("private", engine._diagnostic)

    def test_process_exit_clears_sessions_and_fails_waiters(self):
        engine, process = self.make_process()
        engine._sessions["old-token"] = {"tabs": {}, "touched": time.monotonic()}
        with self.assertRaises(BrowserError) as error:
            engine._command({"action": "crash"})
        self.assertEqual(error.exception.code, "engine_restarted")
        self.assertEqual(engine._sessions, {})
        self.assertIsNone(engine._bridge)


class BrowserEngineRouteTests(unittest.TestCase):
    def handler(self, body=None, headers=None, peer="127.0.0.1"):
        handler = object.__new__(RelayHandler)
        handler.path = "/_reach/browser/engine"
        handler.client_address = (peer, 12345)
        raw = json.dumps(body if body is not None else {"action": "session"}).encode()
        handler.headers = {"Content-Length": str(len(raw)), "Content-Type": "application/json",
                           "Origin": "http://127.0.0.1:18111", **(headers or {})}
        handler.rfile = io.BytesIO(raw)
        handler._json = Mock()
        return handler

    def test_origin_rules_reject_public_and_opaque_origins(self):
        for origin in (None, "http://127.0.0.1:18111", "http://localhost:21887", "http://[::1]:18111"):
            self.assertTrue(allowed_origin(origin), origin)
        for origin in ("null", "https://example.com", "https://127.0.0.1.evil.example", "file:///",
                       "http://localhost.evil.example", "http://user@localhost", "http://@localhost",
                       "http://127.0.0.1/path", "http://localhost:99999", "", "http://localhost#x"):
            self.assertFalse(allowed_origin(origin), origin)

    def test_remote_forwarded_public_origin_and_simple_forms_cannot_start_engine(self):
        for headers, peer, expected in [({}, "198.51.100.1", 403),
                ({"X-Forwarded-For": "198.51.100.1"}, "127.0.0.1", 403),
                ({"Origin": "https://example.com"}, "127.0.0.1", 403),
                ({"Origin": "null"}, "127.0.0.1", 403),
                ({"Content-Type": "text/plain"}, "127.0.0.1", 415),
                ({"Content-Type": "application/x-www-form-urlencoded"}, "127.0.0.1", 415)]:
            handler = self.handler(headers=headers, peer=peer)
            with patch("reachd.handler.BROWSER_ENGINE") as engine:
                handler.do_POST()
            engine.request.assert_not_called()
            self.assertEqual(handler._json.call_args.args[0], expected)
            self.assertEqual(handler._json.call_args.args[2], {"Cache-Control": "no-store"})

    def test_local_json_returns_raw_result_with_no_store(self):
        handler = self.handler()
        with patch("reachd.handler.BROWSER_ENGINE") as engine:
            engine.request.return_value = {"token": "session-token"}
            handler.do_POST()
        engine.request.assert_called_once_with({"action": "session"})
        handler._json.assert_called_once_with(200, {"token": "session-token"}, {"Cache-Control": "no-store"})

    def test_bounded_json_and_transport_errors_preserve_clear_status(self):
        for length in ("0", "131073", "invalid"):
            handler = self.handler(headers={"Content-Length": length})
            with patch("reachd.handler.BROWSER_ENGINE") as engine:
                handler.do_POST()
            engine.request.assert_not_called()
            self.assertEqual(handler._json.call_args.args[0], 400)
        handler = self.handler()
        with patch("reachd.handler.BROWSER_ENGINE") as engine:
            engine.request.side_effect = BrowserError("Expired", 401, "engine_session_expired")
            handler.do_POST()
        self.assertEqual(handler._json.call_args.args[0], 401)
        self.assertEqual(handler._json.call_args.args[1]["error"]["code"], "engine_session_expired")


if __name__ == "__main__":
    unittest.main()
