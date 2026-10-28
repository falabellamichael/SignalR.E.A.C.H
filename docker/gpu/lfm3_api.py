"""Private LFM3-Omni-2B serving API (OpenAI-compatible).

Publish this container on a loopback address. It deliberately has no public
authentication or remote URL/file ingestion; media arrive inside the request
body as data URLs or base64. One omni model stays resident.

Endpoints
  POST /v1/chat/completions   text/image/video/audio in, text+speech out, SSE,
                              tool calls, JSON-mode prompting, usage
  POST /v1/audio/transcriptions  ASR (multipart or JSON); stream=true streams
                              partial transcripts through transcribe_live
  POST /v1/audio/speech       TTS (text -> wav/pcm16, streamable PCM via SSE)
  POST /tokenize              token count for prompts or chat messages
  GET  /v1/models, /health
"""

import asyncio
import base64
import binascii
import io
import json
import math
import os
import queue
import re
import struct
import threading
import time
import uuid
import wave
from concurrent.futures import Future
from types import SimpleNamespace
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field


ROOT = Path(os.environ.get("MODEL_ROOT", "/models"))
MODEL_NAME = os.environ.get("LFM3_MODEL", "lfm3-omni-2b")
REPOSITORY = os.environ.get("LFM3_REPOSITORY", "LiquidAI/LFM3-Omni-2B")
DEVICE = "cuda:0"
MAX_NEW_TOKENS = int(os.environ.get("LFM3_MAX_NEW_TOKENS", "4096"))
CONTEXT_TOKENS = 32768
MAX_BODY_BYTES = 96 * 1024 * 1024
MAX_AUDIO_SECONDS = 900
MAX_VIDEO_SECONDS = 600
LOCK = threading.Lock()
# Generation slots: a single global lock starves every concurrent request
# behind an in-flight decode (Raycast's second call would sit for the whole
# stream). The GPU timeshares N decodes at ~1/N rate each — same aggregate
# throughput, but every caller stays alive. Seeded requests take all slots
# so the global RNG can't interleave with other sampling.
MAX_CONCURRENT = max(1, int(os.environ.get("LFM3_MAX_CONCURRENT", "3")))
GEN_SLOTS = threading.Semaphore(MAX_CONCURRENT)


@contextmanager
def gen_slot(exclusive=False):
    if not exclusive:
        GEN_SLOTS.acquire()
        try:
            yield
        finally:
            GEN_SLOTS.release()
        return
    for _ in range(MAX_CONCURRENT):
        GEN_SLOTS.acquire()
    try:
        yield
    finally:
        for _ in range(MAX_CONCURRENT):
            GEN_SLOTS.release()


COUNTERS = {"requests": 0, "chat": 0, "asr": 0, "tts": 0, "tokens_out": 0}
STATE = {}
BATCH_QUEUE = queue.Queue(maxsize=128)
# Opt-in until the ROCm batch decode regression has been resolved.
BATCH_MAX_SIZE = int(os.environ.get("LFM3_BATCH_MAX_SIZE", "1"))
BATCH_WAIT_SECONDS = 0.02
BATCH_STATS = {"batches": 0, "batched_requests": 0, "largest_batch": 0}
COMPILE_ENABLED = os.environ.get("LFM3_COMPILE", "1") != "0"
STATIC_CACHE_ENABLED = os.environ.get("LFM3_STATIC_CACHE", "1") != "0"

TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*<function=([A-Za-z_][\w.-]*)>\s*(.*?)</function>\s*</tool_call>",
    re.DOTALL)
PARAM_RE = re.compile(
    r"<parameter=([A-Za-z_][\w.-]*)>\s*(.*?)\s*</parameter>", re.DOTALL)

AUDIO_EXTS = {".wav", ".mp3", ".flac", ".ogg", ".oga", ".m4a", ".aac", ".opus", ".wma"}
VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v"}


def b64decode(value, what="data"):
    """Accept a data URL or raw base64 payload."""
    if not isinstance(value, str):
        raise HTTPException(400, f"{what} must be a data URL or base64 string")
    if value.startswith("data:"):
        try:
            value = value.split(",", 1)[1]
        except IndexError:
            raise HTTPException(400, f"Malformed {what} data URL")
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, f"Invalid base64 {what}")


def part_value(part, *keys):
    for key in keys:
        value = part.get(key)
        if value is not None:
            return value
    return None


def decode_image(part):
    from PIL import Image
    raw = part_value(part, "image", "image_url", "url")
    if isinstance(raw, dict):
        raw = raw.get("url") or raw.get("data")
    if hasattr(raw, "read") or raw.__class__.__name__ == "Image":
        return raw
    data = b64decode(raw, "image") if isinstance(raw, str) else None
    if data is None:
        raise HTTPException(400, "image part needs a data URL, base64 payload, or pixels")
    try:
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception as exc:
        raise HTTPException(400, f"Undecodable image payload: {exc}")


def _resample_16k(waveform, rate):
    if rate == 16000:
        return waveform
    try:
        import torchaudio
        tensor = torch.from_numpy(waveform)[None]
        return torchaudio.functional.resample(tensor, rate, 16000)[0].numpy()
    except ImportError:
        pass
    try:
        import librosa
        return librosa.resample(waveform, orig_sr=rate, target_sr=16000).astype(np.float32)
    except ImportError:
        pass
    ratio = rate / 16000.0
    index = np.arange(int(len(waveform) / ratio)) * ratio
    lo = index.astype(np.int64)
    frac = (index - lo).astype(np.float32)
    hi = np.minimum(lo + 1, len(waveform) - 1)
    return (waveform[lo] * (1 - frac) + waveform[hi] * frac).astype(np.float32)


def decode_audio_bytes(data, what="audio"):
    """Return a mono float32 waveform at 16 kHz."""
    import soundfile
    try:
        samples, rate = soundfile.read(io.BytesIO(data), dtype="float32", always_2d=True)
    except Exception:
        try:
            import librosa
            samples, rate = librosa.load(io.BytesIO(data), sr=16000, mono=True)
            return np.asarray(samples, dtype=np.float32)
        except Exception as exc:
            raise HTTPException(400, f"Undecodable {what} payload: {exc}")
    waveform = samples.mean(axis=1)
    if not np.isfinite(waveform).all() or waveform.size == 0:
        raise HTTPException(400, f"Empty or non-finite {what} payload")
    if waveform.size / rate > MAX_AUDIO_SECONDS:
        raise HTTPException(413, f"{what} exceeds {MAX_AUDIO_SECONDS} seconds")
    return _resample_16k(waveform, rate)


def decode_audio(part):
    raw = part_value(part, "input_audio", "audio", "audio_url", "url")
    if isinstance(raw, dict):
        raw = raw.get("data") or raw.get("url")
    if isinstance(raw, np.ndarray):
        waveform = raw.astype(np.float32)
        if waveform.ndim > 1:
            waveform = waveform.mean(axis=-1)
        return waveform
    if isinstance(raw, (list, tuple)):
        return np.asarray(raw, dtype=np.float32)
    if isinstance(raw, torch.Tensor):
        return raw.float().flatten().cpu().numpy()
    data = b64decode(raw, "audio") if isinstance(raw, str) else None
    if data is None:
        raise HTTPException(400, "audio part needs a data URL or base64 payload")
    return decode_audio_bytes(data)


def decode_video(part):
    """Return (frames [T,H,W,C] uint8 np, soundtrack np|None, metadata dict)."""
    raw = part_value(part, "video", "video_url", "url")
    if isinstance(raw, dict):
        raw = raw.get("data") or raw.get("url")
    if isinstance(raw, np.ndarray):
        total = raw.shape[0]
        meta = {"fps": 2.0, "total_num_frames": total,
                "frames_indices": list(range(total)),
                "duration": total / 2.0,
                "height": int(raw.shape[1]), "width": int(raw.shape[2]),
                "video_backend": "direct"}
        return raw, None, meta
    data = b64decode(raw, "video") if isinstance(raw, str) else None
    if data is None:
        raise HTTPException(400, "video part needs a data URL or base64 payload")
    frames, audio, meta = _decode_video_bytes(data)
    return frames, audio, meta


def _decode_video_bytes(data):
    """Decode container bytes to (frames uint8 [T,H,W,C], mono 16k audio or None)."""
    suffix_file = None
    try:
        import tempfile
        handle, suffix_file = tempfile.mkstemp(prefix="lfm3-video-", suffix=".mp4")
        with os.fdopen(handle, "wb") as target:
            target.write(data)
        return _decode_video_path(suffix_file)
    finally:
        if suffix_file:
            try:
                os.unlink(suffix_file)
            except OSError:
                pass


def _decode_video_path(path):
    """Decode with PyAV; the pinned ROCm image has no ROCm-capable torchcodec."""
    try:
        import av
    except ImportError:
        return _decode_video_torchvision(path)
    try:
        container = av.open(path)
    except Exception as exc:
        raise HTTPException(400, f"Undecodable video payload: {exc}")
    try:
        video_stream = next((s for s in container.streams if s.type == "video"), None)
        if video_stream is None:
            raise HTTPException(400, "Video payload has no video stream")
        fps = float(video_stream.average_rate or 30) or 30
        seconds = float(container.duration / 1_000_000) if container.duration else 0.0
        if seconds > MAX_VIDEO_SECONDS:
            raise HTTPException(413, f"video exceeds {MAX_VIDEO_SECONDS} seconds")
        # The processor resamples at ~2 fps with timestamps from the clip's
        # metadata; a stride keeps long clips within memory while preserving
        # correct timestamps through the effective fps.
        stride = max(1, math.ceil((seconds * fps or fps) / 1200))
        decoded = []
        for position, frame in enumerate(container.decode(video=0)):
            if position % stride == 0:
                decoded.append(frame.to_ndarray(format="rgb24"))
        if not decoded:
            raise HTTPException(400, "Video payload has no frames")
        frames = np.stack(decoded)
        effective_fps = fps / stride
        sound = _video_soundtrack(path)
        meta = {"fps": effective_fps, "total_num_frames": len(decoded),
                "frames_indices": list(range(len(decoded))),
                "duration": seconds or len(decoded) / effective_fps,
                "height": int(frames.shape[1]), "width": int(frames.shape[2]),
                "video_backend": "pyav"}
        return frames, sound, meta
    finally:
        container.close()


def _video_soundtrack(path):
    """Return mono 16kHz float32 of the first audio stream, or None."""
    try:
        import av
        container = av.open(path)
    except Exception:
        return None
    try:
        if not any(s.type == "audio" for s in container.streams):
            return None
        resampler = av.audio.resampler.AudioResampler(
            format="s16", layout="mono", rate=16000)
        chunks = []
        for frame in container.decode(audio=0):
            for out in resampler.resample(frame):
                chunks.append(out.to_ndarray()[0])
            if sum(len(c) for c in chunks) > MAX_VIDEO_SECONDS * 16000:
                break
        for out in resampler.resample(None):
            chunks.append(out.to_ndarray()[0])
        if not chunks:
            return None
        data = np.concatenate(chunks).astype(np.float32) / 32768.0
        return data[: MAX_VIDEO_SECONDS * 16000]
    except Exception:
        return None
    finally:
        container.close()


def _decode_video_torchvision(path):
    try:
        import torchvision.io as tvio
        frames, audio, info = tvio.read_video(path, pts_unit="sec")
    except Exception as exc:
        raise HTTPException(400, f"Undecodable video payload: {exc}")
    if frames.numel() == 0:
        raise HTTPException(400, "Video payload has no frames")
    fps = info.get("video_fps") or 30
    total = frames.shape[0]
    if total / fps > MAX_VIDEO_SECONDS:
        raise HTTPException(413, f"video exceeds {MAX_VIDEO_SECONDS} seconds")
    picked = frames.numpy()
    sound = None
    if audio.numel():
        wav = audio.float().mean(dim=0).numpy()
        sound = _resample_16k(wav, int(info.get("audio_fps") or 16000))
    meta = {"fps": fps, "total_num_frames": total,
            "frames_indices": list(range(total)), "duration": total / fps,
            "height": int(picked.shape[1]), "width": int(picked.shape[2]),
            "video_backend": "torchvision"}
    return picked, sound, meta


def normalize_content(content, audio_in_video=False):
    """Translate OpenAI multimodal parts into LFM3 template parts with loaded media."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        raise HTTPException(400, "message content must be a string or part list")
    parts, videos, video_metas = [], [], []
    for part in content:
        if not isinstance(part, dict):
            raise HTTPException(400, "content parts must be objects")
        kind = part.get("type")
        if kind == "text":
            parts.append({"type": "text", "text": str(part.get("text", ""))})
        elif kind in ("image", "image_url"):
            parts.append({"type": "image", "image": decode_image(part)})
        elif kind in ("audio", "audio_url", "input_audio"):
            parts.append({"type": "audio", "audio": decode_audio(part)})
        elif kind == "audio_out":
            clip = decode_audio(part)
            parts.append({"type": "audio_out", "audio_out": clip})
        elif kind in ("video", "video_url"):
            frames, soundtrack, meta = decode_video(part)
            videos.append(frames)
            video_metas.append(meta)
            parts.append({"type": "video", "video": frames})
            if soundtrack is not None and audio_in_video:
                parts.append({"type": "audio", "audio": soundtrack})
        elif kind in ("tool_reference",):
            parts.append(part)
        else:
            raise HTTPException(400, f"unsupported content part type: {kind}")
    return parts, videos, video_metas


def normalize_messages(messages, audio_in_video=False):
    """Return (conversation, video_metas) for apply_chat_template."""
    conversation, all_metas = [], []
    for message in messages:
        if not isinstance(message, dict):
            raise HTTPException(400, "messages must be objects")
        role = message.get("role")
        if role not in ("system", "developer", "user", "assistant", "tool"):
            raise HTTPException(400, f"unsupported role: {role}")
        role = "system" if role == "developer" else role
        item = {"role": role}
        content = message.get("content")
        if isinstance(content, list):
            parts, videos, video_metas = normalize_content(content, audio_in_video)
            item["content"] = parts
            all_metas.extend(video_metas)
        elif content is not None:
            item["content"] = content
        if role == "assistant":
            calls = message.get("tool_calls")
            if calls:
                item["tool_calls"] = [parse_tool_call_entry(call) for call in calls]
            audio = message.get("audio")
            if isinstance(audio, dict) and audio.get("data"):
                clip = decode_audio_bytes(b64decode(audio["data"], "audio"))
                # replayed speech must be 24 kHz for the codec
                clip = _resample_to_rate(clip, 24000)
                item.setdefault("content", [{"type": "audio_out", "audio_out": clip}])
        if role == "tool":
            if message.get("tool_call_id"):
                item["tool_call_id"] = message["tool_call_id"]
            item["content"] = content if content is not None else ""
        conversation.append(item)
    if not conversation:
        raise HTTPException(400, "messages must not be empty")
    return conversation, all_metas


def _resample_to_rate(waveform, rate):
    try:
        import torchaudio
        tensor = torch.from_numpy(waveform)[None]
        return torchaudio.functional.resample(tensor, 16000, rate)[0].numpy()
    except ImportError:
        try:
            import librosa
            return librosa.resample(waveform, orig_sr=16000, target_sr=rate).astype(np.float32)
        except ImportError:
            ratio = 16000.0 / rate
            index = np.arange(int(len(waveform) / ratio)) * ratio
            lo = index.astype(np.int64)
            frac = (index - lo).astype(np.float32)
            hi = np.minimum(lo + 1, len(waveform) - 1)
            return (waveform[lo] * (1 - frac) + waveform[hi] * frac).astype(np.float32)


def parse_tool_call_entry(call):
    """Coerce an OpenAI tool_call into the chat template's mapping form."""
    if not isinstance(call, dict):
        raise HTTPException(400, "tool_calls entries must be objects")
    function = call.get("function") if "function" in call else call
    if not isinstance(function, dict) or not function.get("name"):
        raise HTTPException(400, "tool_calls need a function name")
    arguments = function.get("arguments")
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments) if arguments.strip() else {}
        except ValueError as exc:
            raise HTTPException(400, f"tool_call arguments must decode to an object: {exc}")
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        raise HTTPException(400, "tool_call arguments must be an object")
    return {"type": "function", "function": {"name": function["name"], "arguments": arguments}}


def parse_generated_tool_calls(text):
    """Extract <tool_call> blocks; returns (clean_text, [tool_calls])."""
    calls = []
    def _parse(match):
        name, body = match.group(1), match.group(2)
        arguments = {}
        for param in PARAM_RE.finditer(body):
            arguments[param.group(1)] = param.group(2)
        if not arguments and body.strip():
            try:
                arguments = json.loads(body.strip())
            except ValueError:
                arguments = {"__raw__": body.strip()}
        calls.append({"id": f"call_{uuid.uuid4().hex[:24]}", "type": "function",
                      "function": {"name": name, "arguments": json.dumps(arguments)}})
        return ""
    cleaned = TOOL_CALL_RE.sub(_parse, text)
    return cleaned.strip(), calls


def coerce_tool_arguments(calls, tools):
    """Align string argument values with the declared JSON schema types.

    The model emits <parameter> values as raw strings, so object/array/
    number/boolean/null parameters arrive as text and strict clients
    reject them ("$.target must be object"). Decode them here; anything
    that still won't parse stays a string — that is a real model failure,
    not something the transport can fix.
    """
    schemas = {t["function"]["name"]:
               t["function"].get("parameters", {}).get("properties", {})
               for t in tools or []}
    for call in calls:
        try:
            args = json.loads(call["function"]["arguments"])
        except (ValueError, TypeError):
            continue
        if not isinstance(args, dict):
            continue
        props = schemas.get(call["function"]["name"], {})
        for name, value in args.items():
            if not isinstance(value, str):
                continue
            if props.get(name, {}).get("type") not in \
                    ("integer", "number", "boolean", "array", "object", "null"):
                continue
            text = value.strip()
            candidates = [text]
            for opener, closer in (("{", "}"), ("[", "]")):
                start, end = text.find(opener), text.rfind(closer)
                if 0 <= start < end:
                    candidates.append(text[start:end + 1])
            for candidate in candidates:
                try:
                    args[name] = json.loads(candidate)
                    break
                except ValueError:
                    continue
        call["function"]["arguments"] = json.dumps(args)


def wav_bytes(pcm_f32, sample_rate=24000):
    buffer = io.BytesIO()
    data = np.clip(pcm_f32, -1.0, 1.0)
    pcm16 = (data * 32767.0).astype("<i2")
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm16.tobytes())
    return buffer.getvalue()


def pcm16_bytes(pcm_f32):
    return (np.clip(pcm_f32, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class AudioChunkStreamer:
    """Streams codec-decoded PCM16 chunks; frames arrive one at a time."""

    def __init__(self, codec, sink, every=4):
        self.codec = codec
        self.sink = sink
        self.every = every
        self.frames = []
        self.cache = None

    def _cache(self):
        if self.cache is None:
            import importlib, sys
            name = type(self.codec).__module__
            module = sys.modules.get(name) or importlib.import_module(name)
            self.cache = module.LiquidCodecStreamingCache(self.codec.config)
        return self.cache

    def put(self, value):
        frame = torch.as_tensor(value, dtype=torch.long)
        if frame.ndim == 2:
            frame = frame[0]
        self.frames.append(frame)
        while len(self.frames) >= self.every:
            self._emit(self.every)

    def _emit(self, count, finalize=False):
        codes = torch.stack(self.frames[:count], dim=-1)[None].to(next(self.codec.parameters()).device)
        self.frames = self.frames[count:]
        with torch.inference_mode():
            out = self.codec.decode(codes, streaming_cache=self._cache(),
                                    finalize=finalize, return_dict=True)
        pcm = out.audio_values[0].float().cpu().numpy()
        if pcm.size:
            self.sink.put(("audio", pcm16_bytes(pcm)))

    def end(self):
        if self.frames or (self.cache and not self.cache.finished):
            self._emit(len(self.frames), finalize=True)
        self.sink.put(("audio_end", None))


@asynccontextmanager
async def lifespan(_app):
    if not torch.version.hip or not torch.cuda.is_available():
        raise RuntimeError("A working AMD ROCm GPU is required")
    torch.set_num_threads(int(os.environ.get("OMP_NUM_THREADS", "2")))
    path = str(ROOT / MODEL_NAME)
    from transformers import AutoProcessor
    try:
        from transformers import AutoModelForMultimodalLM as loader
    except ImportError:
        from transformers import AutoModelForImageTextToText as loader
    STATE["processor"] = AutoProcessor.from_pretrained(
        path, local_files_only=True, trust_remote_code=True)
    STATE["model"] = loader.from_pretrained(
        path, local_files_only=True, trust_remote_code=True,
        dtype=torch.bfloat16, attn_implementation="sdpa",
    ).eval().to(DEVICE)
    STATE["codec"] = STATE["processor"].audio_tokenizer.eval().to(DEVICE)
    STATE["tokenizer"] = STATE["processor"].tokenizer
    added = getattr(STATE["tokenizer"], "added_tokens_decoder", {}) or {}
    STATE["ids"] = {token.content: index for index, token in added.items()}
    if COMPILE_ENABLED:
        # torch.compile fuses the ~1000 kernel launches in each eager decode
        # step; on this ROCm build "reduce-overhead" cudagraphs crash, so the
        # default mode is used. ~2.6x on text decode in testing.
        # Decode-only dispatch: sequence-1 steps take the specialized graph,
        # prefill stays eager — otherwise every new prompt length pays a
        # ~40s dynamo recompile (the TTFT bug seen on the VL service).
        try:
            torch._dynamo.config.recompile_limit = 64
            lm = STATE["model"].model.language_model
            orig_forward = lm.forward
            decode_forward = torch.compile(orig_forward, dynamic=False)

            def dispatch(*args, **kwargs):
                ids = kwargs.get("input_ids", args[0] if args else None)
                embeds = kwargs.get("inputs_embeds")
                length = (embeds.shape[-2] if embeds is not None
                          else ids.shape[-1] if ids is not None else 0)
                call = decode_forward if length == 1 else orig_forward
                return call(*args, **kwargs)

            lm.forward = dispatch
            STATE["compiled"] = True
        except Exception as exc:
            STATE["compiled"] = False
            print(json.dumps({"compile_failed": str(exc)}), flush=True)
    print(json.dumps({"loaded": MODEL_NAME, "repository": REPOSITORY,
                      "gpu": torch.cuda.get_device_name(0),
                      "compiled": STATE.get("compiled", False),
                      "allocated_bytes": torch.cuda.memory_allocated(0)}), flush=True)
    if STATE.get("compiled") and os.environ.get("LFM3_COMPILE_WARMUP", "1") != "0":
        # Pay the one-time dynamo cost now; first requests would otherwise
        # stall for a minute while the decode-step graph builds.
        try:
            # Warm both sliding-window cache branches (below/above the
            # window) so mid-decode transitions never recompile.
            with torch.inference_mode():
                for words in (4, 400):
                    text = "hello " * words
                    warm = STATE["processor"].apply_chat_template(
                        [{"role": "user",
                          "content": [{"type": "text", "text": text}]}],
                        add_generation_prompt=True, tokenize=True,
                        return_dict=True, return_tensors="pt").to(DEVICE)
                    STATE["model"].generate(
                        **warm, generation_mode="text", max_new_tokens=6,
                        do_sample=False, return_dict_in_generate=True,
                        past_key_values=make_cache(
                            int(warm["input_ids"].shape[1]), 6))
                if MAX_CONCURRENT > 1:
                    # Concurrent requests each own a StaticCache. Sequential
                    # warms reuse the compiled graph and pre-stage allocator
                    # blocks — parallel first-compile deadlocks dynamo.
                    for i in range(MAX_CONCURRENT - 1):
                        warm = STATE["processor"].apply_chat_template(
                            [{"role": "user",
                              "content": [{"type": "text",
                                           "text": "hi" * (i + 2)}]}],
                            add_generation_prompt=True, tokenize=True,
                            return_dict=True, return_tensors="pt").to(DEVICE)
                        STATE["model"].generate(
                            **warm, generation_mode="text", max_new_tokens=4,
                            do_sample=False, return_dict_in_generate=True,
                            past_key_values=make_cache(
                                int(warm["input_ids"].shape[1]), 4))
            print(json.dumps({"compile_warmup": "done",
                              "concurrency": MAX_CONCURRENT}), flush=True)
        except Exception as exc:
            print(json.dumps({"compile_warmup": "failed",
                              "error": str(exc)}), flush=True)
    threading.Thread(target=batch_worker, daemon=True, name="lfm3-batcher").start()
    yield
    STATE.clear()


def special_id(name):
    """Look up an added special token id by inner name, e.g. im_end."""
    needle = name.strip("_")
    for token, index in STATE.get("ids", {}).items():
        if needle and needle in token:
            return index
    return None


app = FastAPI(title="SignalREACH LFM3-Omni serving", lifespan=lifespan)


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    messages: list[dict] = Field(min_length=1)
    tools: list[dict] | None = None
    functions: list[dict] | None = None
    tool_choice: object = None
    temperature: float | None = None
    top_p: float | None = None
    top_k: int | None = None
    min_p: float | None = None
    repetition_penalty: float | None = None
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    max_tokens: int | None = None
    max_completion_tokens: int | None = None
    seed: int | None = None
    stop: str | list[str] | None = None
    stream: bool = False
    stream_options: dict | None = None
    n: int | None = None
    response_format: dict | None = None
    modalities: list[str] | None = None
    audio: dict | None = None
    generation_mode: str | None = None
    audio_temperature: float | None = None
    audio_top_k: int | None = None
    audio_repetition_penalty: float | None = None
    audio_repetition_window: int | None = None
    text_repetition_window: int | None = None
    suppress_mixed: bool | None = None
    suppress_audio_out: bool | None = None
    use_audio_in_video: bool | None = None
    load_audio_from_video: bool | None = None


class SpeechRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    input: str = Field(min_length=1, max_length=8192)
    voice: str | None = None
    response_format: str = "wav"
    language: str | None = None
    instructions: str | None = None
    stream: bool = False
    audio_temperature: float | None = None
    audio_repetition_penalty: float | None = None
    audio_repetition_window: int | None = None


class TokenizeRequest(BaseModel):
    model_config = ConfigDict(extra="allow")
    model: str | None = None
    prompt: str | None = None
    messages: list[dict] | None = None
    add_generation_prompt: bool = True


def require_model():
    if "model" not in STATE:
        raise HTTPException(503, "Model is still loading")


def check_model_alias(value):
    if value in (None, MODEL_NAME, REPOSITORY, "lfm3", "lfm3-omni", "lfm3-omni-2b"):
        return
    raise HTTPException(404, f"Unknown model: {value}")


def make_cache(prompt_tokens, budget):
    """Fresh StaticCache sized for one request, or None when disabled.

    Static cache keeps decode-step shapes fixed so the compiled
    language_model graph is reused every step instead of reallocating a
    growing DynamicCache.
    """
    if not STATIC_CACHE_ENABLED or "model" not in STATE:
        return None
    from transformers.cache_utils import StaticCache
    # Pin to full context: per-request sizing made every distinct
    # prompt+budget a fresh compiled-graph guard (the TTFT stalls).
    size = CONTEXT_TOKENS + 32
    return StaticCache(
        config=STATE["model"].config.text_config, max_cache_len=size)


def run_generate(inputs, gen_kwargs, extra=None):
    """model.generate with a request-scoped StaticCache injected."""
    kw = dict(gen_kwargs)
    if extra:
        kw.update(extra)
    if "past_key_values" not in kw:
        try:
            budget = int(kw["generation_config"].max_new_tokens)
        except (KeyError, AttributeError, TypeError):
            budget = MAX_NEW_TOKENS
        cache = make_cache(int(inputs["input_ids"].shape[1]), budget)
        if cache is not None:
            kw["past_key_values"] = cache
    return STATE["model"].generate(
        **inputs, return_dict_in_generate=True, **kw)


def batch_key(request, gen_kwargs):
    # Media and seeded requests retain their dedicated generation path.
    if request.seed is not None or gen_kwargs.get("generation_mode") not in (None, "text"):
        return None
    if any(not isinstance(m.get("content", ""), (str, type(None)))
           for m in request.messages):
        return None
    config = gen_kwargs["generation_config"]
    return json.dumps({**gen_kwargs, "generation_config": config.to_dict()},
                      sort_keys=True, default=str)


def execute_chat(conversation, request, gen_kwargs, video_metas, extra=None):
    key = batch_key(request, gen_kwargs)
    if key is None or BATCH_MAX_SIZE < 2:
        with gen_slot(request.seed is not None), torch.inference_mode():
            if request.seed is not None:
                torch.manual_seed(int(request.seed))
            inputs, count = _build_inputs(conversation, request, video_metas)
            return run_generate(inputs, gen_kwargs, extra), count
    future = Future()
    try:
        BATCH_QUEUE.put_nowait((key, conversation, request, gen_kwargs, extra, future))
    except queue.Full:
        raise HTTPException(503, "Generation queue is full")
    return future.result()


def batch_worker():
    pending = []
    while True:
        first = pending.pop(0) if pending else BATCH_QUEUE.get()
        jobs = [first]
        deadline = time.monotonic() + BATCH_WAIT_SECONDS
        while len(jobs) < BATCH_MAX_SIZE:
            try:
                job = BATCH_QUEUE.get(timeout=max(0, deadline - time.monotonic()))
            except queue.Empty:
                break
            if job[0] == first[0]:
                jobs.append(job)
            else:
                pending.append(job)
            if time.monotonic() >= deadline:
                break
        try:
            with gen_slot(), torch.inference_mode():
                prepared = [_build_inputs(j[1], j[2]) for j in jobs]
                width = max(count for _, count in prepared)
                pad = STATE["tokenizer"].pad_token_id
                if pad is None:
                    pad = STATE["tokenizer"].eos_token_id
                ids = torch.full((len(jobs), width), pad, dtype=torch.long, device=DEVICE)
                mask = torch.zeros_like(ids)
                for row, (inputs, count) in enumerate(prepared):
                    ids[row, -count:] = inputs["input_ids"][0]
                    mask[row, -count:] = 1
                extra = {}
                for name in ("streamer", "audio_streamer"):
                    values = [(j[4] or {}).get(name) for j in jobs]
                    if any(v is not None for v in values):
                        extra[name] = values
                out = run_generate({"input_ids": ids, "attention_mask": mask}, first[3], extra)
                for row, job in enumerate(jobs):
                    count = prepared[row][1]
                    offset = width - count
                    result = SimpleNamespace(
                        sequences=out.sequences[row:row + 1, offset:],
                        sequence_lengths=out.sequence_lengths[row:row + 1] - offset,
                        audio_codes=out.audio_codes[row:row + 1],
                        audio_lengths=out.audio_lengths[row:row + 1])
                    job[5].set_result((result, count))
                BATCH_STATS["batches"] += 1
                BATCH_STATS["batched_requests"] += len(jobs)
                BATCH_STATS["largest_batch"] = max(BATCH_STATS["largest_batch"], len(jobs))
        except BaseException as exc:
            for job in jobs:
                if not job[5].done():
                    job[5].set_exception(exc)


def build_generation_kwargs(request):
    """Map OpenAI + extension fields onto Lfm3OmniForConditionalGeneration.generate."""
    model = STATE["model"]
    config = model.generation_config.__class__(**model.generation_config.to_dict())
    if request.temperature is not None:
        config.do_sample = request.temperature > 0
        config.temperature = max(request.temperature, 1e-5)
        if config.do_sample and config.top_k in (None, 1):
            config.top_k = 50
    if request.top_p is not None:
        config.top_p = request.top_p
        config.do_sample = True
    if request.top_k is not None:
        config.top_k = request.top_k
        config.do_sample = True
    if request.min_p is not None:
        config.min_p = request.min_p
        config.do_sample = True
    if request.repetition_penalty is not None:
        config.repetition_penalty = request.repetition_penalty
    if request.presence_penalty or request.frequency_penalty:
        raise HTTPException(400, "presence/frequency_penalty are unsupported; use repetition_penalty")
    budget = request.max_completion_tokens or request.max_tokens or 512
    if not 1 <= budget <= MAX_NEW_TOKENS:
        raise HTTPException(400, f"max_tokens must be within 1..{MAX_NEW_TOKENS}")
    config.max_new_tokens = budget
    mode = request.generation_mode
    if request.modalities:
        modes = set(request.modalities)
        if "audio" in modes and "text" in modes:
            mode = mode or "interleaved"
        elif "audio" in modes:
            mode = mode or "audio"
        elif modes == {"text"}:
            mode = mode or "text"
    if mode is not None and mode not in ("text", "audio", "interleaved"):
        raise HTTPException(400, "generation_mode must be text, audio, or interleaved")
    kwargs = {"generation_config": config, "generation_mode": mode}
    for field in ("audio_temperature", "audio_top_k", "audio_repetition_penalty",
                  "audio_repetition_window", "text_repetition_window",
                  "suppress_mixed", "suppress_audio_out"):
        value = getattr(request, field, None)
        if value is not None:
            kwargs[field] = value
    return kwargs


def apply_response_format(conversation, fmt):
    """JSON-mode prompting; the model has no grammar decoder."""
    if not fmt:
        return
    kind = fmt.get("type")
    if kind in (None, "text"):
        return
    if kind == "json_schema":
        schema = fmt.get("json_schema") or {}
        body = schema.get("schema") if isinstance(schema, dict) else None
        instruction = ("Respond with a single JSON object that validates against this "
                       f"JSON schema, and nothing else:\n{json.dumps(body)}")
    elif kind == "json_object":
        instruction = "Respond with a single valid JSON object and nothing else."
    else:
        raise HTTPException(400, f"unsupported response_format: {kind}")
    system = next((m for m in conversation if m["role"] == "system"), None)
    if system is None:
        conversation.insert(0, {"role": "system", "content": instruction})
    elif isinstance(system.get("content"), str):
        system["content"] = system["content"] + "\n\n" + instruction
    else:
        system.setdefault("content", []).append({"type": "text", "text": instruction})


def template_inputs(conversation, request=None, video_metas=None):
    processor = STATE["processor"]
    kwargs = {"tools": request.tools if request else None,
              "add_generation_prompt": True, "tokenize": True,
              "return_dict": True, "return_tensors": "pt"}
    if request and request.load_audio_from_video:
        kwargs["load_audio_from_video"] = True
    if request and request.use_audio_in_video:
        kwargs["use_audio_in_video"] = True
    if video_metas:
        kwargs["video_metadata"] = video_metas
    inputs = processor.apply_chat_template(conversation, **kwargs)
    return inputs.to(STATE["model"].device)


def truncate_stops(text, stops):
    if not stops:
        return text
    stops = [stops] if isinstance(stops, str) else stops
    cut = len(text)
    for token in stops:
        if token:
            at = text.find(token)
            if at >= 0:
                cut = min(cut, at)
    return text[:cut]


def decode_speech(out):
    """Return 24kHz mono float32 or None from a generate() output."""
    codes = getattr(out, "audio_codes", None)
    lengths = getattr(out, "audio_lengths", None)
    if codes is None or lengths is None or not lengths[0].item():
        return None
    with torch.inference_mode():
        decoded = STATE["codec"].decode(
            codes[:1, :, : int(lengths[0])], return_dict=True)
    return decoded.audio_values[0].float().cpu().numpy()


def sse(payload):
    return "data: " + json.dumps(payload) + "\n\n"


def base_chunk(request_id, model_id, created):
    return {"id": request_id, "object": "chat.completion.chunk", "created": created,
            "model": model_id, "choices": [{"index": 0, "delta": {}, "finish_reason": None}]}


def _build_inputs(conversation, request, video_metas=None):
    """Render the chat template and move inputs to the GPU; runs under LOCK."""
    inputs = template_inputs(conversation, request, video_metas)
    return inputs, int(inputs["input_ids"].shape[1])


async def stream_chat(request, conversation, gen_kwargs, video_metas=None):
    """Generate in a worker thread; stream text deltas and PCM16 audio chunks."""
    from transformers.generation.streamers import TextIteratorStreamer
    request_id = "chatcmpl-" + uuid.uuid4().hex[:24]
    created = int(time.time())
    sink = queue.Queue()
    tokenizer = STATE["tokenizer"]
    text_streamer = TextIteratorStreamer(
        tokenizer, skip_prompt=True, skip_special_tokens=True)
    audio_streamer = AudioChunkStreamer(STATE["codec"], sink)
    holder = {}

    def pump():
        try:
            for text in text_streamer:
                sink.put(("text", text))
        except BaseException as exc:
            sink.put(("error", exc))

    def work():
        try:
            holder["out"], holder["prompt_tokens"] = execute_chat(
                conversation, request, gen_kwargs, video_metas,
                {"streamer": text_streamer, "audio_streamer": audio_streamer})
            sink.put(("done", None))
        except BaseException as exc:
            sink.put(("error", exc))

    yield sse({**base_chunk(request_id, REPOSITORY, created),
               "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}]})
    loop = asyncio.get_event_loop()
    threading.Thread(target=pump, daemon=True).start()
    threading.Thread(target=work, daemon=True).start()
    text_parts = []
    while True:
        kind, payload = await loop.run_in_executor(None, sink.get)
        if kind == "text":
            text_parts.append(payload)
            yield sse({**base_chunk(request_id, REPOSITORY, created),
                       "choices": [{"index": 0, "delta": {"content": payload},
                                    "finish_reason": None}]})
        elif kind == "audio":
            yield sse({**base_chunk(request_id, REPOSITORY, created),
                       "choices": [{"index": 0, "delta": {
                           "audio": {"data": base64.b64encode(payload).decode(),
                                     "format": "pcm16", "sample_rate": 24000}},
                           "finish_reason": None}]})
        elif kind == "done":
            break
        elif kind == "error":
            if isinstance(payload, HTTPException):
                raise payload
            raise HTTPException(500, f"Generation failed: {payload}")
    full_text = "".join(text_parts)
    clean_text, tool_calls = parse_generated_tool_calls(full_text)
    coerce_tool_arguments(tool_calls, request.tools)
    if tool_calls:
        for index, call in enumerate(tool_calls):
            yield sse({**base_chunk(request_id, REPOSITORY, created),
                       "choices": [{"index": 0, "delta": {"tool_calls": [{
                           "index": index, **call,
                           "function": {"name": call["function"]["name"],
                                        "arguments": call["function"]["arguments"]}}]},
                           "finish_reason": None}]})
    out = holder.get("out")
    completion_tokens = None
    if out is not None and getattr(out, "sequence_lengths", None) is not None:
        completion_tokens = int(out.sequence_lengths[0].item()) - holder.get("prompt_tokens", 0)
    COUNTERS["tokens_out"] += completion_tokens or 0
    chunk = base_chunk(request_id, REPOSITORY, created)
    chunk["choices"][0]["finish_reason"] = "tool_calls" if tool_calls else "stop"
    if not request.stream_options or request.stream_options.get("include_usage"):
        prompt_tokens = holder.get("prompt_tokens", 0)
        chunk["usage"] = {"prompt_tokens": prompt_tokens,
                          "completion_tokens": completion_tokens,
                          "total_tokens": prompt_tokens + (completion_tokens or 0)}
    yield sse(chunk)
    yield "data: [DONE]\n\n"


async def run_chat(request):
    check_model_alias(request.model)
    if request.n not in (None, 1):
        raise HTTPException(400, "n must be 1")
    tools = request.tools or [
        {"type": "function", "function": f} for f in (request.functions or [])] or None
    if request.tool_choice == "none":
        tools = None
    conversation, video_metas = normalize_messages(
        request.messages, bool(request.use_audio_in_video))
    apply_response_format(conversation, request.response_format)
    work_request = request if tools == request.tools else \
        request.model_copy(update={"tools": tools})
    gen_kwargs = build_generation_kwargs(work_request)
    if work_request.stream:
        COUNTERS["requests"] += 1
        COUNTERS["chat"] += 1
        return StreamingResponse(
            stream_chat(work_request, conversation, gen_kwargs, video_metas),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
    request_id = "chatcmpl-" + uuid.uuid4().hex[:24]
    created = int(time.time())
    holder = {}

    def work():
        holder["out"], holder["prompt_tokens"] = execute_chat(
            conversation, work_request, gen_kwargs, video_metas)
    try:
        await asyncio.get_event_loop().run_in_executor(None, work)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(500, f"Generation failed: {exc}")
    if "error" in holder:
        raise HTTPException(500, f"Generation failed: {holder['error']}")
    out = holder.get("out")
    if out is None:
        raise HTTPException(500, "Generation produced no output")
    COUNTERS["requests"] += 1
    COUNTERS["chat"] += 1
    prompt_tokens = holder.get("prompt_tokens", 0)
    seq_len = int(out.sequence_lengths[0].item()) \
        if getattr(out, "sequence_lengths", None) is not None else out.sequences.shape[1]
    text = STATE["tokenizer"].decode(out.sequences[0, prompt_tokens:seq_len],
                                     skip_special_tokens=True)
    clean_text, tool_calls = parse_generated_tool_calls(text)
    coerce_tool_arguments(tool_calls, work_request.tools)
    clean_text = truncate_stops(clean_text, request.stop)
    speech = decode_speech(out)
    completion_tokens = seq_len - prompt_tokens
    COUNTERS["tokens_out"] += completion_tokens
    message = {"role": "assistant", "content": clean_text or None}
    if tool_calls:
        message["tool_calls"] = tool_calls
    if speech is not None and speech.size:
        message["audio"] = {"data": base64.b64encode(wav_bytes(speech)).decode(),
                            "format": "wav", "sample_rate": 24000,
                            "transcript": clean_text}
        if request.audio and request.audio.get("format") == "pcm16":
            message["audio"]["format"] = "pcm16"
            message["audio"]["data"] = base64.b64encode(pcm16_bytes(speech)).decode()
    return {"id": request_id, "object": "chat.completion", "created": created,
            "model": REPOSITORY,
            "choices": [{"index": 0, "message": message,
                         "finish_reason": "tool_calls" if tool_calls else "stop"}],
            "usage": {"prompt_tokens": prompt_tokens,
                      "completion_tokens": completion_tokens,
                      "total_tokens": prompt_tokens + completion_tokens}}


@app.post("/v1/chat/completions")
async def chat_completions(request: ChatRequest):
    require_model()
    return await run_chat(request)


def asr_conversation(waveform, language=None, hint=None):
    target = f"Perform ASR in {language}." if language else "Perform ASR."
    if hint:
        target += f" Context: {hint}"
    return [{"role": "system", "content": target},
            {"role": "user", "content": [{"type": "audio", "audio": waveform}]}]


async def run_transcription(waveform, language, hint, temperature):
    conversation = asr_conversation(waveform, language, hint)
    holder = {}
    gen_kwargs = build_generation_kwargs(ChatRequest(
        messages=[{"role": "user", "content": "x"}], temperature=temperature))
    gen_kwargs["generation_mode"] = "text"

    def work():
        with gen_slot():
            inputs = template_inputs(conversation)
            holder["prompt_tokens"] = int(inputs["input_ids"].shape[1])
            with torch.inference_mode():
                holder["out"] = run_generate(inputs, gen_kwargs)
    await asyncio.get_event_loop().run_in_executor(None, work)
    out = holder["out"]
    prompt_tokens = holder["prompt_tokens"]
    seq_len = int(out.sequence_lengths[0].item()) \
        if getattr(out, "sequence_lengths", None) is not None else out.sequences.shape[1]
    return STATE["tokenizer"].decode(
        out.sequences[0, prompt_tokens:seq_len], skip_special_tokens=True).strip()


async def stream_transcription(waveform, language):
    """Feed the clip through transcribe_live, yielding partial transcripts."""
    processor = STATE["processor"]
    model = STATE["model"]
    extractor = processor.feature_extractor
    prompt = processor.apply_chat_template(
        asr_conversation(np.zeros(1600, np.float32), language)[:1],
        add_generation_prompt=True, tokenize=False)
    prompt_ids = processor.tokenizer(
        prompt, return_tensors="pt", add_special_tokens=False).input_ids.to(model.device)
    suppress = [i for i in (special_id("mixed_end"), special_id("endoftext"))
                if i is not None] or None
    stop = [i for i in (special_id("endoftext"), special_id("im_start"))
            if i is not None] or None
    sink = queue.Queue()

    def work():
        box = {"state": None, "cache": None, "prompt": prompt_ids}
        offset = 0
        chunk = 16000
        try:
            with gen_slot(), torch.inference_mode():
                while offset < len(waveform):
                    part = waveform[offset:offset + chunk]
                    offset += len(part)
                    final = offset >= len(waveform)
                    features, box["cache"] = extractor.stream(
                        part, cache=box["cache"], is_final=final)
                    feats = features["input_features"].to(model.device)
                    if not feats.shape[-1] and not final:
                        continue
                    out = model.transcribe_live(
                        feats, state=box["state"], input_ids=box["prompt"],
                        is_final=final, suppress_token_ids=suppress,
                        stop_token_ids=stop)
                    box["state"] = out.state
                    box["prompt"] = None
                    if out.sequences is not None and out.sequences.numel():
                        text = STATE["tokenizer"].decode(
                            out.sequences[0], skip_special_tokens=True)
                        if text:
                            sink.put(("text", text))
            sink.put(("done", None))
        except BaseException as exc:
            sink.put(("error", exc))

    threading.Thread(target=work, daemon=True).start()
    loop = asyncio.get_event_loop()
    while True:
        kind, payload = await loop.run_in_executor(None, sink.get)
        if kind == "text":
            yield sse({"object": "transcription.delta", "delta": {"text": payload}})
        elif kind == "done":
            yield "data: [DONE]\n\n"
            return
        else:
            yield sse({"object": "error",
                       "error": {"message": f"transcription failed: {payload}"}})
            yield "data: [DONE]\n\n"
            return


@app.post("/v1/audio/transcriptions")
async def transcriptions(request: Request):
    require_model()
    form = await request.form()
    file = form.get("file")
    model = form.get("model")
    check_model_alias(model if isinstance(model, str) else None)
    fmt = str(form.get("response_format") or "json")
    if fmt in ("srt", "vtt"):
        raise HTTPException(400, f"response_format {fmt} is not supported; use json, text or verbose_json")
    if fmt not in ("json", "text", "verbose_json"):
        raise HTTPException(400, f"unsupported response_format: {fmt}")
    language = form.get("language")
    language = str(language) if isinstance(language, str) and language else None
    hint = form.get("prompt")
    hint = str(hint) if isinstance(hint, str) and hint else None
    stream = str(form.get("stream") or "").lower() in ("1", "true", "yes")
    temperature = form.get("temperature")
    try:
        temperature = float(temperature) if temperature not in (None, "") else None
    except ValueError:
        raise HTTPException(400, "temperature must be a number")
    if file is None:
        raise HTTPException(400, "file is required")
    data = await file.read() if hasattr(file, "read") else bytes(file)
    if not data:
        raise HTTPException(400, "empty audio file")
    waveform = decode_audio_bytes(data, "audio file")
    COUNTERS["requests"] += 1
    COUNTERS["asr"] += 1
    if stream:
        return StreamingResponse(
            stream_transcription(waveform, language),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
    text = await run_transcription(waveform, language, hint, temperature)
    if fmt == "text":
        return Response(text, media_type="text/plain")
    if fmt == "verbose_json":
        return {"text": text, "duration": round(float(len(waveform)) / 16000.0, 3),
                "language": language or "auto", "task": "transcribe"}
    return {"text": text}


def tts_conversation(request):
    voice = request.voice or "a natural voice"
    language = f" in {request.language}" if request.language else ""
    detail = f" {request.instructions.strip()}" if request.instructions else ""
    return [{"role": "system", "content": f"Perform TTS{language} using {voice}.{detail}"},
            {"role": "user", "content": request.input}]


@app.post("/v1/audio/speech")
async def speech(request: SpeechRequest):
    require_model()
    check_model_alias(request.model)
    conversation = tts_conversation(request)
    kwargs = {"generation_mode": "audio"}
    for field in ("audio_temperature", "audio_repetition_penalty", "audio_repetition_window"):
        value = getattr(request, field, None)
        if value is not None:
            kwargs[field] = value
    holder = {}
    if request.stream:
        from transformers.generation.streamers import TextIteratorStreamer
        sink = queue.Queue()
        streamer = AudioChunkStreamer(STATE["codec"], sink)
        text_streamer = TextIteratorStreamer(
            STATE["tokenizer"], skip_prompt=True, skip_special_tokens=True)

        def pump():
            try:
                for _ in text_streamer:
                    pass
            except BaseException:
                pass

        def work():
            try:
                with gen_slot(), torch.inference_mode():
                    inputs = template_inputs(conversation)
                    run_generate(inputs, kwargs,
                                 {"streamer": text_streamer,
                                  "audio_streamer": streamer})
                sink.put(("done", None))
            except BaseException as exc:
                sink.put(("error", exc))

        async def events():
            yield 'data: {"object":"speech.stream.start","format":"pcm16","sample_rate":24000}\n\n'
            loop = asyncio.get_event_loop()
            threading.Thread(target=pump, daemon=True).start()
            threading.Thread(target=work, daemon=True).start()
            while True:
                kind, payload = await loop.run_in_executor(None, sink.get)
                if kind == "audio":
                    yield sse({"object": "speech.chunk",
                               "data": base64.b64encode(payload).decode(),
                               "format": "pcm16", "sample_rate": 24000})
                elif kind == "done":
                    yield "data: [DONE]\n\n"
                    return
                elif kind == "error":
                    yield sse({"object": "error",
                               "error": {"message": f"speech failed: {payload}"}})
                    yield "data: [DONE]\n\n"
                    return
        COUNTERS["requests"] += 1
        COUNTERS["tts"] += 1
        return StreamingResponse(events(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    def work():
        with gen_slot():
            inputs = template_inputs(conversation)
            with torch.inference_mode():
                holder["out"] = run_generate(inputs, kwargs)
    try:
        await asyncio.get_event_loop().run_in_executor(None, work)
    except Exception as exc:
        raise HTTPException(500, f"Generation failed: {exc}")
    COUNTERS["requests"] += 1
    COUNTERS["tts"] += 1
    pcm = decode_speech(holder.get("out"))
    if pcm is None or not pcm.size:
        raise HTTPException(500, "The model produced no speech")
    fmt = (request.response_format or "wav").lower()
    if fmt == "wav":
        return Response(wav_bytes(pcm), media_type="audio/wav")
    if fmt == "pcm16":
        return Response(pcm16_bytes(pcm), media_type="application/octet-stream")
    raise HTTPException(400, "response_format must be wav or pcm16")


@app.post("/tokenize")
def tokenize(request: TokenizeRequest):
    require_model()
    check_model_alias(request.model)
    processor = STATE["processor"]
    if request.messages is not None:
        conversation, metas = normalize_messages(
            request.messages, bool(getattr(request, "use_audio_in_video", False)))
        tools = getattr(request, "tools", None)
        if getattr(request, "tool_choice", None) == "none":
            tools = None
        kwargs = {"add_generation_prompt": request.add_generation_prompt,
                  "tools": tools, "tokenize": True,
                  "return_dict": True, "return_tensors": "pt"}
        for flag in ("use_audio_in_video", "load_audio_from_video"):
            if getattr(request, flag, False):
                kwargs[flag] = True
        if metas:
            kwargs["video_metadata"] = metas
        with LOCK:
            inputs = processor.apply_chat_template(conversation, **kwargs)
        count = int(inputs["input_ids"].shape[-1])
        return {"tokens": count, "count": count, "max_model_len": CONTEXT_TOKENS}
    if request.prompt is None:
        raise HTTPException(400, "prompt or messages is required")
    ids = processor.tokenizer(request.prompt, add_special_tokens=True).input_ids
    return {"tokens": len(ids), "count": len(ids), "max_model_len": CONTEXT_TOKENS}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [
        {"id": REPOSITORY, "object": "model", "owned_by": "LiquidAI",
         "max_model_len": CONTEXT_TOKENS},
        {"id": MODEL_NAME, "object": "model", "owned_by": "SignalREACH",
         "max_model_len": CONTEXT_TOKENS},
    ]}


@app.get("/health")
def health():
    ready = "model" in STATE
    payload = {"status": "ready" if ready else "loading", "model": MODEL_NAME,
               "repository": REPOSITORY, "counters": dict(COUNTERS),
               "context_tokens": CONTEXT_TOKENS,
               "max_concurrent": MAX_CONCURRENT,
               "batching": {"max_size": BATCH_MAX_SIZE, "queued": BATCH_QUEUE.qsize(),
                            **BATCH_STATS},
               "features": ["chat", "vision", "video", "audio-in", "speech-out",
                            "tool-calls", "streaming", "live-transcription"],
               "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""}
    if ready:
        payload["allocated_bytes"] = torch.cuda.memory_allocated(0)
        payload["reserved_bytes"] = torch.cuda.memory_reserved(0)
    return payload


@app.exception_handler(HTTPException)
async def http_error(_request, exc):
    return JSONResponse({"error": {"message": exc.detail, "type": "invalid_request_error",
                                  "code": exc.status_code}}, status_code=exc.status_code)


@app.exception_handler(Exception)
async def unhandled_error(_request, exc):
    return JSONResponse({"error": {"message": str(exc), "type": "server_error",
                                  "code": 500}}, status_code=500)


@app.middleware("http")
async def limit_body(request, call_next):
    length = request.headers.get("content-length")
    if length and int(length) > MAX_BODY_BYTES:
        return JSONResponse({"error": {"message": "request body too large"}},
                            status_code=413)
    return await call_next(request)
