"""Deploy the D1 native account route to the operator's installed services."""
import json
from pathlib import Path
import shutil

repo = Path(__file__).resolve().parents[1]
root = Path.home() / 'AppData/Local/SignalREACH'
backup = root / 'backups/d1-access-20261024'
backup.mkdir(parents=True, exist_ok=False)
for relative, installed in [
    ('RCH/service/gpu-bridge.mjs', 'accounts-service/service/gpu-bridge.mjs'),
    ('RCH/service/model-gateway.mjs', 'accounts-service/service/model-gateway.mjs'),
    ('RCH/service/server.mjs', 'accounts-service/service/server.mjs'),
    ('server/reachd/account_proxy.py', 'server/reachd/account_proxy.py'),
    ('server/reachd/model_services.py', 'server/reachd/model_services.py'),
]:
    target = root / installed
    assert target.is_file()
    shutil.copy2(target, backup / target.name)
    shutil.copy2(repo / relative, target)
config = root / 'accounts-private/accounts.json'
shutil.copy2(config, backup / 'accounts.json')
data = json.loads(config.read_text(encoding='utf-8'))
assert not any(m['id'] == 'd1-3b' for m in data['models'])
data['models'].append({'id':'d1-3b', 'name':'Liquid d1 3B FP8', 'provider':'LiquidAI',
                       'access':'requests', 'metered':True, 'bridge':{'kind':'gpu','model':'LiquidAI/d1-3B'}})
config.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')
print('Deployed D1 account route and catalog; restart account service and relay to activate.')
