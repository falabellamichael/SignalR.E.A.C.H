"""Check shim transport without starting the server or loading sign-in tokens."""
import ast
import io
import json
from pathlib import Path
import types
import unittest
import urllib.request


class CopilotContextTests(unittest.TestCase):
    def test_system_file_contents_and_history_reach_the_bridge(self):
        source = Path(__file__).parents[1] / 'copilot' / 'copilot_shim.py'
        tree = ast.parse(source.read_text())
        functions = ast.Module(body=[node for node in tree.body
            if isinstance(node, ast.FunctionDef)
            and node.name in ('flatten_content', 'copilot_chat')], type_ignores=[])
        requests = []

        def urlopen(request, timeout):
            requests.append(json.loads(request.data))
            return io.BytesIO(b'{"ok":true,"content":"FILE_END"}')

        namespace = {'json': json, 'BRIDGE_URL': 'http://127.0.0.1:21302',
            'urllib': types.SimpleNamespace(request=types.SimpleNamespace(
                Request=urllib.request.Request, urlopen=urlopen))}
        exec(compile(functions, str(source), 'exec'), namespace)
        messages = [
            {'role': 'system', 'content': 'Complete source file: FILE_END'},
            {'role': 'developer', 'content': 'Read source before reviewing.'},
            {'role': 'user', 'content': 'Read the file.'},
            {'role': 'assistant', 'content': 'I will read it.'},
            {'role': 'tool', 'content': 'More source: TOOL_END'},
            {'role': 'user', 'content': 'Now review it.'},
        ]
        status, chunks, error = namespace['copilot_chat'](messages)
        self.assertEqual((status, chunks, error), (200, ['FILE_END'], None))
        self.assertEqual(requests[0]['messages'], messages)
