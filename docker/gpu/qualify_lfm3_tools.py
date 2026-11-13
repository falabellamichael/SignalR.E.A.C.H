"""Live, side-effect-free qualification of OpenAI-compatible tool delivery.

The declared functions are mocks: this script never sends mail or executes
model-selected functions. It supplies synthetic tool results locally.
"""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request


NAME = "diagnostics__preview-message"
BODY = {
    "Message": {
        "subject": "Parser test",
        "body": {"contentType": "text", "content": "Line one.\nLine two."},
        "toRecipients": [{"emailAddress": {"address": "recipient@example.invalid"}}],
    },
    "SaveToSentItems": False,
}
TOOL = {"type": "function", "function": {
    "name": NAME,
    "description": "Read-only message preview. Validates input without sending or saving anything.",
    "parameters": {"type": "object", "properties": {
        "body": {"type": "object", "properties": {
            "Message": {"type": "object", "properties": {
                "subject": {"type": "string"},
                "body": {"type": "object", "properties": {
                    "contentType": {"type": "string"}, "content": {"type": "string"}},
                    "required": ["contentType", "content"]},
                "toRecipients": {"type": "array", "items": {"type": "object", "properties": {
                    "emailAddress": {"type": "object", "properties": {
                        "address": {"type": "string"}}, "required": ["address"]}},
                    "required": ["emailAddress"]}}},
                "required": ["subject", "body", "toRecipients"]},
            "SaveToSentItems": {"type": "boolean"}},
            "required": ["Message", "SaveToSentItems"]},
        "__raycast_tool_call_description": {"type": "string"}},
        "required": ["body", "__raycast_tool_call_description"]}}}
PROMPT = ("Call " + NAME + " exactly once to preview this exact body, preserving all values: "
          + json.dumps(BODY) + ". Set __raycast_tool_call_description to Preview the test message. "
          "Do not claim success before receiving the tool result. After the tool result, report its reference and whether anything was sent.")


def request(base, payload, key=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    started = time.perf_counter()
    req = urllib.request.Request(base.rstrip("/") + "/chat/completions",
                                 data=json.dumps(payload).encode(), headers=headers)
    with urllib.request.urlopen(req, timeout=180) as response:
        if not payload.get("stream"):
            data = json.load(response)
            choice = data["choices"][0]
            return choice["message"], choice["finish_reason"], time.perf_counter() - started
        calls, content, reasoning, finish = {}, [], [], None
        for line in response:
            if not line.startswith(b"data:") or line[5:].strip() == b"[DONE]":
                continue
            event = json.loads(line[5:])
            if event.get("error"):
                raise AssertionError(event["error"])
            for choice in event.get("choices", []):
                finish = choice.get("finish_reason") or finish
                delta = choice.get("delta", {})
                content.append(delta.get("content") or "")
                reasoning.append(delta.get("reasoning") or delta.get("reasoning_content") or "")
                for part in delta.get("tool_calls") or []:
                    call = calls.setdefault(part["index"], {
                        "id": "", "type": "function", "function": {"name": "", "arguments": ""}})
                    if part.get("id"):
                        call["id"] = part["id"]
                    for field in ("name", "arguments"):
                        call["function"][field] += part.get("function", {}).get(field) or ""
        return {"role": "assistant", "content": "".join(content) or None,
                "reasoning": "".join(reasoning) or None,
                "tool_calls": [calls[i] for i in sorted(calls)]}, finish, time.perf_counter() - started


def validate_call(message, finish, *, named=False):
    # vLLM uses stop for an explicitly named function; calls remain structured.
    assert finish in ({"tool_calls", "stop"} if named else {"tool_calls"}), finish
    for field in ("content", "reasoning", "reasoning_content"):
        assert "<tool_call>" not in (message.get(field) or ""), "XML leaked into " + field
    calls = message.get("tool_calls") or []
    assert len(calls) == 1, calls
    call = calls[0]
    assert call.get("id") and call["type"] == "function", call
    assert call["function"]["name"] == NAME, call
    arguments = json.loads(call["function"]["arguments"])
    assert arguments.get("body") == BODY, arguments
    assert isinstance(arguments.get("__raycast_tool_call_description"), str), arguments
    return call


def qualify(base, model, key=None):
    results = []
    template = {"model": model, "messages": [{"role": "user", "content": PROMPT}],
                "tools": [TOOL], "max_tokens": 1536, "temperature": 0}
    # Keep VL reasoning enabled; match the relay's default half-output budget.
    if "vl" in model.lower():
        template["thinking_token_budget"] = 768
        template["chat_template_kwargs"] = {"enable_thinking": True}
    for label, stream, choice in [
        ("auto-json", False, "auto"), ("auto-stream", True, "auto"),
        ("required-json", False, "required"), ("required-stream", True, "required"),
        ("named-json", False, {"type": "function", "function": {"name": NAME}}),
        ("named-stream", True, {"type": "function", "function": {"name": NAME}}),
    ]:
        try:
            payload = {**template, "stream": stream, "tool_choice": choice}
            message, finish, elapsed = request(base, payload, key)
            call = validate_call(message, finish, named=isinstance(choice, dict))
            result = {"case": label, "ok": True, "seconds": round(elapsed, 3),
                      "thinking_chars": len(message.get("reasoning") or "")}
            # OpenAI clients return arguments as JSON strings in assistant history.
            if label.startswith("auto"):
                history = [*template["messages"], {"role": "assistant", "content": None,
                           "tool_calls": [call]}, {"role": "tool", "tool_call_id": call["id"],
                           "content": '{"status":"validated","reference":"MOCK-42","sent":false}'}]
                followup = {**template, "messages": history, "stream": stream, "tool_choice": "auto"}
                answer, end, duration = request(base, followup, key)
                assert end == "stop" and not answer.get("tool_calls"), (end, answer)
                assert answer.get("content") and "<tool_call>" not in answer["content"], answer
                assert "MOCK-42" in answer["content"], answer
                result["round_trip_seconds"] = round(elapsed + duration, 3)
                result["tool_result_followup"] = True
                failed_history = [*history[:-1], {"role": "tool", "tool_call_id": call["id"],
                    "content": '{"status":"error","reference":"MOCK-FAIL","sent":false,"error":"Validation failed. Do not retry."}'}]
                failure, end, _ = request(base, {**followup, "messages": failed_history}, key)
                assert end == "stop" and not failure.get("tool_calls"), (end, failure)
                assert "MOCK-FAIL" in (failure.get("content") or ""), failure
                assert any(word in failure["content"].lower() for word in ("fail", "error")), failure
                result["tool_error_followup"] = True
            results.append(result)
        except Exception as exc:
            detail = exc.read().decode()[:600] if isinstance(exc, urllib.error.HTTPError) else str(exc)[:800]
            results.append({"case": label, "ok": False, "error": detail})
        print(json.dumps({"model": model, **results[-1]}), flush=True)
    for label, extra in [("tools-none", {"tools": [TOOL], "tool_choice": "none"}), ("plain-chat", {})]:
        try:
            payload = {k: v for k, v in template.items() if k != "tools"}
            payload.update(extra)
            payload["messages"] = [{"role": "user", "content": "Reply with exactly READY. Do not call tools."}]
            message, finish, elapsed = request(base, payload, key)
            assert finish == "stop" and not message.get("tool_calls"), (finish, message)
            assert "READY" in (message.get("content") or ""), message
            results.append({"case": label, "ok": True, "seconds": round(elapsed, 3)})
        except Exception as exc:
            results.append({"case": label, "ok": False, "error": str(exc)[:800]})
        print(json.dumps({"model": model, **results[-1]}), flush=True)
    lookup = {"type": "function", "function": {"name": "lookup_inventory",
              "description": "Read-only stock lookup for one item.",
              "parameters": {"type": "object", "properties": {"item": {"type": "string"}},
                             "required": ["item"]}}}
    for stream in (False, True):
        label = "parallel-stream" if stream else "parallel-json"
        try:
            payload = {**template, "tools": [lookup], "tool_choice": "auto",
                       "parallel_tool_calls": True, "stream": stream,
                       "messages": [{"role": "user", "content":
                         "Check inventory for BLUE-42 and GREEN-7. Make two independent "
                         "lookup_inventory calls in this response, one for each item."}]}
            message, finish, elapsed = request(base, payload, key)
            calls = message.get("tool_calls") or []
            assert finish == "tool_calls" and len(calls) == 2, (finish, message)
            assert len({call["id"] for call in calls}) == 2, calls
            assert all(call["function"]["name"] == "lookup_inventory" for call in calls), calls
            assert {json.loads(call["function"]["arguments"])["item"] for call in calls} == {"BLUE-42", "GREEN-7"}
            assert "<tool_call>" not in (message.get("content") or ""), message
            results.append({"case": label, "ok": True, "seconds": round(elapsed, 3)})
        except Exception as exc:
            detail = exc.read().decode()[:600] if isinstance(exc, urllib.error.HTTPError) else str(exc)[:800]
            results.append({"case": label, "ok": False, "error": detail})
        print(json.dumps({"model": model, **results[-1]}), flush=True)
    return results


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="OpenAI base ending in /v1")
    parser.add_argument("--model", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--key-env", help="Optional existing credential environment variable")
    args = parser.parse_args()
    results = qualify(args.base_url, args.model, os.environ[args.key_env] if args.key_env else None)
    Path(args.output).write_text(json.dumps(results, indent=2), encoding="utf-8")
    raise SystemExit(0 if all(row["ok"] for row in results) else 1)
