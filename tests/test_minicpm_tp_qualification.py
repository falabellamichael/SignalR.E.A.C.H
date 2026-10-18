"""Offline guards for the operator-only MiniCPM TP2 qualification."""
import ast
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class MiniCPMQualificationTests(unittest.TestCase):
    def setUp(self):
        self.source = (ROOT / 'docker/gpu/qualify_minicpm_tp.py').read_text()

    def test_script_compiles(self):
        ast.parse(self.source)

    def test_equal_completion_lengths_and_regression_guard(self):
        for fragment in ("'max_tokens': 128, 'min_tokens': 128, 'ignore_eos': True", "completion_tokens'] == 128", 'r <= 1.10', "for concurrency in (1, 2)"):
            self.assertIn(fragment, self.source)

    def test_tp_runtime_preserves_context_and_gemma(self):
        for fragment in ("('--max-model-len', '39904')", "('--tensor-parallel-size', '2')", "env[key] = gemma_env[key]", 'hashlib.sha256', "inspect('reach-gemma')['State']['StartedAt']", "'--disable-custom-all-reduce'"):
            self.assertIn(fragment, self.source)
        for operation in ('stop', 'start', 'update', 'rename'):
            self.assertNotIn(f"docker('{operation}', 'reach-gemma'", self.source)

    def test_watchdog_and_restore_are_independent(self):
        self.assertIn('start_new_session=True', self.source)
        restore = self.source.split('def restore():', 1)[1].split('def watchdog():', 1)[0]
        self.assertNotIn('check=True', restore)
        self.assertEqual(restore.count('check=False'), 5)
        self.assertIn("(STATE / 'armed').unlink(missing_ok=True)", self.source)


if __name__ == '__main__':
    unittest.main()
