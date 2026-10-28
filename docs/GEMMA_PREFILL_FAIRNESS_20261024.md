# Decode responsiveness during concurrent prefill

Retained live W4A16 setting: `--long-prefill-token-threshold 256`.
The total scheduler budget stays 3072. The installed vLLM help documents that
the threshold caps long prefills when other requests are present, not when a
request is alone. No model, quantization, thinking-default, or context changes.

Test: start a streaming manual response (2048 maximum output tokens), wait for
first output plus two seconds, then submit a unique ~44K-token prompt with a
32-token answer budget. Both benchmark requests explicitly disable thinking.
Record SSE chunk timestamps and running/waiting/preemption metrics.

| Setting | Longest first-stream gap | First-stream chunks during second prefill | Second request prefill to first output |
| --- | ---: | ---: | ---: |
| Default threshold (0) | 6.844 s | 28 | 57.390 s |
| Threshold 256 | 0.687 s | 198 | 57.609 s |
| Threshold 256 repeat | 0.641 s | 196 | 57.891 s |

Chunks are not guaranteed to equal tokens. This test establishes reduced
streaming pauses in the measured overlap scenario, not a general throughput
gain or isolation between concurrent workloads. Pre-overlap chunk counts
differed between baseline and trial, so those rates are not used for a speedup
claim. No kernel profiling was performed; growing baseline gaps are consistent
with increasingly expensive mixed prefill/decode iterations.

The threshold is in the live Docker command and persists across restart.
Rollback: stopped `reach-gemma-before-prefill-fairness-20261024` container.
The W4 deployment remains a retained trial; the generic FP8 launcher is not its
deployment source (see GEMMA_W4A16_20261024.md).

Evidence in C:/Users/Falab/AppData/Local/Temp/opencode:
overlap-events.json, overlap-events-fairness256.json,
overlap-events-fairness256-repeat.json, overlap_probe.py.
