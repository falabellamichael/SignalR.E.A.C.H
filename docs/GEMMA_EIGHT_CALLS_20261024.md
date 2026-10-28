# Eight-request ROCm decode optimization

Deployed on the existing `reach-gemma` vLLM 0.31.0 TP2 service, with the same
Gemma W4A16 group-32 weights, BF16 activations/cache, 131072 context, eight
sequences, and existing user endpoint. This is an actual decode-kernel launch
optimization, not an HTTP gateway benchmark or a port of Locals' Metal code.

## Matched end-to-end measurement

`docker/gpu/benchmark_eight.py` sends eight concurrent requests, each with a
distinct short prompt, temperature zero, thinking disabled, and exactly 256
generated tokens (`min_tokens=256`, `ignore_eos=true`). Same script, server,
weights and request path before/after. First wave is warm-up; three subsequent
waves measure cached short-prompt generation, 2048 output tokens per wave.

| Wave | Original wall seconds | Tuned wall seconds | Original aggregate tokens/s | Tuned aggregate tokens/s |
| --- | ---: | ---: | ---: | ---: |
| 1 | 8.797 | 5.479 | 232.81 | 373.82 |
| 2 | 8.801 | 5.492 | 232.71 | 372.93 |
| 3 | 8.821 | 5.486 | 232.18 | 373.34 |

Mean wall time: 8.806 -> 5.485 seconds, approximately **37.7% less time**.
Aggregate throughput: approximately 232.6 -> 373.4 tokens/s, **1.61x**.
No claim is made for eight separate cold long histories or every workload.
The GPU test process shares a live server; this was not an isolated randomized
ABBA experiment. Kernel microbenchmark timings varied substantially, so the
end-to-end repetitions above are the performance evidence.

## Implementation

The existing RDNA W4A16 implementation sends M>5 to a Triton dequantizing GEMM.
For group-32, its 16x16x32 decode tile launched four warps. At six to eight rows,
one warp avoids idle execution lanes. `docker/gpu/patch_w4_batch.py` selects
`BLOCK_M=16, BLOCK_N=16, BLOCK_K=32, num_warps=1` only for gfx12, group size 32,
and M=6..8. Single-request/other group sizes and prefill dispatch are unchanged.
The kernel math, quantization, weights, sequence limit and output lengths do
not change. Numerical outputs were compared against the original GPU kernel
with BF16 tolerance during the tile sweep.

The patched file is in the active container:
`/usr/local/lib/python3.12/dist-packages/vllm/model_executor/kernels/linear/mixed_precision/rdna_hybrid_w4a16.py`.
Its original is retained as `rdna_hybrid_w4a16.py.before-eight`.
The active container retains modifications across restarts; a snapshot image
`signalreach-gemma:w4-eight-tuned-20261024` was saved, digest
`sha256:7c92a9941f0212d7ba87f8d4920acc8500d20913e76d585224954b22c193582a`.
Recreating from the old base image requires reapplying the patch before startup.
The general FP8 launcher must not recreate the active W4 profile.

After deployment, the existing Windows port 18001 passed JSON-schema output,
regex output, SSE, tool-call/result continuation and concurrent requests.
Support's container was not restarted. Gemma was restarted to load the kernel
and recapture its decode graphs.

## Follow-up: smaller batches

Extended the same group-32 single-wave Triton configuration from M=6..8 to
M=1..8. The HIP skinny dispatch remains unchanged: this affects only projections
that already fall back to Triton (notably K=7680 with five rows exceeds the
32768-element LDS limit). Patch: `docker/gpu/patch_w4_small_batch.py`.

Matched 256-token requests, three warmed waves, before/after this extension:

| Concurrent requests | Before mean wall seconds | After mean wall seconds | Throughput change |
| --- | ---: | ---: | ---: |
| 4 | 4.106 | 4.071 | ~0.8%, essentially unchanged |
| 5 | 5.507 | 4.607 | ~19.5% higher (232 -> 278 tokens/s) |
| 8 | 5.485 | 5.535 | ~0.9% lower (373 -> 370 tokens/s) |

Eight-request results retain the earlier large improvement over the original
8.806-second baseline. These sequential live-server measurements do not establish
sub-percent effects or performance for longer histories. Shape-specific tile
sweeps did not establish a robust further gain; their experimental tile choices
were not deployed. One timed-out sweep process was explicitly terminated.

`verify_w4_decode.py` passed 36 numerical comparisons: six Gemma projection
shapes at batch sizes 1,2,4,5,6,8, against independently dequantized FP32 matrix
multiplication (BF16 tolerance atol=rtol=0.025). Live JSON schema, regex, SSE,
tool-call continuation and concurrent request probes also passed.

Active container saved without pausing into
`signalreach-gemma:w4-small-batch-tuned-20261024`, digest
`sha256:57f7c4045bc27054222fa6c0490679dee23c0a65792da63346e0d56ccaf46450`.
Prior eight-request kernel retained as `rdna_hybrid_w4a16.py.before-small-batch`.
Apply the original eight-call patch then the small-batch patch on recreation
from the original image, or use the saved image with the qualified W4 container
configuration. The general FP8 launcher remains unsuitable for W4 recreation.
