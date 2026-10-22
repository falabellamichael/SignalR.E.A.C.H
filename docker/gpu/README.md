# Optional GPU deployment profile

The selected profile enables Gemma 4 12B QAT Q8 and the shared embedding,
reranking, and decision service on the operator's two Radeon AI PRO R9700 GPUs
(gfx1201). Gemma uses the pinned llama.cpp ROCm image; support retains its
existing runtime. This deployment is separate from the desktop installer.
It does not download models or contain credentials or public endpoint addresses.

| Service | GPU | Runtime allocation | Context tokens per chat |
| --- | --- | --- | --- |
| Gemma 4 12B QAT Q8 | 0 | Q8 weights and KV cache, two slots | 262,144 |
| MiniCPM5 2B (disabled) | Saved 0 + 1, TP2 | Saved 0.24 | Saved 39,904 |
| BGE M3, BGE Reranker v2 M3, Liquid d1 Omni 600M, Liquid d1 3B | 1 | Existing support allocation | Native service limits |

Ornith and MiniCPM are disabled at the operator's request. Their saved
configurations, weights, and containers are retained. Default startup excludes
them, stops leftover `reach-ornith` and `reach-minicpm` containers, and clears
their restart policies so Docker does not load them again. `--only ornith` and
`--only minicpm` refuse without inspecting, starting, or recreating a container.
The host's saved MiniCPM model entry is retained with `enabled: false`.
The saved Ornith context remains 61,776 tokens. Re-enabling it requires an
explicit profile change and GPU memory review; this launcher does not do so.

## Selected Q8 profile

Set `gemma_runtime` to `llama.cpp-q8` in the operator-owned `models.json` and
provision `gemma_q8_profile.json` and `gemma_q8_profile.py` beside the launcher.
The profile pins the image digest and target, MTP assistant, and vision projector
revisions and checksums. It uses the image's bundled ROCm 7.2.1 runtime, full GPU
offload on GPU 0, three speculative tokens, flash attention, and Q8 KV caches.
The total 524,288-token allocation provides two 262,144-token chat slots. Input,
reasoning, and output share each slot's window. The host-memory/swap guard is
16 GiB with OOM score adjustment 500; it does not configure CPU model offload.

The existing API model alias is retained for client compatibility, including its
historical `q4_0-unquantized` suffix. Actual weights are Q8_0. Native Jinja tool
parsing and the matching vision projector remain enabled. The host measures
full chat inputs, tools, and media with llama.cpp's chat input-token endpoint
and reads the live per-slot limit from `/props`; see
[`HOST_CONTEXT_COMPRESSION.md`](../../docs/HOST_CONTEXT_COMPRESSION.md).

Raycast's saved Gemma model must set `abilities.tools.supported: true` and
`context: 262144` in `providers.yaml`. Native server tool support does not
override a client entry that advertises tools as unsupported. After a provider
reload, use a fresh chat and verify an automatic structured call plus its tool
result; a forced diagnostic call alone does not establish the client workflow.

The pinned template cannot render array-item `type` lists because its Jinja
runtime lacks filter-mapping. The relay and Subscription gateway translate
those lists to equivalent `anyOf` constraints only on Gemma routes. Existing
constraints, nullability, tool names, argument values, and caller history remain
intact. This compatibility translation runs before native prompt token counting.

The launcher refuses a mismatched existing `reach-gemma` container without
replacing it. A service switch requires an idle check and retention of the
previous container for rollback. Validate native context/precision/vision,
structured tool calls with a tool-result continuation, and long-context recall
before treating the deployment as complete. Preserve support's container
identity/start time and Mini's disabled state.

The saved trial showed a tradeoff: short single-request end-to-end throughput
was about 81 versus 110 tokens/second, while the longer reference workload was
about 48 versus 36 tokens/second. These are workload-specific measurements, not
a general decode-speed guarantee. The operator selected Q8 for the larger
context window. A full-window recall result is not established by allocation.

## Retained vLLM profiles

The following settings document the preserved FP8 Gemma rollback and disabled
MiniCPM profiles. They apply when the Q8 selector is absent, and do not describe
the selected Q8 runtime. Support keeps its existing vLLM-related runtime files.

MiniCPM's pinned vLLM parser needs `patch_minicpm_tool_parser.py` applied to
`minicpm5xml_tool_parser.py` inside its container, including after recreation.
Raycast requires `__raycast_tool_call_description` as display metadata; MiniCPM
can omit it even when the actual tool inputs are valid. The patch supplies a
label from the declared function name, preserves supplied labels, and still
rejects missing required tool inputs. Without it, the parser can emit partial
JSON followed by raw XML. Run `tests/test_minicpm_tool_parser.py` inside the
container before restarting only MiniCPM. This deployment is text-only; clients
must advertise MiniCPM vision support as disabled.

Gemma uses FP8 language weights and BF16 vision/activations, native MTP with
three speculative tokens, Model Runner V2, and its native `gemma4` reasoning
parser with thinking enabled. Automatic tool choice uses the `gemma4` tool-call
parser and the tool-use chat template bundled in the pinned image at
`/app/vllm/examples/tool_chat_template_gemma4.jinja`. The request-based GPU
gateway forwards function definitions, tool choices, assistant calls, and tool
results; the calling client executes the functions. Existing containers without
these parser/template settings are preserved and refused rather than silently
adopted. The local relay also preserves Gemma's native tool fields and enables
its model-level `allow_tools` default; a saved explicit setting still takes
precedence. Its eight active sequences have target verification
graphs at 4, 8, 12, 16, 20, 24, 28, and 32 tokens, plus assistant decode graphs
at every size from 1 through 8. Both passes use the same capture list; target-only
sizes can leave the assistant running eagerly or padding small requests.
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

Gemma's prompt scheduling step is 3,072 tokens, so a long prefill yields to a
decode that is already running. Its 65,536-token context, TP2 placement, MTP
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
and 65,536-token context are unchanged. MiniCPM remains TP1 and does not
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

## Legacy vLLM concurrency trials

Gemma admits eight active sequences. Its context cache is shared between them;
eight calls at the full 65,536-token context are not guaranteed to fit at once.
The native startup log reports actual KV capacity for the available memory.
Raising only the sequence limit can leave larger batches without decode graph coverage. On the GPU
host, `python3 trial_container.py minicpm --sequences 4` automatically creates
graph sizes 1 through 4; the corresponding Gemma trial creates sizes 1, 2, 3, 4,
8, 12, and 16 to cover both target verification and subsequent assistant decode.
Explicit `--capture` values
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
