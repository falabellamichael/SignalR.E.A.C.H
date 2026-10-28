"""Native GPU discovery, authenticated dispatch and transport isolation."""
import io
import json
from unittest.mock import patch

from tests.test_reachd_access import RelayFixture, TUNNEL
from reachd.support import _text_batches


class SupportModelTests(RelayFixture):
    def post(self, path, body, headers=None):
        status, data, _ = self.call("POST", path,
            {"Content-Type": "application/json", **(headers or self.bearer(**TUNNEL))},
            json.dumps(body).encode())
        return status, json.loads(data)

    def test_catalog_lists_native_roles_and_keeps_authentication(self):
        self.assertEqual(self.status("GET", "/v1/models", TUNNEL), 401)
        status, data, _ = self.call("GET", "/v1/models", self.bearer(**TUNNEL))
        self.assertEqual(status, 200)
        models = {model["id"]: model for model in json.loads(data)["data"]}
        self.assertEqual(models["bge-m3"]["type"], "embedding")
        self.assertEqual(models["bge-m3"]["max_model_len"], 2048)
        self.assertEqual(models["bge-reranker-v2-m3"]["type"], "reranker")
        for model in ("d1-omni-600m", "d1-3b"):
            self.assertNotIn(model, models)  # Native decisions are not chat choices.

    def test_native_paths_require_key_and_reject_customer_bypass(self):
        for path in ("/v1/embeddings", "/v1/rerank", "/rerank", "/v1/decisions"):
            with self.subTest(path=path):
                self.assertEqual(self.post(path, {}, TUNNEL)[0], 401)
                status, body = self.post(path, {}, {"Authorization": "Bearer rch_session_fixture"})
                if path == "/v1/decisions":
                    # Customer decisions belong to the account service. An
                    # unconfigured host fails closed and never reaches the GPU.
                    self.assertEqual(status, 503)
                    self.assertEqual(body["error"]["code"], "accounts_unconfigured")
                else:
                    self.assertEqual(status, 403)

    def test_operation_mismatch_invalid_json_and_unsupported_format_never_dispatch(self):
        with patch("reachd.support.urllib.request.build_opener") as opener:
            for body in ([], {"model": "http://invalid.example/model"}, {"model": "d1-3b"},
                         {"model": "bge-m3", "encoding_format": "base64"},
                         {"model": "bge-m3", "dimensions": 768}):
                self.assertEqual(self.post("/v1/embeddings", body)[0], 400)
            opener.assert_not_called()

    def test_fixed_gpu_dispatch_strips_credentials_and_preserves_vectors(self):
        response = io.BytesIO(json.dumps({"model": "BAAI/bge-m3", "data": [{"index": 0, "embedding": [0.5, 0.25]}],
                                         "usage": {"prompt_tokens": 9, "total_tokens": 9}}).encode())
        with patch("reachd.support.urllib.request.build_opener") as factory:
            factory.return_value.open.return_value = response
            status, result = self.post("/v1/embeddings", {"model": "bge-m3", "input": ["fixture"],
                                                        "encoding_format": "float"})
            request = factory.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, "http://127.0.0.1:18030/v1/embeddings")
            self.assertIsNone(request.get_header("Authorization"))
            self.assertEqual(json.loads(request.data)["model"], "BAAI/bge-m3")
        self.assertEqual(status, 200)
        self.assertEqual(result["model"], "bge-m3")
        self.assertEqual(result["data"][0]["embedding"], [0.5, 0.25])
        self.assertEqual(self.state.gate._active, 0)

    def test_both_rerank_url_forms_and_decision_models_use_native_operations(self):
        for path, model, repository, expected in [
            ("/v1/rerank", "bge-reranker-v2-m3", "BAAI/bge-reranker-v2-m3", "/rerank"),
            ("/rerank", "BAAI/bge-reranker-v2-m3", "BAAI/bge-reranker-v2-m3", "/rerank"),
            ("/v1/decisions", "d1-omni-600m", "LiquidAI/d1-omni-600M", "/v1/decisions"),
            ("/v1/decisions", "d1-3b", "LiquidAI/d1-3B", "/v1/decisions"),
        ]:
            with self.subTest(path=path, model=model), patch("reachd.support.urllib.request.build_opener") as factory:
                factory.return_value.open.return_value = io.BytesIO(b'{"results":[{"index":0,"relevance_score":0.9}]}')
                self.assertEqual(self.post(path, {"model": model, "documents": ["fixture"], "query": "fixture"})[0], 200)
                request = factory.return_value.open.call_args.args[0]
                self.assertEqual(request.full_url, "http://127.0.0.1:18030" + expected)
                self.assertEqual(json.loads(request.data)["model"], repository)

    def test_failure_releases_capacity_and_rate_budget_blocks_dispatch(self):
        with patch("reachd.support.urllib.request.build_opener") as factory:
            factory.return_value.open.side_effect = OSError("fixture failure")
            self.assertEqual(self.post("/v1/embeddings", {"model": "bge-m3", "input": ["fixture"]})[0], 502)
            self.assertEqual(self.state.gate._active, 0)
        with patch.object(self.state.limiter, "check", return_value=(False, {}, "fixture")), \
                patch("reachd.support.urllib.request.build_opener") as factory:
            self.assertEqual(self.post("/v1/embeddings", {"model": "bge-m3"})[0], 429)
            factory.assert_not_called()

    def test_twenty_one_embeddings_preserve_order_global_indices_and_total_usage(self):
        sent = []
        def reply(request, **_kwargs):
            body = json.loads(request.data)
            sent.append(body)
            rows = [{"index": i, "embedding": [float(text)]} for i, text in enumerate(body["input"])]
            return io.BytesIO(json.dumps({"data": list(reversed(rows)),
                "usage": {"prompt_tokens": len(rows), "total_tokens": len(rows)}}).encode())
        with patch("reachd.support.urllib.request.build_opener") as factory:
            factory.return_value.open.side_effect = reply
            texts = [str(i) for i in range(21)]
            status, result = self.post("/v1/embeddings", {"model": "bge-m3", "input": texts})
        self.assertEqual(status, 200)
        self.assertEqual([len(body["input"]) for body in sent], [16, 5])
        self.assertEqual([text for body in sent for text in body["input"]], texts)
        self.assertEqual([row["index"] for row in result["data"]], list(range(21)))
        self.assertEqual([row["embedding"][0] for row in result["data"]], list(range(21)))
        self.assertEqual(result["usage"], {"prompt_tokens": 21, "total_tokens": 21})
        self.assertEqual(self.state.gate._active, 0)

    def test_nineteen_rerank_candidates_apply_top_n_after_global_ranking(self):
        for top_n in (4, 19):
            sent = []
            def reply(request, **_kwargs):
                body = json.loads(request.data)
                sent.append(body)
                rows = [{"index": i, "relevance_score": float(text) / 20}
                        for i, text in enumerate(body["documents"])]
                return io.BytesIO(json.dumps({"results": list(reversed(rows))}).encode())
            with self.subTest(top_n=top_n), patch("reachd.support.urllib.request.build_opener") as factory:
                factory.return_value.open.side_effect = reply
                status, result = self.post("/v1/rerank", {"model": "bge-reranker-v2-m3", "query": "fixture",
                    "documents": [str(i) for i in range(19)], "top_n": top_n})
            self.assertEqual(status, 200)
            self.assertEqual([len(body["documents"]) for body in sent], [16, 3])
            self.assertTrue(all("top_n" not in body and body["query"] == "fixture" for body in sent))
            self.assertEqual([row["index"] for row in result["results"]], list(reversed(range(19)))[:top_n])

    def test_text_character_budget_splits_batches_without_truncation(self):
        texts = ["a" * 70000, "b" * 70000, "c" * 70000]
        batches = list(_text_batches(texts))
        self.assertEqual([start for start, _batch in batches], [0, 1, 2])
        self.assertEqual([text for _start, batch in batches for text in batch], texts)

    def test_failed_second_batch_never_returns_partial_embeddings(self):
        first = {"data": [{"index": i, "embedding": [float(i)]} for i in range(16)],
                 "usage": {"prompt_tokens": 16, "total_tokens": 16}}
        with patch("reachd.support.urllib.request.build_opener") as factory:
            factory.return_value.open.side_effect = [io.BytesIO(json.dumps(first).encode()), OSError("fixture failure")]
            status, result = self.post("/v1/embeddings", {"model": "bge-m3", "input": ["fixture"] * 21})
        self.assertEqual(status, 502)
        self.assertNotIn("data", result)
        self.assertEqual(self.state.gate._active, 0)
