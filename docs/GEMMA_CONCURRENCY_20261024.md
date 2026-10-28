# Gemma FP8 concurrency measurements, 2026-10-24

## Configuration and method

Live Gemma 4 12B FP8 weights, BF16 KV cache, TRITON_ATTN, two R9700 GPUs
with TP2, 131072 context, eight sequences, 3072 batched tokens, 0.55 GPU
memory allocation per device, and three MTP draft tokens. Thinking disabled
explicitly in requests. No serving settings changed during this matrix.

Native streaming endpoint tested directly, bypassing the relay and Raycast.
Concurrency 1/2/4/8; temperature zero; 128 maximum output tokens. Short tests
used three rounds with refill (24/24/24/48 total requests). Cold long tests
used two waves at each concurrency; shared-prefix tests used three waves.
Inputs were synthetic inventory records, approximately 14K and 44K tokens.
Client-side HTTP reads timed out after 300 seconds. Metrics sampled each second.
270 measured requests: 265 successful, five read timeouts. This is a latency
and throughput test, not a task-quality evaluation or a full 128K load test.

## Aggregate output throughput

Tokens/second includes request processing time, not just decode. Cached steady
results exclude the first measured wave: the preliminary short warmup did not
fully eliminate that wave's prefill. Steady wall time is approximated by the
maximum request duration in each simultaneous wave; other rows use measured
whole-round wall times.

| Workload | 1 concurrent | 2 | 4 | 8 |
| --- | ---: | ---: | ---: | ---: |
| Short, refill | 85.7 | 153.7 | 282.6 | 494.0 |
| 14K fresh | 10.2 | 20.1 | 24.1 | 26.9 |
| 14K shared prefix, steady | 27.9 | 50.9 | 95.1 | 174.6 |
| 44K fresh | 2.0 | 3.6 | 4.0 | 2.2 (5/16 failed) |
| 44K shared prefix, steady | 11.3 | 22.6 | 41.7 | 78.5 |

## Latency and scheduling

Fresh 44K p95 time to first token: 58.4 / 60.2 / 119.6 / 298.9 seconds.
At eight concurrency, that last statistic includes only successful requests;
five requests timed out and it must not be interpreted as acceptable service.
Small sample p95 statistics here are effectively maxima, not population estimates.

Steady shared-prefix median first-token latency:

| Input | 1 concurrent | 2 | 4 | 8 |
| --- | ---: | ---: | ---: | ---: |
| 14K | 0.457 s | 0.505 s | 0.674 s | 0.844 s |
| 44K | 0.707 s | 0.934 s | 1.420 s | 1.947 s |

At eight concurrent steady shared-prefix requests, approximate per-request
decode was 27.8 tokens/s at 14K and 11.8 tokens/s at 44K. SSE chunks may contain
multiple speculative tokens, so these decode rates are approximations.

Eight active sequences were observed for short and shared-prefix workloads.
Fresh 44K at eight concurrency reached five active requests and seven waiting
at different samples. Peak cache usage was 55.3%; no preemptions occurred in
that failing group. The shared 44K group peaked at 25.9% cache usage.
These observations support a prompt-processing/scheduling bottleneck rather
than an exhausted KV cache. They do not isolate compute, bandwidth, and TP
communication costs or rule out client/host overhead.

## Recommendations

1. Preserve stable tool/schema/reference prefixes and avoid volatile leading
   timestamps. Shared-prefix results do not represent unrelated user histories.
2. Benchmark larger prefill scheduling budgets (6144 and 8192) separately,
   including overlapping short requests to measure fairness. Do not assume
   larger budgets improve every workload.
3. Consider limiting simultaneous *fresh long* prefills while retaining eight
   decode slots. Measure admission latency and avoid hiding queues in clients.
4. Do not raise the GPU memory allocation based on this test alone: no cache
   exhaustion was demonstrated. Support also occupies GPU memory.
5. Follow with longer outputs, distinct cached histories, mixed prompt sizes,
   and near-128K requests before claiming production multi-user capacity.

## Evidence

Local raw per-request results and sampled native metrics:
`C:/Users/Falab/AppData/Local/Temp/opencode/gemma-concurrency-matrix.jsonl`.
Runner: `C:/Users/Falab/AppData/Local/Temp/opencode/concurrency_matrix.py`.
Progress logs: `concurrency-matrix.log` and `concurrency-cached.log` in that
directory. The cached-only continuation followed the deliberate stop on cold
request failures. No server restart or configuration change was required.
