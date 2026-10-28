import json
import torch
import triton
from vllm.model_executor.kernels.linear.mixed_precision import rdna_hybrid_w4a16 as kernel

torch.manual_seed(42)
results = []
for K, N in [(3840, 4096), (3840, 5120), (3840, 15360), (7680, 3840), (2048, 3840), (4096, 3840)]:
    M, G = 8, 32
    a = torch.randn((M, K), device="cuda", dtype=torch.bfloat16)
    w = torch.randint(0, 16, (N, K), device="cuda", dtype=torch.int32)
    b = kernel.pack_int4_exllama_shuffle(w)
    scales = torch.rand((N, K // G), device="cuda", dtype=torch.bfloat16) * 0.01
    ref = kernel.triton_w4a16_skinny_fmt_gemm(a, b, scales, G)
    baseline = triton.testing.do_bench_cudagraph(lambda: kernel.triton_w4a16_skinny_fmt_gemm(a, b, scales, G), rep=200)
    best = (baseline, None)
    for bn in [16, 32, 64, 128, 256]:
        for bk in [32]:
            for warps in [1, 2, 4, 8]:
                c = torch.empty_like(ref)
                def run():
                    kernel._triton_w4a16_skinny_fmt_kernel[(1, triton.cdiv(N, bn))](
                        a, b, scales, scales, c, M, N, K, K // 8, K // G, G,
                        ZP_BIAS=8, HAS_ZP=False, BLOCK_M=16, BLOCK_N=bn, BLOCK_K=bk,
                        num_warps=warps)
                try:
                    run()
                    torch.testing.assert_close(c, ref, atol=0.02, rtol=0.02)
                    ms = triton.testing.do_bench_cudagraph(run, rep=100)
                    if ms < best[0]:
                        best = (ms, [16, bn, bk, warps])
                except Exception as exc:
                    print(type(exc).__name__, K, N, bn, bk, warps, flush=True)
    result = {"K": K, "N": N, "baseline_ms": baseline, "best_ms": best[0], "config": best[1]}
    results.append(result)
    print(json.dumps(result), flush=True)
print(json.dumps(results), flush=True)
