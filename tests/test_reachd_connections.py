#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Connection hygiene for the relay (issue #15): idle or stalled clients are
dropped, the number of live connections is capped, and slow responses are not
cut off by the client socket timeout.

Run:  python -m unittest tests.test_reachd_connections -v
"""

import http.client
import json
import socket
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

import reachd  # noqa: E402
from reachd import core  # noqa: E402
import reachd.__main__ as reachd_main  # noqa: E402
from reachd.handler import RelayHandler, RelayHTTPServer  # noqa: E402
from reachd.state import RelayState  # noqa: E402


def _closed_within(sock, seconds):
    """True when the peer closes `sock` (recv returns b"") before `seconds`."""
    sock.settimeout(seconds)
    try:
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                return True
    except socket.timeout:
        return False
    except ConnectionResetError:
        return True


class _ServerFixture(unittest.TestCase):
    handler = RelayHandler
    client_timeout = 0.5
    max_connections = 64

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["system"]["host_bind"] = False
        with patch("reachd.state.config_dir", return_value=tmp):
            self.state = RelayState(cfg, tmp / "config.json")
        self._patch = patch.object(core, "STATE", self.state)
        self._patch.start()
        self.server = RelayHTTPServer(("127.0.0.1", 0), self.handler,
                                      max_connections=self.max_connections,
                                      client_timeout=self.client_timeout)
        self.port = self.server.server_address[1]
        threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.02),
                         daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self._patch.stop()
        self._tmp.cleanup()

    def connect(self):
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=5)
        self.addCleanup(sock.close)
        return sock

    def health_on(self, sock):
        """Send GET /health on a raw keep-alive socket and read the reply."""
        sock.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
        sock.settimeout(5)
        data = b""
        while b"\r\n\r\n" not in data:
            data += sock.recv(4096)
        head, _, body = data.partition(b"\r\n\r\n")
        length = int([line.split(b":", 1)[1] for line in head.split(b"\r\n")
                      if line.lower().startswith(b"content-length:")][0])
        while len(body) < length:
            body += sock.recv(4096)
        return head.split(b"\r\n", 1)[0]


class TimeoutTests(_ServerFixture):
    def test_handler_has_a_bounded_default_timeout(self):
        self.assertIsInstance(RelayHandler.timeout, (int, float))
        self.assertTrue(0 < RelayHandler.timeout <= 120)
        self.assertEqual(RelayHandler.timeout, reachd.DEFAULT_SETTINGS["client_timeout_s"])

    def test_silent_connection_is_closed(self):
        self.assertTrue(_closed_within(self.connect(), 5))

    def test_half_sent_request_is_closed(self):
        # The slowloris shape from issue #15: headers promise a body that
        # never arrives.
        sock = self.connect()
        sock.sendall(b"POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                     b"Content-Type: application/json\r\nContent-Length: 1000\r\n\r\n{\"mo")
        self.assertTrue(_closed_within(sock, 5))

    def test_partial_headers_are_closed(self):
        sock = self.connect()
        sock.sendall(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n")  # no blank line
        self.assertTrue(_closed_within(sock, 5))

    def test_idle_keep_alive_is_closed_after_a_response(self):
        sock = self.connect()
        self.assertIn(b" 200 ", self.health_on(sock))
        self.assertTrue(_closed_within(sock, 5))

    def test_requests_still_work(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("GET", "/health")
        resp = conn.getresponse()
        resp.read()
        self.assertEqual(resp.status, 200)
        conn.close()


class _SlowStreamHandler(RelayHandler):
    """A response whose gaps between chunks are longer than the client
    timeout, like a slow generation: waiting on the upstream does not touch
    the client socket, so it must not trip the timeout."""

    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for index in range(3):
            time.sleep(0.4)  # each gap is longer than client_timeout (0.25s)
            self._write_chunk(("data: %d\n\n" % index).encode("ascii"))
        self._write_chunk(b"")


class SlowStreamTests(_ServerFixture):
    handler = _SlowStreamHandler
    client_timeout = 0.25

    def test_gaps_longer_than_the_timeout_do_not_cut_the_stream(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/stream")
        resp = conn.getresponse()
        self.assertEqual(resp.status, 200)
        self.assertEqual(resp.read(), b"data: 0\n\ndata: 1\n\ndata: 2\n\n")
        conn.close()


class StalledReaderTests(unittest.TestCase):
    def test_write_timeout_ends_the_stream_like_a_disconnect(self):
        handler = object.__new__(RelayHandler)
        handler.wfile = MagicMock()
        handler.wfile.write.side_effect = socket.timeout("timed out")
        handler.close_connection = False
        with self.assertRaises(ConnectionAbortedError):
            handler._write_chunk(b"data: x\n\n")
        self.assertTrue(handler.close_connection)


class ConnectionCapTests(_ServerFixture):
    client_timeout = 5
    max_connections = 2

    def test_connections_past_the_cap_are_refused_and_slots_are_reused(self):
        first, second = self.connect(), self.connect()
        # A served request proves each connection holds a handler thread.
        self.assertIn(b" 200 ", self.health_on(first))
        self.assertIn(b" 200 ", self.health_on(second))

        extra = self.connect()
        extra.settimeout(5)
        reply = b""
        try:
            while True:
                chunk = extra.recv(4096)
                if not chunk:
                    break
                reply += chunk
        except ConnectionResetError:
            pass
        if reply:  # the 503 is best effort; the close is the guarantee
            self.assertTrue(reply.startswith(b"HTTP/1.1 503 "), reply[:40])
            self.assertIn(b"too_many_connections", reply)

        first.close()  # frees a slot once its handler thread finishes
        deadline = time.monotonic() + 5
        while True:
            retry = self.connect()
            try:
                if b" 200 " in self.health_on(retry):
                    break
            except (ConnectionError, socket.timeout, IndexError):
                pass
            self.assertLess(time.monotonic(), deadline, "slot was never released")
            time.sleep(0.05)
        self.assertIn(b" 200 ", self.health_on(second))  # still served

    def test_threads_are_daemonic(self):
        self.assertTrue(RelayHTTPServer.daemon_threads)


class SettingsTests(unittest.TestCase):
    def _cfg(self, **overrides):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg.update(overrides)
        return cfg

    def test_defaults_validate(self):
        reachd.validate_settings(self._cfg())

    def test_out_of_range_values_are_rejected(self):
        for field, value in (("client_timeout_s", 0), ("client_timeout_s", 601),
                             ("max_connections", 1), ("max_connections", 5000),
                             ("max_connections", "64")):
            with self.subTest(field=field, value=value), \
                    self.assertRaises(reachd.SettingsError):
                reachd.validate_settings(self._cfg(**{field: value}))

    def test_main_builds_the_bounded_server_from_settings(self):
        cfg = self._cfg(client_timeout_s=45, max_connections=10)
        cfg["system"]["host_bind"] = False
        httpd = MagicMock()
        httpd.serve_forever.side_effect = KeyboardInterrupt
        with patch.object(sys, "argv", ["reachd", "--port", "20999"]), \
                patch.object(reachd_main, "load_config", return_value=cfg), \
                patch.object(reachd_main, "RelayState", MagicMock()), \
                patch.object(reachd_main, "RelayHTTPServer", return_value=httpd) as server_cls, \
                patch.object(reachd_main.threading, "Thread", MagicMock()), \
                patch.object(core, "STATE", None), patch.object(core, "PORT", None), \
                patch("builtins.print"):
            reachd_main.main()
        args, kwargs = server_cls.call_args
        self.assertEqual(args[0], ("127.0.0.1", 20999))
        self.assertIs(args[1], RelayHandler)
        self.assertEqual(kwargs, {"max_connections": 10, "client_timeout": 45})


if __name__ == "__main__":
    unittest.main()
