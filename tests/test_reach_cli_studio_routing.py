"""Explicit agent messages keep fresh chat, histories and retries isolated."""

import contextlib
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from tests.test_reach_cli_agent_completion import ScriptClient, NoWaitIndicator, reply, envelope
from reach_cli import chat, terminal
from reach_cli.studio_context import StudioContextManager


class StudioRoutingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="reach-cli-addressed-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.profile = self.root / "profile"
        self.profile.mkdir()
        (self.profile / "personas.json").write_text(json.dumps({"personas": [
            {"id": "p-a", "name": "Atlas", "prompt": "INSTRUCTIONS_ATLAS"},
            {"id": "p-b", "name": "Boreal Agent", "prompt": "INSTRUCTIONS_BOREAL"},
        ], "teams": []}), encoding="utf-8")
        (self.profile / "agents.json").write_text(json.dumps({"agents": [
            {"id": "c-a", "name": "Atlas chat", "dir": str(self.root), "personaId": "p-a",
             "personaPrompt": "INSTRUCTIONS_ATLAS", "messages": [
                 {"role": "user", "content": "PRIVATE_STUDIO_HISTORY"}]},
        ]}), encoding="utf-8")
        for ident, title in (("p-a", "ATLAS"), ("p-b", "BOREAL")):
            folder = self.profile / "agents" / ident
            folder.mkdir(parents=True)
            (folder / "SOUL.md").write_text("SOUL_" + title, encoding="utf-8")
            (folder / "MEMORY.md").write_text("MEMORY_" + title, encoding="utf-8")
        self.initial_hashes = self.hashes()
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.output = self.stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
        self.stack.enter_context(patch.object(terminal, "PAINT", terminal.Paint(False)))
        self.stack.enter_context(patch.object(chat, "WaitIndicator", NoWaitIndicator))
        self.stack.enter_context(patch.object(chat, "banner"))
        self.stack.enter_context(patch.object(chat, "endpoint_notice"))
        self.stack.enter_context(patch.object(chat, "print_footer"))
        self.stack.enter_context(patch.object(chat, "_set_pet_activity"))

    def hashes(self):
        return {str(file.relative_to(self.profile)): hashlib.sha256(file.read_bytes()).hexdigest()
                for file in self.profile.rglob("*") if file.is_file()}

    def client(self, steps, agent=False):
        client = ScriptClient(steps, str(self.root), agent=agent)
        client.studio_context = StudioContextManager(str(self.root), profile_path=self.profile)
        return client

    def loop(self, client, lines):
        with patch.object(chat, "read_user_line", side_effect=[*lines, None]):
            chat._run_chat_loop(client, client.base)
        self.assertIsNone(client.studio_context.snapshot()["selected"])
        self.assertEqual(self.hashes(), self.initial_hashes)

    @staticmethod
    def users(messages):
        return [message["content"] for message in messages if message["role"] == "user"]

    @staticmethod
    def system(messages):
        return next(message["content"] for message in messages if message["role"] == "system")

    def test_fresh_default_chat_does_not_read_studio_context_files(self):
        client = self.client([reply("ordinary answer")])
        with patch.object(client.studio_context, "_records", side_effect=AssertionError("private read")):
            self.loop(client, ["ordinary question"])
        self.assertNotIn("MEMORY_", self.system(client.messages[0]))
        self.assertNotIn("SOUL_", self.system(client.messages[0]))

    def test_names_route_fresh_histories_and_resume_only_the_same_agent(self):
        client = self.client([reply("answer") for _ in range(5)])
        self.loop(client, ["normal first", "@Atlas agent first", '@"Boreal Agent" other first',
                           "normal second", "@Atlas agent second"])
        self.assertEqual(self.users(client.messages[0]), ["normal first"])
        self.assertEqual(self.users(client.messages[1]), ["agent first"])
        self.assertEqual(self.users(client.messages[2]), ["other first"])
        self.assertEqual(self.users(client.messages[3]), ["normal first", "normal second"])
        self.assertEqual(self.users(client.messages[4]), ["agent first", "agent second"])
        for index in (0, 3):
            self.assertNotIn("MEMORY_", self.system(client.messages[index]))
        self.assertIn("MEMORY_ATLAS", self.system(client.messages[1]))
        self.assertIn("SOUL_ATLAS", self.system(client.messages[4]))
        self.assertNotIn("BOREAL", self.system(client.messages[4]))
        self.assertIn("INSTRUCTIONS_BOREAL", self.system(client.messages[2]))
        self.assertNotIn("ATLAS", self.system(client.messages[2]))
        self.assertNotIn("PRIVATE_STUDIO_HISTORY", str(client.messages))

    def test_retry_cannot_send_another_agents_prompt(self):
        client = self.client([reply("answer") for _ in range(3)])
        self.loop(client, ["@Atlas atlas private question", '@"Boreal Agent" /retry',
                           '@"Boreal Agent" boreal question', '@"Boreal Agent" /retry'])
        self.assertEqual(len(client.messages), 3)
        self.assertEqual(self.users(client.messages[1]), ["boreal question"])
        self.assertEqual(self.users(client.messages[2]), ["boreal question", "boreal question"])
        self.assertNotIn("atlas private question", str(client.messages[1:]))

    def test_top_level_retry_routes_last_address_without_polluting_fresh_history(self):
        client = self.client([reply("answer") for _ in range(3)])
        self.loop(client, ["@Atlas atlas question", "/retry", "normal question"])
        self.assertEqual(self.users(client.messages[1]), ["atlas question", "atlas question"])
        self.assertEqual(self.users(client.messages[2]), ["normal question"])
        self.assertNotIn("MEMORY_ATLAS", self.system(client.messages[2]))

    def test_unknown_address_does_not_send_or_keep_previous_agent(self):
        client = self.client([reply("answer") for _ in range(2)])
        self.loop(client, ["@Atlas atlas question", "@Missing never send this", "normal question"])
        self.assertEqual(len(client.messages), 2)
        self.assertEqual(self.users(client.messages[1]), ["normal question"])
        self.assertNotIn("MEMORY_", self.system(client.messages[1]))

    def test_agent_tool_state_is_separate_between_addressees_and_default_chat(self):
        client = self.client([], agent=True)
        seen = []
        def turn(_client, history, state):
            selected = _client.studio_context.snapshot()["selected"]
            seen.append((selected["id"] if selected else None, state, list(state.todos)))
            state.todos.append({"text": "own plan"})
            return True
        with patch.object(chat, "run_agent_turn", side_effect=turn):
            self.loop(client, ["@Atlas first", '@"Boreal Agent" second', "normal third", "@Atlas fourth"])
        self.assertEqual([row[0] for row in seen], ["p-a", "p-b", None, "p-a"])
        self.assertIs(seen[0][1], seen[3][1])
        self.assertIsNot(seen[0][1], seen[1][1])
        self.assertIsNot(seen[0][1], seen[2][1])
        self.assertEqual([len(row[2]) for row in seen], [0, 0, 0, 1])

    def test_one_shot_explicit_context_clears_before_next_plain_request(self):
        client = self.client([reply("answer") for _ in range(2)])
        self.assertTrue(chat.run_ask(client, "@Atlas addressed question"))
        self.assertIsNone(client.studio_context.snapshot()["selected"])
        self.assertTrue(chat.run_ask(client, "plain question"))
        self.assertIn("MEMORY_ATLAS", self.system(client.messages[0]))
        self.assertNotIn("MEMORY_", self.system(client.messages[1]))
        self.assertEqual(self.hashes(), self.initial_hashes)

    def test_one_shot_selection_interruption_always_clears_context(self):
        client = self.client([])
        select = client.studio_context.select
        def interrupt(*args):
            select(*args)
            raise KeyboardInterrupt()
        with patch.object(client.studio_context, "select", side_effect=interrupt):
            with self.assertRaises(KeyboardInterrupt):
                chat.run_ask(client, "@Atlas question")
        self.assertIsNone(client.studio_context.snapshot()["selected"])

    def test_information_address_succeeds_without_provider_or_body_read(self):
        client = self.client([])
        with patch.object(client.studio_context, "_text", side_effect=AssertionError("body read")):
            self.assertTrue(chat.run_ask(client, "@agents"))
        self.assertEqual(client.messages, [])
        self.assertIn("@Atlas", self.output.getvalue())

    def test_addressed_web_slash_keeps_explicit_agent_and_plain_web_clears_it(self):
        client = self.client([])
        seen = []
        def web(_client, query, fetch_pages=True):
            selected = _client.studio_context.snapshot()["selected"]
            seen.append((selected["id"] if selected else None, query))
            return True
        with patch.object(chat, "_run_web_answer", side_effect=web):
            self.loop(client, ["@Atlas /web fixture question", "/web plain question"])
        self.assertEqual(seen, [("p-a", "fixture question"), (None, "plain question")])


if __name__ == "__main__":
    unittest.main()
