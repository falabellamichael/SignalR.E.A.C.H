"""Pet care remains local and immediate while a response is streaming."""

import io
import os
import sys
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))

from reach_cli import chat, chatbox, footer, terminal  # noqa: E402
from reach_cli.client import ReachClient  # noqa: E402
from reach_cli.pets import TerminalPet  # noqa: E402
from tests.test_reach_cli_hud import FixedTelemetry, MutableTTY  # noqa: E402


class PetCareInputTests(unittest.TestCase):
    def setUp(self):
        self.now = [0.0]
        self.client = SimpleNamespace(pet="cat", pet_motion=True)
        self.client._terminal_pet = TerminalPet(clock=lambda: self.now[0])
        self.tty = MutableTTY()
        with mock.patch.object(footer, "SystemTelemetry", FixedTelemetry):
            self.screen = footer.FooterScreen(self.client, self.tty, size=self.tty.get_size)
        self.screen.pet.set_activity("responding")

    def test_collector_executes_care_without_queue_echo_or_response_release(self):
        self.screen.queue_followup("existing queued prompt")
        release = mock.Mock()
        collector = chat._FollowUpCollector(self.screen, release=release)
        events = []
        for line in ("/feed", "/pat", "/treat", "/pet feed", "/pet pet", "/pet treat"):
            events.extend((("text", line), ("enter", "")))
        with mock.patch.object(self.screen, "care_pet", wraps=self.screen.care_pet) as care:
            collector._run(events=events)
        self.assertEqual([call.args[0] for call in care.call_args_list],
                         ["feed", "pet", "treat", "feed", "pet", "treat"])
        self.assertEqual(self.screen.take_followup(), "existing queued prompt")
        self.assertIsNone(self.screen.take_followup())
        self.assertEqual(self.screen.take_draft_carry(), ("", 0))
        self.assertEqual(self.tty.getvalue(), "")
        self.assertEqual(self.screen.pet.snapshot()["activity"], "responding")
        self.assertIs(self.screen.pet, self.client._terminal_pet)
        release.assert_not_called()

    def test_rejected_live_care_does_not_queue_and_treats_restore_acceptance(self):
        self.now[0] = 600
        collector = chat._FollowUpCollector(self.screen)
        collector._run(events=[("text", "/feed"), ("enter", ""),
                               ("text", "/pat"), ("enter", "")])
        self.assertEqual(self.screen.pet.snapshot()["mood"], "angry")
        self.assertEqual(self.screen.pet.snapshot()["treats_remaining"], 3)
        self.assertFalse(self.screen.has_followups())
        for _ in range(3):
            collector._run(events=[("text", "/treat"), ("enter", "")])
        self.assertEqual(self.screen.pet.snapshot()["mood"], "content")
        self.assertTrue(self.screen.care_pet("feed")["accepted"])
        self.assertEqual(self.screen.pet.snapshot()["activity"], "responding")

    def test_other_commands_prompts_and_unsubmitted_drafts_keep_existing_flow(self):
        collector = chat._FollowUpCollector(self.screen)
        with mock.patch.object(self.screen, "care_pet") as care:
            collector._run(events=[("text", "explain /feed"), ("enter", ""),
                                   ("text", "/pet owl"), ("enter", ""),
                                   ("text", "/feed more"), ("enter", ""),
                                   ("text", "/pat")])
            care.assert_not_called()
        self.assertEqual([self.screen.take_followup() for _ in range(3)],
                         ["explain /feed", "/pet owl", "/feed more"])
        self.assertEqual(self.screen.take_draft_carry(), ("/pat", 4))

    def test_idle_boxed_care_is_not_echoed_into_transcript(self):
        for command in ("/feed", "/pat", "/treat", "/pet feed", "/pet pet", "/pet treat"):
            with self.subTest(command=command), \
                    mock.patch.object(chatbox, "active_footer", return_value=self.screen), \
                    mock.patch.object(self.screen, "refresh_metadata"), \
                    mock.patch("reach_cli.footer_input.read_line", return_value=command), \
                    mock.patch.object(self.screen, "finish_input") as finish:
                chunks = chatbox.read_boxed(self.client, out=io.StringIO())
                self.assertEqual(chunks, [command])
                finish.assert_called_once_with(command, echo=False)

    def test_care_only_chat_session_never_starts_a_model_response(self):
        client = ReachClient("http://fixture.invalid/v1", model="fixture")
        prompts = iter(("/feed", "/pat", "/treat", None))
        with mock.patch.object(terminal, "read_prompt", side_effect=lambda *_args: next(prompts)), \
                mock.patch.object(chat, "banner"), \
                mock.patch.object(chat, "endpoint_notice"), \
                mock.patch.object(chat, "stream_reply") as stream, \
                mock.patch.object(chatbox, "active_footer", return_value=None), \
                redirect_stdout(io.StringIO()):
            chat._run_chat_loop(client, client.base)
        stream.assert_not_called()
        self.assertEqual(client._terminal_pet.snapshot()["mood"], "content")


if __name__ == "__main__":
    unittest.main()
