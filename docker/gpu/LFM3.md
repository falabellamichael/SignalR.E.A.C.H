# LFM3 services (VL-2B active, Omni-2B preserved)

**Current deployment**: `reach-lfm3` runs **LiquidAI/LFM3-VL-2B**
(`lfm3_vl_api.py`, `signalreach-lfm3:vl-2b-20261027`) on GPU 0, host port
8005, Windows forward 127.0.0.1:18005. Both catalog selectors route to it:
`lfm3-vl-2b` and the legacy `lfm3-omni-2b` alias. The previous Omni
deployment below is preserved as `reach-lfm3-omni-backup` (stopped) and the
`lfm3-omni-2b` weights remain on disk.

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
