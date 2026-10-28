"""Compare native BF16 D1 decisions with FP8 linear inference on the live GPU."""
import json
import sys
import time
import torch
from transformers import AutoModel
sys.path.insert(0, '/app')
from support_fp8 import quantize_linears, storage_report

torch.set_num_threads(2)
model = AutoModel.from_pretrained('/models/d1-3b', local_files_only=True,
                                trust_remote_code=True, dtype=torch.bfloat16).eval().to('cuda:0')
fixtures = [
    ('Paris is the capital of France.', {'france': {'type': 'noul', 'instructions': 'Is this about France?'}}),
    ('Please refund the duplicate payment on my order.', {'intent': {'type': 'choice', 'instructions': 'Classify the request.',
      'criteria': {'refund': 'Customer requests a refund', 'shipping': 'Customer asks about delivery', 'other': 'Neither'}}}),
    ('The customer says thank you, everything works perfectly.', {'urgent': {'type': 'noul', 'instructions': 'Does the customer report an urgent problem?'}}),
]
with torch.inference_mode():
    before = [model.system_one(*fixture) for fixture in fixtures]
    # Keep the tied output head in BF16; the decision engine indexes its weight.
    count = quantize_linears(model.model)
    torch.cuda.empty_cache()
    started = time.monotonic()
    after = [model.system_one(*fixture) for fixture in fixtures]
    for a, b in zip(before, after):
        for name, value in a['answers'].items():
            result = b['answers'][name]
            if value['type'] == 'choice':
                assert value['choice'] == result['choice'], (a, b)
            else:
                assert abs(value['noul'] - result['noul']) < 0.1, (a, b)
    print(json.dumps({'linears': count, 'storage': storage_report(model), 'seconds': time.monotonic()-started,
                      'before': before, 'after': after}), flush=True)
