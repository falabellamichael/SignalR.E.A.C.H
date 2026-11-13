# LFM3 services (vLLM: VL-2B + Omni-2B BF16)

**Current deployment** (2026-10-30): both selectors are standard
`launch_services.py` vLLM services on the patched `vllm-lfm3:20261029`
image (`vllm serve` entrypoint; the image carries the `/tmp/reach-vllm-source`
LFM3 model files, including the `num_heads` fix the `:test` build lacked):

- `reach-lfm3` → `lfm3-vl-2b` BF16 weights, TP2 on GPUs 0+1, host port 8005
  → Windows forward `127.0.0.1:18005`, served as `LiquidAI/LFM3-VL-2B`.
  Image input enabled: `--limit-mm-per-prompt '{"image":1,"video":0}'`.
  Video input remains disabled.
- `reach-lfm3-omni` → `lfm3-omni-2b` (original BF16 checkpoint at
  revision `ce2458cbce4ad970f92032ed94e3d18d30b04f9c`), TP2 on GPUs 0+1, host port 8006 → Windows forward
  `127.0.0.1:18006`, served as `LiquidAI/LFM3-Omni-2B`. Image+audio mm enabled.

Both services use `--reasoning-parser qwen3`. This is only an output
parser; both active weight sets are BF16. The previous
`deepseek_r1` parser could classify a plain answer entirely as reasoning
and return `content: null`.

### Omni summary regression (2026-10-30)

The custom `lora_98k_tail` merged checkpoint regressed on Raycast's actual
compaction instructions. Synthetic conversation tests reproduced repeated
headings and schema text with the deployed INT4 export; its BF16 parent also
failed, including a 13,144-token prompt. Changing sampling did not establish
a reliable repair. The original checkpoint on the same vLLM image terminated
normally at 13,144, 31,384, 100,081, and 115,480 input tokens. Restore the
original weights instead of promoting the merged BF16 export as a fix.

The original checkpoint passed automatic/required/named tool delivery in JSON
and SSE, tool-result/error continuation, image colors, and generated-speech
transcription. It returned one call at a time for the two-inventory-item test;
both results and the final answer were verified over three turns. The existing
qualification suite's two same-turn parallel-call checks therefore fail for
this checkpoint and must not be reported as passing.

The configured 128000 server limit is unchanged. The original Omni model card
specifies a 32K context; larger requests above are extrapolation tests, not a
claim of vendor-qualified 128K accuracy. Even terminating summaries invented
some record counts and file details in this synthetic stress test. Passing
transport, termination, and Raycast's heading validator does not establish
factual summary quality or replace a fresh Raycast UI check.

Production verification after restoration used Raycast's configured public
provider URL and model ID. Streamed compaction replays at 13,144 and 115,480
input tokens finished with `stop` in 5.00 and 18.89 seconds, respectively;
the requested heading format was accepted by the same minimum-three-heading
criterion used in the client. Eight tool-delivery cases passed, while the two
same-turn parallel-call cases remained the limitation described above. A
separate streamed two-tool workflow completed both lookups and the final
answer in three turns. The stopped rollback container is
`reach-lfm3-omni-int4-before-summary-20261030` (restart policy `no`).

VL defaults to `enable_thinking=true` in the launcher, relay, and account
bridge. For a finite requested output limit, the relay and account gateway
send vLLM's native `thinking_token_budget` at half that limit, preserving
the total limit and reserving room for answer content. The relay preserves
an explicit caller thinking budget or disabled-thinking preference. Without
an output limit these routes do not manufacture one. Direct native API
callers can supply `thinking_token_budget` themselves.

Omni is a non-reasoning model. Its launcher defaults to thinking off and
its relay route forces thinking off even when a client or saved profile
enables it. Existing structured-action requests still answer directly.

Verified on 2026-10-29 through the installed PDF Assistant using the same
document, five retrieved chunks, and a 2048-token output cap: the original
VL request exhausted all 2048 tokens on reasoning and returned only a limit
warning. With thinking enabled and a 1024-token thinking budget, it returned
both a thinking stream and a 2782-character summary, finishing normally
(`finish_reason=stop`) in 49.07 seconds with 1676 generated tokens. The
previous thinking-off workaround was rejected and replaced by this budget.
This checks completion and separate reasoning delivery, not factual accuracy
of the generated summary. Omni's direct-answer regression previously finished
normally with 100 generated tokens.

Both run chunked prefill batching (`--max-num-seqs 8`,
`--max-num-batched-tokens` 4096/2048), full decode GPU graphs
(`mode: 0`, `cudagraph_mode: FULL_DECODE_ONLY`, capture sizes 1/2/4/8),
context 128000
(vLLM rejects 131072 — config `max_position_embeddings` is 128000).
Memory fractions: VL 0.40 + Omni 0.30 of each GPU.

Measured speed repair on 2026-10-29: replacing eager execution with decode
graphs kept weights, TP2, context, reasoning defaults, and output budgets.
Identical single-request 512-output-token benchmarks, measured on the GPU
host, gave VL 34.27 -> 72.99 tokens/s and Omni 32.21 -> 70.33 tokens/s on
repeat runs. Total request times were 15.035 -> 7.048 seconds for VL and
15.983 -> 7.339 seconds for Omni. Initial graph requests additionally spent
about four seconds before first output; repeat first-output latency was
0.046/0.071 seconds. These are short-prompt single-request measurements,
not long-context or concurrent throughput claims.

The installed PDF Assistant's five-chunk summary with thinking enabled and
a 2048-token output allowance completed in 28.450 seconds (previous eager
run 49.313 seconds), with 1654 generated tokens, a separate thinking stream,
and a final summary (`stop`). Longest delivery gap was 0.141 seconds. Both
models passed a left-red/right-blue image check; VL retained separate
thinking. Audio was not retested for this runtime-only change. Launcher
adoption checks passed for both running services. Previous eager containers
are preserved as `reach-lfm3-before-decode-graphs-20261029` and
`reach-lfm3-omni-before-decode-graphs-20261029`.

### Native tool-call delivery

Both LFM3 services require `--enable-auto-tool-choice`,
`--tool-call-parser lfm3_xml`, `--tool-strict-level parameter`, and
`--tool-parser-plugin /app/lfm3_tool_parser.py`. The plugin source is
`docker/gpu/lfm3_tool_parser.py`; install it on the host at
`/srv/signalreach/runtime/lfm3_tool_parser.py`. The launcher mounts it
read-only and validates the flags and mount when adopting a container.
Recreate/restart the service after changing the plugin or command.

The models emit Qwen XML function/parameter tags. The native parser converts
those tags into OpenAI `tool_calls`, including incremental streaming
arguments, call IDs, and multiple calls. Missing parser/auto-choice flags
previously exposed XML as answer text or rejected explicit automatic calls.
Parsing alone was insufficient: complex message bodies could still have
incorrect nesting and invalid JSON. Server-level parameter strictness
activates grammar enforcement even when the client omits `strict: true`.
This flag is necessary because vLLM resolves strictness before calling the
parser plugin. Automatic choice still permits an ordinary text answer.

The plugin bounds JSON grammar whitespace to one character per whitespace
position. Without that bound, this model/runtime combination repeatedly
generated newline tokens until it exhausted the output allowance. This
does not rewrite text inside string values or change the supplied schema.
VL thinking and the existing decode graphs remain enabled.

`qualify_lfm3_tools.py` exercises automatic, required, and named calls in
JSON and SSE modes, a nested Outlook-style body with arrays/booleans/newlines,
successful and failed synthetic tool-result follow-ups, two independent
calls with unique IDs, tools disabled, and ordinary chat. It declares mock
functions only; it never executes a model-selected action or sends mail.
For example:

```powershell
python docker/gpu/qualify_lfm3_tools.py --base-url http://127.0.0.1:20777/v1 --model lfm3-vl-2b --output tool-qualification.json
```

Start the two services sequentially: concurrent vLLM startup profiling can
count the other service's allocations as its own and fail cache sizing.
The normal launcher already starts selected services sequentially. Keep
the qualified memory fractions and 128000-token context unchanged.

Live qualification on 2026-10-29 passed all ten cases for each model through
the native API, local relay, and authenticated public REACH endpoint (60
cases total), including both
successful and failed tool-result continuations. Warm public automatic calls
took 0.908/0.972 seconds for Omni (JSON/SSE), with complete successful mock
round trips of 1.433/1.424 seconds. VL, retaining 2480 characters of separate
reasoning for this prompt, took 4.997/5.074 seconds for the call and
6.102/6.055 seconds for the successful round trip. These are measurements
of this synthetic prompt and schema; actual third-party tool execution and
the Raycast UI were not exercised. First requests after restart incurred
additional kernel warmup latency. Thirteen targeted unit tests passed.

Previous HF-transformers runtime is preserved as `reach-lfm3-hf-backup`
(stopped); the legacy Omni HF container stays `reach-lfm3-omni-backup`.
The rest of this file documents that retired HF deployment.

VL differences vs Omni: no audio (the audio endpoints are unmounted),
reasoning-capable (`enable_thinking` chat-template kwarg, default on;
`reasoning_content` is split from `content` in responses), 128K context,
image+video input, OpenAI tools, and real SSE streaming — token deltas
route to `reasoning_content` inside `<think>` and `content` after
`</think>`; tool-call markup is buffered and emitted as a `tool_calls`
delta; `stop` strings abort generation via a stopping-criteria flag.
Qualified defaults: `temperature 0.1, top_k 50, repetition_penalty 1.1`.

## Throughput

Eager BF16 decode ran ~30 tok/s — the custom omni generate loop dispatches
~1,000 kernel launches per step and is CPU-bound (profiler: 44 ms CPU vs
14 ms GPU per step; rocBLAS/CK GEMVs are additionally untuned on gfx1201).
Two changes brought text decode to ~70-80 tok/s (2.5-3x):

- `torch.compile` (default mode) on the decode step only. A dispatch
  wrapper on the forward (`language_model.forward` for Omni, `model.forward`
  for VL) routes sequence-1 calls to the specialized compiled graph and
  everything longer to the original eager function. Compiling prefill is
  the TTFT killer: every new prompt length triggered a ~40 s dynamo
  recompile (measured 42.9 s TTFB before the fix, ~0.3 s after).
  `mode="reduce-overhead"` is unusable: inductor's HIP-graph capture hits a
  triton launcher bug (`Pointer argument must be either uint64`) in this
  torch build. `max-autotune-no-cudagraphs` measures worse (~68 tok/s).
  `dynamic=True` avoids recompiles but symbolic-shape kernels cost ~2x
  decode speed (~35 tok/s) — specialized graphs + eager prefill wins.
- `StaticCache` pinned to full context for every request — Omni via
  `past_key_values=` (`make_cache`), VL via `cache_implementation="static"`
  + `max_length=131072`. Per-request sizing made every distinct
  prompt+budget a fresh compiled-graph guard → recompile per request.

Gotchas found the hard way:

- Dynamo specializes on `StaticCache.layers[i].cumulative_length_int`,
  which changes every step → recompile-per-token (~14 tok/s collapse) when
  the cache is passed as a kwarg to the compiled outer forward. Internal
  caches via `cache_implementation="static"` don't hit it; Omni's remote
  code uses `is_compileable`-aware cache reads so it's also unaffected.
- The 256-token sliding-attention window adds a second decode-graph
  variant (cache-filling vs cache-full). Both are warmed at startup;
  requests crossing the boundary mid-decode reuse them.
- `torch._dynamo.config.recompile_limit = 64` for headroom — hitting the
  default limit silently falls back to eager (~15 tok/s).
- Warmup covers short/mid/long prompts through the same generate kwargs as
  production (~90 s one-time during lifespan; health only reports ready
  after it).

## Concurrency: decode slots, not one global lock

Generation paths take `gen_slot()` — a semaphore of
`LFM3_MAX_CONCURRENT` (default 3) — instead of the old global lock. The
GPU timeshares N decodes at ~1/N rate each (~35 t/s with 2 in flight),
so a long stream no longer starves a second caller into client timeouts.
Seeded requests take every slot for RNG determinism. Each concurrent
request owns a full-context StaticCache (~4.3 GB on VL), so the slot
count is also the memory bound; warmup pre-stages N-1 extra caches
sequentially — a parallel *first compile* deadlocks dynamo's compile
lock, so slot warmup must run after the decode graph exists.

Batched decode (`LFM3_BATCH_MAX_SIZE` ≥ 2) stays available but measured
worse: a padded B=4 shared decode runs ~15 tok/s per row (~44 t/s
aggregate) vs ~68 t/s solo, and N separate streams total the same ~70 t/s.
There is no batching throughput to win on this GPU — slots are about
fairness, not speed. Batch machinery: 20 ms same-signature coalescing,
left-pad to `BATCH_MAX_SIZE`, per-row demux streamer + stopping criteria,
8K batch cache cap, single-job batches take the solo path. `/health`
exposes `max_concurrent` and `batching` stats.

Kill switches: `LFM3_COMPILE=0`, `LFM3_STATIC_CACHE=0`,
`LFM3_COMPILE_WARMUP=0`.

Host note: the gfx1201 cards sit at idle clocks (mclk 96 MHz, sclk 41 MHz)
even under decode load — amdgpu on this host does not boost them. Both
cards are pinned via
`echo high > /sys/class/drm/card{0,2}/device/power_dpm_force_performance_level`.
Measured decode speed was unchanged, but it removes per-kernel ramp
behavior; the setting resets on reboot.

## Preserved: LFM3-Omni-2B omni-modal service

`reach-lfm3-omni-backup` holds the Omni container (stopped); relaunch with
`--only lfm3` after reverting the `lfm3` service entry, or manually on a
spare port. Historical deployment notes:

The pinned vLLM ROCm image cannot serve `lfm3_omni` (no registry entry in
vLLM 0.31.0), so `Dockerfile.lfm3` reuses it only as the ROCm/PyTorch base
and installs transformers 5.21.0, soundfile, librosa, and PyAV. The model
loads via `trust_remote_code` from `/models/lfm3-omni-2b` at pinned revision
`ce2458cbce4ad970f92032ed94e3d18d30b04f9c` (BF16, SDPA, offline).

`lfm3_api.py` exposes an OpenAI-compatible surface:

- `POST /v1/chat/completions` — text/image/video/audio input, text output by
  default. Accepts data-URL or base64 parts (`image_url`, `video_url`,
  `input_audio`/`audio_url`), OpenAI `tools`/`tool_choice` (parsed from the
  model's `<tool_call><function=name>{json}</function></tool_call>` output),
  `response_format` json_object/json_schema (system-prompt enforcement),
  `stop`, `seed`, `stream` (SSE deltas + usage), `stream_options`.
- Speech output: `modalities`/`generation_mode` (`text`, `audio`,
  `interleaved`) plus `audio_temperature`, `audio_top_k`,
  `audio_repetition_penalty`, `audio_repetition_window`,
  `text_repetition_window`, `suppress_mixed`, `suppress_audio_out`. Audio
  replies arrive as a base64 WAV (24 kHz) in `message.audio`, or as live
  `delta.audio` PCM16 SSE chunks when streaming.
- `use_audio_in_video` interleaves a video's decoded soundtrack into its frame
  groups; `load_audio_from_video` passes the template flag through.
- `POST /v1/audio/transcriptions` — multipart ASR (json/text/verbose_json,
  `language`, `prompt` hint, `temperature`); `stream=true` drives
  `transcribe_live` for chunked partial transcripts over SSE.
- `POST /v1/audio/speech` — TTS; `response_format` wav (default) or pcm16,
  `voice`/`language`/`instructions` shape the system prompt, `stream=true`
  streams PCM16 SSE chunks through the LiquidCodec streaming decoder.
- `POST /tokenize`, `GET /v1/models`, `GET /health` (readiness, counters,
  GPU memory).

Video decoding uses PyAV (torchcodec ships CUDA-only wheels; there is no ROCm
build). Decoded frames pass to the processor with `video_metadata`
(fps/total_num_frames/frames_indices) so LFM3's frame-timestamp prompts stay
accurate; a decode stride caps long clips at ~1200 frames, 600 s max.

LFM3 is non-reasoning: qualified defaults are greedy (`temperature 0`,
`top_k 1`) and no `enable_thinking` chat-template kwarg is ever sent.
`server/reachd/model_routes.py` skips `chat_template_kwargs` for the
`lfm3-omni-2b` selector; `RCH/service/gpu-bridge.mjs` maps it to 18005 with the
same defaults, and `tools/reach/model_runtime.py` adds (18005→8005) to
`GPU_FORWARDS`. The launcher registers `lfm3` in `CUSTOM_RUNTIME_SERVICES`,
so TP/graph/vLLM-command qualification is skipped while the HSA mount,
host-memory guard, OMP threads, and label checks still apply.

Qualified live on 2026-10-27: text chat, SSE streaming, tool calls, image and
video understanding, video+soundtrack (`use_audio_in_video`), WAV and PCM16
TTS, TTS streaming, multipart ASR, live chunked ASR, JSON mode, `/v1/models`,
`/health`, and the full Windows relay path (`lfm3-omni-2b` selector through
127.0.0.1:18005). Interleaved mode returns text when the model chooses not to
speak; that is model behavior. Existing Gemma/support/Locals services were
verified unaffected. Functional qualification only — no throughput claims.
