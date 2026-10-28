import json
from pathlib import Path
import urllib.request

root = Path.home() / 'AppData/Local/SignalREACH'
config = json.loads((root / 'accounts-private/accounts.json').read_text())
base = f"http://127.0.0.1:{config['port']}"
with urllib.request.urlopen(base + '/v1/account/config') as response:
    catalog = json.load(response)
assert any(m['id'] == 'd1-3b' for m in catalog['redemptionModels']), catalog.keys()
print('PASS live account catalog includes D1')
payload = {'model':'LiquidAI/d1-3B', 'state':'Please refund the duplicate charge.',
           'questions':{'refund':{'type':'noul','instructions':'Does the customer request a refund?'}}}
request = urllib.request.Request('http://127.0.0.1:18030/v1/decisions',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=90) as response:
    result = json.load(response)
assert result['answers']['refund']['noul'] > .9, result
print('PASS live FP8 decision', json.dumps(result))
