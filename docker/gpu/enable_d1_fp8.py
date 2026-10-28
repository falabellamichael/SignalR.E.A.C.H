"""Patch the qualified support runtime to load resident D1 3B FP8."""
from pathlib import Path
import shutil

path = Path('/app/signalreach_support.py')
source = path.read_text()
assert '"LiquidAI/d1-3B": "d1-3b"' not in source
backup = path.with_suffix('.py.before-d1-fp8')
assert not backup.exists()
shutil.copy2(path, backup)
source = source.replace('    "LiquidAI/d1-omni-600M": "d1-omni-600m",',
                        '    "LiquidAI/d1-omni-600M": "d1-omni-600m",\n    "LiquidAI/d1-3B": "d1-3b",')
needle = '    yield\n'
assert source.count(needle) == 1
source = source.replace(needle, '''    decision = AutoModel.from_pretrained(
        str(ROOT / "d1-3b"), local_files_only=True, trust_remote_code=True,
        dtype=torch.bfloat16).eval().to(DEVICE)
    count = quantize_linears(decision.model)
    if count != 331:
        raise RuntimeError(f"Unexpected D1 FP8 layer count: {count}")
    with torch.inference_mode():
        probe = decision.system_one("Paris is in France.", {
            "france": {"type": "noul", "instructions": "Is this about France?"}})
    if not probe["answers"]["france"]["noul"] > 0.9:
        raise RuntimeError("D1 FP8 startup qualification failed")
    MODELS["d1-3b"] = decision
    torch.cuda.empty_cache()
    print(json.dumps({"loaded": "d1-3b", "fp8_linears": count, **storage_report(decision)}), flush=True)
    yield
''')
source = source.replace('require_model(request.model, {"d1-omni-600m"})',
                        'require_model(request.model, {"d1-omni-600m", "d1-3b"})')
compile(source, str(path), 'exec')
path.write_text(source)
