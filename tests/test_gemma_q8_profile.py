"""Q8 profile adoption preserves unrelated containers and validates the runtime."""

import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch


GPU = Path(__file__).resolve().parents[1] / "docker/gpu"
spec = importlib.util.spec_from_file_location("gemma_q8_profile", GPU / "gemma_q8_profile.py")
q8 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(q8)


class GemmaQ8ProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.profile = json.loads((GPU / "gemma_q8_profile.json").read_text())
        (self.root / "gemma_q8_profile.json").write_text(json.dumps(self.profile))
        for kind in ("target", "draft", "projector"):
            p = self.root / "models/gemma4-12b-qat-q8" / self.profile[kind]["file"]
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"fixture")
        memory = 16 * 1024 ** 3
        self.details = {"Config": {"Labels": {"io.signalreach.deployment": "fixture"},
            "Image": self.profile["image"], "Cmd": self.profile["args"],
            "Env": ["ROCR_VISIBLE_DEVICES=0", "OMP_NUM_THREADS=4", "GPU_MAX_HW_QUEUES=1",
                    "ROCBLAS_USE_HIPBLASLT=0"]},
            "HostConfig": {"Memory": memory, "MemorySwap": memory, "OomScoreAdj": 500,
                "Binds": [f"{self.root}/models:/models:ro"],
                "PortBindings": {"8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8001"}]},
                "RestartPolicy": {"Name": "unless-stopped"}}, "State": {"Status": "running"}}

    def call(self):
        docker = MagicMock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps([self.details])))
        with patch.object(q8, "wait_native") as wait:
            q8.start_gemma_q8(self.root, "fixture", docker, MagicMock())
        return docker, wait

    def test_running_selected_q8_is_adopted_without_restarting(self):
        docker, wait = self.call()
        docker.assert_called_once_with("container", "inspect", "reach-gemma", check=False)
        wait.assert_called_once()

    def test_wrong_image_command_gpu_or_port_is_preserved(self):
        for field in ("image", "command", "gpu", "port"):
            original = json.loads(json.dumps(self.details))
            if field == "image": self.details["Config"]["Image"] = "other-image"
            if field == "command": self.details["Config"]["Cmd"] = ["other-runtime"]
            if field == "gpu": self.details["Config"]["Env"][0] = "ROCR_VISIBLE_DEVICES=0,1"
            if field == "port": self.details["HostConfig"]["PortBindings"]["8000/tcp"][0]["HostIp"] = "0.0.0.0"
            docker = MagicMock(return_value=SimpleNamespace(returncode=0, stdout=json.dumps([self.details])))
            with self.subTest(field=field), patch.object(q8, "wait_native") as wait:
                with self.assertRaisesRegex(RuntimeError, "Preserving reach-gemma"):
                    q8.start_gemma_q8(self.root, "fixture", docker, MagicMock())
                docker.assert_called_once()
                wait.assert_not_called()
            self.details = original

    def test_missing_asset_and_wrong_checksum_never_create_a_container(self):
        docker = MagicMock(return_value=SimpleNamespace(returncode=1, stdout=""))
        with self.assertRaisesRegex(RuntimeError, "checksum"):
            q8.start_gemma_q8(self.root, "fixture", docker, MagicMock())
        docker.assert_called_once_with("container", "inspect", "reach-gemma", check=False)
        docker.reset_mock()
        (self.root / "models/gemma4-12b-qat-q8" / self.profile["target"]["file"]).unlink()
        with self.assertRaisesRegex(RuntimeError, "Missing"):
            q8.start_gemma_q8(self.root, "fixture", docker, MagicMock())
        docker.assert_not_called()

    def test_unexpected_context_profile_is_rejected(self):
        self.profile["context_per_chat"] = 131072
        (self.root / "gemma_q8_profile.json").write_text(json.dumps(self.profile))
        with self.assertRaisesRegex(RuntimeError, "Unexpected Gemma Q8 profile"):
            q8.read_profile(self.root)

    def test_manifest_routes_q8_without_running_the_legacy_launcher(self):
        spec = importlib.util.spec_from_file_location("q8_launch", GPU / "launch_services.py")
        launch = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(launch)
        start = MagicMock()
        with patch.dict("sys.modules", {"gemma_q8_profile": SimpleNamespace(start_gemma_q8=start)}), \
                patch.object(launch, "check_weights") as weights, patch.object(launch, "docker") as docker:
            launch.start("gemma", {"gemma_runtime": "llama.cpp-q8"})
        start.assert_called_once_with(launch.ROOT, launch.DEPLOYMENT, docker, launch.wait_ready)
        weights.assert_not_called()
        docker.assert_not_called()
