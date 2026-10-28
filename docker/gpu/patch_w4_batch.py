"""Tune group-32 RDNA decode tiles for 6-8 active sequences; preserve rollback."""
from pathlib import Path
import shutil
from vllm.model_executor.kernels.linear.mixed_precision import rdna_hybrid_w4a16

path = Path(rdna_hybrid_w4a16.__file__)
source = path.read_text()
marker = "    # SignalREACH group-32 eight-request decode tuning."
if marker not in source:
    needle = "    # The kernel loads one scale per BLOCK_K tile, so BLOCK_K must not"
    assert source.count(needle) == 1
    backup = path.with_suffix(".py.before-eight")
    if backup.exists():
        assert backup.read_text() == source, "Unexpected kernel changes; refusing overwrite"
    else:
        shutil.copy2(path, backup)
    patch = '''    # SignalREACH group-32 eight-request decode tuning.
    # A single wave avoids idle lanes on the small 16x16 decode tile.
    if _on_gfx12x() and group_size == 32 and 6 <= M <= 8:
        BLOCK_M, BLOCK_N, BLOCK_K, num_warps = 16, 16, 32, 1

'''
    path.write_text(source.replace(needle, patch + needle))
print(path)
