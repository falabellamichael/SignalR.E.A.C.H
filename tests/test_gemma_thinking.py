import unittest
from types import SimpleNamespace

from reachd.model_routes import dispatch


class ThinkingTests(unittest.TestCase):
    def test_model_setting_controls_thinking_without_mutating_request(self):
        payload = {"messages": [{"role": "user", "content": "Hello"}]}
        for setting, expected in ((None, True), (False, False), (True, True)):
            with self.subTest(setting=setting):
                _, result, _, _ = dispatch("gpu/gemma-4-12b-qat", payload,
                    SimpleNamespace(), {"enable_thinking": setting})
                self.assertEqual(result["chat_template_kwargs"]["enable_thinking"], expected)
                self.assertNotIn("chat_template_kwargs", payload)

    def test_other_gpu_models_keep_reasoning_default(self):
        _, result, _, _ = dispatch("gpu/minicpm5-2b", {}, SimpleNamespace())
        self.assertTrue(result["chat_template_kwargs"]["enable_thinking"])
