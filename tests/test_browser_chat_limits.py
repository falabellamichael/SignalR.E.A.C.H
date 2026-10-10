"""Browser-chat routes reach their signed-in provider without relay chat caps."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
import reachd
from reachd import core
from reachd.chat import chat_execute
from reachd.state import RelayState


class BrowserChatLimitsTests(unittest.TestCase):
    def execute(self, upstream, messages, max_tokens=None):
        cfg = json.loads(json.dumps(reachd.DEFAULT_SETTINGS))
        cfg["models"]["fixture"] = {"enabled": True, "public": True,
            "upstream": upstream, "max_tokens": 10, "max_tokens_cap": 20}
        cfg["request"].update(max_messages=2, max_input_chars=100, max_tokens_cap=30)
        cfg["rate_limits"]["max_prompt_tokens"] = 1
        cfg["cache"]["enabled"] = False
        state = RelayState(cfg, Path("unused-test-settings.json"))
        h = MagicMock()
        h._client_ip.return_value = "127.0.0.1"
        h.key_limits.return_value = (None, 0, 0)
        h.headers = {}
        payload = {"model": "fixture", "messages": messages, "stream": True}
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        h._read_body.return_value = json.dumps(payload).encode()
        with patch.object(core, "STATE", state), patch("reachd.chat.net.urlopen") as send:
            result = chat_execute(h)
            if result:
                state.gate.release()
            return h, send

    def test_all_three_browser_routes_preserve_large_history_and_output(self):
        messages = [{"role": "user", "content": "x" * 200000} for _ in range(4)]
        for model in ["copilot-chat", "chatgpt-chat", "gemini-chat"]:
            for max_tokens in [None, 50000]:
                with self.subTest(model=model, max_tokens=max_tokens):
                    h, send = self.execute("bridge/" + model, messages, max_tokens)
                    send.assert_called_once()
                    h._json.assert_not_called()
                    request = send.call_args.args[0]
                    body = json.loads(request.data)
                    self.assertEqual(body["messages"], messages)
                    self.assertEqual(body.get("max_tokens"), max_tokens)
                    self.assertIsNone(send.call_args.kwargs["timeout"])
                    self.assertNotIn("Authorization", request.headers)

    def test_codegpt_bridge_still_strips_max_tokens(self):
        _h, send = self.execute("bridge/codegpt-eco", [{"role": "user", "content": "x"}], 15)
        send.assert_called_once()
        self.assertNotIn("max_tokens", json.loads(send.call_args.args[0].data))

    def test_other_provider_routes_still_enforce_their_input_guards(self):
        for upstream in ["provider/gemini-3.8-flash", "bridge/codegpt-eco", "bridge/gemini-chat-extra"]:
            for messages in [
                [{"role": "user", "content": "x"}] * 3,
                [{"role": "user", "content": "x" * 101}],
                [{"role": "user", "content": "x" * 8}],
            ]:
                with self.subTest(upstream=upstream, messages=len(messages)):
                    h, send = self.execute(upstream, messages)
                    send.assert_not_called()
                    self.assertEqual(h._json.call_args.args[0], 400)


if __name__ == "__main__":
    unittest.main()
