"""CPU-only checks for sustained load generation and graph trial sizing."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1] / "docker" / "gpu"


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ConcurrencyTests(unittest.TestCase):
    def test_disabled_minicpm_preserves_saved_profile_without_starting(self):
        launch = load("launch_services")
        self.assertIn("minicpm", launch.DISABLED_SERVICES)
        self.assertIn("minicpm", launch.SERVICES)
        self.assertEqual(launch.CHAT_CONTEXT_WINDOWS["minicpm"], 39904)
        with patch.object(launch, "docker") as docker, patch.object(launch, "check_weights") as weights:
            with self.assertRaisesRegex(RuntimeError, "disabled.*preserving"):
                launch.start("minicpm", {})
        docker.assert_not_called()
        weights.assert_not_called()

    def test_disabled_minicpm_is_unloaded_and_restart_policy_is_cleared(self):
        launch = load("launch_services")
        details = {"HostConfig": {"RestartPolicy": {"Name": "unless-stopped"}},
                   "State": {"Status": "running"}}
        def docker(*args, **kwargs):
            found = args == ("container", "inspect", "reach-minicpm")
            return unittest.mock.Mock(returncode=0 if found else 1,
                                      stdout=json.dumps([details]) if found else "")
        with patch.object(launch, "docker", side_effect=docker) as calls, \
                contextlib.redirect_stdout(io.StringIO()):
            launch.quiesce_disabled()
        self.assertIn(unittest.mock.call("update", "--restart", "no", "reach-minicpm"), calls.call_args_list)
        self.assertIn(unittest.mock.call("stop", "reach-minicpm"), calls.call_args_list)
        self.assertFalse(any("rm" in call.args or "remove" in call.args for call in calls.call_args_list))

    def test_gemma_q8_context_matches_relay_and_preserves_legacy_profile(self):
        launch = load("launch_services")
        spec = importlib.util.spec_from_file_location("context_model_routes", ROOT.parents[1] / "server/reachd/model_routes.py")
        routes = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(routes)
        self.assertEqual(launch.CHAT_CONTEXT_WINDOWS["gemma"], 65536)
        profile = json.loads((ROOT / "gemma_q8_profile.json").read_text())
        self.assertEqual(profile["context_per_chat"], 262144)
        self.assertEqual(routes.GPU_CONTEXT_WINDOWS["gemma-4-12b-qat"], profile["context_per_chat"])

    def test_gemma_adoption_requires_tool_parser_and_template_without_restarting(self):
        launch = load("launch_services")
        key = "gemma"
        _, gpu, port, fraction, extra = launch.SERVICES[key]
        command = ["--tensor-parallel-size", "2", "--max-model-len", str(launch.CHAT_CONTEXT_WINDOWS[key]),
                   "--max-num-seqs", str(launch.CHAT_MAX_SEQUENCES[key]), "--dtype", "bfloat16",
                   "--gpu-memory-utilization", str(fraction),
                   "--speculative-config", json.dumps(launch.CHAT_SPECULATIVE_CONFIGS[key]),
                   "--max-num-batched-tokens", str(launch.CHAT_PREFILL_TOKENS[key]),
                   "--compilation-config", json.dumps(launch.chat_decode_config(key)), *extra]
        details = {"Config": {"Labels": {"io.signalreach.deployment": launch.DEPLOYMENT},
                              "Cmd": command, "Env": [f"ROCR_VISIBLE_DEVICES={gpu}", "GPU_MAX_HW_QUEUES=1",
                                                       "OMP_NUM_THREADS=1", "VLLM_USE_V2_MODEL_RUNNER=1"]},
                   "HostConfig": {"Binds": [f"{launch.HSA_OVERRIDE}:/opt/rocm-7.2.3/lib/libhsa-runtime64.so.1.18.0:ro",
                                              f"{launch.RCCL_OVERRIDE}:/opt/rocm-7.2.3/lib/librccl.so.1.0.70203:ro"],
                                  "Memory": launch.HOST_MEMORY_LIMIT_BYTES, "MemorySwap": launch.HOST_MEMORY_LIMIT_BYTES,
                                  "OomScoreAdj": 500, "RestartPolicy": {"Name": "unless-stopped"}},
                   "State": {"Status": "running"}}
        manifest = {"models": [{"name": "gemma4-12b-qat", "repository": "gemma-test"}]}
        for missing in (None, "--enable-auto-tool-choice", "--tool-call-parser", "--chat-template"):
            candidate = json.loads(json.dumps(details))
            if missing:
                index = candidate["Config"]["Cmd"].index(missing)
                del candidate["Config"]["Cmd"][index:index + (1 if missing == "--enable-auto-tool-choice" else 2)]
            result = unittest.mock.Mock(returncode=0, stdout=json.dumps([candidate]))
            with self.subTest(missing=missing), patch.object(launch, "check_weights"), \
                    patch.object(launch, "docker", return_value=result) as docker, \
                    patch.object(launch, "wait_ready") as ready, contextlib.redirect_stdout(io.StringIO()):
                if missing:
                    with self.assertRaisesRegex(RuntimeError, "tool|template"):
                        launch.start(key, manifest)
                    ready.assert_not_called()
                else:
                    launch.start(key, manifest)
                    ready.assert_called_once_with("reach-gemma", port)
                docker.assert_called_once_with("container", "inspect", "reach-gemma", check=False)

    def test_sustained_requests_refill_slots_and_report_errors(self):
        bench = load("benchmark_concurrency")
        active = peak = calls = 0
        lock = threading.Lock()

        def request(*args):
            nonlocal active, peak, calls
            with lock:
                active += 1
                peak = max(peak, active)
                calls += 1
                index = calls
            time.sleep(.01 if index % 2 else .03)
            with lock:
                active -= 1
            if index == 3:
                return {"error": "injected failure"}
            return {"usage": {"completion_tokens": 10}, "end_to_end_tokens_s": 100,
                    "ttft_s": .01, "first_content_s": .01, "elapsed_s": .1, "max_chunk_gap_s": .02}

        class Opener:
            def open(self, *args, **kwargs):
                return io.BytesIO(b'{"data":[{"id":"test"}]}')

        output = io.StringIO()
        argv = ["bench", "--models", "gemma", "--rounds", "1", "--concurrency", "2",
                "--requests", "7", "--warmup", "0"]
        with patch("sys.argv", argv), patch.object(bench, "request", request), \
                patch.object(bench.urllib.request, "build_opener", return_value=Opener()), \
                contextlib.redirect_stdout(output):
            status = bench.main()
        report = json.loads(output.getvalue())
        self.assertEqual((calls, peak, report["errors"]), (7, 2, 1))
        self.assertEqual(sorted(s["request"] for s in report["samples"]), list(range(7)))
        self.assertEqual(status, 1)
        self.assertEqual(report["per_model"]["gemma"]["completion_tokens"], 60)

    def test_stream_rates_use_provider_tokens_and_full_request_time(self):
        bench = load("benchmark_concurrency")
        events = [
            {"choices": [{"delta": {"content": "many tokens in one speculative chunk"}}]},
            {"choices": [{"delta": {"content": "more tokens"}}]},
            {"choices": [{"delta": {}, "finish_reason": "length"}]},
            {"usage": {"completion_tokens": 20}},
        ]
        stream = b"".join(b"data: " + json.dumps(e).encode() + b"\n\n" for e in events)
        opener = unittest.mock.Mock()
        opener.open.return_value = io.BytesIO(stream + b"data: [DONE]\n")
        with patch.object(bench.urllib.request, "build_opener", return_value=opener), \
                patch.object(bench.time, "perf_counter", side_effect=[0, 2, 3, 5]):
            result = bench.request("http://local", "test", "prompt", 20)
        self.assertNotIn("error", result)
        self.assertNotIn("decode_tokens_s", result)
        self.assertEqual(result["end_to_end_tokens_s"], 4)
        self.assertEqual((result["ttft_s"], result["chunks"], result["max_chunk_gap_s"]), (2, 2, 1))
        self.assertEqual(result["first_content_s"], result["ttft_s"])

    def test_reasoning_only_stream_has_no_visible_content_latency(self):
        bench = load("benchmark_concurrency")
        events = [
            {"choices": [{"delta": {"reasoning_content": "thinking"}}]},
            {"choices": [{"delta": {}, "finish_reason": "length"}],
             "usage": {"completion_tokens": 10}},
        ]
        stream = b"".join(b"data: " + json.dumps(e).encode() + b"\n\n" for e in events)
        opener = unittest.mock.Mock()
        opener.open.return_value = io.BytesIO(stream + b"data: [DONE]\n")
        with patch.object(bench.urllib.request, "build_opener", return_value=opener), \
                patch.object(bench.time, "perf_counter", side_effect=[0, 2, 5]):
            result = bench.request("http://local", "test", "prompt", 10)
        self.assertNotIn("error", result)
        self.assertEqual(result["ttft_s"], 2)
        self.assertIsNone(result["first_content_s"])
        report = bench.summarize([result], 5)
        self.assertEqual(report["requests_with_visible_content"], 0)
        self.assertIsNone(report["p95_first_content_s"])
        self.assertEqual(report["aggregate_tokens_s"], 2)

    def test_visible_content_latency_excludes_earlier_reasoning(self):
        bench = load("benchmark_concurrency")
        events = [
            {"choices": [{"delta": {"reasoning_content": "thinking"}}]},
            {"choices": [{"delta": {"content": "answer"}, "finish_reason": "stop"}],
             "usage": {"completion_tokens": 20}},
        ]
        stream = b"".join(b"data: " + json.dumps(e).encode() + b"\n\n" for e in events)
        opener = unittest.mock.Mock()
        opener.open.return_value = io.BytesIO(stream + b"data: [DONE]\n")
        with patch.object(bench.urllib.request, "build_opener", return_value=opener), \
                patch.object(bench.time, "perf_counter", side_effect=[0, 2, 3, 5]):
            result = bench.request("http://local", "test", "prompt", 20)
        self.assertNotIn("error", result)
        self.assertEqual(result["ttft_s"], 2)
        self.assertEqual(result["first_content_s"], 3)
        report = bench.summarize([result], 5)
        self.assertEqual(report["requests_with_visible_content"], 1)
        self.assertEqual(report["p95_first_content_s"], 3)
        self.assertEqual(report["aggregate_tokens_s"], 4)

    def test_invalid_or_incomplete_streams_fail(self):
        bench = load("benchmark_concurrency")
        for usage, done, finish in [(None, True, True), ({"completion_tokens": -1}, True, True),
                                    ({"completion_tokens": True}, True, True),
                                    ({"completion_tokens": 10}, False, True),
                                    ({"completion_tokens": 10}, True, False)]:
            with self.subTest(usage=usage, done=done, finish=finish):
                event = {"choices": [{"delta": {"content": "text"},
                                      "finish_reason": "stop" if finish else None}], "usage": usage}
                stream = b"data: " + json.dumps(event).encode() + b"\n"
                opener = unittest.mock.Mock()
                opener.open.return_value = io.BytesIO(stream + (b"data: [DONE]\n" if done else b""))
                with patch.object(bench.urllib.request, "build_opener", return_value=opener):
                    self.assertIn("error", bench.request("http://local", "test", "prompt", 20))

    def test_mixed_reports_keep_targets_distinct_and_account_for_worker_errors(self):
        bench = load("benchmark_concurrency")
        opener = unittest.mock.Mock()
        opener.open.side_effect = lambda *a, **k: io.BytesIO(b'{"data":[{"id":"same-id"}]}')

        def request(base, *args):
            if base.endswith("18004"):
                raise RuntimeError("worker failure")
            return {"usage": {"completion_tokens": 10}, "end_to_end_tokens_s": 100,
                    "ttft_s": .01, "first_content_s": .01, "elapsed_s": .1, "max_chunk_gap_s": .02}

        output = io.StringIO()
        argv = ["bench", "--rounds", "2", "--concurrency", "1", "--requests", "3", "--warmup", "0"]
        with patch("sys.argv", argv), patch.object(bench, "request", request), \
                patch.object(bench.urllib.request, "build_opener", return_value=opener), \
                contextlib.redirect_stdout(output):
            self.assertEqual(bench.main(), 1)
        reports = [json.loads(line) for line in output.getvalue().splitlines()]
        mixed = reports[-1]
        self.assertEqual(mixed["errors"], 3)
        self.assertEqual(mixed["per_model"]["gemma"]["requests"], 3)
        self.assertEqual(mixed["per_model"]["minicpm"]["errors"], 3)
        self.assertIsNone(mixed["per_model"]["minicpm"]["p95_ttft_s"])
        self.assertAlmostEqual(sum(s["aggregate_tokens_s"] for s in mixed["per_model"].values()),
                               mixed["aggregate_tokens_s"])

    def test_percentile_includes_tail_for_small_samples(self):
        bench = load("benchmark_concurrency")
        self.assertEqual(bench.percentile([1, 10], .95), 10)
        self.assertIsNone(bench.percentile([], .95))

    def test_trial_sizes_graphs_for_speculative_concurrency(self):
        trial = load("trial_container")
        config = {"Labels": {"io.signalreach.deployment": "signalreach-nextify-20261015"},
                  "Env": [], "Cmd": ["--max-num-seqs", "2", "--max-num-batched-tokens", "1024",
                                      "--speculative-config", '{"num_speculative_tokens":3}',
                                      "--compilation-config", '{"mode":0}']}
        created = []

        def api(method, path, body=None):
            if path == "/containers/reach-gemma/json":
                return {"Config": config, "HostConfig": {}, "State": {"Running": True}}
            if path == "/containers/json?all=true":
                return []
            if path.startswith("/containers/create"):
                created.append(body)

        class Response(io.BytesIO):
            status = 200

        with patch("sys.argv", ["trial", "gemma", "--sequences", "5"]), \
                patch.object(trial, "api", side_effect=api), \
                patch.object(trial.urllib.request, "urlopen", side_effect=lambda *a, **k: Response(b"")), \
                contextlib.redirect_stdout(io.StringIO()):
            trial.main()
        command = created[0]["Cmd"]
        graph = json.loads(command[command.index("--compilation-config") + 1])
        # vLLM drops captures larger than max_seqs * tokens_per_request for
        # each pass. Five target-only sizes left the fifth draft batch eager.
        for tokens_per_request in (1, 4):
            captures = [size for size in graph["cudagraph_capture_sizes"]
                        if size <= 5 * tokens_per_request]
            for active_requests in range(1, 6):
                with self.subTest(pass_width=tokens_per_request, active=active_requests):
                    self.assertIn(active_requests * tokens_per_request, captures)
        self.assertEqual(graph["max_cudagraph_capture_size"], 20)


if __name__ == "__main__":
    unittest.main()
