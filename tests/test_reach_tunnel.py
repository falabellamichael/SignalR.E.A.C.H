"""The cloudflared launcher must only trust the URL the CURRENT launch prints."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from reach import tunnel  # noqa: E402

OLD_URL = "https://old-dead-tunnel.trycloudflare.com"
NEW_URL = "https://fresh-live-tunnel.trycloudflare.com"


def _banner(url):
    return ("2026-10-01T12:00:00Z INF |  %s  |\n" % url).encode("utf-8")


class CloudflaredUrlTests(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._dir.cleanup)
        self.log = Path(self._dir.name) / "tunnel.log"
        self.pid = Path(self._dir.name) / "tunnel.pid"
        # A previous launch left its (now dead) quick-tunnel URL in the log.
        self.log.write_bytes(b"earlier run\n" + _banner(OLD_URL))
        for name, value in (("TUNNEL_LOG", self.log), ("TUNNEL_PID_PATH", self.pid)):
            patcher = patch.object(tunnel, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_url_before_the_offset_is_ignored(self):
        offset = self.log.stat().st_size
        with open(self.log, "ab") as log:
            log.write(b"starting tunnel\n" + _banner(NEW_URL))
        self.assertEqual(tunnel.wait_for_cloudflared_url(1, offset), NEW_URL)

    def test_only_a_stale_url_times_out(self):
        offset = self.log.stat().st_size
        with patch.object(tunnel.time, "sleep"):
            self.assertIsNone(tunnel.wait_for_cloudflared_url(0.05, offset))

    def test_truncated_log_is_scanned_from_the_start(self):
        offset = self.log.stat().st_size
        self.log.write_bytes(_banner(NEW_URL))  # rotated: now shorter than offset
        self.assertEqual(tunnel.wait_for_cloudflared_url(1, offset), NEW_URL)

    def test_start_tunnel_publishes_the_new_launch_url(self):
        def fake_popen(argv, stdout=None, **_kwargs):
            stdout.write(b"INF Requesting new quick Tunnel\n" + _banner(NEW_URL))
            stdout.flush()
            return MagicMock(pid=4242)

        with patch.object(tunnel, "public_url_from_server", return_value=None), \
                patch.object(tunnel, "find_cloudflared", return_value="cloudflared"), \
                patch.object(tunnel, "no_window_kwargs", return_value={}), \
                patch.object(tunnel.subprocess, "Popen", side_effect=fake_popen), \
                patch.object(tunnel, "post_public_url_override") as post:
            self.assertTrue(tunnel.start_tunnel("cloudflared", 20777))
        post.assert_called_once_with(20777, NEW_URL)
        # History is kept: the earlier run's output is still in the log.
        self.assertIn(OLD_URL.encode("utf-8"), self.log.read_bytes())
        self.assertEqual(self.pid.read_text(encoding="utf-8"), "4242")


if __name__ == "__main__":
    unittest.main()
