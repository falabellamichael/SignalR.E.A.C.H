"""Create or adopt the selected Q8 runtime without replacing other containers."""

import hashlib
import json
from pathlib import Path
import urllib.request


def read_profile(root):
    profile = json.loads((Path(root) / "gemma_q8_profile.json").read_text())
    args = profile["args"]
    if (profile["backend"] != "llama.cpp" or profile["gpu_devices"] != "0"
            or profile["context_per_chat"] != 262144 or profile["parallel_chats"] != 2
            or int(args[args.index("-c") + 1]) != 524288
            or int(args[args.index("-np") + 1]) != 2
            or not profile["image"].startswith("ghcr.io/ggml-org/llama.cpp@sha256:")):
        raise RuntimeError("Unexpected Gemma Q8 profile; preserving existing services")
    return profile


def wait_native(profile, wait_ready, port=8001):
    wait_ready("reach-gemma", port)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(f"http://127.0.0.1:{port}/props", timeout=10) as response:
        props = json.load(response)
    if (props.get("default_generation_settings", {}).get("n_ctx") != profile["context_per_chat"]
            or props.get("total_slots") != profile["parallel_chats"]
            or props.get("model_ftype") != "Q8_0" or not props.get("modalities", {}).get("vision")):
        raise RuntimeError("Gemma Q8 native context, precision, or vision differs from its selected profile")


def start_gemma_q8(root, deployment, docker, wait_ready):
    root = Path(root)
    profile = read_profile(root)
    for kind in ("target", "draft", "projector"):
        path = (root / "models/gemma4-12b-qat-q8" / profile[kind]["file"]).resolve()
        if not path.is_relative_to((root / "models/gemma4-12b-qat-q8").resolve()) or not path.is_file():
            raise RuntimeError("Missing approved Gemma Q8 asset: " + kind)
    existing = docker("container", "inspect", "reach-gemma", check=False)
    if existing.returncode == 0:
        details = json.loads(existing.stdout)[0]
        config, host = details["Config"], details["HostConfig"]
        env = dict(v.split("=", 1) for v in config.get("Env", []) if "=" in v)
        memory = profile["host_memory_gib"] * 1024 ** 3
        if (config.get("Labels", {}).get("io.signalreach.deployment") != deployment
                or config.get("Image") != profile["image"] or config.get("Cmd") != profile["args"]
                or env.get("ROCR_VISIBLE_DEVICES") != profile["gpu_devices"]
                or env.get("OMP_NUM_THREADS") != "4" or env.get("GPU_MAX_HW_QUEUES") != "1"
                or env.get("ROCBLAS_USE_HIPBLASLT") != "0"
                or host.get("Memory") != memory or host.get("MemorySwap") != memory
                or host.get("OomScoreAdj") != 500
                or f"{root}/models:/models:ro" not in (host.get("Binds") or [])
                or host.get("PortBindings", {}).get("8000/tcp") != [
                    {"HostIp": "127.0.0.1", "HostPort": "8001"}]):
            raise RuntimeError("Preserving reach-gemma: existing runtime differs from the selected Q8 profile")
        state = details["State"]["Status"]
        if state not in {"running", "created", "exited"}:
            raise RuntimeError("Preserving reach-gemma in unexpected state " + state)
        if host.get("RestartPolicy", {}).get("Name") != "unless-stopped":
            docker("update", "--restart", "unless-stopped", "reach-gemma")
        if state != "running":
            docker("start", "reach-gemma")
    else:
        for kind in ("target", "draft", "projector"):
            asset = profile[kind]
            with (root / "models/gemma4-12b-qat-q8" / asset["file"]).open("rb") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() != asset["sha256"]:
                    raise RuntimeError("Gemma Q8 asset checksum mismatch: " + kind)
        args = ["run", "-d", "--init", "--pull=never", "--name", "reach-gemma",
                "--label", "io.signalreach.deployment=" + deployment, "--restart=unless-stopped",
                "--log-opt", "max-size=20m", "--log-opt", "max-file=3",
                "--device=/dev/kfd", "--device=/dev/dri", "--group-add=video", "--shm-size=2g",
                "--memory=16g", "--memory-swap=16g", "--oom-score-adj=500",
                "-e", "ROCR_VISIBLE_DEVICES=" + profile["gpu_devices"], "-e", "OMP_NUM_THREADS=4",
                "-e", "GPU_MAX_HW_QUEUES=1", "-e", "ROCBLAS_USE_HIPBLASLT=0",
                "-v", f"{root}/models:/models:ro", "-p", "127.0.0.1:8001:8000",
                profile["image"], *profile["args"]]
        docker(*args)
    wait_native(profile, wait_ready)
    print("READY reach-gemma Q8_0; 262144 tokens per chat; 2 chat slots", flush=True)
