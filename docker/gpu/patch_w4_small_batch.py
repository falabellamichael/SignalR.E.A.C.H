"""Extend the validated single-wave fallback to smaller decode batches."""
from pathlib import Path
import shutil
from vllm.model_executor.kernels.linear.mixed_precision import rdna_hybrid_w4a16

path = Path(rdna_hybrid_w4a16.__file__)
source = path.read_text()
old = "if _on_gfx12x() and group_size == 32 and 6 <= M <= 8:"
new = "if _on_gfx12x() and group_size == 32 and 1 <= M <= 8:"
assert source.count(old) == 1, "Expected the qualified eight-call kernel"
backup = path.with_suffix('.py.before-small-batch')
assert not backup.exists(), "Preserve existing backup"
shutil.copy2(path, backup)
path.write_text(source.replace(old, new))
print(path)
