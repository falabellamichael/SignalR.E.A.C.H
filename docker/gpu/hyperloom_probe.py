"""Read-only serving benchmark emitting Hyperloom's custom report contract."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import time
import urllib.request

from benchmark_concurrency import request, summarize


def run(base, concurrency, lines):
    with urllib.request.urlopen(base + '/v1/models', timeout=10) as response:
        model = json.load(response)['data'][0]['id']
    question = {'model': model, 'messages': [{'role': 'user', 'content':
                'Return only the result of 17 multiplied by 19.'}],
                'temperature': 0, 'max_tokens': 64,
                'chat_template_kwargs': {'enable_thinking': False}}
    req = urllib.request.Request(base + '/v1/chat/completions',
        data=json.dumps(question).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=120) as response:
        answer = json.load(response)['choices'][0]['message'].get('content') or ''
    passed = answer.strip() == '323'
    prefix = f'Benchmark {time.time_ns()}.\n' + '\n'.join(
        f'Record {i}: twelve blue containers and seven green containers.' for i in range(lines))
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        samples = list(pool.map(lambda i: request(base, model,
            prefix + f'\nTask {i}: Explain inventory reconciliation in detail.',
            128, thinking=False), range(concurrency)))
    summary = summarize(samples, time.monotonic() - started)
    return {'framework': 'custom', 'workload_kind': 'scriptable',
            'throughput_unit': 'tokens/s', 'output_throughput': summary['aggregate_tokens_s'],
            'quality_gate': {'passed': passed and summary['errors'] == 0,
                             'scope': 'arithmetic smoke and stream completion only'},
            'model': model, 'concurrency': concurrency, 'reference_lines': lines,
            'summary': summary, 'samples': samples}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', default='http://127.0.0.1:18001')
    parser.add_argument('--concurrency', type=int, default=2)
    parser.add_argument('--lines', type=int, default=0)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.concurrency < 1 or args.lines < 0:
        parser.error('concurrency must be positive and lines nonnegative')
    result = run(args.base.rstrip('/'), args.concurrency, args.lines)
    args.output.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({k: v for k, v in result.items() if k != 'samples'}))
    raise SystemExit(0 if result['quality_gate']['passed'] else 1)
