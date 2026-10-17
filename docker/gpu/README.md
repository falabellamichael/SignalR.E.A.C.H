# Optional GPU deployment profile

The launcher enables Gemma 4 12B QAT, MiniCPM5 2B, and the shared embedding,
reranking, and decision service on the operator's two Radeon AI PRO R9700 GPUs
(gfx1201), ROCm 7.2.3, and vLLM 0.31.0. It is separate from the desktop installer.
It does not download models or contain credentials or public endpoint addresses.

| Service | GPU | vLLM memory fraction | Context tokens |
| --- | --- | --- | --- |
| Gemma 4 12B QAT | 0 + 1, TP2 | 0.40 per GPU | 92,960 |
| MiniCPM5 2B | 1, TP1 | 0.24 | 39,904 |
| BGE M3, BGE Reranker v2 M3, Liquid d1 Omni 600M, Liquid d1 3B | 1 | Existing support allocation | Native service limits |

Ornith is disabled at the operator's request. Its saved configuration, weights,
and rollback containers are retained. Default startup excludes it, stops a
leftover `reach-ornith` container, and clears that container's restart policy
so Docker does not load it again. `--only ornith` refuses without inspecting,
starting, or recreating its container.
The saved Ornith context remains 61,776 tokens. Re-enabling it requires an
explicit profile change and GPU memory review; this launcher does not do so.

Gemma uses FP8 language weights and BF16 vision/activations, native MTP with
three speculative tokens, Model Runner V2, and its native `gemma4` reasoning
parser with thinking enabled. Decode graph capture sizes remain 4 and 8.
`OMP_NUM_THREADS=1` remains unchanged. MiniCPM retains FP8 weights, BF16
activations, its Qwen3 reasoning parser, existing runner/graphs, and
`OMP_NUM_THREADS=2`. Support remains unchanged on GPU 1. All models and KV
caches stay on GPU; the launcher does not configure CPU offload.

Every new chat container pins its numeric context. Existing numeric settings
must match exactly. MiniCPM's already-running `--max-model-len auto` profile
is adoptable only when native `/v1/models` reports exactly one matching
repository with integer `max_model_len: 39904`. Missing or different metadata
causes refusal while preserving the container. No context is silently reduced.
Input and output share that window; output is automatic unless the client or
operator supplies a positive cap. Transport guards are separate from context.

Gemma's prompt scheduling step is 1,024 tokens, so a long prefill yields to a
decode that is already running. Its 92,960-token context, TP2 placement, MTP
speculative decoding, and GPU execution settings are unchanged. A running
container with a different step is preserved and not rewritten; replace it only
after an overlapping-request check. MiniCPM's step remains 2,048 tokens.

The Gemma host-memory/swap guard remains 12 GiB with OOM score adjustment 500,
independently of tensor parallelism. The retained disabled Ornith profile keeps
the same guard. These are host allocation guards, not CPU model offload.
`GPU_MAX_HW_QUEUES=1` remains set on all services. All published ports bind to
loopback. Existing ownership, placement, memory, precision, OpenMP, reasoning,
MTP, runtime, and graph checks remain enforced before adopting containers.

The deployment root is `/srv/signalreach`. Provision its `models.json`, approved
model directories, pinned vLLM image, and `signalreach-support:20261015` image
before running the launcher. Support's image and dependencies are provisioned
by the operator. The launcher does not recreate unrelated containers or remove
model assets. Retained services use `unless-stopped`; Docker must be enabled at
VM boot. An intentional stop remains stopped until the operator starts it.

The read-only HSA runtime is required for all enabled services. Gemma TP2
also requires the qualified RCCL override:

| File under the deployment root | SHA256 |
| --- | --- |
| `runtime/rocr-7.2.3-poll-backoff/libhsa-runtime64.so.1` | `c0770ac794014146886990b0998e538fdc66c25ab61bdc24e2be7154f3ecf521` |
| `runtime/rccl-gfx1201-7.2.3/librccl.so.1` | `84cfccf7be387384b344bc497748e6fa4597a8b48e5f142683b000ee01a6316b` |

Gemma TP2 retains its qualified RCCL Simple protocol and distributed runtime
mounts. Its MTP, reasoning, graph configuration, OpenMP setting, precision,
and 92,960-token context are unchanged. MiniCPM remains TP1 and does not
require RCCL; inherited validated RCCL settings are tolerated and retained.
The launcher does not build or substitute runtime libraries; their ABI must
match the pinned image. Gemma's matching MTP assistant must already be present
under `models/gemma4-12b-qat-assistant` with its qualified revision.

The relay uses fixed operator-owned loopback forwards on ports 18001, 18004,
and 18030 for enabled services. GPU chat, embeddings, reranking, and decisions
retain their separate native operations and API access controls. BGE M3 returns
1,024 float dimensions. Embedding/rerank batching preserves every text and
performs a global rerank before applying `top_n`; native service context limits
remain unchanged. CodeGPT and signed-in browser models remain in the separate
local Login Providers catalog in REACH Studio and the REACH VS Code extension.

This source profile does not assert a throughput figure. Compare sustained
output and concurrent requests after native startup and readiness checks.

## Sustained concurrency trials

The qualified profiles currently admit two active sequences each. Raising only
that limit can leave larger batches without decode graph coverage. On the GPU
host, `python3 trial_container.py minicpm --sequences 4` automatically creates
graph sizes 1 through 4; the corresponding Gemma trial creates sizes 4, 8, 12,
and 16 to account for its three MTP draft tokens. Explicit `--capture` values
override that calculation. Trial settings are experimental until measured;
additional graph captures and active sequences consume GPU memory.

Record a baseline, trial one model at a time, and repeat the same load:

```sh
python3 benchmark_concurrency.py --rounds 3 --concurrency 1 2 4 --requests 24 --tokens 512
python3 benchmark_concurrency.py --rounds 3 --concurrency 2 4 --requests 24 --tokens 256 --prompt-lines 512 --stagger 0.5
```

Defaults use the relay forwards. When running directly on the GPU host, pass
`--gemma http://127.0.0.1:8001 --minicpm http://127.0.0.1:8004`.
The benchmark warms each model, refills completed request slots, and reports
errors, p95 time to first token, p95 total latency, aggregate output throughput,
and per-request stream gaps. Mixed-model runs share the total concurrency across
both models. Stream chunks can contain multiple speculative tokens, so chunk
gaps are not per-token latency and decode token rates are approximate.

Use `python3 trial_container.py minicpm --rollback` (or `gemma`) to restore the
saved profile before another trial. Promote sequence, graph, and prefill settings
to the launcher only after native readiness, sustained/mixed load, and long-context
checks pass. Existing containers must match the qualified sequence limit as well
as graph and prefill settings before the launcher adopts them.
