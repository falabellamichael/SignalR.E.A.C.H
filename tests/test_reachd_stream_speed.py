"""Regression coverage for short GPU streams and buffered provider replies."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))
from reachd.chat import stream_speed


class StreamSpeedTests(unittest.TestCase):
    def test_short_gpu_greeting_excludes_startup(self):
        rate, source, seconds = stream_speed(10, 9, 5.0, 5.18, 0.5, gpu_usage=True)
        self.assertEqual(rate, 50.0)
        self.assertEqual(source, "relay_stream_decode")
        self.assertAlmostEqual(seconds, 0.18)

    def test_zero_monotonic_origin_is_valid(self):
        self.assertEqual(stream_speed(10, 9, 0.0, 0.18, 0.5, gpu_usage=True)[0], 50.0)

    def test_long_reply_preserves_decode_rate(self):
        self.assertEqual(stream_speed(101, 100, 10, 12, 3)[:2], (50.0, "relay_stream_decode"))

    def test_instantaneous_buffered_burst_is_not_decode(self):
        self.assertEqual(stream_speed(100, 100, 10, 10.001, 2, gpu_usage=True)[:2], (50.0, "request_elapsed"))

    def test_one_or_two_chunks_have_no_decode_sample(self):
        for count in (1, 2):
            self.assertEqual(stream_speed(100, count, 10, 11, 2, gpu_usage=True)[1], "request_elapsed")

    def test_unmeasured_or_non_gpu_short_stream_keeps_buffer_guard(self):
        self.assertEqual(stream_speed(10, 9, 10, 10.18, 0.5)[:2], (20.0, "request_elapsed"))

    def test_empty_and_backwards_samples_are_safe(self):
        for first, last in ((None, None), (2, 1), (1, 1)):
            self.assertEqual(stream_speed(0, 0, first, last, 0, gpu_usage=True), (0.0, "request_elapsed", None))


if __name__ == '__main__':
    unittest.main()
