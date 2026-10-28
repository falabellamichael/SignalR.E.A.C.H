import sys
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'docker/gpu'))
from patch_gemma_parser_warnings import patch_source


class WarningTests(unittest.TestCase):
    def test_repeated_malformed_arrays_keep_results_and_bound_warnings(self):
        source = (ROOT / 'tests/fixtures/gemma4_literal_parser.py.txt').read_text(encoding='utf-8')
        class Logger:
            def __init__(self):
                self.messages = set()
            def warning_once(self, message):
                self.messages.add(message)
        logger = Logger()
        ns = {'init_logger': lambda _: logger}
        patched = patch_source(source)
        self.assertEqual(patch_source(patched), patched)
        exec(patched, ns)
        for _ in range(100):
            self.assertEqual(ns['_parse_gemma4_array']('1,]'), ['1'])
        self.assertEqual(len(logger.messages), 1)
        self.assertEqual(ns['_parse_gemma4_array']('1,2'), ['1', '2'])

    def test_unknown_source_is_rejected(self):
        with self.assertRaises(RuntimeError):
            patch_source('pass')
