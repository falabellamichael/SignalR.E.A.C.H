"""MiniCPM no-progress detection and real HTTP/SSE termination."""

import copy
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from reachd.loop_guard import check_minicpm_loop
from tests.test_reachd_access import RelayFixture


def round_messages(index, *, name="lookup", arguments=None, result="same result", parallel=False):
    arguments = {"query": "one"} if arguments is None else arguments
    calls = [{"id": "call-%d-%d" % (index, n), "type": "function",
              "function": {"name": name + ("_second" if n else ""),
                           "arguments": json.dumps(arguments)}}
             for n in range(2 if parallel else 1)]
    return [{"role": "assistant", "content": None, "tool_calls": calls}] + [
        {"role": "tool", "tool_call_id": c["id"], "content": result} for c in calls]


def request(*, count=4, **kwargs):
    messages = [{"role": "system", "content": "Keep working carefully."},
                {"role": "user", "content": "Find the relevant items."}]
    for i in range(count):
        messages.extend(round_messages(i, **kwargs))
    return {"model": "minicpm5-2b", "messages": messages,
            "tools": [{"type": "function", "function": {"name": kwargs.get("name", "lookup"),
                       "parameters": {"type": "object", "properties": {}}}}]}


class LoopDetectionTests(unittest.TestCase):
    def check(self, payload, **kwargs):
        return check_minicpm_loop("gpu/minicpm5-2b", payload, **kwargs)

    def test_small_completed_work_and_pending_calls_are_allowed(self):
        self.assertIsNone(self.check(request(count=1)))
        pending = request(count=1)
        pending["messages"].extend(round_messages(1)[:1])
        self.assertIsNone(self.check(pending))
        self.assertIsNone(self.check(request(count=3)))

    def test_repeated_results_stop_before_another_generation_without_mutation(self):
        payload = request()
        original = copy.deepcopy(payload)
        self.assertEqual(self.check(payload), {"reason": "no_progress", "completed_rounds": 4,
                                              "no_progress_rounds": 3})
        self.assertEqual(payload, original)

    def test_github_queries_cannot_hide_identical_search_results(self):
        payload = request(count=0, name="extension__search-pull-requests_abc12")
        for i in range(4):
            payload["messages"].extend(round_messages(i,
                name="extension__search-pull-requests_abc12", arguments={"query": "query-%d" % i}))
        self.assertEqual(self.check(payload)["reason"], "no_progress")

    def test_explicit_read_only_annotation_also_compares_result_data(self):
        payload = request(count=0)
        payload["tools"][0]["annotations"] = {"readOnlyHint": True}
        for i in range(4):
            payload["messages"].extend(round_messages(i, arguments={"query": str(i)}))
        self.assertEqual(self.check(payload)["reason"], "no_progress")

    def test_distinct_writes_returning_success_and_real_pagination_make_progress(self):
        for kind in ("write", "pages"):
            payload = request(count=0)
            for i in range(10):
                payload["messages"].extend(round_messages(i, arguments={"page_or_id": i},
                    result="Success" if kind == "write" else json.dumps({"items": [i]})))
            self.assertIsNone(self.check(payload))

    def test_changed_results_reset_the_no_progress_counter(self):
        payload = request(count=3)
        payload["messages"].extend(round_messages(3, result="new result"))
        payload["messages"].extend(round_messages(4, result="new result"))
        self.assertIsNone(self.check(payload))

    def test_alternating_tools_are_detected_as_a_cycle(self):
        payload = request(count=0)
        for i in range(5):
            payload["messages"].extend(round_messages(i, name="lookup_a" if i % 2 else "lookup_b"))
        self.assertEqual(self.check(payload)["completed_rounds"], 5)

    def test_parallel_calls_count_as_one_round_and_wait_for_all_results(self):
        payload = request(parallel=True)
        self.assertEqual(self.check(payload)["completed_rounds"], 4)
        payload["messages"].pop()
        self.assertIsNone(self.check(payload))

    def test_metadata_and_json_key_order_are_not_progress(self):
        payload = request(count=0)
        for i in range(4):
            payload["messages"].extend(round_messages(i,
                arguments={"query": "one", "__raycast_tool_call_description": str(i)},
                result='{"a":1,"b":2}' if i % 2 else '{ "b": 2, "a": 1 }'))
        self.assertEqual(self.check(payload)["reason"], "no_progress")

    def test_new_user_turn_resets_budget_and_repeats(self):
        payload = request(count=15)
        payload["messages"].append({"role": "user", "content": "Try another approach."})
        payload["messages"].extend(round_messages(20))
        self.assertIsNone(self.check(payload))

    def test_hard_round_budget_stops_even_unique_outputs(self):
        payload = request(count=0)
        for i in range(12):
            payload["messages"].extend(round_messages(i, result="new-%d" % i))
        self.assertEqual(self.check(payload)["reason"], "round_limit")

    def test_model_scope_and_final_text_only_generation(self):
        payload = request()
        self.assertIsNone(check_minicpm_loop("gpu/gemma-4-12b-qat", payload))
        payload["tool_choice"] = "none"
        self.assertIsNone(self.check(payload))
        payload.pop("tool_choice")
        payload.pop("tools")
        self.assertIsNone(self.check(payload))

    def test_duplicate_ids_unmatched_results_and_malformed_calls_are_not_rounds(self):
        for variant in ("duplicate", "unmatched", "malformed"):
            payload = request(count=0)
            for i in range(6):
                messages = round_messages(i)
                if variant == "duplicate":
                    messages[0]["tool_calls"] *= 2
                elif variant == "unmatched":
                    messages[1]["tool_call_id"] = "not-a-call"
                else:
                    messages[0]["tool_calls"] = [None]
                payload["messages"].extend(messages)
            self.assertIsNone(self.check(payload))

    def test_malformed_tool_catalogue_does_not_crash_detection(self):
        for tools in (True, {"invalid": "catalogue"}, [None],
                      [{"function": {"name": {}}, "annotations": {"readOnlyHint": True}}]):
            payload = request(count=1)
            payload["tools"] = tools
            self.assertIsNone(self.check(payload))


class LoopRelayTests(RelayFixture):
    def setUp(self):
        super().setUp()
        # Exercise the retained Mini protocol explicitly; production defaults
        # leave this model disabled and unpublished.
        self.state.cfg["models"]["minicpm5-2b"].update(enabled=True, public=True)

    def call_loop(self, *, stream=False, model="minicpm5-2b", headers=None):
        payload = request()
        payload.update(model=model, stream=stream)
        return self.call("POST", "/v1/chat/completions", headers=headers,
                         body=json.dumps(payload))

    def test_json_stop_is_terminal_and_skips_gpu_compression_gate_and_cache(self):
        self.state.cfg["cache"]["enabled"] = True
        with patch("reachd.chat.net.urlopen") as native, \
                patch("reachd.chat.prepare_gpu_context") as compress, \
                patch.object(self.state.gate, "acquire") as acquire, \
                patch.object(self.state.cache, "get") as cache:
            status, body, response = self.call_loop()
        for call in (native, compress, acquire, cache):
            call.assert_not_called()
        self.assertEqual(status, 200)
        self.assertEqual(response.getheader("X-Reach-Loop-Guard"), "no_progress")
        result = json.loads(body)
        self.assertEqual(result["choices"][0]["finish_reason"], "stop")
        self.assertNotIn("tool_calls", result["choices"][0]["message"])
        self.assertIn("stopped by the host", result["choices"][0]["message"]["content"])
        self.assertEqual(result["usage_source"], "host")

    def test_sse_is_complete_openai_shape_and_has_no_tool_calls(self):
        with patch("reachd.chat.net.urlopen") as native:
            status, body, response = self.call_loop(stream=True)
        native.assert_not_called()
        self.assertEqual(status, 200)
        self.assertIn("text/event-stream", response.getheader("Content-Type"))
        chunks = [line[6:] for line in body.decode().splitlines() if line.startswith("data: ")]
        self.assertEqual(chunks[-1], "[DONE]")
        parsed = [json.loads(chunk) for chunk in chunks[:-1]]
        self.assertEqual(parsed[-1]["choices"][0]["finish_reason"], "stop")
        self.assertEqual(parsed[0]["choices"][0]["delta"]["role"], "assistant")
        self.assertTrue(all("tool_calls" not in c["choices"][0]["delta"] for c in parsed))
        self.assertEqual(self.state.gate._active, 0)

    def test_metered_request_stops_without_inventing_provider_usage(self):
        with patch("reachd.chat.net.urlopen") as native:
            status, body, response = self.call_loop(stream=True, headers={"X-Reach-Metered": "provider-v1"})
        native.assert_not_called()
        self.assertEqual(status, 409)
        self.assertEqual(json.loads(body)["error"]["code"], "tool_loop_detected")

    def test_opt_out_and_other_models_continue_to_the_upstream_path(self):
        for model, enabled in (("minicpm5-2b", False), ("gemma-4-12b-qat", True)):
            self.state.cfg["request"]["minicpm_loop_guard"] = enabled
            with patch("reachd.chat.net.urlopen", side_effect=OSError("test upstream unavailable")) as native:
                status, body, response = self.call_loop(model=model)
            self.assertTrue(native.called)
            self.assertIsNone(response.getheader("X-Reach-Loop-Guard"))

    def test_fallback_to_minicpm_keeps_the_guard_and_releases_the_gate(self):
        self.state.cfg["models"]["gemma-4-12b-qat"]["fallback"] = "minicpm5-2b"
        self.state.cfg["upstream_retries"] = 0
        def compressed_history(selector, payload, spec, **kwargs):
            return {**payload, "messages": [{"role": "user", "content": "summarized history"}]}, None
        with patch("reachd.chat.net.urlopen", side_effect=OSError("upstream unavailable")) as native, \
                patch("reachd.chat.prepare_gpu_context", side_effect=compressed_history):
            status, body, response = self.call_loop(model="gemma-4-12b-qat", stream=True)
        self.assertEqual(native.call_count, 1)
        self.assertEqual(status, 200)
        self.assertEqual(response.getheader("X-Reach-Loop-Guard"), "no_progress")
        self.assertEqual(self.state.gate._active, 0)


if __name__ == "__main__":
    unittest.main()
