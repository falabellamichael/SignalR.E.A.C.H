"""Start the requested models on the VM, preserving existing containers."""

import argparse
import json
from pathlib import Path
import subprocess
import time
import urllib.request


ROOT = Path("/srv/signalreach")
IMAGE = "vllm/vllm-openai-rocm@sha256:749f6f3f944f12af49966ac523c1f8573e4b229594b541954bd5f879b4496b1f"
DEPLOYMENT = "signalreach-nextify-20261015"
SERVICES = {
    "gemma": ("gemma4-12b-qat", "0,1", 8001, 0.55, [
        "--quantization", "fp8_per_tensor", "--quantization-config",
        '{"ignore":["vision_embedder.*"]}',
        "--enable-auto-tool-choice", "--tool-call-parser", "gemma4",
        "--reasoning-parser", "gemma4",
        "--chat-template", "/app/vllm/examples/tool_chat_template_gemma4.jinja",
        "--default-chat-template-kwargs", '{"enable_thinking":true}',
    ]),
    "ornith": ("ornith-1.5-9b", 1, 8002, 0.52, [
        "--quantization", "fp8_per_tensor", "--quantization-config", '{"ignore":["visual.*"]}',
        "--enable-auto-tool-choice", "--tool-call-parser", "qwen3_xml",
        "--reasoning-parser", "qwen3",
        "--mm-processor-kwargs", '{"max_pixels":262144,"max_frames":8}',
        "--limit-mm-per-prompt", '{"image":1,"video":1}',
    ]),
    "support": (None, 1, 8030, None, []),
    "minicpm": ("minicpm5-2b", "0,1", 8004, 0.24, [
        "--quantization", "fp8_per_tensor", "--enable-auto-tool-choice",
        "--tool-call-parser", "minicpm5", "--reasoning-parser", "qwen3",
    ]),
}


# Gemma and qualified MiniCPM use both GPUs with TP2.
# Distributed runtime checks remain separate from host-memory guards.
TP_MODELS = frozenset({"gemma", "minicpm"})
HOST_MEMORY_GUARDED_MODELS = frozenset({"gemma", "ornith"})
HOST_MEMORY_LIMIT_BYTES = 12 * 1024 ** 3
# Operator-disabled services retain their saved profile and assets.
DISABLED_SERVICES = frozenset({"ornith"})
RCCL_OVERRIDE = ROOT / "runtime/rccl-gfx1201-7.2.3/librccl.so.1"
HSA_OVERRIDE = ROOT / "runtime/rocr-7.2.3-poll-backoff/libhsa-runtime64.so.1"
CHAT_DECODE_CONFIG = {'mode': 0, 'cudagraph_mode': 'FULL_DECODE_ONLY', 'cudagraph_capture_sizes': [1, 2], 'max_cudagraph_capture_size': 2}
# Gemma MTP uses V2 to capture the assistant's forward pass and sampling on GPU.
CHAT_RUNNERS = {"gemma": "1", "ornith": "0", "minicpm": "0"}
# Host-side OpenMP coordination only; model weights and KV caches stay on GPU.
SERVICE_OMP_THREADS = {"gemma": "1", "ornith": "2", "minicpm": "1", "support": "2"}
# MTP needs both target verification (4 tokens/request) and later assistant
# decode (1 token/request) shapes to cover every admitted batch on runner V2.
CHAT_CAPTURE_SIZES = {"gemma": [1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 28, 32], "ornith": [2], "minicpm": [1, 2, 3, 4, 5]}
CHAT_MAX_SEQUENCES = {"gemma": 8, "ornith": 2, "minicpm": 5}
# Pin every qualified context so a future create cannot silently resize it.
CHAT_CONTEXT_WINDOWS = {"gemma": 65536, "ornith": 61776, "minicpm": 39904}
# Tokens of prompt work per scheduler step. Smaller Gemma chunks let an
# in-flight decode emit tokens while a second request prefills. Context length,
# tensor parallelism, MTP, and GPU placement stay as qualified below.
CHAT_PREFILL_TOKENS = {"gemma": 3072, "ornith": 2048, "minicpm": 2048}
CHAT_SPECULATIVE_CONFIGS = {
    "gemma": {
        "method": "mtp",
        "model": "/models/gemma4-12b-qat-assistant",
        "num_speculative_tokens": 3,
    },
}


def chat_decode_config(key):
    sizes = CHAT_CAPTURE_SIZES[key]
    return {**CHAT_DECODE_CONFIG, "cudagraph_capture_sizes": sizes,
            "max_cudagraph_capture_size": max(sizes)}


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, text=True, capture_output=True)


def check_weights(name):
    path = ROOT / "models" / name
    if not (path / "config.json").is_file():
        raise RuntimeError(f"Missing config for {name}; wait for its download")
    indexes = list(path.glob("*.index.json"))
    weights = set()
    for index in indexes:
        weights.update(json.loads(index.read_text()).get("weight_map", {}).values())
    if weights:
        if any(not (path / filename).is_file() for filename in weights):
            raise RuntimeError(f"Incomplete weight shards for {name}")
    elif not any(path.glob("*.safetensors")) and not (path / "pytorch_model.bin").is_file():
        raise RuntimeError(f"No completed weight file for {name}")


def wait_ready(name, port):
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        state = docker("inspect", "--format", "{{.State.Status}}", name).stdout.strip()
        if state != "running":
            raise RuntimeError(f"{name} is {state}; inspect its Docker logs")
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as response:
                if response.status == 200:
                    return
        except OSError:
            pass
        time.sleep(3)
    raise TimeoutError(f"{name} did not become ready in 15 minutes")


def gemma_config_override():
    """Supply Google's missing vision metadata without editing source assets."""
    path = ROOT / "models/gemma4-12b-qat"
    config = json.loads((path / "config.json").read_text())
    processor = json.loads((path / "processor_config.json").read_text())
    vision = config["vision_config"]
    soft_tokens = processor["image_seq_length"]
    patch_size = vision["patch_size"] * vision["pooling_kernel_size"]
    assert soft_tokens == processor["image_processor"]["max_soft_tokens"] == 280
    assert patch_size == 48
    for key, value in (("num_soft_tokens", soft_tokens), ("model_patch_size", patch_size)):
        assert key not in vision or vision[key] == value
        vision[key] = value
    target = ROOT / "overrides/gemma4-config.json"
    target.parent.mkdir(exist_ok=True)
    if target.exists():
        assert json.loads(target.read_text()) == config, "Preserving unexpected Gemma override"
    else:
        target.write_text(json.dumps(config, indent=2) + "\n")
    return target


def validate_existing_context(key, command, port, repository):
    expected = CHAT_CONTEXT_WINDOWS[key]
    actual = command[command.index("--max-model-len") + 1] if "--max-model-len" in command else None
    if actual == str(expected):
        return
    # Preserve the already-running MiniCPM auto profile only when the native
    # model API confirms the exact qualified window. Never rewrite it to fit.
    if key == "minicpm" and actual == "auto":
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(f"http://127.0.0.1:{port}/v1/models", timeout=3) as response:
                payload = json.load(response)
            matches = [item for item in payload.get("data", [])
                       if isinstance(item, dict) and item.get("id") == repository]
            if len(matches) == 1 and type(matches[0].get("max_model_len")) is int \
                    and matches[0]["max_model_len"] == expected:
                return
        except (OSError, ValueError, TypeError, AttributeError):
            pass
    raise RuntimeError(f"Preserving reach-{key}: context must be exactly {expected}; "
                       "MiniCPM auto requires matching live native model metadata")


def quiesce_disabled():
    """A disabled model must not stay resident. Stop a leftover container and
    clear its restart policy so Docker cannot load it again at boot."""
    for key in DISABLED_SERVICES:
        name = f"reach-{key}"
        existing = docker("container", "inspect", name, check=False)
        if existing.returncode != 0:
            continue
        details = json.loads(existing.stdout)[0]
        if details["HostConfig"].get("RestartPolicy", {}).get("Name") != "no":
            docker("update", "--restart", "no", name)
        if details["State"]["Status"] == "running":
            print(f"STOPPING disabled {name}", flush=True)
            docker("stop", name)
            print(f"STOPPED {name}", flush=True)


def start(key, manifest):
    if key in DISABLED_SERVICES:
        raise RuntimeError(f"Service {key} is disabled at the operator request; "
                           "preserving its containers, weights, and saved settings")
    model, gpu, port, fraction, extra = SERVICES[key]
    name = f"reach-{key}"
    repository = None
    if model:
        repository = next(item["repository"] for item in manifest["models"] if item["name"] == model)
        check_weights(model)
        if key in CHAT_SPECULATIVE_CONFIGS:
            check_weights(Path(CHAT_SPECULATIVE_CONFIGS[key]["model"]).name)
    else:
        for item in ("bge-m3", "bge-reranker-v2-m3", "d1-omni-600m"):
            check_weights(item)
    existing = docker("container", "inspect", name, check=False)
    if existing.returncode == 0:
        details = json.loads(existing.stdout)[0]
        labels = details["Config"].get("Labels") or {}
        if labels.get("io.signalreach.deployment") != DEPLOYMENT:
            raise RuntimeError(f"Preserving existing unrelated container {name}")
        environment = dict(value.split("=", 1) for value in details["Config"].get("Env", []) if "=" in value)
        if environment.get("ROCR_VISIBLE_DEVICES") != str(gpu):
            raise RuntimeError(f"Preserving {name}: existing GPU settings differ from the requested deployment")
        if environment.get("GPU_MAX_HW_QUEUES") != "1":
            raise RuntimeError(f"Preserving {name}: hardware queue limit differs from qualification")
        if environment.get("OMP_NUM_THREADS") != SERVICE_OMP_THREADS[key]:
            raise RuntimeError(f"Preserving {name}: OpenMP thread count differs from qualification")
        hsa_bind = f"{HSA_OVERRIDE}:/opt/rocm-7.2.3/lib/libhsa-runtime64.so.1.18.0:ro"
        if hsa_bind not in set(details["HostConfig"].get("Binds") or []):
            raise RuntimeError(f"Preserving {name}: existing container lacks the validated HSA runtime mount")
        if key != "support":
            command = details["Config"].get("Cmd") or []
            actual_tp = int(command[command.index("--tensor-parallel-size") + 1]) if "--tensor-parallel-size" in command else 1
            expected_tp = 2 if key in TP_MODELS else 1
            if actual_tp != expected_tp or environment.get("ROCR_VISIBLE_DEVICES") != str(gpu):
                raise RuntimeError(f"Preserving {name}: existing TP/GPU settings differ from the requested deployment")
            expected_dtype = "bfloat16"
            validate_existing_context(key, command, port, repository)
            actual_sequences = int(command[command.index("--max-num-seqs") + 1]) if "--max-num-seqs" in command else None
            if actual_sequences != CHAT_MAX_SEQUENCES[key]:
                raise RuntimeError(f"Preserving {name}: sequence limit differs from qualification")
            if "--dtype" not in command or command[command.index("--dtype") + 1] != expected_dtype:
                raise RuntimeError(f"Preserving {name}: activation dtype differs from qualification")
            if "--gpu-memory-utilization" not in command or float(command[command.index("--gpu-memory-utilization") + 1]) != fraction:
                raise RuntimeError(f"Preserving {name}: GPU memory budget differs from qualification")
            actual_speculation = json.loads(command[command.index("--speculative-config") + 1]) if "--speculative-config" in command else None
            if actual_speculation != CHAT_SPECULATIVE_CONFIGS.get(key):
                raise RuntimeError(f"Preserving {name}: speculative decoding differs from qualification")
            actual_prefill = int(command[command.index("--max-num-batched-tokens") + 1]) if "--max-num-batched-tokens" in command else None
            if actual_prefill != CHAT_PREFILL_TOKENS[key]:
                raise RuntimeError(f"Preserving {name}: prompt scheduling step must be exactly {CHAT_PREFILL_TOKENS[key]} tokens; "
                                   "context, TP, MTP and GPU placement are unchanged")
            if ("--enable-auto-tool-choice" in command) != ("--enable-auto-tool-choice" in extra):
                raise RuntimeError(f"Preserving {name}: automatic tool choice differs from qualification")
            for flag in ("--quantization", "--quantization-config", "--reasoning-parser", "--default-chat-template-kwargs",
                         "--tool-call-parser", "--chat-template"):
                expected = extra[extra.index(flag) + 1] if flag in extra else None
                actual = command[command.index(flag) + 1] if flag in command else None
                if flag in ("--quantization-config", "--default-chat-template-kwargs"):
                    expected = json.loads(expected) if expected else None
                    actual = json.loads(actual) if actual else None
                if actual != expected:
                    raise RuntimeError(f"Preserving {name}: {flag} differs from qualification")
        if key in HOST_MEMORY_GUARDED_MODELS:
            host = details["HostConfig"]
            if host.get("Memory") != HOST_MEMORY_LIMIT_BYTES or host.get("MemorySwap") != HOST_MEMORY_LIMIT_BYTES \
                    or host.get("OomScoreAdj") != 500:
                raise RuntimeError(f"Preserving {name}: host-memory guard differs from qualification")
        if key in TP_MODELS:
            required = {
                f"{RCCL_OVERRIDE}:/opt/rocm-7.2.3/lib/librccl.so.1.0.70203:ro",
                f"{HSA_OVERRIDE}:/opt/rocm-7.2.3/lib/libhsa-runtime64.so.1.18.0:ro",
            }
            if not required.issubset(set(details["HostConfig"].get("Binds") or [])):
                raise RuntimeError(f"Preserving {name}: existing container lacks the validated distributed runtime mounts")
        if key != "support":
            command = details["Config"].get("Cmd") or []
            if environment.get("VLLM_USE_V2_MODEL_RUNNER") != CHAT_RUNNERS[key]:
                raise RuntimeError(f"Preserving {name}: model runner differs from qualification")
            if key in CHAT_CAPTURE_SIZES:
                if "--enforce-eager" in command or "--compilation-config" not in command:
                    raise RuntimeError(f"Preserving {name}: expected the qualified decode graph configuration")
                if json.loads(command[command.index("--compilation-config") + 1]) != chat_decode_config(key):
                    raise RuntimeError(f"Preserving {name}: decode graph configuration differs from qualification")
            elif "--enforce-eager" not in command or "--compilation-config" in command:
                raise RuntimeError(f"Preserving {name}: expected the qualified eager execution configuration")
        if details["HostConfig"].get("RestartPolicy", {}).get("Name") != "unless-stopped":
            docker("update", "--restart", "unless-stopped", name)
        state = details["State"]["Status"]
        if state in {"created", "exited"}:
            docker("start", name)
        elif state != "running":
            raise RuntimeError(f"Preserving {name} in unexpected state {state}")
        print(f"EXISTING {name}; checking readiness", flush=True)
        wait_ready(name, port)
        return
    args = [
        "run", "-d", "--init", "--pull=never", "--name", name,
        "--label", f"io.signalreach.deployment={DEPLOYMENT}",
        "--restart=unless-stopped", "--log-opt", "max-size=20m", "--log-opt", "max-file=3",
        "--device=/dev/kfd", "--device=/dev/dri", "--group-add=video",
        "--shm-size=2g", "-e", f"ROCR_VISIBLE_DEVICES={gpu}",
        "-e", f"OMP_NUM_THREADS={SERVICE_OMP_THREADS[key]}", "-e", "GPU_MAX_HW_QUEUES=1", "-e", "HF_HUB_OFFLINE=1",
        "-e", "TRANSFORMERS_OFFLINE=1", "-e", "VLLM_ROCM_USE_AITER=0",
        "-v", f"{ROOT}/models:/models:ro",
        "-p", f"127.0.0.1:{port}:{8030 if key == 'support' else 8000}",
    ]
    if not HSA_OVERRIDE.is_file():
        raise RuntimeError(f"Missing validated HSA runtime: {HSA_OVERRIDE}")
    args += ["-v", f"{HSA_OVERRIDE}:/opt/rocm-7.2.3/lib/libhsa-runtime64.so.1.18.0:ro"]
    if key in HOST_MEMORY_GUARDED_MODELS:
        args += ["--memory=12g", "--memory-swap=12g", "--oom-score-adj=500"]
    if key in TP_MODELS:
        if not RCCL_OVERRIDE.is_file():
            raise RuntimeError(f"Missing validated RCCL library: {RCCL_OVERRIDE}")
        args += ["-v", f"{RCCL_OVERRIDE}:/opt/rocm-7.2.3/lib/librccl.so.1.0.70203:ro"]
        for setting in ("NCCL_PROTO=Simple", "NCCL_SET_STACK_SIZE=0", "NCCL_P2P_DISABLE=1", "NCCL_IB_DISABLE=1", "NCCL_MAX_NCHANNELS=4", "HSA_NO_SCRATCH_RECLAIM=0", "HSA_ENABLE_SDMA=0"):
            args += ["-e", setting]
    if key != "support":
        args += ["-e", f"VLLM_USE_V2_MODEL_RUNNER={CHAT_RUNNERS[key]}"]
    if key == "gemma":
        override = gemma_config_override()
        args += ["-v", f"{override}:/models/{model}/config.json:ro"]
    if key == "support":
        args += ["signalreach-support:20261017-fp8-gpu"]
    else:
        args += [
            IMAGE, f"/models/{model}", "--served-model-name", repository,
            "--host", "0.0.0.0", "--port", "8000",
            "--dtype", "bfloat16",
            "--max-model-len", str(CHAT_CONTEXT_WINDOWS[key]), "--max-num-seqs", str(CHAT_MAX_SEQUENCES[key]),
            "--max-num-batched-tokens", str(CHAT_PREFILL_TOKENS[key]),
            *(["--compilation-config", json.dumps(chat_decode_config(key))] if key in CHAT_CAPTURE_SIZES else ["--enforce-eager"]),
            "--gpu-memory-utilization", str(fraction),
            "--attention-backend", "TRITON_ATTN", "--mm-processor-cache-gb", "0",
            "--no-enable-log-requests", *extra,
        ]
        if key in CHAT_SPECULATIVE_CONFIGS:
            args += ["--speculative-config", json.dumps(CHAT_SPECULATIVE_CONFIGS[key])]
    if key in TP_MODELS:
        args += ["--tensor-parallel-size", "2", "--distributed-executor-backend", "mp", "--disable-custom-all-reduce"]
    print(f"STARTING {name} GPU={gpu} PORT={port}", flush=True)
    result = docker(*args)
    print(result.stdout.strip(), flush=True)
    wait_ready(name, port)
    print(f"READY {name}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=SERVICES)
    args = parser.parse_args()
    if args.only in DISABLED_SERVICES:
        parser.error(f"Service {args.only} is disabled at the operator request; "
                     "preserving its containers, weights, and saved settings")
    manifest = json.loads((ROOT / "models.json").read_text())
    if not args.only:
        quiesce_disabled()
    selected = [args.only] if args.only else [key for key in SERVICES if key not in DISABLED_SERVICES]
    for key in selected:
        start(key, manifest)
    print("SELECTED_SERVICES_READY", flush=True)


if __name__ == "__main__":
    main()
