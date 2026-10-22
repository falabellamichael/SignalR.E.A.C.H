"""Stop MiniCPM tool loops using only the current request's original history."""

import hashlib
import json
import re
import time
import uuid

from reachd.const import CLIENT_DISCONNECT_ERRORS


# These Raycast searches can vary their query while returning the same data.
# Other tools must repeat BOTH their arguments and result: two distinct writes
# returning "Success" still represent progress.
_GITHUB_SEARCH = re.compile(
    r"(?:^|__)search-(?:issues|pull-requests|repositories)(?:_[A-Za-z0-9]+)?$")


def _fingerprint(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            pass
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(encoded).digest()


def _arguments(value):
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return value
    if isinstance(value, dict):
        return {k: v for k, v in value.items()
                if k != "__raycast_tool_call_description"}
    return value


def check_minicpm_loop(upstream, payload, *, no_progress_rounds=3, max_rounds=12):
    """Return a stop report, or None. No shared state and no input mutation.

    Only fully completed assistant tool batches count. The first new result
    resets the consecutive no-progress counter. Parallel calls are one round;
    an unfinished batch never establishes a repeated result.
    """
    if upstream != "gpu/minicpm5-2b" or not isinstance(payload.get("tools"), list) \
            or not payload["tools"] \
            or payload.get("tool_choice") == "none":
        return None
    messages = payload.get("messages") or []
    start = max((i for i, m in enumerate(messages)
                 if isinstance(m, dict) and m.get("role") == "user"), default=-1)
    if start < 0:
        return None
    read_only = set()
    for tool in payload["tools"]:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function") or {}
        annotations = tool.get("annotations") or {}
        if isinstance(function, dict) and isinstance(function.get("name"), str) \
                and isinstance(annotations, dict) \
                and annotations.get("readOnlyHint") is True:
            read_only.add(function.get("name"))
    seen = set()
    pending, completed = {}, {}
    rounds = repeats = 0
    for message in messages[start + 1:]:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "assistant":
            pending, completed = {}, {}
            calls = message.get("tool_calls") or []
            if not isinstance(calls, list):
                continue
            for call in calls:
                if not isinstance(call, dict):
                    break
                function = call.get("function") or {}
                call_id = call.get("id")
                name = function.get("name") if isinstance(function, dict) else None
                if not isinstance(call_id, str) or not call_id \
                        or call_id in pending or not isinstance(name, str) or not name:
                    break
                args = None if name in read_only or _GITHUB_SEARCH.search(name) else \
                    _fingerprint(_arguments(function.get("arguments")))
                pending[call_id] = (name, args)
            else:
                continue
            # Malformed or duplicate IDs cannot prove a completed round.
            pending = {}
        elif message.get("role") == "tool":
            call_id = message.get("tool_call_id")
            if not isinstance(call_id, str) or call_id not in pending \
                    or message.get("content") is None:
                continue
            completed[call_id] = (*pending[call_id], _fingerprint(message["content"]))
            if len(completed) != len(pending):
                continue
            outcomes = set(completed.values())
            repeats = repeats + 1 if outcomes <= seen else 0
            seen.update(outcomes)
            rounds += 1
            pending, completed = {}, {}
            reason = ("no_progress" if repeats >= no_progress_rounds else
                      "round_limit" if rounds >= max_rounds else None)
            if reason:
                return {"reason": reason, "completed_rounds": rounds,
                        "no_progress_rounds": repeats}
    return None


def send_loop_stop(h, model, report, *, stream, headers, metered=False):
    """A normal terminal chat response for clients, with no executable calls."""
    rounds = report["completed_rounds"]
    detail = ("The last %d tool rounds repeated results already seen in this turn."
              % report["no_progress_rounds"] if report["reason"] == "no_progress" else
              "The per-turn limit of %d tool rounds was reached." % rounds)
    content = ("MiniCPM's tool loop was stopped by the host after %d completed tool rounds. "
               "%s No further tool calls were issued. Results already collected remain "
               "in this chat. Send a new instruction to continue with a different approach."
               % (rounds, detail))
    headers = {**headers, "X-Reach-Loop-Guard": report["reason"]}
    # Provider-metered routes require real provider counters. No generation
    # took place, so return an explicit error rather than fabricate usage.
    if metered:
        h._json(409, {"error": {"message": content, "type": "invalid_request_error",
                               "code": "tool_loop_detected"}}, headers)
        return
    base = {"id": "chatcmpl-loop-" + uuid.uuid4().hex, "created": int(time.time()),
            "model": model, "usage_source": "host"}
    if not stream:
        h._json(200, {**base, "object": "chat.completion", "choices": [{"index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop"}]}, headers)
        return
    h.send_response(200)
    h.send_header("Content-Type", "text/event-stream")
    h._cors()
    h._rate_limit_headers(headers)
    h.send_header("Cache-Control", "no-cache")
    h.send_header("Transfer-Encoding", "chunked")
    h.end_headers()
    try:
        for delta, finish in (({"role": "assistant", "content": content}, None), ({}, "stop")):
            chunk = {**base, "object": "chat.completion.chunk", "choices": [
                {"index": 0, "delta": delta, "finish_reason": finish}]}
            h._write_chunk(("data: " + json.dumps(chunk) + "\n\n").encode("utf-8"))
        h._write_chunk(b"data: [DONE]\n\n")
        h._write_chunk(b"")
    except CLIENT_DISCONNECT_ERRORS:
        h.close_connection = True
