"""Build and start the CPU-only Locals gateway beside the existing vLLM service."""

from pathlib import Path
import subprocess
import urllib.request
import time


def launch():
    root = Path(__file__).resolve().parent
    subprocess.run(["docker", "build", "-f", str(root / "Dockerfile.locals"),
                    "-t", "signalreach-locals:vllm-4f4d03f", str(root)], check=True)
    existing = subprocess.run(["docker", "inspect", "reach-locals"], capture_output=True)
    if existing.returncode == 0:
        raise RuntimeError("reach-locals already exists; inspect it before replacing or restarting it")
    subprocess.run(["docker", "run", "-d", "--name", "reach-locals", "--network", "host",
                    "--restart", "unless-stopped", "--memory", "512m",
                    "--label", "signalreach.backend=vllm", "signalreach-locals:vllm-4f4d03f"], check=True)
    for _ in range(30):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8321/health", timeout=3) as response:
                if response.status == 200:
                    print("LOCALS_VLLM_READY http://127.0.0.1:8321/v1")
                    return
        except OSError:
            time.sleep(1)
    raise RuntimeError("Locals gateway is not ready; inspect docker logs reach-locals")


if __name__ == "__main__":
    launch()
