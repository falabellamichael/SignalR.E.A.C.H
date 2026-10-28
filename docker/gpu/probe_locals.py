"""Live Locals/vLLM checks; run on the GPU host with its loopback gateway."""
import concurrent.futures
import json
import os
import time
import urllib.request

BASE = os.environ.get("LOCALS_PROBE_URL", "http://127.0.0.1:8321")


def chat(prompt="Say hello briefly.", **extra):
    body = {"model": "locals", "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 256, "temperature": 0,
            "chat_template_kwargs": {"enable_thinking": False}, **extra}
    req = urllib.request.Request(BASE + "/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as response:
        return response.read().decode() if body.get("stream") else json.load(response)


def main():
    schema = {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"], "additionalProperties": False}
    reply = chat("Return ok true.", response_format={"type": "json_schema", "json_schema": {"name": "probe", "schema": schema}})
    assert json.loads(reply["choices"][0]["message"]["content"]) == {"ok": True}, reply
    print("PASS json_schema", flush=True)
    reply = chat("Return PASS.", response_format={"type": "regex", "regex": "PASS"})
    assert reply["choices"][0]["message"]["content"] == "PASS", reply
    print("PASS regex", flush=True)
    assert "data: [DONE]" in chat(stream=True)
    print("PASS streaming", flush=True)
    tools = [{"type": "function", "function": {"name": "get_number", "description": "Get the requested number", "parameters": {"type": "object", "properties": {}, "additionalProperties": False}}}]
    messages = [{"role": "user", "content": "Call get_number then tell me its result."}]
    reply = chat(messages=messages, tools=tools, tool_choice="required")
    message = reply["choices"][0]["message"]
    call = message["tool_calls"][0]
    assert call["function"]["name"] == "get_number", reply
    json.loads(call["function"]["arguments"])
    messages += [message, {"role": "tool", "tool_call_id": call["id"], "content": "42"}]
    reply = chat(messages=messages, tools=tools, tool_choice="none")
    assert "42" in reply["choices"][0]["message"]["content"], reply
    print("PASS tool_call_and_continuation", flush=True)
    start = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(chat, ["Say hello one.", "Say hello two."]))
    assert all(r["choices"][0]["message"]["content"] for r in results)
    print(f"PASS concurrent_two {time.monotonic() - start:.2f}s", flush=True)


if __name__ == "__main__":
    main()
