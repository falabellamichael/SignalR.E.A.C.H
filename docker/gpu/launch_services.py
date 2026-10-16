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
    "gemma": ("gemma4-12b-qat", "0,1", 8001, 0.30, [
        "--quantization", "fp8_per_tensor", "--quantization-config",
        '{"ignore":["vision_embedder.*"]}',
    ]),
    "ornith": ("ornith-1.5-9b", "0,1", 8002, 0.25, [
        "--quantization", "fp8_per_tensor", "--quantization-config", '{"ignore":["visual.*"]}',
        "--enable-auto-tool-choice", "--tool-call-parser", "qwen3_xml",
        "--reasoning-parser", "qwen3",
        "--mm-processor-kwargs", '{"max_pixels":262144,"max_frames":8}',
        "--limit-mm-per-prompt", '{"image":1,"video":1}',
    ]),
    "support": (None, 1, 8030, None, []),
    "minicpm": ("minicpm5-2b", 0, 8004, 0.13, [
        "--quantization", "fp8_per_tensor", "--enable-auto-tool-choice",
        "--tool-call-parser", "minicpm5",
    ]),
}


TP_MODELS = {"gemma", "ornith"}
RCCL_OVERRIDE = ROOT / "runtime/rccl-gfx1201-7.2.3/librccl.so.1"
HSA_OVERRIDE = ROOT / "runtime/rocr-7.2.3-poll-backoff/libhsa-runtime64.so.1"
CHAT_DECODE_CONFIG = {'mode': 0, 'cudagraph_mode': 'FULL_DECODE_ONLY', 'cudagraph_capture_sizes': [1, 2], 'max_cudagraph_capture_size': 2}
CHAT_RUNNERS = {"gemma": "0", "ornith": "0", "minicpm": "0"}
CHAT_CAPTURE_SIZES = {"gemma": [1, 2], "ornith": [2], "minicpm": [2]}


def chat_decode_config(key):
    return {**CHAT_DECODE_CONFIG, "cudagraph_capture_sizes": CHAT_CAPTURE_SIZES[key]}


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


def start(key, manifest):
    model, gpu, port, fraction, extra = SERVICES[key]
    name = f"reach-{key}"
    if model:
        check_weights(model)
    else:
        for item in ("bge-m3", "bge-reranker-v2-m3", "d1-omni-600m", "d1-3b"):
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
        hsa_bind = f"{HSA_OVERRIDE}:/opt/rocm-7.2.3/lib/libhsa-runtime64.so.1.18.0:ro"
        if hsa_bind not in set(details["HostConfig"].get("Binds") or []):
            raise RuntimeError(f"Preserving {name}: existing container lacks the validated HSA runtime mount")
        if key != "support":
            command = details["Config"].get("Cmd") or []
            actual_tp = int(command[command.index("--tensor-parallel-size") + 1]) if "--tensor-parallel-size" in command else 1
            expected_tp = 2 if key in TP_MODELS else 1
            if actual_tp != expected_tp or environment.get("ROCR_VISIBLE_DEVICES") != str(gpu):
                raise RuntimeError(f"Preserving {name}: existing TP/GPU settings differ from the requested deployment")
            expected_dtype = "bfloat16" if key in {"gemma", "ornith"} else "half"
            if "--dtype" not in command or command[command.index("--dtype") + 1] != expected_dtype:
                raise RuntimeError(f"Preserving {name}: activation dtype differs from qualification")
            if "--gpu-memory-utilization" not in command or float(command[command.index("--gpu-memory-utilization") + 1]) != fraction:
                raise RuntimeError(f"Preserving {name}: GPU memory budget differs from qualification")
            for flag in ("--quantization", "--quantization-config"):
                expected = extra[extra.index(flag) + 1] if flag in extra else None
                actual = command[command.index(flag) + 1] if flag in command else None
                if flag == "--quantization-config":
                    expected = json.loads(expected) if expected else None
                    actual = json.loads(actual) if actual else None
                if actual != expected:
                    raise RuntimeError(f"Preserving {name}: quantization settings differ from qualification")
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
        "--restart=no", "--log-opt", "max-size=20m", "--log-opt", "max-file=3",
        "--device=/dev/kfd", "--device=/dev/dri", "--group-add=video",
        "--shm-size=2g", "-e", f"ROCR_VISIBLE_DEVICES={gpu}",
        "-e", "OMP_NUM_THREADS=2", "-e", "GPU_MAX_HW_QUEUES=1", "-e", "HF_HUB_OFFLINE=1",
        "-e", "TRANSFORMERS_OFFLINE=1", "-e", "VLLM_ROCM_USE_AITER=0",
        "-v", f"{ROOT}/models:/models:ro",
        "-p", f"127.0.0.1:{port}:{8030 if key == 'support' else 8000}",
    ]
    if not HSA_OVERRIDE.is_file():
        raise RuntimeError(f"Missing validated HSA runtime: {HSA_OVERRIDE}")
    args += ["-v", f"{HSA_OVERRIDE}:/opt/rocm-7.2.3/lib/libhsa-runtime64.so.1.18.0:ro"]
    if key in TP_MODELS:
        args += ["--memory=12g", "--memory-swap=12g", "--oom-score-adj=500"]
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
        args += ["signalreach-support:20261015"]
    else:
        repository = next(item["repository"] for item in manifest["models"] if item["name"] == model)
        args += [
            IMAGE, f"/models/{model}", "--served-model-name", repository,
            "--host", "0.0.0.0", "--port", "8000",
            "--dtype", "bfloat16" if key in {"gemma", "ornith"} else "half",
            "--max-model-len", "8192", "--max-num-seqs", "2",
            "--max-num-batched-tokens", str(4096 if key == "gemma" else 2048),
            *(["--compilation-config", json.dumps(chat_decode_config(key))] if key in CHAT_CAPTURE_SIZES else ["--enforce-eager"]),
            "--gpu-memory-utilization", str(fraction),
            "--attention-backend", "TRITON_ATTN", "--mm-processor-cache-gb", "0",
            "--no-enable-log-requests", *extra,
        ]
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
    manifest = json.loads((ROOT / "models.json").read_text())
    selected = [args.only] if args.only else SERVICES
    for key in selected:
        start(key, manifest)
    print("SELECTED_SERVICES_READY", flush=True)


if __name__ == "__main__":
    main()
