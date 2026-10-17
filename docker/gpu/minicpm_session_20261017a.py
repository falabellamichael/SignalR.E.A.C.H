"""Isolated MiniCPM trials; retain every container and measurement."""
import argparse
import copy
import json
import pathlib
import subprocess
import time
import urllib.request
from trial_container import api

NAME = 'reach-minicpm'
PORT = 8004
ROOT = pathlib.Path('/tmp/reach-opt-20261017a')


def idle():
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/metrics', timeout=10) as r:
        for line in r.read().decode().splitlines():
            if line.startswith(('vllm:num_requests_running{', 'vllm:num_requests_waiting{')) and float(line.split()[-1]):
                raise RuntimeError('Active requests')


def ready():
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        if not api('GET', f'/containers/{NAME}/json')['State']['Running']:
            raise RuntimeError('Container exited')
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/health', timeout=3) as r:
                if r.status == 200:
                    return
        except OSError:
            pass
        time.sleep(3)
    raise TimeoutError('Readiness timeout')


def switch(backup, target=None, config=None):
    idle()
    existing = {n for d in api('GET', '/containers/json?all=true') for n in d['Names']}
    if '/' + backup in existing:
        raise RuntimeError('Backup already exists')
    api('POST', f'/containers/{NAME}/stop?t=60')
    api('POST', f'/containers/{NAME}/rename?name={backup}')
    api('POST', f'/containers/{backup}/update', {'RestartPolicy': {'Name': 'no'}})
    try:
        if target:
            api('POST', f'/containers/{target}/rename?name={NAME}')
        else:
            api('POST', f'/containers/create?name={NAME}', config)
        api('POST', f'/containers/{NAME}/update', {'RestartPolicy': {'Name': 'unless-stopped'}})
        api('POST', f'/containers/{NAME}/start')
        ready()
        print('READY; retained:', backup, flush=True)
    except BaseException:
        existing = {n for d in api('GET', '/containers/json?all=true') for n in d['Names']}
        if '/' + NAME in existing:
            api('POST', f'/containers/{NAME}/stop?t=30')
            api('POST', f'/containers/{NAME}/rename?name={backup}-failed')
        api('POST', f'/containers/{backup}/rename?name={NAME}')
        api('POST', f'/containers/{NAME}/update', {'RestartPolicy': {'Name': 'unless-stopped'}})
        api('POST', f'/containers/{NAME}/start')
        ready()
        raise


def main():
    global NAME, PORT
    p = argparse.ArgumentParser()
    p.add_argument('action', choices=['trial', 'restore', 'bench'])
    p.add_argument('label')
    p.add_argument('--model', choices=['minicpm', 'gemma'], default='minicpm')
    p.add_argument('--speculative-tokens', type=int, choices=[1, 2, 3])
    p.add_argument('--env')
    p.add_argument('--unset')
    p.add_argument('--capture', nargs='+', type=int)
    p.add_argument('--sequences', type=int)
    p.add_argument('--target')
    p.add_argument('--rounds', type=int, default=2)
    p.add_argument('--requests', type=int, default=8)
    p.add_argument('--tokens', type=int, default=128)
    a = p.parse_args()
    NAME = 'reach-' + a.model
    PORT = 8001 if a.model == 'gemma' else 8004
    if a.speculative_tokens is not None and a.model != 'gemma':
        p.error('Speculative token trials require Gemma')
    if a.action == 'bench':
        out = ROOT / (a.label + '.jsonl')
        with out.open('x') as f:
            subprocess.run(['python3', str(ROOT / 'benchmark_concurrency.py'), '--gemma', 'http://127.0.0.1:8001', '--minicpm', 'http://127.0.0.1:8004', '--rounds', str(a.rounds), '--requests', str(a.requests), '--tokens', str(a.tokens), '--warmup', '1', '--concurrency', '1', '2', '4'], stdout=f, check=True)
        for line in out.read_text().splitlines():
            d = json.loads(line)
            print(json.dumps({k:d[k] for k in ['models', 'concurrency', 'successful_requests', 'errors', 'completion_tokens', 'aggregate_tokens_s', 'p95_ttft_s', 'p95_elapsed_s']}), flush=True)
        return
    backup = NAME + '-opt-20261017a-' + a.label
    if a.action == 'restore':
        switch(backup, target=a.target)
        return
    d = api('GET', f'/containers/{NAME}/json')
    if d['Config'].get('Labels', {}).get('io.signalreach.deployment') != 'signalreach-nextify-20261015':
        raise RuntimeError('Unexpected container ownership')
    config = copy.deepcopy(d['Config'])
    env = dict(x.split('=', 1) for x in config['Env'])
    if a.env:
        k, v = a.env.split('=', 1)
        env[k] = v
    if a.unset:
        env.pop(a.unset, None)
    config['Env'] = [k + '=' + v for k, v in env.items()]
    cmd = config['Cmd']
    if a.speculative_tokens is not None:
        i = cmd.index('--speculative-config') + 1
        speculation = json.loads(cmd[i])
        speculation['num_speculative_tokens'] = a.speculative_tokens
        cmd[i] = json.dumps(speculation)
        sequences = int(cmd[cmd.index('--max-num-seqs') + 1])
        width = 1 + a.speculative_tokens
        a.capture = [width * n for n in range(1, sequences + 1)]
    if a.capture:
        i = cmd.index('--compilation-config') + 1
        c = json.loads(cmd[i])
        c.update(cudagraph_capture_sizes=a.capture, max_cudagraph_capture_size=max(a.capture))
        cmd[i] = json.dumps(c)
    if a.sequences:
        cmd[cmd.index('--max-num-seqs') + 1] = str(a.sequences)
    config['HostConfig'] = d['HostConfig']
    switch(backup, config=config)


if __name__ == '__main__':
    main()
