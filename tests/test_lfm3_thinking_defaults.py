import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from reachd import model_routes


class Lfm3ThinkingDefaultsTests(unittest.TestCase):
    def test_document_clients_keep_vl_thinking_with_an_answer_budget(self):
        for model in ("lfm3-omni-2b", "lfm3-vl-2b"):
            with self.subTest(model=model):
                _, body, _, _ = model_routes.dispatch("gpu/" + model,
                    {"messages": [{"role": "user", "content": "summarize the document"}],
                     "max_tokens": 2048}, None)
                self.assertEqual(body["chat_template_kwargs"]["enable_thinking"], model == "lfm3-vl-2b")
                self.assertEqual(body.get("thinking_token_budget"), 1024 if model == "lfm3-vl-2b" else None)
                self.assertEqual(body["max_tokens"], 2048)

    def test_omni_cannot_enable_unsupported_thinking_or_mutate_client_payload(self):
        payload = {"chat_template_kwargs": {"enable_thinking": True, "preserve_thinking": False}}
        before = copy.deepcopy(payload)
        _, body, _, _ = model_routes.dispatch("gpu/lfm3-omni-2b", payload, None,
                                             {"enable_thinking": True})
        self.assertFalse(body["chat_template_kwargs"]["enable_thinking"])
        self.assertFalse(body["chat_template_kwargs"]["preserve_thinking"])
        self.assertEqual(payload, before)

    def test_vl_preserves_explicit_thinking_preference(self):
        for thinking in (True, False):
            payload = {"chat_template_kwargs": {"enable_thinking": thinking}}
            _, body, _, _ = model_routes.dispatch("gpu/lfm3-vl-2b", payload, None)
            self.assertEqual(body["chat_template_kwargs"]["enable_thinking"], thinking)

    def test_vl_budget_preserves_explicit_limits_preferences_and_payload(self):
        cases = [
            ({"max_completion_tokens": 2048}, 1024),
            ({"max_tokens": 8192}, 4096),
            ({"max_tokens": 2048, "thinking_token_budget": 768}, 768),
            ({"max_tokens": 2048, "chat_template_kwargs": {"enable_thinking": False}}, None),
            ({}, None),
        ]
        for payload, expected in cases:
            with self.subTest(payload=payload):
                before = copy.deepcopy(payload)
                _, body, _, _ = model_routes.dispatch("gpu/lfm3-vl-2b", payload, None)
                self.assertEqual(body.get("thinking_token_budget"), expected)
                self.assertEqual(payload, before)

    def test_other_models_keep_their_thinking_defaults(self):
        for model in ("gemma-4-12b-qat", "ornith-1.5-9b", "minicpm5-2b"):
            _, body, _, _ = model_routes.dispatch("gpu/" + model, {}, None)
            self.assertTrue(body["chat_template_kwargs"]["enable_thinking"])


if __name__ == "__main__":
    unittest.main()
