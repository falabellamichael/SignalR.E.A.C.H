from pathlib import Path
import json
from safetensors import safe_open
root = Path('/models/gemma4-12b-qat-w4a16-ct')
print((root / 'config.json').read_text())
for p in root.glob('*.safetensors'):
    with safe_open(p, framework='pt') as f:
        for key in f.keys():
            if '.layers.0.' in key and ('weight_packed' in key or 'weight_scale' in key):
                print(key, f.get_slice(key).get_shape())
