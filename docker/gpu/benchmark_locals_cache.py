"""Compare discovery refresh behavior locally; does not benchmark GPU inference."""
import asyncio
import json
from pathlib import Path
import statistics
import time
import types

import httpx


PATH = Path(__file__).with_name("locals_vllm.py")


def load_versions():
    source = PATH.read_text(encoding="utf-8")
    start = source.index("    async def models(client):")
    end = source.index("    @asynccontextmanager", start)
    baseline = source[:start] + '''    async def models(client):
        if time.monotonic() >= cached["expires"]:
            response = await client.get(upstream + "/v1/models")
            response.raise_for_status()
            cached.update(data=response.json(), expires=time.monotonic() + 10)
        return cached["data"]

''' + source[end:]
    versions = {}
    for name, text in (("baseline", baseline), ("optimized", source)):
        module = types.ModuleType(name)
        exec(compile(text, str(PATH), "exec"), module.__dict__)
        versions[name] = module
    return versions


async def sample(module, concurrency, serialized, warm):
    calls = 0
    backend_lock = asyncio.Lock()

    async def upstream(request):
        nonlocal calls
        calls += 1
        if serialized:
            async with backend_lock:
                await asyncio.sleep(0.01)
        else:
            await asyncio.sleep(0.01)
        return httpx.Response(200, json={"data": [{"id": "gemma"}]})

    app = module.create_app("http://backend", transport=httpx.MockTransport(upstream))
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://gateway") as client:
            if warm:
                assert (await client.get("/v1/models")).status_code == 200
                calls = 0
            start = time.perf_counter()
            results = await asyncio.gather(*(client.get("/v1/models") for _ in range(concurrency)))
            elapsed = (time.perf_counter() - start) * 1000
            assert all(r.status_code == 200 and r.json()["data"][0]["id"] == "gemma" for r in results)
    return elapsed, calls


async def main():
    versions = load_versions()
    for scenario, concurrency, serialized, warm in (
        ("cold_single", 1, False, False),
        ("cold_16_parallel_backend", 16, False, False),
        ("cold_16_serialized_backend", 16, True, False),
        ("warm_16", 16, False, True),
    ):
        measurements = {name: [] for name in versions}
        for trial in range(20):
            # Alternate ordering to reduce systematic warm-up bias.
            for name in list(versions)[::1 if trial % 2 == 0 else -1]:
                measurements[name].append(await sample(versions[name], concurrency, serialized, warm))
        report = {"scenario": scenario, "trials": 20}
        for name, values in measurements.items():
            expected = 0 if warm else (concurrency if name == "baseline" else 1)
            assert all(calls == expected for _, calls in values), (name, values)
            report[name] = {"median_burst_ms": round(statistics.median(v[0] for v in values), 3),
                            "backend_calls_per_burst": expected}
        print(json.dumps(report), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
