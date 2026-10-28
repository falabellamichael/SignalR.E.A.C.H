# Locals on the vLLM GPU server

## Active user-serving integration

The existing server loopback endpoint `127.0.0.1:8001` now routes through
Locals on port 8321. Existing SSH forwarding to Windows port 18001 therefore
uses this integration automatically; users keep their existing URLs and model
IDs. The gateway talks directly to the Gemma container bridge address on port
8000, avoiding a routing loop. Gemma and support were not restarted.

`signalreach-locals.service` is enabled on the GPU host. It runs
`locals_inline.py`, checks the backend, starts the gateway, and installs an
idempotent loopback OUTPUT redirect. Container replacement that changes its IP
requires updating/recreating the gateway; the script refuses a mismatched
upstream rather than silently routing to it. Roll back the redirect with:

```sh
sudo iptables -t nat -D OUTPUT -d 127.0.0.1/32 -p tcp --dport 8001 \
  -m comment --comment signalreach-locals -j REDIRECT --to-ports 8321
sudo systemctl disable signalreach-locals.service
```

The serving path uses the pinned upstream Locals reasoning-line loop detector,
loaded from its Python AST without importing MLX. It stops repetitive streamed
reasoning with an explicit SSE error and closes the GPU request. Ordinary answer
text and tool argument streams are not altered. Abandoned non-streaming requests
are also cancelled while waiting for headers or a response body. vLLM retains
continuous batching, prefix caching (verified enabled), and constrained decoding.
Model discovery preserves context metadata; native tokenization and other GET/
POST backend routes pass through. No agent executes code for ordinary chat users.

Verified through the **existing Windows port 18001**, not just the new gateway:
JSON schema, regex, SSE, tool-result continuation, concurrent requests and
abandoned non-streaming cancellation. `/health` exposes request, loop-stop and
disconnect counters for observing the live path. These are functional checks;
no throughput improvement or Metal-kernel port is claimed.

This integration runs Generated-Computers/Locals' actual Python multi-agent
harness at revision `4f4d03f10232c9f2adeb1e96e2a7bd79a9e7fe19` with the existing
vLLM Gemma backend. The container installs upstream with `--no-deps`, so MLX
and Metal are not required. Upstream source and license notices remain in the
installed package. No model weights are downloaded by this integration.

The CPU-only gateway listens on loopback port 8321 and forwards to the existing
loopback vLLM port 8001. It discovers the real served model ID, accepts Locals
model aliases, translates Locals regex response formats to vLLM
`structured_outputs.regex`, and passes JSON schemas, tool calls, usage and SSE
through. Backend errors retain their status and body for completions.
Streaming disconnects close the upstream response.

## Deploy on the Linux GPU host

Provision `Dockerfile.locals`, `locals_vllm.py` and `launch_locals.py` alongside
`launch_services.py` under `/srv/signalreach` (or the existing launcher directory).
With Gemma already running:

```sh
python3 launch_locals.py
curl --fail http://127.0.0.1:8321/health
```

For combined startup use `python3 launch_services.py --only gemma --with-locals`.
The gateway launcher refuses an existing `reach-locals` container rather than
replacing it. Inspect and manage an existing deployment with Docker.
Host networking is intended for the Linux GPU host.

Clients can use `http://127.0.0.1:8321/v1` with model `locals`.
To run the Locals harness on a project, mount its parent (the harness creates
sibling workspaces), and provide a check command available in the container:

```sh
docker run --rm --network host -v /srv/projects:/projects \
  signalreach-locals:vllm-4f4d03f run 'Implement the requested change' \
  --dir /projects/my-project --check 'python3 -m unittest discover' \
  --workers 2 --parts 4 --versions 1
```

The harness executes model-selected commands and the check inside this container;
use a derived image when the project needs additional build tools. Its original
check-and-apply workflow and workspace handling are retained. Reports can be
saved with `--report /projects/run-report.json`.

For another backend, run `locals_vllm.py serve --upstream URL --model SERVED_ID`.
Optional upstream authentication uses `LOCALS_VLLM_API_KEY`; never put keys in
the image. `LOCALS_VLLM_URL` and `LOCALS_VLLM_MODEL` also configure the gateway.

## Scope and verification

vLLM owns inference, continuous batching, prefix caching, tool parsing and
structured decoding. Locals' MLX GPU grammar kernels, forced-span acceleration,
disk prompt cache and Mac benchmark speedups are not ported. Locals' upstream
Mac-only `locals serve/code/launch` commands are not used; the supported entry
points are this integration's `serve` and `run`.

Unit tests exercise routing, authentication, schema/regex translation, streaming
and backend errors.

### Live qualification (2026-10-24)

Deployed `reach-locals` with restart policy `unless-stopped` on the existing GPU
host, from `/srv/signalreach/locals-vllm`. The live vLLM 0.31.0 TP2 backend
reported the existing Gemma alias and a 131,072-token context. Its active weight
path was `gemma4-12b-qat-w4a16-ct`.

- `probe_locals.py`: JSON schema, regex, SSE, structured tool call with tool-result
  continuation, and two concurrent requests all passed.
- `locals_smoke.py`: the pinned upstream harness corrected a broken addition
  function in a disposable project, passed its unittest check and applied the
  change in 5.7 seconds (three agent steps). This is a functional smoke test,
  not a throughput benchmark.
- A local SSH tunnel exposes the gateway on `http://127.0.0.1:18321/v1` on the
  operator's Windows PC. A chat request through that tunnel succeeded. The
  tunnel is session-local and must be reopened after it exits or the PC restarts.

Repeat API checks with `python3 probe_locals.py` on the GPU host. Run the real
harness check using a disposable container with `locals_smoke.py` mounted as
`/probe.py` and `--entrypoint python ... /probe.py`.

### Follow-up verification (2026-10-25)

- Existing Windows endpoint `127.0.0.1:18001`: JSON schema, regex, SSE,
  tool-call continuation and two concurrent requests passed. The two-request
  check completed in 0.50 seconds; this is a functional sample, not a benchmark.
- Abandoned non-streaming request cancellation passed through the same endpoint.
- The host service was active; `reach-locals` had been up for 12 hours.
  A single Docker stats sample reported 32 MiB RAM and 0.20% CPU.
- Local gateway optimization coalesces simultaneous model-discovery cache
  refreshes. A regression test verifies one upstream discovery per 16-request
  burst, refresh after expiry and recovery after a backend failure.
- `py -3.12 -m pytest tests/test_locals_vllm.py -q`: 5 passed.
  This optimization is validated locally and has not been deployed to the
  running container.

#### Cache optimization A/B measurement

Run `py -3.12 docker/gpu/benchmark_locals_cache.py`. The benchmark reconstructs
the previous discovery function and compares it with the current implementation
using an in-process mock backend with 10 ms discovery delay, alternating version
order over 20 trials per scenario. All response contents and call counts are
asserted. Measured median burst times on Windows:

| Scenario | Previous | Optimized | Backend calls, previous / optimized |
| --- | ---: | ---: | ---: |
| Cold, one request | 11.754 ms | 11.978 ms | 1 / 1 |
| Cold, 16 requests, parallel backend | 15.905 ms | 14.262 ms | 16 / 1 |
| Cold, 16 requests, serialized backend | 184.816 ms | 14.232 ms | 16 / 1 |
| Warm, 16 requests | 2.861 ms | 2.903 ms | 0 / 0 |

The demonstrated benefit is 93.75% fewer discovery requests on a cold burst.
The serialized-backend scenario illustrates contention, not a measured property
of the live vLLM backend. Single-request and warm-cache timings were slightly
slower in this sample. These results do not establish a GPU inference or live
end-to-end latency improvement; deployment and live A/B measurements remain
necessary for that claim.

Later live recheck returned HTTP 502 for both API and cancellation probes.
The Gemma container had restarted again and logs showed an earlier
`EngineDeadError` followed by a new model startup. Locals remained up for
12 hours. The local cache change was not deployed, so it was not involved in
this live failure. Live health must be requalified after backend recovery.
