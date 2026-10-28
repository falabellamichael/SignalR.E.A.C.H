"""LFM3-VL service using the shared private API's media and tool adapters."""
import asyncio
import json
import logging
import os
import queue
import threading
import time
import uuid
from contextlib import asynccontextmanager

import torch
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
import lfm3_api as base

base.MODEL_NAME = "lfm3-vl-2b"
base.REPOSITORY = "LiquidAI/LFM3-VL-2B"
base.CONTEXT_TOKENS = 131072
base.MAX_NEW_TOKENS = 16384

# max_length pins the static cache size; max_new_tokens still wins on
# budget — the co-set warning is expected and suppressed.
class _MaxLenNotice(logging.Filter):
    def filter(self, record):
        return "max_new_tokens" not in record.getMessage()

logging.getLogger("transformers").addFilter(_MaxLenNotice())

# Batched decode measured SLOWER than serial on this GPU: a padded B=4
# graph runs ~15 tok/s per row (~44 t/s aggregate) vs ~68 t/s solo, and
# 2-3 concurrent decode loops on separate streams total ~70 t/s — the card
# is saturated by a single compiled decode. Default off; the machinery
# stays env-gated for future hardware/kernels.
BATCH_MAX_SIZE = int(os.environ.get("LFM3_BATCH_MAX_SIZE", "1"))
BATCH_WAIT_SECONDS = float(os.environ.get("LFM3_BATCH_WAIT", "0.02"))
BATCH_CACHE_LEN = int(os.environ.get("LFM3_BATCH_CACHE_LEN", "8192"))
BATCH_QUEUE = queue.Queue(maxsize=256)
BATCH_STATS = {"batches": 0, "batched_requests": 0, "largest_batch": 0}


@asynccontextmanager
async def lifespan(app):
    from transformers import AutoModelForImageTextToText, AutoProcessor
    path = str(base.ROOT / base.MODEL_NAME)
    torch.set_num_threads(2)
    base.STATE["processor"] = AutoProcessor.from_pretrained(
        path, trust_remote_code=True, local_files_only=True)
    model = AutoModelForImageTextToText.from_pretrained(
        path, trust_remote_code=True, local_files_only=True,
        dtype=torch.bfloat16, attn_implementation="sdpa").eval().to(base.DEVICE)
    base.STATE["model"] = model
    base.STATE["tokenizer"] = base.STATE["processor"].tokenizer
    if base.COMPILE_ENABLED:
        # Decode-only compile: sequence-1 steps go through a specialized
        # graph (~2.3x decode), prefill stays eager so every prompt length
        # shares zero recompiles. Compiling prefill is the TTFT killer:
        # every new length triggered a ~40s dynamo recompile, and sliding
        # window / int-guard variants can cascade past the recompile limit.
        # reduce-overhead cudagraph mode crashes on this ROCm build.
        try:
            torch._dynamo.config.recompile_limit = 64
            orig_forward = model.forward
            decode_forward = torch.compile(orig_forward, dynamic=False)

            def dispatch(*args, **kwargs):
                ids = kwargs.get("input_ids", args[0] if args else None)
                embeds = kwargs.get("inputs_embeds")
                length = (embeds.shape[-2] if embeds is not None
                          else ids.shape[-1] if ids is not None else 0)
                call = decode_forward if length == 1 else orig_forward
                return call(*args, **kwargs)

            model.forward = dispatch
            base.STATE["compiled"] = True
        except Exception as exc:
            base.STATE["compiled"] = False
            print(json.dumps({"compile_failed": str(exc)}), flush=True)
    print(json.dumps({"loaded": base.MODEL_NAME, "repository": base.REPOSITORY,
                      "compiled": base.STATE.get("compiled", False)}), flush=True)
    if base.STATE.get("compiled") and os.environ.get("LFM3_COMPILE_WARMUP", "1") != "0":
        try:
            # Warm every guard variant seen in profiling: cache below the
            # 256-token sliding window and above it, plus a second short
            # prompt for mask-shape variants. max_length pins the internal
            # static cache so decode shapes never vary per request.
            with torch.inference_mode():
                for words in (4, 60, 400):
                    text = "hello " * words
                    warm = base.STATE["processor"].apply_chat_template(
                        [{"role": "user",
                          "content": [{"type": "text", "text": text}]}],
                        add_generation_prompt=True, tokenize=True,
                        return_dict=True, return_tensors="pt",
                        enable_thinking=False).to(base.DEVICE)
                    model.generate(**warm, max_new_tokens=6, do_sample=False,
                                   cache_implementation="static",
                                   max_length=base.CONTEXT_TOKENS)
                if BATCH_MAX_SIZE >= 2:
                    # Batched requests run one padded B=BATCH_MAX_SIZE decode
                    # at C=BATCH_CACHE_LEN — a distinct compiled graph that
                    # must exist before the first multi-call or it pays ~40s.
                    tok = base.STATE["tokenizer"]
                    pad = tok.pad_token_id
                    if pad is None:
                        pad = tok.eos_token_id
                    ids = torch.full((BATCH_MAX_SIZE, 16), pad,
                                     dtype=torch.long, device=base.DEVICE)
                    mask = torch.ones_like(ids)
                    model.generate(input_ids=ids, attention_mask=mask,
                                   max_new_tokens=6, do_sample=False,
                                   cache_implementation="static",
                                   max_length=BATCH_CACHE_LEN)
            if base.MAX_CONCURRENT > 1:
                # Each concurrent request owns a ~4.3 GB static cache.
                # Sequential warm calls reuse the already-compiled graph and
                # pre-stage the allocator blocks — parallel first-compile
                # deadlocks dynamo's compile lock.
                with torch.inference_mode():
                    for i in range(base.MAX_CONCURRENT - 1):
                        warm = base.STATE["processor"].apply_chat_template(
                            [{"role": "user",
                              "content": [{"type": "text",
                                           "text": "hi" * (i + 2)}]}],
                            add_generation_prompt=True, tokenize=True,
                            return_dict=True, return_tensors="pt",
                            enable_thinking=False).to(base.DEVICE)
                        model.generate(**warm, max_new_tokens=4,
                                       do_sample=False,
                                       cache_implementation="static",
                                       max_length=base.CONTEXT_TOKENS)
            print(json.dumps({"compile_warmup": "done",
                              "concurrency": base.MAX_CONCURRENT}), flush=True)
        except Exception as exc:
            print(json.dumps({"compile_warmup": "failed",
                              "error": str(exc)}), flush=True)
    threading.Thread(target=batch_worker, daemon=True,
                     name="lfm3-vl-batcher").start()
    yield
    base.STATE.clear()


def check_alias(value):
    if value not in (None, "lfm3-vl-2b", "LiquidAI/LFM3-VL-2B",
                     "lfm3-omni-2b", "LiquidAI/LFM3-Omni-2B", "lfm3"):
        raise HTTPException(404, "Unknown model")


def prepare(request):
    conversation, metas = base.normalize_messages(request.messages)
    for original, normalized in zip(request.messages, conversation):
        if original.get("reasoning_content") is not None:
            normalized["reasoning_content"] = original["reasoning_content"]
    tools = getattr(request, "tools", None)
    if getattr(request, "tool_choice", None) == "none":
        tools = None
    kwargs = {"tools": tools, "tokenize": True, "return_dict": True,
              "return_tensors": "pt", "add_generation_prompt": True}
    template = getattr(request, "chat_template_kwargs", None) or {}
    kwargs["enable_thinking"] = template.get("enable_thinking", True)
    if metas:
        kwargs["video_metadata"] = metas
    return base.STATE["processor"].apply_chat_template(conversation, **kwargs), kwargs["enable_thinking"]


def parse_output(text, thinking, tools):
    reasoning = None
    if thinking:
        reasoning, separator, answer = text.partition("</think>")
        reasoning = reasoning.removeprefix("<think>").strip()
        text = answer if separator else ""
    content, calls = base.parse_generated_tool_calls(text)
    base.coerce_tool_arguments(calls, tools)
    message = {"role": "assistant", "content": content or None}
    if reasoning is not None:
        message["reasoning_content"] = reasoning
    if calls:
        message["tool_calls"] = calls
    return message


def _gen_kwargs(request, budget):
    temperature = request.temperature if request.temperature is not None else 0.1
    kwargs = {"max_new_tokens": budget, "do_sample": temperature > 0,
              "repetition_penalty": request.repetition_penalty or 1.1}
    if temperature > 0:
        kwargs.update(temperature=temperature, top_p=request.top_p or 1.0,
                      top_k=request.top_k if request.top_k is not None else 50)
    if base.STATIC_CACHE_ENABLED:
        kwargs["cache_implementation"] = "static"
        # Pin the static cache to full context so compiled decode
        # graph shapes never vary between requests.
        kwargs["max_length"] = base.CONTEXT_TOKENS
    return kwargs


def _preflight(request, budget):
    inputs, thinking = prepare(request)
    inputs = inputs.to(base.DEVICE)
    count = int(inputs["input_ids"].shape[1])
    if count + budget > base.CONTEXT_TOKENS:
        raise HTTPException(400, "Input and output exceed the context window")
    return inputs, thinking, count


def _batch_key(request, budget, streaming):
    """Identical generate()-signature jobs may share one batched decode."""
    if request.seed is not None:
        return None
    if any(not isinstance(m.get("content", ""), (str, type(None)))
           for m in request.messages):
        return None
    return json.dumps({
        "temperature": request.temperature, "top_p": request.top_p,
        "top_k": request.top_k, "rep": request.repetition_penalty,
        "budget": budget, "stream": streaming})


def _end_ids():
    ids = set()
    tok = base.STATE["tokenizer"]
    for value in (tok.pad_token_id, tok.eos_token_id):
        if value is not None:
            ids.add(int(value))
    for name in ("im_end", "endoftext"):
        idx = base.special_id(name)
        if idx is not None:
            ids.add(int(idx))
    return ids


_END_TEXT_MARKERS = tuple("<" + "|" + n + "|" + ">" for n in ("im_end", "endoftext"))


def _message(job):
    generated = job["generated_ids"]
    text = base.STATE["tokenizer"].decode(generated, skip_special_tokens=False)
    for marker in _END_TEXT_MARKERS:
        text = text.split(marker)[0]
    message = parse_output(text, job["thinking"], job["request"].tools)
    if message["content"]:
        message["content"] = base.truncate_stops(message["content"], job["request"].stop)
    reason = ("tool_calls" if message.get("tool_calls")
              else "length" if job["generated"] >= job["budget"] else "stop")
    usage = {"prompt_tokens": job["count"], "completion_tokens": job["generated"],
             "total_tokens": job["count"] + job["generated"]}
    return message, reason, usage


class _RowDemux:
    """Fans a batched streamer.put([B, k]) out to per-row streamers."""

    def __init__(self, streamers, end_ids):
        self.streamers = streamers
        self.end_ids = end_ids
        self.first = True
        self.ended = [s is None for s in streamers]

    def put(self, value):
        v = value if torch.is_tensor(value) else torch.tensor(value)
        if v.dim() == 1:
            v = v.unsqueeze(0)
        if v.shape[0] == 1 and len(self.streamers) > 1:
            v = v.expand(len(self.streamers), -1)
        if self.first:
            # First put is the prompt; forward rows verbatim, no end scan.
            self.first = False
            for row, stream in enumerate(self.streamers):
                if stream is not None:
                    stream.put(v[row:row + 1])
            return
        for row, stream in enumerate(self.streamers):
            if stream is None or self.ended[row]:
                continue
            toks = v[row].tolist()
            hit = next((i for i, t in enumerate(toks) if t in self.end_ids), None)
            if hit is None:
                stream.put(v[row:row + 1])
            else:
                if hit:
                    stream.put(v[row:row + 1, :hit])
                stream.end()
                self.ended[row] = True

    def end(self):
        for stream in self.streamers:
            if stream is not None:
                stream.end()


def _run_solo(job):
    try:
        with base.gen_slot(job["request"].seed is not None), torch.inference_mode():
            if job["request"].seed is not None:
                torch.manual_seed(job["request"].seed)
            kwargs = dict(job["gen_kwargs"])
            if job.get("streamer") is not None:
                kwargs["streamer"] = job["streamer"]
                kwargs["stopping_criteria"] = [job["stop_flag"]]
            out = base.STATE["model"].generate(**job["inputs"], **kwargs)
            job["generated_ids"] = out[0, job["count"]:]
            job["generated"] = int(job["generated_ids"].shape[0])
    except BaseException as exc:
        job["error"] = exc
        if job.get("sink") is not None:
            job["sink"].put(("error", exc))
    finally:
        job["done"].set()


def _run_batch(jobs):
    """One generate() for same-signature jobs, padded to B=BATCH_MAX_SIZE."""
    if len(jobs) == 1:
        _run_solo(jobs[0])
        j = jobs[0]
        if j.get("future") is not None:
            if j.get("error") is not None:
                j["future"].set_exception(j["error"])
            else:
                j["future"].set_result(_message(j))
        return
    try:
        with base.gen_slot(), torch.inference_mode():
            tok = base.STATE["tokenizer"]
            pad = tok.pad_token_id
            if pad is None:
                pad = tok.eos_token_id
            width = max(j["count"] for j in jobs)
            size = BATCH_MAX_SIZE
            ids = torch.full((size, width), pad, dtype=torch.long, device=base.DEVICE)
            mask = torch.zeros_like(ids)
            for row, j in enumerate(jobs):
                c = j["count"]
                ids[row, -c:] = j["inputs"]["input_ids"][0]
                mask[row, -c:] = 1
            for row in range(len(jobs), size):
                ids[row, -1] = pad
                mask[row, -1] = 1
            kwargs = dict(jobs[0]["gen_kwargs"])
            kwargs["max_length"] = BATCH_CACHE_LEN
            streamers = [j.get("streamer") for j in jobs] + [None] * (size - len(jobs))
            if any(s is not None for s in streamers):
                kwargs["streamer"] = _RowDemux(streamers, _end_ids())
            flags = [j.get("stop_flag") for j in jobs] + [None] * (size - len(jobs))
            if any(f is not None for f in flags):
                kwargs["stopping_criteria"] = [
                    lambda input_ids, scores, **kw: torch.tensor(
                        [bool(f and f.hit) for f in flags],
                        dtype=torch.bool, device=input_ids.device)]
            out = base.STATE["model"].generate(
                input_ids=ids, attention_mask=mask, **kwargs)
            ends = _end_ids()
            for row, j in enumerate(jobs):
                seq = out[row, width:]
                cut = len(seq)
                for i, t in enumerate(seq.tolist()):
                    if int(t) in ends:
                        cut = i + 1
                        break
                j["generated_ids"] = seq[:cut]
                j["generated"] = int(cut)
    except BaseException as exc:
        for j in jobs:
            j["error"] = exc
    for j in jobs:
        j["done"].set()
        if j.get("future") is not None:
            if j.get("error") is not None:
                j["future"].set_exception(j["error"])
            else:
                j["future"].set_result(_message(j))
        elif j.get("error") is not None and j.get("sink") is not None:
            j["sink"].put(("error", j["error"]))


def batch_worker():
    """Coalesce same-key jobs within a short window into one decode."""
    pending = []
    while True:
        job = pending.pop(0) if pending else BATCH_QUEUE.get()
        jobs = [job]
        deadline = time.monotonic() + BATCH_WAIT_SECONDS
        while len(jobs) < BATCH_MAX_SIZE:
            try:
                nxt = BATCH_QUEUE.get(timeout=max(0.0, deadline - time.monotonic()))
            except queue.Empty:
                break
            if nxt["key"] == job["key"]:
                jobs.append(nxt)
            else:
                pending.append(nxt)
            if time.monotonic() >= deadline:
                break
        _run_batch(jobs)
        BATCH_STATS["batches"] += 1
        BATCH_STATS["batched_requests"] += len(jobs)
        BATCH_STATS["largest_batch"] = max(BATCH_STATS["largest_batch"], len(jobs))


def _make_job(request, inputs, thinking, count, budget, key):
    return {"request": request, "inputs": inputs, "thinking": thinking,
            "count": count, "budget": budget, "gen_kwargs": _gen_kwargs(request, budget),
            "key": key, "done": threading.Event(), "error": None,
            "generated": 0, "generated_ids": None,
            "streamer": None, "stop_flag": None, "sink": None, "future": None}


async def run_chat(request):
    check_alias(request.model)
    if request.n not in (None, 1):
        raise HTTPException(400, "n must be 1")
    if request.modalities and "audio" in request.modalities:
        raise HTTPException(400, "LFM3-VL does not support audio")
    budget = request.max_completion_tokens or request.max_tokens or 4096
    if not 1 <= budget <= base.MAX_NEW_TOKENS:
        raise HTTPException(400, "Output budget must be within 1..16384")
    if request.stream:
        return await stream_response(request, budget)

    inputs, thinking, count = await asyncio.to_thread(_preflight, request, budget)
    key = _batch_key(request, budget, False) if BATCH_MAX_SIZE >= 2 else None
    job = _make_job(request, inputs, thinking, count, budget, key)
    loop = asyncio.get_event_loop()
    if key is not None:
        from concurrent.futures import Future
        job["future"] = Future()
        try:
            BATCH_QUEUE.put_nowait(job)
        except queue.Full:
            raise HTTPException(503, "Generation queue is full")
        message, reason, usage = await loop.run_in_executor(None, job["future"].result)
    else:
        await loop.run_in_executor(None, _run_solo, job)
        if job["error"] is not None:
            if isinstance(job["error"], HTTPException):
                raise job["error"]
            raise HTTPException(500, f"Generation failed: {job['error']}")
        message, reason, usage = _message(job)
    if (reason == "length" and thinking and not message.get("content")
            and not message.get("tool_calls")):
        # The whole budget died inside <think> — retry once without
        # reasoning so the caller gets a real answer instead of
        # content:null (Raycast's background summarize calls surfaced as
        # "Summarizing chat failed").
        retry = request.model_copy(update={
            "chat_template_kwargs":
                {**(getattr(request, "chat_template_kwargs", None) or {}),
                 "enable_thinking": False}})
        inputs, _, count = await asyncio.to_thread(_preflight, retry, budget)
        job = _make_job(retry, inputs, False, count, budget, None)
        await loop.run_in_executor(None, _run_solo, job)
        if job["error"] is not None:
            if isinstance(job["error"], HTTPException):
                raise job["error"]
            raise HTTPException(500, f"Generation failed: {job['error']}")
        message, reason, usage = _message(job)
    base.COUNTERS["requests"] += 1
    base.COUNTERS["chat"] += 1
    base.COUNTERS["tokens_out"] += usage["completion_tokens"]
    return {"id": "chatcmpl-" + uuid.uuid4().hex, "created": int(time.time()),
            "model": base.REPOSITORY, "object": "chat.completion",
            "choices": [{"index": 0, "message": message, "finish_reason": reason}], "usage": usage}


_PIPE = "|"
_STREAM_MARKERS = ("<think>", "</think>", "<tool_call>", "</tool_call>") + tuple(
    "<" + _PIPE + n + _PIPE + ">" for n in ("im_start", "im_end", "endoftext"))
_STREAM_KEEP = max(len(m) for m in _STREAM_MARKERS) - 1
_END_TEXT_MARKERS = _STREAM_MARKERS[5:]


class _StreamStop:
    """StoppingCriteria flag: aborts a decode when the SSE consumer is done."""

    def __init__(self):
        self.hit = False

    def __call__(self, input_ids, scores, **kwargs):
        return self.hit


def _scan_markers(text):
    """Earliest marker occurrence in text -> (pos, marker) or (None, None)."""
    best, found = None, None
    for mark in _STREAM_MARKERS:
        at = text.find(mark)
        if at >= 0 and (best is None or at < best):
            best, found = at, mark
    return best, found


async def stream_response(request, budget):
    """Token-at-a-time SSE: reasoning deltas, content deltas, tool buffering."""
    from transformers.generation.streamers import TextIteratorStreamer

    inputs, thinking, count = await asyncio.to_thread(_preflight, request, budget)
    request_id = "chatcmpl-" + uuid.uuid4().hex
    created = int(time.time())
    chunk = {"id": request_id, "created": created, "model": base.REPOSITORY,
             "object": "chat.completion.chunk"}
    key = _batch_key(request, budget, True) if BATCH_MAX_SIZE >= 2 else None
    job = _make_job(request, inputs, thinking, count, budget, key)
    job["sink"] = queue.Queue()
    job["stop_flag"] = _StreamStop()
    job["streamer"] = TextIteratorStreamer(
        base.STATE["tokenizer"], skip_prompt=True, skip_special_tokens=False)

    def pump():
        # "eos" is queued only after the streamer fully drains, so every
        # "text" item is guaranteed to precede it.
        try:
            for piece in job["streamer"]:
                job["sink"].put(("text", piece))
        except BaseException as exc:
            job["sink"].put(("error", exc))
        finally:
            job["sink"].put(("eos", None))

    async def events():
        yield base.sse({**chunk, "choices": [{"index": 0, "delta": {"role": "assistant"},
                                             "finish_reason": None}]})
        loop = asyncio.get_event_loop()
        if key is not None:
            try:
                BATCH_QUEUE.put_nowait(job)
            except queue.Full:
                raise HTTPException(503, "Generation queue is full")
        else:
            threading.Thread(target=_run_solo, args=(job,), daemon=True).start()
        threading.Thread(target=pump, daemon=True).start()
        mode = "reasoning" if thinking else "content"
        pending, raw, emitted = "", "", ""
        field = {"reasoning": "reasoning_content", "content": "content"}
        # `emitted` tracks content-mode text only, so stop strings are
        # matched against the answer — never against reasoning text.
        stops = request.stop if isinstance(request.stop, list) else (
            [request.stop] if request.stop else [])
        ended = False

        def emit(text):
            if not text or mode not in field:
                return None
            key_ = field[mode]
            return base.sse({**chunk, "choices": [{"index": 0,
                "delta": {key_: text}, "finish_reason": None}]})

        while True:
            kind, payload = await loop.run_in_executor(None, job["sink"].get)
            if kind == "error":
                job["stop_flag"].hit = True
                job["streamer"].end()
                raise HTTPException(500, f"Generation failed: {payload}")
            if kind == "eos":
                break
            raw += payload
            pending += payload
            while pending and not ended:
                pos, mark = _scan_markers(pending)
                if mark is None:
                    safe = pending[:-_STREAM_KEEP] if len(pending) > _STREAM_KEEP else ""
                    if safe:
                        if mode == "content":
                            cut = len(emitted) + len(safe)
                            for stop in stops:
                                at = (emitted + safe).find(stop)
                                if at >= 0:
                                    cut = min(cut, at)
                            if cut < len(emitted) + len(safe):
                                out = emit((emitted + safe)[len(emitted):cut])
                                emitted = (emitted + safe)[:cut]
                                if out:
                                    yield out
                                ended, job["stop_flag"].hit = True, True
                                break
                        if mode == "content":
                            emitted += safe
                        out = emit(safe)
                        if out:
                            yield out
                        pending = pending[len(safe):]
                    break
                head, pending = pending[:pos], pending[pos + len(mark):]
                if head:
                    if mode == "content":
                        emitted += head
                    out = emit(head)
                    if out:
                        yield out
                if mark == "</think>":
                    mode = "content"
                elif mark == "<tool_call>":
                    mode = "tool"
                elif mark in _END_TEXT_MARKERS:
                    ended, job["stop_flag"].hit = True, True
            if ended:
                job["stop_flag"].hit = True
        await loop.run_in_executor(None, job["done"].wait)
        if pending and not ended:
            out = emit(base.truncate_stops(pending, stops) if mode == "content" else pending)
            if out:
                yield out
        error = job["error"]
        if error is not None:
            if isinstance(error, HTTPException):
                raise error
            raise HTTPException(500, f"Generation failed: {error}")
        _, calls = base.parse_generated_tool_calls(raw)
        base.coerce_tool_arguments(calls, request.tools)
        if calls:
            delta = {"tool_calls": [{"index": i, **c} for i, c in enumerate(calls)]}
            yield base.sse({**chunk, "choices": [{"index": 0, "delta": delta,
                                                 "finish_reason": None}]})
        reason = ("tool_calls" if calls else
                  "length" if job.get("generated", 0) >= budget else "stop")
        usage = {"prompt_tokens": count, "completion_tokens": job.get("generated", 0),
                 "total_tokens": count + job.get("generated", 0)}
        yield base.sse({**chunk, "choices": [{"index": 0, "delta": {},
                                             "finish_reason": reason}], "usage": usage})
        yield "data: [DONE]\n\n"

    base.COUNTERS["requests"] += 1
    base.COUNTERS["chat"] += 1
    return StreamingResponse(events(), media_type="text/event-stream")


def tokenize(request: base.TokenizeRequest):
    base.require_model()
    check_alias(request.model)
    with base.LOCK:
        if request.messages is not None:
            inputs, _ = prepare(request)
            count = int(inputs["input_ids"].shape[-1])
        elif request.prompt is not None:
            count = len(base.STATE["tokenizer"](request.prompt).input_ids)
        else:
            raise HTTPException(400, "prompt or messages is required")
    return {"count": count, "tokens": count, "max_model_len": base.CONTEXT_TOKENS}


base.check_model_alias = check_alias
base.run_chat = run_chat
app = base.app
app.router.lifespan_context = lifespan
app.router.routes = [r for r in app.router.routes if getattr(r, "path", "") not in
                     ("/tokenize", "/v1/audio/speech", "/v1/audio/transcriptions", "/health")]
app.post("/tokenize")(tokenize)


@app.get("/health")
def health():
    return {"status": "ready" if "model" in base.STATE else "loading",
            "model": base.MODEL_NAME, "repository": base.REPOSITORY,
            "context_tokens": base.CONTEXT_TOKENS, "counters": base.COUNTERS,
            "max_concurrent": base.MAX_CONCURRENT,
            "batching": {"max_size": BATCH_MAX_SIZE, "queued": BATCH_QUEUE.qsize(),
                         **BATCH_STATS},
            "features": ["chat", "vision", "video", "reasoning", "tool-calls",
                         "sse", "batching"]}
