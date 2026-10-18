"""Bounded live MiniCPM TP qualification. Never modifies Gemma or weights."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time
import urllib.request

ROOT = Path('/srv/signalreach')
STATE = ROOT / 'backups/minicpm-tp2-20261017'
ROLLBACK = 'reach-minicpm-tp1-rollback-20261017'


def docker(*args, check=True):
    return subprocess.run(['docker', *args], capture_output=True, text=True, check=check)


def inspect(name):
    return json.loads(docker('inspect', name).stdout)[0]


def request(port, route, payload=None, timeout=120):
    req = urllib.request.Request(f'http://127.0.0.1:{port}{route}',
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = response.read()
        return json.loads(body) if body else {}


def restore():
    # Every cleanup is independent: already stopped/missing trials cannot block rollback.
    docker('stop', '-t', '8', 'reach-minicpm', check=False)
    docker('rename', 'reach-minicpm', 'reach-minicpm-tp2-rejected-20261017', check=False)
    docker('rename', ROLLBACK, 'reach-minicpm', check=False)
    docker('update', '--restart=unless-stopped', 'reach-minicpm', check=False)
    docker('start', 'reach-minicpm', check=False)


def watchdog():
    deadline = time.monotonic() + 780
    while time.monotonic() < deadline:
        if not (STATE / 'armed').exists():
            return
        time.sleep(3)
    if (STATE / 'armed').exists():
        restore()
        (STATE / 'watchdog-restored').touch()


def memory():
    return {p.parent.parent.name: {k: int((p.parent / k).read_text()) for k in ('mem_info_vram_used', 'mem_info_vram_total')}
            for p in Path('/sys/class/drm').glob('card[0-9]/device/mem_info_vram_used')}


def bench():
    model = request(8004, '/v1/models')['data'][0]['id']
    def run(_):
        payload = {'model': model, 'prompt': 'Write an informative explanation of how rain forms, including evaporation, condensation and precipitation. Continue in complete sentences.',
                   'temperature': 0, 'seed': 123, 'max_tokens': 128, 'min_tokens': 128, 'ignore_eos': True}
        started = time.monotonic()
        out = request(8004, '/v1/completions', payload)
        elapsed = time.monotonic() - started
        assert out['usage']['completion_tokens'] == 128, out
        assert out['choices'][0]['text'].strip(), out
        return {'seconds': elapsed, 'tokens': 128, 'text': out['choices'][0]['text']}
    run(0)
    results = {}
    for concurrency in (1, 2):
        trials = []
        for _ in range(3):
            started = time.monotonic()
            with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
                samples = list(pool.map(run, range(concurrency)))
            trials.append({'wall_seconds': time.monotonic()-started, 'samples': samples})
        results[str(concurrency)] = {'median_seconds': statistics.median(t['wall_seconds'] for t in trials), 'trials': trials}
    smoke = request(8004, '/v1/chat/completions', {'model': model, 'messages': [{'role': 'user', 'content': 'What is 7 plus 5? Reply with just the number.'}], 'temperature': 0.4, 'seed': 42, 'max_tokens': 512, 'chat_template_kwargs': {'enable_thinking': False}})
    assert '12' in (smoke['choices'][0]['message'].get('content') or ''), smoke
    tool = request(8004, '/v1/chat/completions', {'model': model, 'messages': [{'role': 'user', 'content': 'Call get_weather for Paris.'}], 'tools': [{'type': 'function', 'function': {'name': 'get_weather', 'description': 'Get city weather', 'parameters': {'type': 'object', 'properties': {'city': {'type': 'string'}}, 'required': ['city']}}}], 'tool_choice': 'required', 'temperature': 0, 'max_tokens': 512, 'chat_template_kwargs': {'enable_thinking': False}})
    calls = tool['choices'][0]['message'].get('tool_calls')
    assert calls and calls[0]['function']['name'] == 'get_weather', tool
    assert json.loads(calls[0]['function']['arguments'])['city'].lower() == 'paris', tool
    results.update(smoke=smoke, tool=tool, memory=memory(), metadata=request(8004, '/v1/models'))
    return results


def main():
    STATE.mkdir(parents=True, exist_ok=True)
    if sys.argv[1] == 'baseline':
        current = inspect('reach-minicpm')
        gemma = inspect('reach-gemma')
        # Store inspection privately; environment can contain credentials.
        os.chmod(STATE, 0o700)
        (STATE / 'original.json').write_text(json.dumps(current))
        (STATE / 'gemma.json').write_text(json.dumps(gemma))
        result = bench()
        (STATE / 'baseline.json').write_text(json.dumps(result))
        print(json.dumps({k: result[k] for k in ('1', '2', 'memory', 'metadata')}))
        return
    if sys.argv[1] == 'watchdog':
        watchdog()
        return
    if sys.argv[1] == 'restore':
        restore()
        return
    original = json.loads((STATE / 'original.json').read_text())
    gemma = json.loads((STATE / 'gemma.json').read_text())
    assert inspect('reach-minicpm')['Id'] == original['Id']
    command = original['Config']['Cmd'][:]
    for flag, value in (('--max-model-len', '39904'), ('--tensor-parallel-size', '2'), ('--distributed-executor-backend', 'mp')):
        if flag in command:
            command[command.index(flag)+1] = value
        else:
            command += [flag, value]
    if '--disable-custom-all-reduce' not in command:
        command += ['--disable-custom-all-reduce']
    env = dict(v.split('=', 1) for v in original['Config']['Env'])
    gemma_env = dict(v.split('=', 1) for v in gemma['Config']['Env'])
    env['ROCR_VISIBLE_DEVICES'] = '0,1'
    for key in ('NCCL_PROTO', 'NCCL_SET_STACK_SIZE', 'NCCL_P2P_DISABLE', 'NCCL_IB_DISABLE', 'NCCL_MAX_NCHANNELS', 'HSA_NO_SCRATCH_RECLAIM', 'HSA_ENABLE_SDMA'):
        env[key] = gemma_env[key]
    binds = original['HostConfig']['Binds'][:]
    checksums = {}
    for bind in gemma['HostConfig']['Binds']:
        if 'librccl.so' in bind or 'libhsa-runtime' in bind:
            path = Path(bind.split(':')[0])
            checksums[str(path)] = hashlib.sha256(path.read_bytes()).hexdigest()
            if bind not in binds:
                binds.append(bind)
    (STATE / 'runtime-checksums.json').write_text(json.dumps(checksums))
    args = ['run', '-d', '--init', '--name', 'reach-minicpm', '--pull=never', '--restart=unless-stopped', '--device=/dev/kfd', '--device=/dev/dri', '--group-add=video', '--shm-size=2g', '-p', '127.0.0.1:8004:8000', '--log-opt', 'max-size=20m', '--log-opt', 'max-file=3']
    for key, value in (original['Config'].get('Labels') or {}).items():
        args += ['--label', key+'='+value]
    for key, value in env.items():
        args += ['-e', key+'='+value]
    for bind in binds:
        args += ['-v', bind]
    (STATE / 'armed').touch()
    with (STATE / 'watchdog.log').open('w') as output:
        subprocess.Popen([sys.executable, __file__, 'watchdog'], stdout=output, stderr=output, start_new_session=True)
    changed = False
    try:
        docker('stop', '-t', '15', 'reach-minicpm')
        docker('rename', 'reach-minicpm', ROLLBACK)
        changed = True
        docker('update', '--restart=no', ROLLBACK)
        docker(*args, original['Image'], *command)
        deadline = time.monotonic() + 540
        while time.monotonic() < deadline:
            state = inspect('reach-minicpm')['State']
            if not state['Running'] or state.get('Restarting'):
                raise RuntimeError('TP2 exited or restarted')
            try:
                request(8004, '/health', timeout=3)
                break
            except (OSError, ValueError):
                time.sleep(3)
        else:
            raise TimeoutError('TP2 startup exceeded nine minutes')
        result = bench()
        (STATE / 'tp2.json').write_text(json.dumps(result))
        baseline = json.loads((STATE / 'baseline.json').read_text())
        ratios = {c: result[c]['median_seconds']/baseline[c]['median_seconds'] for c in ('1', '2')}
        assert all(r <= 1.10 for r in ratios.values()), f'Material latency regression: {ratios}'
        assert inspect('reach-gemma')['Id'] == gemma['Id']
        assert inspect('reach-gemma')['State']['StartedAt'] == gemma['State']['StartedAt']
        (STATE / 'armed').unlink(missing_ok=True)
        print(json.dumps({'kept_tp2': True, 'latency_ratios': ratios, 'memory': memory()}), flush=True)
    except BaseException:
        if changed:
            restore()
        else:
            docker('start', 'reach-minicpm', check=False)
        (STATE / 'armed').unlink(missing_ok=True)
        print('RESTORED_TP1', flush=True)
        raise


if __name__ == '__main__':
    main()
