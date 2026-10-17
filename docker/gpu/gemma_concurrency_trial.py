"""Preserve the current Gemma container and trial a valid prefill budget."""
import copy
import json
import time
import urllib.request
from trial_container import api


def main():
    name = 'reach-gemma'
    backup = name + '-before-prefill3072-' + str(time.time_ns())
    details = api('GET', f'/containers/{name}/json')
    if details['Config'].get('Labels', {}).get('io.signalreach.deployment') != 'signalreach-nextify-20261015':
        raise RuntimeError('Unexpected container ownership')
    # A healthy server may be serving users; refuse to replace it without an idle check.
    try:
        with urllib.request.urlopen('http://127.0.0.1:8001/metrics', timeout=5) as r:
            for line in r.read().decode().splitlines():
                if line.startswith(('vllm:num_requests_running{', 'vllm:num_requests_waiting{')) and float(line.split()[-1]):
                    raise RuntimeError('Active requests; refusing trial')
    except OSError:
        if details['RestartCount'] < 1:
            raise RuntimeError('Server unavailable without confirmed restart loop')
    config = copy.deepcopy(details['Config'])
    command = config['Cmd']
    command[command.index('--max-num-batched-tokens') + 1] = '3072'
    config['HostConfig'] = copy.deepcopy(details['HostConfig'])
    config['HostConfig']['RestartPolicy'] = {'Name': 'no', 'MaximumRetryCount': 0}
    api('POST', f'/containers/{name}/update', {'RestartPolicy': {'Name': 'no'}})
    api('POST', f'/containers/{name}/stop?t=60')
    api('POST', f'/containers/{name}/rename?name={backup}')
    try:
        api('POST', f'/containers/create?name={name}', config)
        api('POST', f'/containers/{name}/start')
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            if not api('GET', f'/containers/{name}/json')['State']['Running']:
                raise RuntimeError('Trial exited; inspect retained failed container')
            try:
                with urllib.request.urlopen('http://127.0.0.1:8001/health', timeout=3) as r:
                    if r.status == 200:
                        api('POST', f'/containers/{name}/update', {'RestartPolicy': {'Name': 'unless-stopped'}})
                        print(json.dumps({'ready': name, 'backup': backup, 'prefill': 3072}), flush=True)
                        return
            except OSError:
                pass
            time.sleep(3)
        raise TimeoutError('Trial startup timed out')
    except BaseException:
        api('POST', f'/containers/{name}/stop?t=30')
        api('POST', f'/containers/{name}/rename?name={backup}-failed')
        api('POST', f'/containers/{backup}/rename?name={name}')
        # Preserve a failing original without re-enabling its restart loop.
        if details['RestartCount'] == 0:
            api('POST', f'/containers/{name}/update', {'RestartPolicy': details['HostConfig']['RestartPolicy']})
            api('POST', f'/containers/{name}/start')
        raise


if __name__ == '__main__':
    main()
