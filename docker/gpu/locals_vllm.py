"""Locals' portable agent harness backed by an existing vLLM server."""

import argparse
import asyncio
import ast
import copy
import importlib.util
import json
import os
from pathlib import Path
import time


def load_loop_guard():
    """Load Locals' pure-Python guard without importing its MLX server."""
    spec = importlib.util.find_spec("locals")
    source = Path(spec.origin).with_name("server.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_line_looping")
    namespace = {}
    exec(compile(ast.Module(body=[function], type_ignores=[]), "locals/server.py", "exec"), namespace)
    return namespace["_line_looping"]


def translate(body, model):
    body = copy.deepcopy(body)
    body["model"] = model
    fmt = body.get("response_format", {})
    if fmt.get("type") == "regex":
        if "structured_outputs" in body:
            raise ValueError("regex response_format conflicts with structured_outputs")
        body["structured_outputs"] = {"regex": fmt["regex"]}
        del body["response_format"]
    return body


def create_app(upstream, model=None, api_key=None, transport=None, loop_guard=None):
    import httpx
    from contextlib import asynccontextmanager
    from starlette.applications import Starlette
    from starlette.background import BackgroundTask
    from starlette.requests import ClientDisconnect
    from starlette.responses import JSONResponse, Response, StreamingResponse
    from starlette.routing import Route

    upstream = upstream.rstrip("/")
    if upstream.endswith("/v1"):
        upstream = upstream[:-3]
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    cached = {"expires": 0, "data": None}
    models_lock = asyncio.Lock()
    counters = {"requests": 0, "loop_stops": 0, "disconnects": 0}

    async def models(client):
        if time.monotonic() >= cached["expires"]:
            # Coalesce concurrent discovery requests when the cache expires.
            async with models_lock:
                if time.monotonic() >= cached["expires"]:
                    response = await client.get(upstream + "/v1/models")
                    response.raise_for_status()
                    cached.update(data=response.json(), expires=time.monotonic() + 10)
        return cached["data"]

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(headers=headers, transport=transport,
                                     timeout=httpx.Timeout(900, connect=10)) as client:
            app.state.client = client
            yield

    async def served_model(client):
        entries = (await models(client))["data"]
        ids = [entry["id"] for entry in entries]
        if model:
            if model not in ids:
                raise ValueError("Configured Locals model is not served by vLLM")
            return model
        if len(ids) != 1:
            raise ValueError("Set LOCALS_VLLM_MODEL when vLLM advertises multiple models")
        return ids[0]

    async def handle(request):
        client = request.app.state.client
        try:
            if request.url.path == "/health":
                selected = await served_model(client)
                return JSONResponse({"status": "ok", "backend": "vllm", "model": selected,
                                     "locals": counters, "reasoning_loop_guard": loop_guard is not None})
            if request.url.path == "/v1/models":
                return JSONResponse(await models(client))
            if request.url.path != "/v1/chat/completions":
                response = await client.request(request.method, upstream + request.url.path,
                                                params=request.query_params, content=await request.body(),
                                                headers={"Content-Type": request.headers.get("content-type", "application/json")})
                return Response(response.content, status_code=response.status_code,
                                media_type=response.headers.get("content-type"))
            body = await request.json()
            if not isinstance(body, dict):
                raise ValueError("Request must be a JSON object")
            selected = await served_model(client)
            requested = body.get("model", "locals")
            if not isinstance(requested, str):
                raise ValueError("model must be a string")
            if requested not in (selected, "locals") and not requested.startswith("locals/"):
                return JSONResponse({"error": {"message": "Unknown model"}}, status_code=404)
            body = translate(body, selected)
            counters["requests"] += 1
            req = client.build_request("POST", upstream + "/v1/chat/completions", json=body)
            async def connected(operation):
                task = asyncio.create_task(operation)
                try:
                    while not task.done():
                        await asyncio.wait({task}, timeout=0.1)
                        if await request.is_disconnected():
                            counters["disconnects"] += 1
                            raise ClientDisconnect()
                    return await task
                finally:
                    if not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)

            response = await connected(client.send(req, stream=True))
            if body.get("stream") and response.is_success:
                async def chunks():
                    reasoning = {}
                    try:
                        async for line in response.aiter_lines():
                            if loop_guard and line.startswith("data: ") and line != "data: [DONE]":
                                event = json.loads(line[6:])
                                for choice in event.get("choices", []):
                                    delta = choice.get("delta", {})
                                    text = delta.get("reasoning") or delta.get("reasoning_content") or ""
                                    index = choice.get("index", 0)
                                    if text:
                                        reasoning[index] = (reasoning.get(index, "") + text)[-32768:]
                                        if loop_guard(reasoning[index]):
                                            counters["loop_stops"] += 1
                                            await response.aclose()
                                            yield 'data: ' + json.dumps({"error": {
                                                "message": "Locals stopped repetitive reasoning; retry or disable thinking.",
                                                "type": "generation_loop", "code": "locals_reasoning_loop"}}) + '\n\n'
                                            yield 'data: [DONE]\n\n'
                                            return
                            yield line + "\n"
                    finally:
                        await response.aclose()
                return StreamingResponse(chunks(), status_code=response.status_code,
                                         media_type="text/event-stream",
                                         background=BackgroundTask(response.aclose))
            try:
                return Response(await connected(response.aread()), status_code=response.status_code,
                                media_type=response.headers.get("content-type", "application/json"))
            finally:
                await response.aclose()
        except (ValueError, KeyError, TypeError) as exc:
            return JSONResponse({"error": {"message": str(exc)}}, status_code=400)
        except httpx.HTTPError:
            return JSONResponse({"error": {"message": "vLLM backend unavailable"}}, status_code=502)
        except ClientDisconnect:
            return Response(status_code=499)

    return Starlette(routes=[Route("/health", handle), Route("/v1/models", handle),
                            Route("/v1/chat/completions", handle, methods=["POST"]),
                            Route("/{path:path}", handle, methods=["GET", "POST"])], lifespan=lifespan)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve")
    serve.add_argument("--upstream", default=os.environ.get("LOCALS_VLLM_URL", "http://127.0.0.1:8001"))
    serve.add_argument("--model", default=os.environ.get("LOCALS_VLLM_MODEL"))
    serve.add_argument("--port", type=int, default=8321)
    run = sub.add_parser("run", help="Run the upstream Locals multi-agent harness against vLLM")
    run.add_argument("task")
    run.add_argument("--dir", required=True)
    run.add_argument("--check", required=True)
    run.add_argument("--base-url", default="http://127.0.0.1:8321")
    run.add_argument("--workers", type=int, default=2)
    run.add_argument("--parts", type=int, default=4)
    run.add_argument("--steps", type=int, default=10)
    run.add_argument("--rounds", type=int, default=2)
    run.add_argument("--versions", type=int, default=1)
    run.add_argument("--report")
    args = parser.parse_args(argv)
    if args.command == "serve":
        import uvicorn
        uvicorn.run(create_app(args.upstream, args.model, os.environ.get("LOCALS_VLLM_API_KEY"),
                               loop_guard=load_loop_guard()),
                    host="127.0.0.1", port=args.port)
        return
    import urllib.request
    from locals.harness import Run

    root = Path(args.dir).resolve(strict=True)
    if not root.is_dir() or root == Path.home() or root == Path(root.anchor):
        parser.error("--dir must name a project directory")
    if min(args.workers, args.parts, args.steps, args.versions) < 1 or args.rounds < 0:
        parser.error("workers, parts, steps and versions must be positive; rounds must be nonnegative")
    base = args.base_url.rstrip("/")
    with urllib.request.urlopen(base + "/health", timeout=10) as response:
        health = json.load(response)
    if health.get("backend") != "vllm":
        parser.error("--base-url must point to the Locals vLLM gateway")
    runner = Run(args.task, root, base, health["model"], args.check, max_parts=args.parts,
                 workers=args.workers, rounds=args.rounds, max_steps=args.steps,
                 versions=args.versions, race=0, keep_dir=root.parent / ".locals-runs")
    report = runner.go()
    if args.report:
        Path(args.report).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    raise SystemExit(0 if report.get("passed") is True and not report.get("skipped") and not report.get("links") else 1)


if __name__ == "__main__":
    main()
