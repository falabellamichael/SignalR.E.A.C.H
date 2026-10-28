"""Compare deployed decode GEMM with independently dequantized FP32 math."""
import torch
from vllm.model_executor.kernels.linear.mixed_precision import rdna_hybrid_w4a16 as kernel

torch.manual_seed(71)
for K, N in [(3840, 4096), (3840, 5120), (3840, 15360), (7680, 3840), (2048, 3840), (4096, 3840)]:
    weights = torch.randint(0, 16, (N, K), device='cuda', dtype=torch.int32)
    packed = kernel.pack_int4_exllama_shuffle(weights)
    scales = torch.rand((N, K // 32), device='cuda', dtype=torch.bfloat16) * 0.01
    dequantized = (weights.float() - 8) * scales.float().repeat_interleave(32, dim=1)
    for M in [1, 2, 4, 5, 6, 8]:
        a = torch.randn((M, K), device='cuda', dtype=torch.bfloat16)
        result = kernel.triton_w4a16_skinny_fmt_gemm(a, packed, scales, 32)
        torch.testing.assert_close(result.float(), a.float() @ dequantized.T, atol=0.025, rtol=0.025)
    print(f'PASS K={K} N={N} batches=1,2,4,5,6,8', flush=True)
