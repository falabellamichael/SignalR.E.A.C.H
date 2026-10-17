"""Keep explicitly provisioned private model connections alive on the host.

The operator supplies model-runtime.json locally. No SSH host, identity, or
provider credential is shipped in source or accepted from model API requests.
"""
import json
from pathlib import Path
import re
import subprocess
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from .runtime import no_window_kwargs, port_open

GPU_FORWARDS = ((18001, 8001), (18002, 8002), (18004, 8004), (18030, 8030))


def healthy(port, direct=False):
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://127.0.0.1:%d/health" % port, timeout=2) as response:
            if response.status != 200:
                return False
            if direct:
                value = json.loads(response.read(65536))
                return (value.get("service") == "codegpt-direct"
                        and value.get("status") == "ready"
                        and value.get("agents") is False)
            return True
    except (OSError, ValueError):
        return False


class Dependency:
    def __init__(self, name, command, ports, root, direct=False, restart_on_unhealthy=True):
        self.name, self.command, self.ports = name, command, tuple(ports)
        self.root, self.direct = Path(root), direct
        self.restart_on_unhealthy = restart_on_unhealthy
        self.process = None
        self.failures = 0
        self.next_attempt = 0.0
        self.retry_delay = 5
        self.status = "starting"

    def tick(self):
        now = time.monotonic()
        if self.process is not None and self.process.poll() is not None:
            self.process = None
        with ThreadPoolExecutor(max_workers=len(self.ports)) as pool:
            ready = all(pool.map(lambda port: healthy(port, self.direct), self.ports))
        if ready:
            self.failures, self.retry_delay = 0, 5
            self.status = "ready"
            return self.status
        self.failures += 1
        if self.process is not None:
            self.status = "starting" if self.failures < 3 else "unhealthy"
            if self.failures >= 3 and self.restart_on_unhealthy:
                # Only our own child may be recycled. Never kill an adopted
                # listener or a GPU container because a health probe timed out.
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
                self.process = None
                self.next_attempt = now + self.retry_delay
            return self.status
        if any(port_open(port) for port in self.ports):
            self.status = "unhealthy_external_listener"
            return self.status
        if now < self.next_attempt:
            self.status = "retrying"
            return self.status
        self.next_attempt = now + self.retry_delay
        self.retry_delay = min(self.retry_delay * 2, 60)
        log_path = self.root / (self.name + ".log")
        if log_path.exists() and log_path.stat().st_size > 2 * 1024 * 1024:
            log_path.replace(log_path.with_suffix(".previous.log"))
        try:
            with log_path.open("ab") as log:
                self.process = subprocess.Popen(self.command, cwd=str(self.root),
                    stdout=log, stderr=subprocess.STDOUT, **no_window_kwargs())
            self.failures = 0
            self.status = "starting"
        except OSError:
            self.status = "start_failed"
        return self.status


class ModelRuntime:
    def __init__(self, root, node):
        self.root = Path(root)
        self.dependencies = []
        path = self.root / "model-runtime.json"
        if not path.is_file():
            return
        if path.stat().st_size > 16384:
            raise ValueError("Model runtime profile is too large")
        profile = json.loads(path.read_text(encoding="utf-8-sig"))
        if profile.get("schema_version") != 1:
            raise ValueError("Unsupported model runtime profile")
        gpu = profile.get("gpu_tunnel")
        if gpu:
            target = gpu.get("target", "")
            executable = Path(gpu.get("executable", ""))
            identity = Path(gpu.get("identity_file", ""))
            if (not re.fullmatch(r"[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+", target)
                    or not executable.is_absolute() or not executable.is_file()
                    or not identity.is_absolute() or not identity.is_file()):
                raise ValueError("The operator's GPU tunnel profile is invalid")
            command = [str(executable), "-N", "-T", "-i", str(identity),
                       "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
                       "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15",
                       "-o", "ServerAliveCountMax=3", "-o", "ExitOnForwardFailure=yes"]
            for local, remote in GPU_FORWARDS:
                command += ["-L", "127.0.0.1:%d:127.0.0.1:%d" % (local, remote)]
            self.dependencies.append(Dependency("gpu-tunnel", command + [target],
                                     [local for local, _ in GPU_FORWARDS], self.root,
                                     restart_on_unhealthy=False))
            # A model reload is not an SSH failure. Keep the shared transport
            # alive for the other models; SSH keepalives detect a lost peer and
            # the normal dead-child path reconnects it after the process exits.
        if profile.get("codegpt_direct") is True:
            script = self.root / "copilot" / "tray" / "codegpt-direct-host.cjs"
            if not script.is_file():
                raise ValueError("The installed CodeGPT direct host is missing")
            self.dependencies.append(Dependency("codegpt-direct", [node, str(script)],
                                                 [21304], self.root, direct=True))

    def tick(self):
        status = {}
        for dependency in self.dependencies:
            try:
                status[dependency.name] = dependency.tick()
            except Exception:
                # One unavailable connection must not disable recovery of the
                # other connection, the account service, or the public relay.
                status[dependency.name] = "check_failed"
        path = self.root / "model-runtime-status.json"
        data = json.dumps(status, sort_keys=True)
        if not path.exists() or path.read_text(encoding="utf-8") != data:
            pending = path.with_suffix(".tmp")
            pending.write_text(data, encoding="utf-8")
            pending.replace(path)
        return status
