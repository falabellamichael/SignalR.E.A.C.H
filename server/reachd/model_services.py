"""Local operator inventory and bounded Subscription model configuration."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import urllib.request

from reachd.model_routes import GPU_MODELS, DIRECT_MODELS, BROWSER_MODELS

LOCK = threading.Lock()
SUPPORT_MODELS = (
    ("bge-m3", "BAAI/bge-m3", "BGE M3", "FP16", "embeddings", "/v1/embeddings"),
    ("bge-reranker-v2-m3", "BAAI/bge-reranker-v2-m3", "BGE Reranker v2 M3", "FP16", "rerank", "/rerank"),
    ("d1-omni-600m", "LiquidAI/d1-omni-600M", "Liquid d1 Omni 600M", "FP16", "decisions", "/v1/decisions"),
    ("d1-3b", "LiquidAI/d1-3B", "Liquid d1 3B", "BF16", "decisions", "/v1/decisions"),
)


def account_file():
    return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "SignalREACH/accounts-private/accounts.json"


def read_account(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 2_000_000:
        raise ValueError("Subscription configuration must be an existing private regular file")
    raw = path.read_bytes()
    value = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(value.get("models"), list):
        raise ValueError("Subscription model configuration is missing")
    return raw, value


def model_revision(models):
    # Match the Node service's ordered JSON representation for acknowledgement.
    return hashlib.sha256(json.dumps(models, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def editable(model):
    bridge = model.get("bridge") or {}
    return model.get("access") == "requests" and (
        bridge.get("kind") == "gpu" and bridge.get("model") in {row[0] for row in GPU_MODELS.values()}
        or bridge.get("kind") == "codegpt-direct" and bridge.get("model") in DIRECT_MODELS
        or bridge.get("kind") == "tray" and bridge.get("model") in BROWSER_MODELS)


def subscription_view(path=None):
    path = path or account_file()
    try:
        raw, config = read_account(path)
    except (OSError, ValueError):
        return {"available": False, "message": "The local Subscription configuration is unavailable."}
    return {"available": True, "revision": hashlib.sha256(raw).hexdigest(),
            "modelsRevision": model_revision(config["models"]),
            "models": [{"id": m["id"], "name": m.get("name", m["id"]),
                        "provider": m.get("provider", ""), "enabled": m.get("metered") is True,
                        "route": dict(m.get("bridge") or {}), "editable": editable(m),
                        "maxInputBytes": m.get("maxInputBytes", 32000),
                        "maxOutputTokens": (m.get("maxOutputTokens") or 4096) if (m.get("bridge") or {}).get("kind") == "gpu" else None}
                       for m in config["models"]]}


def update_subscription(body, path=None):
    """Compare-and-swap only approved model fields; preserve all private state."""
    if not isinstance(body, dict) or set(body) != {"revision", "id", "changes"}:
        raise ValueError("Send a model id, current revision and changes")
    changes = body["changes"]
    if not isinstance(changes, dict) or not changes or set(changes) - {"enabled", "maxInputBytes", "maxOutputTokens"}:
        raise ValueError("Only enabled, maxInputBytes and GPU maxOutputTokens can change")
    path = path or account_file()
    with LOCK:
        raw, config = read_account(path)
        if body["revision"] != hashlib.sha256(raw).hexdigest():
            raise ValueError("Configuration changed; refresh before saving")
        model = next((m for m in config["models"] if m["id"] == body["id"]), None)
        if not model or not editable(model):
            raise ValueError("This legacy model is preserved but cannot be enabled here")
        for key, value in changes.items():
            if key == "enabled":
                if type(value) is not bool:
                    raise ValueError("Enabled must be a boolean")
                model["metered"] = value
            else:
                limit = 32000 if key == "maxInputBytes" else 4096
                if key == "maxOutputTokens" and model["bridge"]["kind"] != "gpu":
                    raise ValueError("This provider does not enforce an output token limit")
                if type(value) is not int or not 1 <= value <= limit:
                    raise ValueError("%s must be between 1 and %d" % (key, limit))
                model[key] = value
        if not any(m.get("metered") is True for m in config["models"]):
            raise ValueError("Keep at least one Subscription model enabled")
        backup = path.parent / "backups" / "admin-models"
        backup.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        (backup / (stamp + ".json")).write_bytes(raw)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".admin-models-", delete=False) as handle:
                temporary = Path(handle.name)
                handle.write((json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode())
                handle.flush()
                os.fsync(handle.fileno())
            # Do not overwrite a concurrent owner edit after the backup.
            if path.read_bytes() != raw:
                raise ValueError("Configuration changed; refresh before saving")
            os.replace(temporary, path)
        finally:
            if temporary and temporary.exists():
                temporary.unlink()
    return subscription_view(path)


def request_json(port, path, body=None, timeout=4):
    req = urllib.request.Request("http://127.0.0.1:%d%s" % (port, path),
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    # Never inherit a workstation proxy for private service requests.
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=timeout) as response:
        raw = response.read(2_000_000)
        return json.loads(raw) if raw else {}


def inventory():
    gpu_ports = tuple(row[1] for row in GPU_MODELS.values())
    ports = gpu_ports + (18030, 21304, 20978)
    def probe(port):
        try:
            result = request_json(port, "/v1/account/config" if port == 20978 else "/health")
            if port in gpu_ports:
                result["servedModels"] = [m["id"] for m in request_json(port, "/v1/models").get("data", [])]
            return result
        except Exception:
            return None
    with ThreadPoolExecutor(max_workers=len(ports)) as pool:
        health = dict(zip(ports, pool.map(probe, ports)))
    rows = [{"id": alias, "repository": repo, "name": name, "precision": precision,
             "gpu": gpu, "kind": "chat", "port": port, "path": "/v1/chat/completions",
             "contextWindow": 8192, "ready": repo in (health[port] or {}).get("servedModels", [])}
            for alias, (repo, port, name, precision, gpu) in GPU_MODELS.items()]
    support = health[18030] or {}
    rows.extend({"id": alias, "repository": repo, "name": name, "precision": precision,
                 "gpu": 1, "kind": kind, "port": 18030, "path": path,
                 "contextWindow": 2048 if kind in ("embeddings", "rerank") else None,
                 "ready": alias in support.get("models", [])}
                for alias, repo, name, precision, kind, path in SUPPORT_MODELS)
    subscription = subscription_view()
    public = health[20978] or {}
    subscription.update({"online": health[20978] is not None,
                         "appliedRevision": public.get("modelsRevision"),
                         "activeModels": [m["id"] for m in public.get("redemptionModels", [])]})
    direct = health[21304] or {}
    return {"gpuModels": rows, "residentReady": sum(m["ready"] for m in rows),
            "codegpt": {"ready": direct.get("status") == "ready" and direct.get("agents") is False,
                        "agents": direct.get("agents"),
                        "models": direct.get("models", []), "active": direct.get("active", 0)},
            "subscription": subscription}


def test_support(alias):
    row = next((m for m in SUPPORT_MODELS if m[0] == alias), None)
    if not row:
        raise ValueError("Choose one of the four support models")
    _, repository, _, _, kind, path = row
    body = {"model": repository}
    if kind == "embeddings":
        body["input"] = ["SignalREACH model readiness test"]
    elif kind == "rerank":
        body.update(query="refund", documents=["A customer requests a refund.", "The weather is sunny."], top_n=1)
    else:
        body.update(state="The customer requests a refund.", questions={"refund": {
            "type": "noul", "instructions": "Does the customer request a refund?"}})
    result = request_json(18030, path, body, timeout=90)
    if kind == "embeddings":
        result = {"dimensions": len(result["data"][0]["embedding"])}
    return {"model": alias, "ok": True, "result": result}
