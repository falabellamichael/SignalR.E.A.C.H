"""Run on the GPU host: reversibly trial explicit chat runtime settings."""

import argparse
import http.client
import json
import socket
import subprocess
import time
import urllib.request


class DockerConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect("/var/run/docker.sock")


def api(method, path, body=None):
    connection = DockerConnection("localhost", timeout=120)
    try:
        connection.request(method, "/v1.45" + path,
                           json.dumps(body) if body is not None else None,
                           {"Content-Type": "application/json"})
        response = connection.getresponse()
        data = response.read()
        if response.status >= 300:
            raise RuntimeError(f"Docker {response.status}: {data.decode()}")
        return json.loads(data) if data else None
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("model", choices=["gemma", "minicpm"])
    parser.add_argument("--env", action="append", default=[])
    parser.add_argument("--prefill", type=int)
    parser.add_argument("--sequences", type=int)
    parser.add_argument("--capture", type=int, nargs="+")
    parser.add_argument("--rollback", action="store_true")
    args = parser.parse_args()
    if args.capture and (min(args.capture) < 1 or args.capture != sorted(set(args.capture))):
        parser.error("capture sizes must be positive, unique, and ascending")
    name = "reach-" + args.model
    backup = name + "-before-concurrency-trial"
    if args.rollback:
        api("GET", f"/containers/{backup}/json")
        api("POST", f"/containers/{name}/stop?t=60")
        api("DELETE", f"/containers/{name}")
        api("POST", f"/containers/{backup}/rename?name={name}")
        api("POST", f"/containers/{name}/update", {"RestartPolicy": {"Name": "unless-stopped"}})
        api("POST", f"/containers/{name}/start")
        return
    details = api("GET", f"/containers/{name}/json")
    config = details["Config"]
    if config.get("Labels", {}).get("io.signalreach.deployment") != "signalreach-nextify-20261015":
        raise RuntimeError("Unexpected container ownership")
    for existing in api("GET", "/containers/json?all=true"):
        if "/" + backup in existing["Names"]:
            raise RuntimeError("A previous trial exists; roll it back before another trial")
    environment = dict(value.split("=", 1) for value in config["Env"])
    for value in args.env:
        key, value = value.split("=", 1)
        environment[key] = value
    config["Env"] = [f"{key}={value}" for key, value in environment.items()]
    command = config["Cmd"]
    for flag, value in (("--max-num-batched-tokens", args.prefill), ("--max-num-seqs", args.sequences)):
        if value is not None:
            if value < 1:
                raise ValueError("Scheduler limits must be positive")
            command[command.index(flag) + 1] = str(value)
    if args.capture:
        index = command.index("--compilation-config") + 1
        graph = json.loads(command[index])
        graph.update(cudagraph_capture_sizes=args.capture, max_cudagraph_capture_size=max(args.capture))
        command[index] = json.dumps(graph)
    elif args.sequences is not None:
        # The target verifies one token plus drafts per sequence. The V2 MTP
        # assistant also decodes one token per sequence on later draft steps,
        # using this same capture list; omit those sizes and it falls back to eager.
        speculation = json.loads(command[command.index("--speculative-config") + 1]) if "--speculative-config" in command else {}
        width = 1 + speculation.get("num_speculative_tokens", 0)
        sizes = sorted(set(range(1, args.sequences + 1)) |
                       {width * n for n in range(1, args.sequences + 1)})
        index = command.index("--compilation-config") + 1
        graph = json.loads(command[index])
        graph.update(cudagraph_capture_sizes=sizes, max_cudagraph_capture_size=max(sizes))
        command[index] = json.dumps(graph)
    sequences = int(command[command.index("--max-num-seqs") + 1])
    prefill = int(command[command.index("--max-num-batched-tokens") + 1])
    if prefill < sequences:
        raise ValueError("Prefill budget must be at least the sequence limit")
    config["HostConfig"] = details["HostConfig"]
    # Refuse to stop a model while it has active or queued requests.
    port = 8001 if args.model == "gemma" else 8004
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=10) as response:
        metrics = response.read().decode()
    for line in metrics.splitlines():
        if line.startswith(("vllm:num_requests_running{", "vllm:num_requests_waiting{")) and float(line.split()[-1]):
            raise RuntimeError("Model has active requests; retry when idle")
    api("POST", f"/containers/{name}/stop?t=60")
    api("POST", f"/containers/{name}/rename?name={backup}")
    api("POST", f"/containers/{backup}/update", {"RestartPolicy": {"Name": "no"}})
    try:
        api("POST", f"/containers/create?name={name}", config)
        api("POST", f"/containers/{name}/start")
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            state = api("GET", f"/containers/{name}/json")["State"]
            if not state["Running"]:
                raise RuntimeError("Trial container exited")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=3) as response:
                    if response.status == 200:
                        print("READY", name, "rollback container:", backup, flush=True)
                        return
            except OSError:
                pass
            time.sleep(3)
        raise TimeoutError("Trial readiness timeout")
    except BaseException:
        subprocess.run(["docker", "rm", "-f", name], check=False)
        api("POST", f"/containers/{backup}/rename?name={name}")
        api("POST", f"/containers/{name}/update", {"RestartPolicy": {"Name": "unless-stopped"}})
        api("POST", f"/containers/{name}/start")
        raise


if __name__ == "__main__":
    main()
