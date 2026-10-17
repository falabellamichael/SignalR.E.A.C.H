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
                    "ttft_s": .01, "elapsed_s": .1, "max_chunk_gap_s": .02}

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
                    "ttft_s": .01, "elapsed_s": .1, "max_chunk_gap_s": .02}

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

        with patch("sys.argv", ["trial", "gemma", "--sequences", "4"]), \
                patch.object(trial, "api", side_effect=api), \
                patch.object(trial.urllib.request, "urlopen", side_effect=lambda *a, **k: Response(b"")), \
                contextlib.redirect_stdout(io.StringIO()):
            trial.main()
        command = created[0]["Cmd"]
        graph = json.loads(command[command.index("--compilation-config") + 1])
        self.assertEqual(graph["cudagraph_capture_sizes"], [4, 8, 12, 16])
        self.assertEqual(graph["max_cudagraph_capture_size"], 16)


if __name__ == "__main__":
    unittest.main()
