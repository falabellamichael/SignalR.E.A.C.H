"""Explicit agent addresses preserve prompts and complete metadata only."""

import os
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "tools"))
from reach_cli import terminal  # Initialize the legacy terminal/commands re-exports first.
from reach_cli import prompt, studio_mentions
from reach_cli.footer_input import EditBuffer
from reach_cli.studio_mentions import (
    complete_agent_token, detected_agent_completions, format_agent_alias,
    parse_agent_address,
)


def source(name, ident="persona-fixture", kind="persona"):
    return {"id": ident, "kind": kind, "name": name, "dir": "",
            "personaId": ident if kind == "persona" else "",
            "hasSoul": True, "hasMemory": True, "hasInstructions": True}


class AgentAddressTests(unittest.TestCase):
    def test_normal_chat_is_returned_byte_for_byte(self):
        for text in ("", "  ordinary prompt  ", "email me@example.invalid",
                     "use @Auditor here", "\n@Auditor is a code decorator",
                     "```python\n@decorator\ndef example():\n    pass\n```"):
            with self.subTest(text=text):
                self.assertEqual(parse_agent_address(text), (None, text))

    def test_only_selector_is_parsed_and_prompt_code_remains_verbatim(self):
        body = '  print("quoted  body")\n    path = r"C:\\work\\file.py"\n    x = \'$HOME `literal`\'  '
        self.assertEqual(parse_agent_address("@Auditor " + body), ("Auditor", body))
        self.assertEqual(parse_agent_address(" \t@persona-fixture\t" + body), ("persona-fixture", body))
        self.assertEqual(parse_agent_address("@conversation:agent-fixture\n" + body),
                         ("conversation:agent-fixture", body))
        self.assertEqual(parse_agent_address("@Auditor\r\n" + body), ("Auditor", body))

    def test_quoted_name_with_spaces_and_quotes_preserves_body(self):
        body = 'code("hello")  C:\\Users\\fixture\\file.txt\n  keep indent'
        self.assertEqual(parse_agent_address('@"Data Scientist" ' + body), ("Data Scientist", body))
        self.assertEqual(parse_agent_address('@"Data \\"Team\\" Scientist" ' + body),
                         ('Data "Team" Scientist', body))
        self.assertEqual(parse_agent_address('@"C:\\Agent" ' + body), ("C:\\Agent", body))

    def test_bare_and_metadata_selectors_remain_available_to_dispatch(self):
        self.assertEqual(parse_agent_address("@"), ("", ""))
        self.assertEqual(parse_agent_address("@ "), ("", ""))
        for selector in ("agents", "list", "help", "Agent", "persona:persona-a", "conversation:agent-a"):
            self.assertEqual(parse_agent_address("@" + selector), (selector, ""))

    def test_invalid_selector_errors_are_useful_without_echoing_prompt_contents(self):
        private = "PRIVATE-PROMPT-FIXTURE"
        malformed = ('@"unfinished ' + private, '@"" ' + private, '@"   " ' + private,
                     '@"Agent"missing-space-' + private, '@Un"balanced ' + private,
                     '@Agent\x1b[31m ' + private, '@persona: ' + private,
                     '@conversation:../private ' + private)
        for text in malformed:
            with self.subTest(text=text):
                with self.assertRaises(ValueError) as caught:
                    parse_agent_address(text)
                self.assertNotIn(private, str(caught.exception))
                self.assertNotIn("\x1b", str(caught.exception))
                self.assertTrue(str(caught.exception).strip())


class AgentAliasTests(unittest.TestCase):
    def test_names_round_trip_through_alias_parser(self):
        for name in ("Auditor", "Data Scientist", 'Writer "A"', "C:\\Agent", "猫", "Molly's", "SQL:Core"):
            with self.subTest(name=name):
                row = source(name)
                alias = format_agent_alias(row, [row])
                self.assertEqual(parse_agent_address(alias + " prompt"), (name, "prompt"))

    def test_duplicate_names_and_reserved_commands_use_explicit_kind_id(self):
        rows = [source("Auditor", "persona-a"), source("auditor", "agent-a", "conversation")]
        self.assertEqual(format_agent_alias(rows[0], rows), "@persona:persona-a")
        self.assertEqual(format_agent_alias(rows[1], rows), "@conversation:agent-a")
        for name in ("agents", "LIST", "Help", "persona:misleading", "conversation:misleading"):
            self.assertEqual(format_agent_alias(source(name)), "@persona:persona-fixture")

    def test_name_colliding_with_another_source_id_does_not_select_wrong_identity(self):
        rows = [source("persona-other", "persona-own"), source("Other", "persona-other")]
        self.assertEqual(format_agent_alias(rows[0], rows), "@persona:persona-own")
        self.assertEqual(format_agent_alias(rows[1], rows), "@Other")

    def test_unusable_names_fall_back_to_safe_id_and_invalid_ids_are_rejected(self):
        for name in ("", " spaced ", "unsafe\x1b[31m", "line\nname", "x" * 257):
            self.assertEqual(format_agent_alias(source(name)), "@persona:persona-fixture")
        for ident in ("../private", "", "a" * 65, "unsafe\x1b"):
            with self.assertRaises(ValueError):
                format_agent_alias(source("Agent", ident))


class AgentCompletionTests(unittest.TestCase):
    def test_completion_is_pure_and_does_not_read_agent_bodies(self):
        rows = [source("Auditor", "persona-a"), source("Data Scientist", "persona-data")]
        with patch("builtins.open", side_effect=AssertionError("Completion must use supplied metadata only")):
            self.assertEqual(complete_agent_token("@Au", "@Au", rows), ["@Auditor"])
            self.assertEqual(complete_agent_token("@Da", "@Da", rows), ['@"Data Scientist"'])
            self.assertEqual(complete_agent_token("@persona:persona-d", "@persona:persona-d", rows),
                             ["@persona:persona-data"])

    def test_quoted_completion_replaces_only_the_final_token(self):
        rows = [source("Data Scientist")]
        self.assertEqual(complete_agent_token("Sc", '@"Data Sc', rows), ['Scientist"'])
        self.assertEqual(complete_agent_token("Sc", '  @"data Sc', rows), ['Scientist"'])
        buffer = EditBuffer('@"Data Sc untouched body', complete=lambda text, before: complete_agent_token(text, before, rows))
        buffer.cursor = len('@"Data Sc')
        buffer.feed("tab")
        self.assertEqual(buffer.text, '@"Data Scientist" untouched body')
        self.assertEqual(buffer.cursor, len('@"Data Scientist"'))

    def test_quoted_completion_handles_escaped_quotes(self):
        rows = [source('Data "Team" Lead')]
        before = '@"Data \\"Team\\" Le'
        self.assertEqual(complete_agent_token("Le", before, rows), ['Lead"'])
        buffer = EditBuffer(before, complete=lambda text, prefix: complete_agent_token(text, prefix, rows))
        buffer.feed("tab")
        self.assertEqual(parse_agent_address(buffer.text + " prompt"), ('Data "Team" Lead', "prompt"))

    def test_completion_cycles_multiword_candidates_without_repeating_selector_prefix(self):
        rows = [source("Data Science", "persona-science"), source("Data Scout", "persona-scout")]
        buffer = EditBuffer('@"Data Sc', complete=lambda text, before: complete_agent_token(text, before, rows))
        completions = set()
        for _ in range(2):
            buffer.feed("tab")
            completions.add(buffer.text)
        self.assertEqual(completions, {'@"Data Science"', '@"Data Scout"'})

    def test_metadata_detection_runs_only_while_editing_initial_selector(self):
        manager = Mock()
        manager.detect.return_value = {"sources": [source("Auditor")]}
        manager.read.side_effect = AssertionError("No body reads")
        manager.select.side_effect = AssertionError("No identity activation")
        with patch("reach_cli.studio_context.StudioContextManager", return_value=manager) as factory:
            for before in ("plain text", "use @Au", "@Auditor use @Au", '@"Data Scientist" use @Au', "\n@Au"):
                self.assertEqual(detected_agent_completions("@Au", before), [])
            factory.assert_not_called()
            self.assertEqual(detected_agent_completions("@Au", "@Au"), ["@Auditor"])
            factory.assert_called_once()
            manager.detect.assert_called_once_with(refresh=True)
            manager.read.assert_not_called()
            manager.select.assert_not_called()

    def test_empty_profile_keeps_agent_list_completion_and_never_activates_context(self):
        manager = Mock()
        manager.detect.return_value = {"status": "unavailable", "sources": []}
        with patch("reach_cli.studio_context.StudioContextManager", return_value=manager):
            self.assertEqual(detected_agent_completions("@ag", "@ag"), ["@agents"])
            self.assertEqual(detected_agent_completions("@", "@"), ["@agents", "@help", "@list"])
            manager.select.assert_not_called()
            manager.read.assert_not_called()

    def test_duplicate_and_reserved_names_complete_to_selectable_explicit_ids(self):
        rows = [source("Twin", "persona-a"), source("twin", "agent-a", "conversation"), source("agents", "persona-list")]
        aliases = complete_agent_token("@", "@", rows)
        self.assertNotIn("@Twin", aliases)
        for alias in ("@persona:persona-a", "@conversation:agent-a", "@persona:persona-list", "@agents"):
            self.assertIn(alias, aliases)

    def test_an_id_shared_by_both_kinds_never_completes_to_an_ambiguous_raw_id(self):
        rows = [source("First", "shared-id"), source("Second", "shared-id", "conversation")]
        self.assertEqual(complete_agent_token("@shared", "@shared", rows), [])
        self.assertEqual(complete_agent_token("@persona:shared", "@persona:shared", rows),
                         ["@persona:shared-id"])
        self.assertEqual(complete_agent_token("@conversation:shared", "@conversation:shared", rows),
                         ["@conversation:shared-id"])

    def test_prompt_completion_retains_slash_commands_and_avoids_body_detection(self):
        with patch("reach_cli.studio_context.StudioContextManager", side_effect=AssertionError("No profile lookup")):
            self.assertIn("/workpath", prompt.complete_token("/wor", "/wor"))
            self.assertEqual(prompt.complete_token("@Au", "ordinary @Au"), [])
            self.assertEqual(prompt.complete_token("@Au", "@Auditor body @Au"), [])

    def test_readline_completes_selector_before_existing_body_without_changing_body(self):
        readline = Mock()
        readline.get_line_buffer.return_value = "@Au untouched body"
        readline.get_endidx.return_value = len("@Au")
        with patch.object(prompt, "load_readline", return_value=readline), \
                patch.object(studio_mentions, "detected_agent_completions", return_value=["@Auditor"]) as complete:
            self.assertEqual(prompt._readline_complete("@Au", 0), "@Auditor")
            complete.assert_called_once_with("@Au", "@Au")


if __name__ == "__main__":
    unittest.main()
