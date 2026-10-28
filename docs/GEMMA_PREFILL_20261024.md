# Gemma prefill scheduling trial, 2026-10-24

## Decision

Retain `--max-num-batched-tokens 3072`. Trials at 6144 and 8192 provided no
throughput improvement and increased pauses in streamed output. All 36
measured requests succeeded. The original container was restored after trials.

## Method

Same FP8 Gemma weights, BF16 cache, Triton attention, TP2 on two R9700 GPUs,
128K context, eight sequences, three MTP draft tokens, 0.55 memory allocation.
Thinking disabled, temperature zero, output capped at 128 tokens. Each profile
received a short warmup followed by two four-request fresh ~44K-input waves
and two mixed tests: one fresh ~44K request, then a short request two seconds
later. Requests had distinct leading content to prevent prefix reuse.

Profiles tested sequentially (3072, 6144, 8192), not in randomized order.
Each trial preserved the original container, disabled automatic restarts, and
used a six-minute startup timeout. Support's identity/start time were checked
by the rollback script. Detailed timings are client streaming measurements.

| Prefill budget | Mean four-request wall time | Worst streamed chunk gap in cold waves | Short-request first-token delay, mixed tests |
| --- | ---: | ---: | --- |
| 3072 | 247.44 s | 7.07 s | 55.99 / 56.13 s |
| 6144 | 248.80 s | 13.39 s | 57.29 / 57.37 s |
| 8192 | 250.53 s | 17.62 s | 57.42 / 56.84 s |

Cold wall times differ from the earlier concurrency matrix, so the within-trial
control is used here. Repeated runs within each profile agree closely. This
does not establish the cause of the cross-run difference or exclude host/GPU
load effects. No claim of a statistically significant ~1% throughput difference
is made; the large streaming-gap increase is the clear regression.

Increasing the scheduler chunk size does not solve the short-request admission
delay. Future investigation should inspect partial-prefill scheduling and
multimodal restrictions, rather than raising this budget again without evidence.
The runtime logs report `disable_chunked_mm_input` forced for the multimodal
architecture; whether that explains text-only behavior remains unverified.

Raw samples: `C:/Users/Falab/AppData/Local/Temp/opencode/prefill-results.json`.
Remote log: `/tmp/prefill-trial.log`; runner: `/tmp/prefill_trial.py`.
