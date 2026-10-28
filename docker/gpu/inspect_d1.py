from pathlib import Path
import json
root = Path('/models/d1-3b')
print('exists', root.exists())
print((root / 'config.json').read_text())
for p in root.glob('*.py'):
    print('SOURCE', p.name)
    print(p.read_text()[:22000])
