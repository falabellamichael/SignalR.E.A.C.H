"""CPU-only structural checks for the isolated support deployment."""
import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class SupportDeploymentTests(unittest.TestCase):
    def test_scripts_compile(self):
        for name in ('support_fp8.py', 'upgrade_support.py'):
            source = (ROOT / 'docker/gpu' / name).read_text()
            ast.parse(source)

    def test_support_launcher_no_longer_requires_3b(self):
        source = (ROOT / 'docker/gpu/launch_services.py').read_text()
        self.assertNotIn('"d1-omni-600m", "d1-3b"', source)
        self.assertIn('signalreach-support:20261017-fp8-gpu', source)

    def test_gpu_decision_precision_and_memory_are_qualified(self):
        source = (ROOT / 'docker/gpu/upgrade_support.py').read_text()
        self.assertIn("DECISION_DEVICE = 'cuda:0'", source)
        self.assertIn("DECISION_DTYPE = 'float16'", source)
        self.assertIn("storage['cuda:0/torch.float16']", source)
        self.assertIn("allocated_bytes'] < 4 * 1024**3", source)
        self.assertIn('reach-support-fp8-cpu-rollback-20261017', source)

    def test_quantization_has_no_fallback(self):
        source = (ROOT / 'docker/gpu/support_fp8.py').read_text()
        self.assertIn('torch._scaled_mm', source)
        self.assertIn('torch.float8_e4m3fn', source)
        self.assertNotIn('except', source)


if __name__ == '__main__':
    unittest.main()
