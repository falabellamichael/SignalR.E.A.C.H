"""Fixed private model routes. Client requests never choose hosts or credentials."""

GPU_MODELS = {
    "gemma-4-12b-qat": ("google/gemma-4-12B-it-qat-q4_0-unquantized", 18001, "Gemma 4 12B QAT FP8", "FP8 (BF16 vision)", 0),
    "ornith-1.5-9b": ("ornith-ai/Ornith-1.5-9B", 18002, "Ornith 1.5 9B", "FP8 (BF16 vision)", 0),
    "minicpm5-2b": ("openbmb/MiniCPM5-2B", 18004, "MiniCPM5 2B", "FP8", 0),
}
GPU_TP_MODELS = frozenset(("gemma-4-12b-qat", "ornith-1.5-9b"))
GPU_TOOL_MODELS = frozenset(("gemma-4-12b-qat", "minicpm5-2b"))
GPU_DISABLED_MODELS = frozenset(("minicpm5-2b",))
GPU_CONTEXT_WINDOWS = {"gemma-4-12b-qat": 65536, "ornith-1.5-9b": 61776, "minicpm5-2b": 39856}
GPU_SAMPLING_DEFAULTS = {
    "ornith-1.5-9b": {"temperature": 0.6, "top_p": 0.95, "top_k": 20},
    "gemma-4-12b-qat": {"temperature": 1.0, "top_p": 0.95, "top_k": 64},
    "minicpm5-2b": {"temperature": 1.0, "top_p": 0.95, "min_p": 0.0},
}
DIRECT_MODELS = (
    "deepseek-v4.1-flash", "ox-alpha", "gemini-3.8-flash", "gpt-5.6-luna",
    "glm-5.2", "MiniMax-M3", "gpt-4o", "gpt-5", "claude-sonnet-4.6",
    "claude-opus-4.6", "gemini-3.7-flash", "gemini-2.5-flash", "gpt-4o-mini",
)
BROWSER_MODELS = ("chatgpt-chat", "copilot-chat", "gemini-chat")


def is_gpu_model(spec):
    """Only fixed private GPU selectors belong to the general API catalog."""
    return isinstance(spec, dict) and spec.get("upstream") in {
        "gpu/" + alias for alias in GPU_MODELS}


def is_login_provider_model(spec):
    if not isinstance(spec, dict):
        return False
    upstream = spec.get("upstream", "")
    return (upstream in {"direct/" + alias for alias in DIRECT_MODELS}
            or upstream in {"bridge/" + alias for alias in BROWSER_MODELS}
            or upstream.startswith("bridge/codegpt-eco")
            or upstream.startswith("codegpt/"))


def catalog_models(models, catalog, *, include_private=False):
    """Select before dispatch so a saved fallback cannot cross catalogs."""
    predicate = is_login_provider_model if catalog == "login-providers" else is_gpu_model
    return {alias: spec for alias, spec in models.items()
            if predicate(spec) and spec.get("enabled")
            and (include_private or spec.get("public", True))}


def login_provider_catalog(models):
    data = []
    for alias, spec in sorted(catalog_models(models, "login-providers", include_private=True).items()):
        upstream = spec["upstream"]
        provider = upstream[7:-5] if upstream in {"bridge/" + name for name in BROWSER_MODELS} else "codegpt"
        data.append({"id": alias, "object": "model", "created": 1715367049,
                     "owned_by": "SignalR.E.A.C.H", "name": alias,
                     "description": spec.get("description", ""),
                     "provider": provider, "requires_login": True,
                     "catalog": "login-providers"})
    return {"object": "list", "catalog": "login-providers", "data": data}


def service_label(upstream):
    if upstream.startswith("gpu/"):
        return "Private GPU model service"
    if upstream.startswith("direct/"):
        return "CodeGPT direct service"
    if upstream.startswith("bridge/"):
        return "Local tray bridge"
    return "OmniRoute"


def private_route(upstream):
    if upstream.startswith("gpu/"):
        alias = upstream[4:]
        if alias not in GPU_MODELS:
            raise ValueError("Unknown GPU model selector")
        model, port, *_ = GPU_MODELS[alias]
        return {"url": "http://127.0.0.1:%d/v1/chat/completions" % port,
                "model": model, "circuit": "gpu/" + alias}
    if upstream.startswith("direct/"):
        model = upstream[7:]
        if model not in DIRECT_MODELS:
            raise ValueError("Unknown CodeGPT direct selector")
        return {"url": "http://127.0.0.1:21304/v1/chat/completions",
                "model": model, "circuit": "codegpt-direct"}
    return None


def dispatch(upstream, payload, state):
    """Build each initial/fallback request independently; keep legacy paths."""
    route = private_route(upstream)
    data = dict(payload)
    headers = {"Content-Type": "application/json"}
    if route:
        data["model"] = route["model"]
        if upstream.startswith("direct/"):
            data = {key: value for key, value in data.items()
                    if key in ("model", "messages", "stream", "max_tokens", "max_completion_tokens")}
        else:
            if "max_completion_tokens" in data:
                data["max_tokens"] = data.pop("max_completion_tokens")
            if upstream[4:] not in GPU_TOOL_MODELS:
                for field in ("tools", "tool_choice", "parallel_tool_calls"):
                    data.pop(field, None)
            alias = upstream[4:]
            if alias == "gemma-4-12b-qat" and "tools" in data:
                from reachd.gemma_tools import compatible_tools
                data["tools"] = compatible_tools(data["tools"])
            # All resident chat models use their native reasoning path.
            data["chat_template_kwargs"] = {"enable_thinking": True}
            for field, value in GPU_SAMPLING_DEFAULTS[alias].items():
                data.setdefault(field, value)
            if data.get("stream"):
                options = data.get("stream_options")
                if options is None or isinstance(options, dict):
                    data["stream_options"] = {**(options or {}), "include_usage": True}
        return route["url"], data, headers, route["circuit"]
    bridge = upstream.startswith("bridge/")
    data["model"] = upstream[7:] if bridge else upstream
    if not bridge:
        headers["Authorization"] = "Bearer " + state.key
    url = (state.bridge_url if bridge else state.omniroute_url).rstrip("/") + "/chat/completions"
    return url, data, headers, "bridge" if bridge else "omniroute"


def deployment_defaults(spec_defaults):
    models = {alias: {**spec_defaults, "upstream": "direct/" + alias,
                     "description": "CodeGPT direct model (no agents)", "allow_tools": False}
              for alias in DIRECT_MODELS}
    models["rch-gpt-4o-mini"] = {**models["gpt-4o-mini"]}
    for alias, (_, _, name, precision, gpu) in GPU_MODELS.items():
        placement = "GPUs 0+1 (TP2)" if alias in GPU_TP_MODELS else "GPU %d" % gpu
        models[alias] = {**spec_defaults, "upstream": "gpu/" + alias,
                         "description": "%s — %s, %s, resident" % (name, precision, placement),
                         "enabled": alias not in GPU_DISABLED_MODELS,
                         "public": alias not in GPU_DISABLED_MODELS,
                         "context_window": GPU_CONTEXT_WINDOWS.get(alias, 8192), "max_tokens": None,
                         "max_tokens_cap": 0, "allow_tools": alias in GPU_TOOL_MODELS}
    models.update({alias: {**spec_defaults, "upstream": "bridge/" + alias,
                          "description": "Provider browser chat (existing sign-in)",
                          "enabled": alias != "gemini-chat", "public": alias != "gemini-chat"}
                   for alias in BROWSER_MODELS})
    return models
