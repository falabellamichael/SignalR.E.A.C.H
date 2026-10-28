"""Exercise the real upstream harness in a disposable container workspace."""
import json
from pathlib import Path
import subprocess
import tempfile


root = Path(tempfile.mkdtemp(prefix="locals-vllm-smoke-"))
project = root / "project"
project.mkdir()
(project / "math_ops.py").write_text("def add(a, b):\n    return a - b\n")
(project / "test_math_ops.py").write_text(
    "import unittest\nfrom math_ops import add\n"
    "class Tests(unittest.TestCase):\n"
    "    def test_add(self):\n"
    "        self.assertEqual(add(2, 3), 5)\n"
    "        self.assertEqual(add(-4, 7), 3)\n")
result = subprocess.run([
    "python", "/app/locals_vllm.py", "run",
    "Fix add in math_ops.py so it returns the sum of a and b. Do not change tests.",
    "--dir", str(project), "--check", "python3 -m unittest discover -v",
    "--workers", "1", "--parts", "1", "--steps", "6", "--rounds", "1",
    "--report", str(root / "report.json")], timeout=360)
assert result.returncode == 0, result.returncode
subprocess.run(["python", "-m", "unittest", "discover", "-v"], cwd=project, check=True)
report = json.loads((root / "report.json").read_text())
assert report["passed"] is True and "math_ops.py" in report["changed"], report
print("PASS real_locals_harness_fix_check_apply", flush=True)
