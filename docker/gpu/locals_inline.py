"""Install the Locals serving layer on the existing loopback vLLM endpoint."""
import json
import subprocess
import time
import urllib.request

IMAGE = "signalreach-locals:vllm-inline"
RULE = ["-t", "nat", "OUTPUT", "-d", "127.0.0.1/32", "-p", "tcp", "--dport", "8001",
        "-m", "comment", "--comment", "signalreach-locals", "-j", "REDIRECT", "--to-ports", "8321"]


def command(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs)


def main():
    details = json.loads(command("docker", "inspect", "reach-gemma").stdout)[0]
    address = details["NetworkSettings"]["Networks"]["bridge"]["IPAddress"]
    if not address:
        raise RuntimeError("Gemma bridge address unavailable")
    upstream = f"http://{address}:8000"
    with urllib.request.urlopen(upstream + "/v1/models", timeout=10) as response:
        assert json.load(response)["data"]
    old = subprocess.run(["docker", "inspect", "reach-locals"], capture_output=True)
    if old.returncode == 0:
        current = json.loads(old.stdout)[0]
        expected_image = command("docker", "image", "inspect", IMAGE, "--format", "{{.Id}}").stdout.strip()
        if current["Image"] == expected_image and "LOCALS_VLLM_URL=" + upstream in current["Config"]["Env"]:
            command("docker", "start", "reach-locals")
        else:
            raise RuntimeError("Existing Locals image or upstream differs; retain it for rollback before replacement")
    else:
        command("docker", "run", "-d", "--name", "reach-locals", "--network", "host",
                "--restart", "unless-stopped", "--memory", "512m", "-e", "LOCALS_VLLM_URL=" + upstream, IMAGE)
    for _ in range(60):
        try:
            with urllib.request.urlopen("http://127.0.0.1:8321/health", timeout=2) as response:
                assert json.load(response)["reasoning_loop_guard"]
            break
        except OSError:
            time.sleep(1)
    else:
        raise RuntimeError("Locals did not become ready")
    check = subprocess.run(["iptables", *RULE[:2], "-C", *RULE[2:]], capture_output=True)
    if check.returncode:
        command("iptables", *RULE[:2], "-I", *RULE[2:])
    with urllib.request.urlopen("http://127.0.0.1:8001/health", timeout=10) as response:
        assert json.load(response)["backend"] == "vllm"
    print("EXISTING_USER_ENDPOINT_INLINE_LOCALS_READY")


if __name__ == "__main__":
    main()
