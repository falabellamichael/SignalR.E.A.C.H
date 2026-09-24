"""Metered relay protocol: measured counters, single dispatch, no cache replay."""
import io
import json
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from reachd import core
from reachd.chat import chat_execute, chat_finalize, provider_usage


class MeteredRelayTests(unittest.TestCase):
    def state(self):
        state = MagicMock()
        state.cfg = {"request": {}, "models": {
            "test": {"enabled": True, "upstream": "vendor/test", "fallback": "backup"},
            "backup": {"enabled": True, "upstream": "vendor/backup"}},
            "cache": {"enabled": True}, "upstream_retries": 3, "retry_delay_ms": 0,
            "data": {}, "rate_limits": {}}
        state.limiter.check.return_value = (True, {}, None)
        state.circuit_open.return_value = False
        state.gate.acquire.return_value = True
        state.key = "operator-test-key"
        state.omniroute_url = "http://127.0.0.1:20128/v1"
        return state

    def handler(self, extra=None):
        h = MagicMock()
        h.headers = {"X-Reach-Metered": "provider-v1"}
        h._check_ip_lists.return_value = True
        h._read_body.return_value = json.dumps({"model": "test",
            "messages": [{"role": "user", "content": "Hello"}], "max_tokens": 20,
            **(extra or {})}).encode()
        return h

    def finalize(self, payload, *, stream=False, metered=True, spec=None):
        source = io.BytesIO(payload if isinstance(payload, bytes) else json.dumps(payload).encode())
        source.headers = {"Content-Type": "text/event-stream" if stream else "application/json"}
        state, h = self.state(), self.handler()
        ctx = {"started": time.time(), "ip": "127.0.0.1", "rl_headers": {},
               "requested": "test", "upstream_model": "vendor/test", "spec": spec or {},
               "stream": stream, "metered": metered, "total_chars": 50, "request_body": None,
               "fallback_used": False, "cache_cfg": {}, "cache_key": None, "models": {}}
        with patch.object(core, "STATE", state):
            chat_finalize(h, source, ctx)
        if stream:
            data = b"".join(c.args[0] for c in h._write_chunk.call_args_list)
        else:
            data = h.wfile.write.call_args.args[0]
        return data, h

    @staticmethod
    def sse(*events):
        return b"".join(b"data: " + (event if isinstance(event, bytes) else json.dumps(event).encode())
                        + b"\n\n" for event in events)

    def test_measured_zero_counters_are_preserved(self):
        data, h = self.finalize({"choices": [{"message": {"content": ""}}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}})
        parsed = json.loads(data)
        self.assertEqual(parsed["usage_source"], "provider")
        self.assertEqual(parsed["usage"]["total_tokens"], 0)
        h.send_header.assert_any_call("X-Reach-Metering", "provider-v1")

    def test_missing_or_estimated_usage_is_never_promoted(self):
        for extra in ({}, {"usage_source": "estimated", "usage": {
                "prompt_tokens": 5, "completion_tokens": 5, "total_tokens": 10}},
                {"usage": {"prompt_tokens": "bad", "completion_tokens": False}}):
            with self.subTest(extra=extra):
                data, _ = self.finalize({"choices": [{"message": {"content": "Example"}}], **extra})
                self.assertEqual(json.loads(data)["usage_source"], "estimated")

    def test_validity_rejects_incoherent_and_bool_counters(self):
        for usage in ({"prompt_tokens": True, "completion_tokens": 0, "total_tokens": 1},
                      {"prompt_tokens": 3, "completion_tokens": 4, "total_tokens": 8},
                      {"prompt_tokens": -1, "completion_tokens": 4, "total_tokens": 3}):
            self.assertIsNone(provider_usage({"usage": usage}))

    def test_metered_dispatch_skips_cache_retry_and_fallback(self):
        state, h = self.state(), self.handler()
        with patch.object(core, "STATE", state), patch("urllib.request.urlopen", side_effect=OSError("failed")) as upstream:
            self.assertIsNone(chat_execute(h))
        self.assertEqual(upstream.call_count, 1)
        state.cache.get.assert_not_called()
        state.gate.release.assert_called_once()

    def test_metered_route_cannot_raise_requested_output_budget(self):
        state, h = self.state(), self.handler()
        state.cfg["models"]["test"]["min_output_tokens"] = 100
        with patch.object(core, "STATE", state), patch("urllib.request.urlopen") as upstream:
            self.assertIsNone(chat_execute(h))
        upstream.assert_not_called()
        self.assertEqual(h._json.call_args.args[0], 400)

    def test_metered_route_rejects_scrubber_that_can_drop_usage(self):
        state, h = self.state(), self.handler({"stream": True})
        state.cfg["models"]["test"]["strip_trailing_roles"] = True
        with patch.object(core, "STATE", state), patch("urllib.request.urlopen") as upstream:
            self.assertIsNone(chat_execute(h))
        upstream.assert_not_called()
        self.assertEqual(h._json.call_args.args[1]["error"]["code"], "unmetered_route")

    def test_stream_provider_usage_preserves_exact_counts(self):
        data, h = self.finalize(self.sse(
            {"choices": [{"delta": {"content": "Hello"}, "finish_reason": None}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            {"choices": [], "usage": {"prompt_tokens": 2, "completion_tokens": 0, "total_tokens": 2}},
            b"[DONE]"), stream=True)
        usages = [json.loads(line[6:]) for line in data.splitlines()
                  if line.startswith(b"data: {") and b'"usage"' in line]
        self.assertEqual(len(usages), 2)
        for event in usages:
            self.assertEqual(event["usage_source"], "provider")
            self.assertEqual(event["usage"]["completion_tokens"], 0)
            self.assertEqual(event["usage"]["total_tokens"], 2)
        h.send_header.assert_any_call("X-Reach-Metering", "provider-v1")

    def test_stream_missing_usage_is_marked_estimated(self):
        data, _ = self.finalize(self.sse({"choices": [{"delta": {"content": "Hello"}}]},
                                        b"[DONE]"), stream=True)
        self.assertIn(b'"usage_source": "estimated"', data)
        self.assertNotIn(b'"usage_source": "provider"', data)

    def test_truncated_stream_does_not_synthesize_successful_final_usage(self):
        data, _ = self.finalize(self.sse({"choices": [{"delta": {"content": "Hello"}}]},
            {"choices": [], "usage": {"prompt_tokens": 2, "completion_tokens": 2, "total_tokens": 4}}), stream=True)
        self.assertIn(b'"upstream_truncated"', data)
        self.assertEqual(data.count(b'"usage_source": "provider"'), 1)

    def test_metered_stream_failure_has_no_fallback_dispatch(self):
        state, h = self.state(), self.handler()
        source = io.BytesIO(self.sse({"error": {"message": "failed"}}, b"[DONE]"))
        source.headers = {"Content-Type": "text/event-stream"}
        ctx = {"started": time.time(), "ip": "127.0.0.1", "rl_headers": {},
               "requested": "test", "upstream_model": "vendor/test", "spec": {"fallback": "backup"},
               "stream": True, "metered": True, "total_chars": 50, "request_body": None,
               "fallback_used": False, "cache_cfg": {}, "cache_key": None, "models": state.cfg["models"]}
        with patch.object(core, "STATE", state), patch("urllib.request.urlopen") as upstream:
            chat_finalize(h, source, ctx)
        upstream.assert_not_called()
        self.assertEqual(h._json.call_args.args[0], 502)


if __name__ == "__main__":
    unittest.main()
