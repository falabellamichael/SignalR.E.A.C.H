"""Print only nonsecret deployment settings for operator verification."""
import json
import pathlib
import subprocess
import urllib.request
import time
config = json.loads(pathlib.Path('/srv/signalreach/models/minicpm5-2b/config.json').read_text())
print('minicpm_heads', {k: config.get(k) for k in ('num_attention_heads', 'num_key_value_heads', 'hidden_size')})
for name in ('reach-support', 'reach-minicpm', 'reach-gemma'):
    d = json.loads(subprocess.check_output(['docker', 'inspect', name]))[0]
    env = dict(v.split('=', 1) for v in d['Config']['Env'])
    print(json.dumps({'name': name, 'id': d['Id'], 'started': d['State']['StartedAt'], 'command': d['Config']['Cmd'], 'gpu': env.get('ROCR_VISIBLE_DEVICES'), 'runtime_env': {k:v for k,v in env.items() if k.startswith(('NCCL_', 'HSA_', 'GPU_MAX_', 'OMP_', 'VLLM_USE_'))}, 'binds': d['HostConfig']['Binds']}))
for p in pathlib.Path('/sys/class/drm').glob('card[0-9]/device/mem_info_vram_used'):
    print(p.parent.parent.name, p.read_text().strip(), (p.parent / 'mem_info_vram_total').read_text().strip())
with urllib.request.urlopen('http://127.0.0.1:8004/v1/models') as r:
    print(r.read().decode())
for port in (8030, 8001):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health') as r:
        print('health', port, r.read().decode())
state = pathlib.Path('/srv/signalreach/backups/minicpm-tp2-20261017')
for filename in ('baseline.json', 'tp2.json'):
    if (state / filename).exists():
        data = json.loads((state / filename).read_text())
        print(filename, {c: data[c]['median_seconds'] for c in ('1', '2')})
print('watchdog_armed', (state / 'armed').exists())
if __import__('sys').argv[-1] == 'smoke':
    with urllib.request.urlopen('http://127.0.0.1:8001/v1/models') as r:
        model = json.load(r)['data'][0]['id']
    payload = {'model': model, 'messages': [{'role': 'user', 'content': 'Reply with the word READY.'}], 'temperature': 0, 'max_tokens': 16, 'chat_template_kwargs': {'enable_thinking': False}}
    started = time.monotonic()
    req = urllib.request.Request('http://127.0.0.1:8001/v1/chat/completions', data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        print('gemma_smoke', time.monotonic()-started, r.read().decode())
    fixtures = json.loads(pathlib.Path('/srv/signalreach/backups/support-20261017/fixtures.json').read_text())
    for _ in range(3):
        route, payload = fixtures['decision']
        started = time.monotonic()
        req = urllib.request.Request('http://127.0.0.1:8030'+route, data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as r:
            print('decision_warm', time.monotonic()-started, r.read().decode())
