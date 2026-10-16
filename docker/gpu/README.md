# Qualified optional GPU deployment

`launch_services.py` preserves the Linux operator profile qualified on two
Radeon AI PRO R9700 GPUs (gfx1201), ROCm 7.2.3, and vLLM 0.31.0. It is separate
from the desktop installer and does not download model weights or runtime files.
It contains no host credentials or public endpoint address.

The deployment root is `/srv/signalreach`. An operator must provision its
`models.json`, approved model directories under `models`, and the support-service
image before using this launcher. The pinned vLLM image must already be present.
The support image `signalreach-support:20261015` is an operator-provisioned
dependency, not built by this repository. Do not run this profile on an unrelated
host as a generic GPU installer.

Required qualified read-only runtime mounts are:

| File under the deployment root | SHA256 |
| --- | --- |
| `runtime/rocr-7.2.3-poll-backoff/libhsa-runtime64.so.1` | `c0770ac794014146886990b0998e538fdc66c25ab61bdc24e2be7154f3ecf521` |
| `runtime/rccl-gfx1201-7.2.3/librccl.so.1` | `84cfccf7be387384b344bc497748e6fa4597a8b48e5f142683b000ee01a6316b` |

The launcher does not build or substitute these libraries. Their ABI must match
the pinned image. Existing containers with a different ownership label, GPU
mapping, runtime mount, queue setting, precision, memory allocation, or decode
configuration are preserved and rejected for operator review.

Gemma and Ornith use TP2, FP8 weights, and BF16 vision/activations. MiniCPM uses
one GPU. Four embedding, reranking, and decision models remain in the shared
support service. `GPU_MAX_HW_QUEUES=1` applies consistently to all four containers.
Granite is excluded; the launcher does not remove its original weights or old
containers. All published service ports bind to loopback.

Measured installed SimpleRAG streaming requests after this deployment decoded
at 53.0-53.7 tokens/s for Gemma, 67.7-68.6 for Ornith, and 145.8-149.8 for MiniCPM.
These workload measurements are not general hardware performance guarantees.
Basic outputs, structured JSON, and Gemma/Ornith image recognition passed;
comprehensive FP8 answer-quality evaluation was not performed. Warm isolated
support requests took 21-37 ms, but concurrent support bursts still queued and
the first post-startup burst was substantially slower. This profile does not
claim to resolve support-service startup/concurrency latency.

The relay routes its fixed model selectors through operator-owned loopback SSH
forwards on ports 18001, 18002, 18004, and 18030. It requests provider token usage
for streaming GPU replies. Customers cannot choose a destination URL or supply
operator credentials through these selectors.
