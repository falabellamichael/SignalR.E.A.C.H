import importlib.util
import asyncio
import json
from pathlib import Path

import httpx
from starlette.testclient import TestClient


spec = importlib.util.spec_from_file_location(
    "locals_vllm", Path(__file__).parents[1] / "docker/gpu/locals_vllm.py")
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


def test_concurrent_discovery_coalesces_and_recovers_after_failure(monkeypatch):
    async def scenario():
        calls = 0
        now = 100
        fail = False
        monkeypatch.setattr(gateway, "time", type("Clock", (), {"monotonic": staticmethod(lambda: now)}))

        async def upstream(request):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.01)
            return httpx.Response(503) if fail else httpx.Response(200, json={"data": [{"id": "gemma"}]})

        app = gateway.create_app("http://vllm", transport=httpx.MockTransport(upstream))
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as client:
                for expected in (1, 2):
                    results = await asyncio.gather(*(client.get("/v1/models") for _ in range(16)))
                    assert all(r.status_code == 200 for r in results)
                    assert calls == expected
                    now += 11
                fail = True
                assert (await client.get("/health")).status_code == 502
                fail = False
                assert (await client.get("/health")).status_code == 200
                assert calls == 4

    asyncio.run(scenario())


def test_translation_keeps_tools_and_history():
    body = {"model": "locals/qwen", "messages": [{"role": "tool", "content": "result", "tool_call_id": "a"}],
            "tools": [{"type": "function", "function": {"name": "read"}}],
            "response_format": {"type": "regex", "regex": "[a-z]+"}}
    result = gateway.translate(body, "gemma")
    assert result["structured_outputs"] == {"regex": "[a-z]+"}
    assert result["messages"] == body["messages"]
    assert result["tools"] == body["tools"]
    assert result["model"] == "gemma"
    assert "response_format" in body


def test_gateway_forwards_stream_schema_auth_and_errors():
    seen = []

    def upstream(request):
        assert request.headers["authorization"] == "Bearer secret"
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "gemma"}]})
        body = json.loads(request.content)
        seen.append(body)
        if body.get("max_tokens") == -1:
            return httpx.Response(400, json={"error": {"message": "invalid tokens"}})
        if body.get("stream"):
            return httpx.Response(200, content=b'data: {"choices":[]}\n\ndata: [DONE]\n\n',
                                  headers={"content-type": "text/event-stream"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    app = gateway.create_app("http://vllm/v1", api_key="secret", transport=httpx.MockTransport(upstream))
    with TestClient(app) as client:
        assert client.get("/health").json()["model"] == "gemma"
        fmt = {"type": "json_schema", "json_schema": {"name": "answer", "schema": {"type": "object"}}}
        assert client.post("/v1/chat/completions", json={"model": "locals", "response_format": fmt}).status_code == 200
        assert seen[-1]["response_format"] == fmt
        assert seen[-1]["model"] == "gemma"
        result = client.post("/v1/chat/completions", json={"stream": True})
        assert "data: [DONE]" in result.text
        result = client.post("/v1/chat/completions", json={"max_tokens": -1})
        assert result.status_code == 400
        assert result.json()["error"]["message"] == "invalid tokens"
        assert client.post("/v1/chat/completions", json={"model": "wrong"}).status_code == 404


def test_ambiguous_model_and_backend_failure():
    for response, status in [(httpx.Response(200, json={"data": [{"id": "a"}, {"id": "b"}]}), 400),
                             (httpx.Response(503), 502)]:
        app = gateway.create_app("http://vllm", transport=httpx.MockTransport(lambda request: response))
        with TestClient(app) as client:
            assert client.get("/health").status_code == status


def test_reasoning_guard_stops_upstream_without_modifying_tool_or_answer_text():
    def upstream(request):
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "gemma", "max_model_len": 131072}]})
        event = {"choices": [{"index": 0, "delta": {"reasoning": "repeat\n" * 30}}]}
        return httpx.Response(200, text="data: " + json.dumps(event) + "\n\ndata: [DONE]\n\n")
    app = gateway.create_app("http://vllm", transport=httpx.MockTransport(upstream),
                             loop_guard=lambda text: text.count("repeat") >= 30)
    with TestClient(app) as client:
        assert client.get("/v1/models").json()["data"][0]["max_model_len"] == 131072
        response = client.post("/v1/chat/completions", json={"stream": True})
        assert "locals_reasoning_loop" in response.text
        assert client.get("/health").json()["locals"]["loop_stops"] == 1
