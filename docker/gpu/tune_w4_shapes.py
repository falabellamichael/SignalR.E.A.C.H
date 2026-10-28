"""Paired graph benchmarks for small-batch group-32 Gemma projections."""
import json
import random
import statistics
from pathlib import Path

import torch
import triton
from vllm.model_executor.kernels.linear.mixed_precision import rdna_hybrid_w4a16 as kernel

torch.manual_seed(42)
random.seed(42)
results = []
for K, N in [(3840, 4096), (3840, 5120), (3840, 15360), (7680, 3840), (2048, 3840), (4096, 3840)]:
    M, G = 8, 32
    a = torch.randn((M, K), device="cuda", dtype=torch.bfloat16)
    weights = torch.randint(0, 16, (N, K), device="cuda", dtype=torch.int32)
    packed = kernel.pack_int4_exllama_shuffle(weights)
    scales = torch.rand((N, K // G), device="cuda", dtype=torch.bfloat16) * 0.01
    reference = a.float() @ ((weights.float() - 8) * scales.float().repeat_interleave(G, dim=1)).T
    functions = {}
    for bn in [16, 32, 64, 128]:
        for warps in [1, 2, 4, 8]:
            output = torch.empty((M, N), device="cuda", dtype=a.dtype)
            def run(bn=bn, warps=warps, output=output):
                kernel._triton_w4a16_skinny_fmt_kernel[(1, triton.cdiv(N, bn))](
                    a, packed, scales, scales, output, M, N, K, K // 8, K // G, G,
                    ZP_BIAS=8, HAS_ZP=False, BLOCK_M=16, BLOCK_N=bn, BLOCK_K=32,
                    num_warps=warps)
            run()
            torch.testing.assert_close(output.float(), reference, atol=0.025, rtol=0.025)
            functions[(bn, warps)] = run
    samples = {config: [] for config in functions}
    for repeat in range(5):
        order = list(functions)
        random.shuffle(order)
        for config in order:
            samples[config].append(triton.testing.do_bench_cudagraph(functions[config], rep=100))
    medians = {config: statistics.median(times) for config, times in samples.items()}
    best = min(medians, key=medians.get)
    result = {"K": K, "N": N, "baseline_ms": medians[(16, 1)], "best_ms": medians[best],
              "config": list(best), "samples": {str(k): v for k, v in samples.items()}}
    results.append(result)
    print(json.dumps(result), flush=True)
Path('/tmp/w4-shape-results.json').write_text(json.dumps(results, indent=2))
