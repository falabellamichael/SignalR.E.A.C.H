"""Recovery contracts for the provisioned private model connections."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
from reach import model_runtime as runtime


class ModelRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.addCleanup(self.temporary.cleanup)

    def dependency(self):
        return runtime.Dependency("fixture", ["fixture-program"], [18001], self.root)

    def test_healthy_external_service_is_adopted_without_spawning(self):
        with patch.object(runtime, "healthy", return_value=True), patch.object(runtime.subprocess, "Popen") as spawn:
            dependency = self.dependency()
            self.assertEqual(dependency.tick(), "ready")
        spawn.assert_not_called()

    def test_missing_connection_is_spawned_and_a_dead_child_is_revived(self):
        child = Mock()
        child.poll.return_value = None
        with patch.object(runtime, "healthy", return_value=False), patch.object(runtime, "port_open", return_value=False), \
                patch.object(runtime.time, "monotonic", return_value=100), patch.object(runtime.subprocess, "Popen", return_value=child) as spawn:
            dependency = self.dependency()
            self.assertEqual(dependency.tick(), "starting")
            self.assertEqual(spawn.call_count, 1)
            child.poll.return_value = 255
            with patch.object(runtime.time, "monotonic", return_value=120):
                self.assertEqual(dependency.tick(), "starting")
            self.assertEqual(spawn.call_count, 2)

    def test_failed_launch_backs_off_instead_of_spawning_every_probe(self):
        with patch.object(runtime, "healthy", return_value=False), patch.object(runtime, "port_open", return_value=False), \
                patch.object(runtime.time, "monotonic", return_value=100), patch.object(runtime.subprocess, "Popen", side_effect=OSError) as spawn:
            dependency = self.dependency()
            self.assertEqual(dependency.tick(), "start_failed")
            self.assertEqual(dependency.tick(), "retrying")
            self.assertEqual(spawn.call_count, 1)

    def test_unknown_unhealthy_listener_is_never_replaced(self):
        with patch.object(runtime, "healthy", return_value=False), patch.object(runtime, "port_open", return_value=True), \
                patch.object(runtime.subprocess, "Popen") as spawn:
            self.assertEqual(self.dependency().tick(), "unhealthy_external_listener")
        spawn.assert_not_called()

    def test_transient_health_failure_does_not_restart_owned_service(self):
        dependency = self.dependency()
        dependency.process = Mock()
        dependency.process.poll.return_value = None
        with patch.object(runtime, "healthy", side_effect=[False, True, False]):
            dependency.tick()
            dependency.tick()
            dependency.tick()
        dependency.process.terminate.assert_not_called()

    def test_three_failures_recycle_only_the_owned_child(self):
        dependency = self.dependency()
        child = dependency.process = Mock()
        child.poll.return_value = None
        with patch.object(runtime, "healthy", return_value=False):
            dependency.tick()
            dependency.tick()
            child.terminate.assert_not_called()
            self.assertEqual(dependency.tick(), "unhealthy")
        child.terminate.assert_called_once()
        child.wait.assert_called_once_with(timeout=5)
        self.assertIsNone(dependency.process)

    def test_model_reload_keeps_shared_tunnel_and_other_models_available(self):
        dependency = runtime.Dependency("gpu-tunnel", ["ssh"], [18001, 18002, 18004],
                                        self.root, restart_on_unhealthy=False)
        child = dependency.process = Mock()
        child.poll.return_value = None
        with patch.object(runtime, "healthy", side_effect=lambda port, direct: port != 18002), \
                patch.object(runtime.subprocess, "Popen") as spawn:
            for _ in range(12):
                status = dependency.tick()
            self.assertEqual(status, "unhealthy")
        child.terminate.assert_not_called()
        child.kill.assert_not_called()
        spawn.assert_not_called()
        self.assertIs(dependency.process, child)
        with patch.object(runtime, "healthy", return_value=True):
            self.assertEqual(dependency.tick(), "ready")
        self.assertEqual(dependency.failures, 0)

    def test_ssh_exit_still_reconnects_when_health_restarts_are_disabled(self):
        dependency = runtime.Dependency("gpu-tunnel", ["ssh"], [18001], self.root,
                                        restart_on_unhealthy=False)
        previous = dependency.process = Mock()
        previous.poll.return_value = 255
        replacement = Mock()
        with patch.object(runtime, "healthy", return_value=False), \
                patch.object(runtime, "port_open", return_value=False), \
                patch.object(runtime.subprocess, "Popen", return_value=replacement) as spawn:
            self.assertEqual(dependency.tick(), "starting")
        spawn.assert_called_once()
        self.assertIs(dependency.process, replacement)
        previous.terminate.assert_not_called()

    def test_unprovisioned_host_does_not_start_any_model_service(self):
        with patch.object(runtime.subprocess, "Popen") as spawn:
            manager = runtime.ModelRuntime(self.root, "node")
            self.assertEqual(manager.tick(), {})
        spawn.assert_not_called()

    def test_fixed_forwards_require_a_local_operator_profile(self):
        executable = self.root / "ssh.exe"
        identity = self.root / "operator-identity"
        executable.touch()
        identity.touch()
        profile = {"schema_version": 1, "gpu_tunnel": {"executable": str(executable),
                   "identity_file": str(identity), "target": "operator@fixture.invalid"}}
        (self.root / "model-runtime.json").write_text(json.dumps(profile), encoding="utf-8")
        manager = runtime.ModelRuntime(self.root, "node")
        command = manager.dependencies[0].command
        for local, remote in ((18001, 8001), (18002, 8002), (18004, 8004), (18030, 8030)):
            self.assertIn("127.0.0.1:%d:127.0.0.1:%d" % (local, remote), command)
        self.assertNotIn("18003", " ".join(command))
        self.assertIn("StrictHostKeyChecking=yes", command)
        self.assertIn("ExitOnForwardFailure=yes", command)
        self.assertIn("ServerAliveInterval=15", command)
        self.assertFalse(manager.dependencies[0].restart_on_unhealthy)
        profile["gpu_tunnel"]["target"] = "-oProxyCommand=unexpected"
        (self.root / "model-runtime.json").write_text(json.dumps(profile), encoding="utf-8")
        with self.assertRaises(ValueError):
            runtime.ModelRuntime(self.root, "node")

    def test_one_failed_check_does_not_block_the_other_dependency(self):
        manager = runtime.ModelRuntime(self.root, "node")
        bad, good = Mock(name="bad"), Mock(name="good")
        bad.name, good.name = "gpu-tunnel", "codegpt-direct"
        bad.tick.side_effect = OSError
        good.tick.return_value = "ready"
        manager.dependencies = [bad, good]
        self.assertEqual(manager.tick(), {"gpu-tunnel": "check_failed", "codegpt-direct": "ready"})
        good.tick.assert_called_once()


if __name__ == "__main__":
    unittest.main()
