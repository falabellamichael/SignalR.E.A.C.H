"""Fixed private model routes. Client requests never choose hosts or credentials."""

GPU_MODELS = {
    "gemma-4-12b-qat": ("google/gemma-4-12B-it-qat-q4_0-unquantized", 18001, "Gemma 4 12B QAT", "FP8 (BF16 vision)", 0),
    "ornith-1.5-9b": ("ornith-ai/Ornith-1.5-9B", 18002, "Ornith 1.5 9B", "FP8 (BF16 vision)", 0),
    "minicpm5-2b": ("openbmb/MiniCPM5-2B", 18004, "MiniCPM5 2B", "FP8", 0),
}
GPU_TP_MODELS = frozenset(("gemma-4-12b-qat", "ornith-1.5-9b"))
DIRECT_MODELS = (
    "deepseek-v4.1-flash", "ox-alpha", "gemini-3.8-flash", "gpt-5.6-luna",
    "glm-5.2", "MiniMax-M3", "gpt-4o", "gpt-5", "claude-sonnet-4.6",
    "claude-opus-4.6", "gemini-3.7-flash", "gemini-2.5-flash", "gpt-4o-mini",
)
BROWSER_MODELS = ("chatgpt-chat", "copilot-chat", "gemini-chat")


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
            output = data.pop("max_completion_tokens", data.get("max_tokens", 1024))
            data["max_tokens"] = min(output, 4096) if type(output) is int else output
            for field in ("tools", "tool_choice", "parallel_tool_calls"):
                data.pop(field, None)
            data["chat_template_kwargs"] = {"enable_thinking": False}
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
                         "context_window": 8192, "max_tokens": 1024,
                         "max_tokens_cap": 4096, "allow_tools": False}
    models.update({alias: {**spec_defaults, "upstream": "bridge/" + alias,
                          "description": "Provider browser chat (existing sign-in)",
                          "enabled": alias != "gemini-chat", "public": alias != "gemini-chat"}
                   for alias in BROWSER_MODELS})
    return models
