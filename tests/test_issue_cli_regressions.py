"""Regression checks for issue #25: default VS Code action and /web history."""
import importlib
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))


class CLIRegressions(unittest.TestCase):
    def test_vscode_without_subcommand_dispatches_status(self):
        cli = importlib.import_module('reach.cli')
        with patch.object(cli, 'cmd_vscode') as command:
            cli.main(['vscode'])
        command.assert_called_once()
        self.assertIsNone(command.call_args.args[0].vscode_cmd)

    def test_web_does_not_leave_an_unanswered_history_turn(self):
        importlib.import_module('reach_cli.terminal')
        commands = importlib.import_module('reach_cli.commands')
        chat = importlib.import_module('reach_cli.chat')
        history = [{'role': 'user', 'content': 'hello'},
                   {'role': 'assistant', 'content': 'hi'}]
        original = list(history)
        with patch.object(chat, 'run_web_answer') as answer:
            commands._cmd_web(object(), history, None, 'new question')
        answer.assert_called_once()
        self.assertEqual(history, original)


if __name__ == '__main__':
    unittest.main()
