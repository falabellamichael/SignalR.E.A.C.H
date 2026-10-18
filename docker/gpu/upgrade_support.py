"""Run as root on the VM, alongside support_fp8.py. Changes support only."""
import json
from pathlib import Path
import subprocess
import time
import urllib.error
import urllib.request

ROOT = Path('/srv/signalreach')
BACKUP = ROOT / 'backups/support-20261017'
IMAGE = 'signalreach-support:20261017-fp8-gpu'
ROLLBACK = 'reach-support-fp8-cpu-rollback-20261017'
DECISION_DEVICE = 'cuda:0'
DECISION_DTYPE = 'float16'


def docker(*args, check=True):
    return subprocess.run(['docker', *args], capture_output=True, text=True, check=check)


def request(route, payload=None):
    req = urllib.request.Request('http://127.0.0.1:8030' + route,
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as response:
        return json.load(response)


def qualify():
    baseline = json.loads((BACKUP / 'baseline.json').read_text())
    fixtures = json.loads((BACKUP / 'fixtures.json').read_text())
    results = {}
    for key, (route, payload) in fixtures.items():
        started = time.monotonic()
        response = request(route, payload)
        results[key] = {'response': response, 'seconds': time.monotonic() - started}
    import math
    similarities = []
    for old, new in zip(baseline['embeddings']['response']['data'], results['embeddings']['response']['data']):
        a, b = old['embedding'], new['embedding']
        assert len(b) == 1024 and all(math.isfinite(v) for v in b)
        cosine = sum(x*y for x,y in zip(a,b)) / math.sqrt(sum(x*x for x in a)*sum(y*y for y in b))
        similarities.append(cosine)
        assert cosine > 0.995, cosine
    old = baseline['rerank']['response']['results']
    new = results['rerank']['response']['results']
    assert [r['index'] for r in old] == [r['index'] for r in new], new
    assert all(math.isfinite(r['relevance_score']) for r in new)
    assert max(abs(a['relevance_score']-b['relevance_score']) for a,b in zip(old,new)) < 0.02
    assert results['decision']['response']['answers']['is_about_france']['noul'] > 0.9
    for name in ['d1-3b', 'LiquidAI/d1-3B']:
        payload = {**fixtures['decision'][1], 'model': name}
        try:
            request('/v1/decisions', payload)
        except urllib.error.HTTPError as error:
            assert error.code == 400
        else:
            raise AssertionError('Removed model accepted')
    assert all(row['id'] != 'LiquidAI/d1-3B' for row in request('/v1/models')['data'])
    results['embedding_cosines'] = similarities
    results['health'] = request('/health')
    storage = results['health']['precision']['d1-omni-600m']['storage_by_device_dtype']
    assert set(storage) <= {'cuda:0/torch.float16', 'cuda:0/torch.int64'}
    assert 1_000_000_000 < storage['cuda:0/torch.float16'] < 1_600_000_000
    assert results['health']['allocated_bytes'] < 4 * 1024**3
    for name in ('bge-m3', 'bge-reranker-v2-m3'):
        assert results['health']['precision'][name]['storage_by_device_dtype']['cuda:0/torch.float8_e4m3fn'] > 250_000_000
    (BACKUP / 'after.json').write_text(json.dumps(results))
    print(json.dumps({'cosines': similarities, 'latencies': {k: v['seconds'] for k,v in results.items() if isinstance(v,dict) and 'seconds' in v}, 'health': results['health']}), flush=True)


def main():
    original = json.loads((BACKUP / 'containers.json').read_text())[0]
    current = json.loads(docker('inspect', 'reach-support').stdout)[0]
    if current['Config']['Image'] == IMAGE:
        qualify()
        return
    assert current['Config']['Image'] == 'signalreach-support:20261017-fp8-cpu', 'Unexpected support container; preserving it'
    original = current
    peers = json.loads(docker('inspect', 'reach-gemma', 'reach-minicpm').stdout)
    context = ROOT / 'support-fp8-20261017'
    context.mkdir(exist_ok=True)
    source = (BACKUP / 'signalreach_support.py').read_text()
    source = source.replace('All four models remain loaded.', 'Two native FP8 encoders and the FP16 Omni600M decision model remain on GPU.')
    source = source.replace('from transformers import AutoModel, AutoModelForSequenceClassification, AutoTokenizer', 'from transformers import AutoModel, AutoModelForSequenceClassification, AutoTokenizer\nfrom support_fp8 import quantize_linears, storage_report')
    source = source.replace('    "LiquidAI/d1-3B": "d1-3b",\n', '')
    source = source.replace('        print(json.dumps({"loaded": name, "dtype": "float16"}), flush=True)', '''        count = quantize_linears(MODELS[name])
        if count != 145:
            raise RuntimeError(f"Unexpected encoder FP8 layer count: {count}")
        # Exercise real token shapes and SDPA at startup, not just isolated GEMMs.
        sample = TOKENIZERS[name]("FP8 startup qualification", return_tensors="pt").to(DEVICE)
        with torch.inference_mode():
            out = MODELS[name](**sample)
            value = out.logits if "reranker" in name else out.last_hidden_state
            if not torch.isfinite(value).all():
                raise RuntimeError("Nonfinite FP8 startup result")
        del sample, out, value
        torch.cuda.empty_cache()
        print(json.dumps({"loaded": name, "fp8_linears": count, **storage_report(MODELS[name])}), flush=True)''')
    source = source.replace('for name, dtype in (("d1-omni-600m", torch.float16), ("d1-3b", torch.bfloat16)):', 'for name, dtype in (("d1-omni-600m", getattr(torch, os.environ.get("DECISION_DTYPE", "' + DECISION_DTYPE + '"))),):')
    source = source.replace('        ).eval().to(DEVICE)\n        print(json.dumps({"loaded": name, "dtype": str(dtype)}), flush=True)', '        ).eval().to(os.environ.get("DECISION_DEVICE", "' + DECISION_DEVICE + '"))\n        print(json.dumps({"loaded": name, **storage_report(MODELS[name])}), flush=True)')
    source = source.replace('"retrieval_max_tokens": MAX_TOKENS,', '"retrieval_max_tokens": MAX_TOKENS,\n        "precision": {name: storage_report(model) for name, model in MODELS.items()},\n        "fp8_compute": "encoder linear GEMMs E4M3FN inputs/weights, FP16 output; embeddings/norms/attention FP16",')
    source = source.replace('name = require_model(request.model, {"d1-omni-600m", "d1-3b"})', 'name = require_model(request.model, {"d1-omni-600m"})')
    compile(source, 'signalreach_support.py', 'exec')
    (context / 'signalreach_support.py').write_text(source)
    (context / 'support_fp8.py').write_text(Path(__file__).with_name('support_fp8.py').read_text())
    (context / 'Dockerfile').write_text('FROM signalreach-support:20261015\nCOPY signalreach_support.py support_fp8.py /app/\n')
    print(docker('build', '-t', IMAGE, str(context)).stdout, flush=True)
    docker('stop', 'reach-support')
    renamed = False
    try:
        docker('rename', 'reach-support', ROLLBACK)
        renamed = True
        docker('update', '--restart=no', ROLLBACK)
        host = original['HostConfig']
        args = ['run', '-d', '--name', 'reach-support', '--init', '--pull=never', '--restart=unless-stopped', '--shm-size=2g', '--group-add=video', '--device=/dev/kfd', '--device=/dev/dri', '-p', '127.0.0.1:8030:8030', '--log-opt', 'max-size=20m', '--log-opt', 'max-file=3']
        for key,value in (original['Config'].get('Labels') or {}).items():
            args += ['--label', key+'='+value]
        for value in original['Config']['Env']:
            args += ['-e', value]
        for bind in host['Binds']:
            args += ['-v', bind]
        docker(*args, IMAGE)
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            state = json.loads(docker('inspect', 'reach-support').stdout)[0]['State']
            if not state['Running'] or state.get('Restarting'):
                raise RuntimeError('Replacement exited: '+docker('logs', '--tail', '30', 'reach-support').stdout)
            try:
                if request('/health')['status'] == 'ready':
                    break
            except OSError:
                time.sleep(2)
        else:
            raise TimeoutError('Support readiness exceeded 300 seconds')
        qualify()
        for old in peers:
            now = json.loads(docker('inspect', old['Name']).stdout)[0]
            assert now['Id'] == old['Id'] and now['State']['StartedAt'] == old['State']['StartedAt']
        print('DEPLOYED_SUPPORT_ONLY; rollback container '+ROLLBACK, flush=True)
    except BaseException:
        if renamed:
            docker('rm', '-f', 'reach-support', check=False)
            docker('rename', ROLLBACK, 'reach-support')
        docker('update', '--restart=unless-stopped', 'reach-support')
        docker('start', 'reach-support')
        print('RESTORED_PREVIOUS_FP8_CPU_SUPPORT', flush=True)
        raise


if __name__ == '__main__':
    main()
