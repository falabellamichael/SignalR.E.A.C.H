"""Credential and response regressions; all transports and secrets are owned mocks."""

import io
import json
import os
import sys
import types
import unicodedata
import urllib.error
import urllib.request
import unittest
from unittest import mock

TOOLS = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "tools")
sys.path.insert(0, TOOLS)

from reach_cli import client as client_mod

KEY = "owned-provider-secret-review-123"
BUILTIN_KEY = "owned-subscription-secret-review-456"
REDACTED = "[credential redacted]"


def _sse(content=None, tool_calls=None, finish=None):
    delta = {}
    if content is not None:
        delta["content"] = content
    if tool_calls is not None:
        delta["tool_calls"] = tool_calls
    choice = {"delta": delta}
    if finish is not None:
        choice["finish_reason"] = finish
    return ("data: " + json.dumps({"choices": [choice]}) + "\n").encode()


class _Response:
    status = 200

    def __init__(self, body=b"", lines=None, failure=None):
        self.body = io.BytesIO(body)
        self.lines = list(lines or [])
        self.failure = failure

    def read(self, size=-1):
        return self.body.read(size)

    def __iter__(self):
        yield from self.lines
        if self.failure is not None:
            raise self.failure

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.body.close()


class EndpointClientSecurityTests(unittest.TestCase):
    def setUp(self):
        environment = mock.patch.dict(os.environ, {
            "REACH_KEY": BUILTIN_KEY,
            "OWNED_PROVIDER_KEY": KEY,
        }, clear=True)
        environment.start()
        self.addCleanup(environment.stop)
        network = mock.patch.object(client_mod.urllib.request, "urlopen",
                                    side_effect=AssertionError("A test attempted real network access"))
        network.start()
        self.addCleanup(network.stop)

    def client(self, **kwargs):
        return client_mod.ReachClient("https://owned-provider.example/v1", key=KEY, **kwargs)

    def assert_private(self, value):
        rendered = str(value)
        visible = "".join(ch for ch in rendered if not unicodedata.category(ch).startswith("C"))
        self.assertNotIn(KEY, rendered)
        self.assertNotIn(KEY, visible)
        self.assertNotIn("\x1b", rendered)
        self.assertNotIn("\x9b", rendered)
        self.assertNotIn("\u200b", rendered)
        self.assertNotIn("\u202e", rendered)

    def complete(self, response, stream=True):
        client = self.client()
        emitted = []
        with mock.patch.object(client_mod.urllib.request, "urlopen", return_value=response) as opened:
            result = client.complete([{"role": "user", "content": "owned question"}],
                                     on_text=emitted.append, stream=stream)
        self.assertEqual(opened.call_count, 1)
        self.assertEqual(opened.call_args.args[0].get_header("Authorization"), "Bearer " + KEY)
        self.assertEqual("".join(emitted), result["content"])
        return result, emitted

    def test_only_symbolic_subscription_inherits_global_key(self):
        for base in ("public", "subscription"):
            with self.subTest(base=base):
                self.assertEqual(client_mod.ReachClient(base).key, BUILTIN_KEY)
        for base in ("local", "http://127.0.0.1:20777/v1", "https://owned-provider.example/v1"):
            with self.subTest(base=base):
                self.assertEqual(client_mod.ReachClient(base).key, "")
                self.assertEqual(client_mod.ReachClient(base, key="").key, "")

    def test_custom_environment_reference_keeps_subscription_credential_separate(self):
        client = client_mod.ReachClient("https://owned-provider.example/v1", key_env="OWNED_PROVIDER_KEY")
        self.assertEqual(client.key, KEY)
        self.assertEqual(client._builtin_key, BUILTIN_KEY)
        self.assertEqual(client.key_ref, "env:OWNED_PROVIDER_KEY")
        self.assertEqual(client_mod.ReachClient("https://owned-provider.example/v1", key_env="OWNED_MISSING_KEY").key, "")

    def test_invalid_credential_and_reference_errors_do_not_echo_values(self):
        for key in (KEY + "\nInjected: true", KEY + "\x1b", KEY + "\u200b", "x" * 8193):
            with self.subTest(length=len(key)):
                with self.assertRaises(ValueError) as caught:
                    client_mod.ReachClient("https://owned-provider.example/v1", key=key)
                self.assert_private(caught.exception)
        with self.assertRaises(ValueError) as caught:
            client_mod.ReachClient("local", key_env=KEY)
        self.assert_private(caught.exception)

    def test_redirected_request_cannot_forward_authorization(self):
        request = client_mod._request("https://owned-provider.example/v1/models", KEY)
        self.assertEqual(request.get_header("Authorization"), "Bearer " + KEY)
        handler = urllib.request.HTTPRedirectHandler()
        redirected = handler.redirect_request(request, None, 302, "Found", {},
                                              "https://another-owned.example/v1/models")
        self.assertIsNone(redirected.get_header("Authorization"))

    def test_safe_text_sanitizes_controls_before_credential_matching(self):
        for inserted in ("\x1b", "\x9b", "\u200b", "\u202e", "\ud800"):
            with self.subTest(category=unicodedata.category(inserted)):
                echo = KEY[:12] + inserted + KEY[12:]
                result = client_mod._safe_text(echo, KEY)
                self.assert_private(result)
                self.assertIn(REDACTED, result)

    def test_stream_redactor_preserves_ordinary_text_at_every_secret_split(self):
        for split in range(1, len(KEY)):
            with self.subTest(split=split):
                redactor = client_mod._TextRedactor(KEY)
                first = redactor.feed("ordinary prefix " + KEY[:split])
                middle = redactor.feed(KEY[split:] + " ordinary suffix")
                last = redactor.feed("", final=True)
                result = first + middle + last
                self.assertEqual(result, "ordinary prefix " + REDACTED + " ordinary suffix")
                self.assert_private(result)

    def test_split_control_insertion_cannot_reconstruct_visible_key(self):
        for inserted in ("\x1b", "\x9b", "\u200b", "\u202e"):
            for split in (1, 10, len(KEY) - 1):
                with self.subTest(category=unicodedata.category(inserted), split=split):
                    redactor = client_mod._TextRedactor(KEY)
                    result = redactor.feed("prefix " + KEY[:split] + inserted)
                    result += redactor.feed(KEY[split:] + " suffix")
                    result += redactor.feed("", final=True)
                    self.assert_private(result)
                    self.assertIn(REDACTED, result)

    def test_complete_success_redacts_nonstream_content(self):
        response = _Response(json.dumps({"choices": [{"message": {
            "content": "prefix " + KEY + " suffix\x1b[2J"
        }}]}).encode())
        result, _emitted = self.complete(response, stream=False)
        self.assert_private(result["content"])
        self.assertIn(REDACTED, result["content"])

    def test_complete_stream_redacts_split_and_control_inserted_content(self):
        lines = [_sse("prefix " + KEY[:12] + "\x1b"),
                 _sse(KEY[12:] + " suffix"), b"data: [DONE]\n"]
        result, emitted = self.complete(_Response(lines=lines))
        self.assert_private(result["content"])
        self.assertIn(REDACTED, "".join(emitted))

    def test_complete_tool_call_ids_names_and_nested_arguments_are_private(self):
        tool = {"index": 0, "id": "call_" + KEY + "\x1b", "type": "function", "function": {
            "name": "name_" + KEY,
            "arguments": json.dumps({KEY: {"nested": [KEY, "safe"]}}),
        }}
        result, _emitted = self.complete(_Response(lines=[_sse(tool_calls=[tool], finish="tool_calls")]))
        serialized = json.dumps(result)
        self.assert_private(serialized)
        arguments = json.loads(result["tool_calls"][0]["function"]["arguments"])
        self.assertEqual(arguments[REDACTED]["nested"], [REDACTED, "safe"])

    def test_transient_stream_cut_redacts_pending_key_and_exception(self):
        response = _Response(lines=[_sse("prefix " + KEY[:12])],
                             failure=TimeoutError(KEY + "\x1b[2J"))
        with mock.patch.object(client_mod.urllib.request, "urlopen", return_value=response):
            with self.assertRaises(client_mod.ReachTransientError) as caught:
                self.client().complete([{"role": "user", "content": "owned"}])
        self.assert_private(caught.exception)
        self.assert_private(caught.exception.partial["content"])
        self.assertIn(REDACTED, caught.exception.partial["content"])

    def test_http_error_echo_redaction_and_transient_status_remain_actionable(self):
        for status in (401, 429, 503):
            with self.subTest(status=status):
                body = io.BytesIO(json.dumps({"error": {"message": KEY + "\x1b[2J",
                                                      "reset_seconds": 7}}).encode())
                error = urllib.error.HTTPError("https://owned-provider.example/v1", status, "owned", {}, body)
                self.addCleanup(error.close)
                with mock.patch.object(client_mod.urllib.request, "urlopen", side_effect=error):
                    with self.assertRaises(client_mod.ReachApiError) as caught:
                        self.client().complete([{"role": "user", "content": "owned"}])
                self.assert_private(caught.exception)
                self.assertIn("HTTP %d" % status, str(caught.exception))
                self.assertEqual(caught.exception.status, status)

    def test_nonhttp_transport_exceptions_never_echo_key_or_escape(self):
        for error in (urllib.error.URLError(KEY + "\x1b[2J"), TimeoutError(KEY), OSError(KEY)):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(client_mod.urllib.request, "urlopen", side_effect=error):
                    with self.assertRaises(client_mod.ReachTransientError) as caught:
                        self.client().complete([{"role": "user", "content": "owned"}])
                self.assert_private(caught.exception)

    def test_chat_generator_success_and_errors_are_private(self):
        for stream in (False, True):
            with self.subTest(stream=stream):
                response = (_Response(lines=[_sse(KEY[:12]), _sse(KEY[12:]), b"data: [DONE]\n"])
                            if stream else _Response(json.dumps({"choices": [{"message": {"content": KEY}}]}).encode()))
                with mock.patch.object(client_mod.urllib.request, "urlopen", return_value=response):
                    content = "".join(self.client().chat([{"role": "user", "content": "owned"}], stream=stream))
                self.assert_private(content)
                self.assertIn(REDACTED, content)
                with mock.patch.object(client_mod.urllib.request, "urlopen", side_effect=urllib.error.URLError(KEY + "\x1b")):
                    with self.assertRaises(client_mod.ReachApiError) as caught:
                        list(self.client().chat([{"role": "user", "content": "owned"}], stream=stream))
                self.assert_private(caught.exception)

    def test_symbolic_subscription_resolves_before_real_request_without_mutating_identity(self):
        client = client_mod.ReachClient("subscription")
        response = _Response(json.dumps({"choices": [{"message": {"content": "owned response"}}]}).encode())
        with mock.patch.object(client_mod, "discover_public_url", return_value="https://owned-provider.example/v1") as pointer, \
                mock.patch.object(client_mod.urllib.request, "urlopen", return_value=response) as opened:
            result = client.complete([{"role": "user", "content": "owned"}], stream=False)
        self.assertEqual(pointer.call_count, 1)
        self.assertEqual(opened.call_args.args[0].full_url, "https://owned-provider.example/v1/chat/completions")
        self.assertEqual(opened.call_args.args[0].get_header("Authorization"), "Bearer " + BUILTIN_KEY)
        self.assertEqual(client.base, "subscription")
        self.assertEqual(result["content"], "owned response")

    def test_public_pointer_is_bounded_validated_and_never_authenticated(self):
        for body, expected in ((b"https://owned-provider.example/v1\n", "https://owned-provider.example/v1"),
                               (b"x" * 4097, None),
                               (b"https://user:owned-secret@owned-provider.example/v1", None),
                               (b"https://owned-provider.example/v1?api_key=owned-secret", None),
                               (b"https://owned-provider.example/%1b", None)):
            with self.subTest(expected=expected is not None):
                with mock.patch.object(client_mod.urllib.request, "urlopen", return_value=_Response(body)) as opened:
                    self.assertEqual(client_mod.discover_public_url(timeout=0.1), expected)
                self.assertEqual(opened.call_args.args[0], client_mod.POINTER_GIST)
                self.assertEqual(opened.call_args.kwargs, {"timeout": 0.1})

    def test_models_filters_credential_and_terminal_control_echoes(self):
        response = _Response(json.dumps({"data": [{"id": value} for value in
            ("owned-model", KEY, "model\x1b[2J", "model\u202e", "model with space")]}).encode())
        with mock.patch.object(client_mod.urllib.request, "urlopen", return_value=response):
            models = self.client().models()
        self.assertEqual(models, ["owned-model"])

    def test_models_transport_errors_never_echo_credentials_or_controls(self):
        http = urllib.error.HTTPError("https://owned-provider.example/v1/models", 401,
                                     KEY + "\x1b[2J", {}, io.BytesIO(b"owned error"))
        self.addCleanup(http.close)
        for error in (http, urllib.error.URLError(KEY + "\x1b[2J"), OSError(KEY)):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(client_mod.urllib.request, "urlopen", side_effect=error):
                    with self.assertRaises(Exception) as caught:
                        self.client().models()
                self.assert_private(caught.exception)

    def test_unsafe_legacy_url_resolution_fails_without_reflecting_credential(self):
        for base in ("https://user:" + KEY + "@owned-provider.example/v1",
                     "https://owned-provider.example/v1?api_key=" + KEY,
                     "https://owned-provider.example/v1#" + KEY,
                     "https://owned-provider.example/%1b[2J"):
            with self.subTest(kind="userinfo" if "@" in base else "suffix"):
                client = client_mod.ReachClient("local")
                client.base = base
                with self.assertRaises(Exception) as caught:
                    client.resolve_base()
                self.assert_private(caught.exception)

    def test_saved_endpoint_restore_preserves_explicit_environment_credential(self):
        from reach_cli import __main__ as entry, endpoints, session, terminal
        args = types.SimpleNamespace(base=None, model=None, workpath=None,
                                     key=None, key_env="OWNED_PROVIDER_KEY", resume=True)
        saved_cases = (
            {"endpoint_name": "team", "endpoint": "https://owned-provider.example/v1"},
            {"endpoint_name": "subscription", "endpoint": "subscription"},
            {"endpoint": "https://owned-provider.example/v1"},
        )
        with mock.patch.dict(os.environ, {"OWNED_STORED_KEY": "owned-different-stored-credential"}):
            for saved in saved_cases:
                with self.subTest(identity=saved.get("endpoint_name", "legacy")):
                    client = client_mod.ReachClient(saved["endpoint"], key_env="OWNED_PROVIDER_KEY")
                    client.endpoint_name = saved.get("endpoint_name")
                    client.explicit_credential = True
                    record = {"url": "https://owned-provider.example/v1", "key_env": "OWNED_STORED_KEY"}
                    with mock.patch.object(terminal, "load_session_config", return_value=saved), \
                            mock.patch.object(session, "load_session_config", return_value=saved), \
                            mock.patch.object(endpoints, "get_custom", return_value=record):
                        entry._restore_endpoint_selection(client, args)
                    self.assertEqual(client.key, KEY)
                    self.assertEqual(client.key_env, "OWNED_PROVIDER_KEY")
                    self.assertEqual(client._builtin_key, BUILTIN_KEY)


if __name__ == "__main__":
    unittest.main()
