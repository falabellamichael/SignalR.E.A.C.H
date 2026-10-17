"""GPU reasoning must reach clients promptly without becoming a fake answer."""
import json
import unittest

from tests import test_reachd as fixtures


class GpuProgressTests(unittest.TestCase):
    @staticmethod
    def observed_stream(*events):
        source = fixtures.StreamPreflightTests._stream(*events)
        read = source.readline
        source.read_calls = 0

        def readline():
            source.read_calls += 1
            return read()

        source.readline = readline
        return source

    @staticmethod
    def frames(handler):
        return [json.loads(line[5:]) for call in handler._write_chunk.call_args_list
                for line in call.args[0].splitlines() if line.startswith(b'data: {')]

    def finalize(self, source, **kwargs):
        return fixtures.StreamPreflightTests()._finalize(source, **kwargs)

    def test_reasoning_reaches_client_before_reading_the_answer(self):
        for alias in ('ornith-1.5-9b', 'minicpm5-2b'):
            for field in ('reasoning_content', 'reasoning', 'thought'):
                with self.subTest(model=alias, field=field):
                    source = self.observed_stream(
                        {'choices':[{'delta':{field:'Working'}}]},
                        {'choices':[{'delta':{field:' through it'}}]},
                        {'choices':[{'delta':{'content':'The answer.'},'finish_reason':'stop'}]},
                        b'[DONE]')
                    observed = []

                    def on_write(chunk):
                        if field.encode() in chunk:
                            observed.append(source.read_calls)

                    h, state = self.finalize(source, upstream_model='gpu/'+alias, on_write=on_write)
                    self.assertEqual(observed[0], 1, 'Reasoning was buffered until the answer')
                    self.assertEqual(h.send_response.call_args.args[0], 200)
                    self.assertTrue(source.closed)
                    state.note_success.assert_called_once_with('gpu/'+alias)

    def test_reasoning_prefix_does_not_impose_an_output_allowance(self):
        thought = {'choices':[{'delta':{'reasoning_content':'x'*32768}}]}
        source = self.observed_stream(*([thought]*257),
            {'choices':[{'delta':{'content':'Completed.'},'finish_reason':'stop'}]}, b'[DONE]')
        h, state = self.finalize(source, upstream_model='gpu/minicpm5-2b')
        h._json.assert_not_called()
        self.assertTrue(any(event.get('choices',[{}])[0].get('delta',{}).get('content') == 'Completed.'
                            for event in self.frames(h) if event.get('choices')))
        state.note_success.assert_called_once_with('gpu/minicpm5-2b')
        state.gate.release.assert_called_once()

    def test_reasoning_without_an_answer_ends_with_an_error_and_no_retry(self):
        for finish in ('stop', 'length'):
            with self.subTest(finish=finish):
                source = self.observed_stream(
                    {'choices':[{'delta':{'reasoning_content':'Still thinking'}}]},
                    {'choices':[{'delta':{},'finish_reason':finish}]}, b'[DONE]')
                fallback = {'enabled':True,'upstream':'gpu/ornith-1.5-9b'}
                attempted = []

                def retry(*args, **kwargs):
                    attempted.append(True)
                    raise AssertionError('A started reasoning stream must not be replayed')

                h, state = self.finalize(source, upstream_model='gpu/minicpm5-2b',
                    fallback=fallback, urlopen=retry)
                self.assertEqual(h.send_response.call_args.args[0], 200)
                frames = self.frames(h)
                self.assertTrue(any(event.get('error',{}).get('code') == 'empty_upstream_response'
                                    for event in frames))
                self.assertFalse(any('usage' in event for event in frames))
                self.assertEqual(attempted, [])
                self.assertEqual(h._log_chat.call_args.kwargs['status'], 502)
                state.note_success.assert_not_called()
                state.note_failure.assert_called_once_with('gpu/minicpm5-2b')
                state.gate.release.assert_called_once()

    def test_gpu_disconnect_does_not_finish_a_partial_answer_successfully(self):
        source = self.observed_stream({'choices':[{'delta':{'content':'Partial answer'}}]})
        h, state = self.finalize(source, upstream_model='gpu/ornith-1.5-9b')
        frames = self.frames(h)
        self.assertTrue(any(event.get('error',{}).get('code') == 'upstream_truncated'
                            for event in frames))
        self.assertFalse(any('usage' in event for event in frames))
        state.note_success.assert_not_called()
        state.note_failure.assert_called_once_with('gpu/ornith-1.5-9b')
        state.gate.release.assert_called_once()

    def test_client_stop_during_reasoning_closes_the_upstream_immediately(self):
        source = self.observed_stream(
            {'choices':[{'delta':{'reasoning_content':'Working'}}]},
            {'choices':[{'delta':{'content':'Must not be read after Stop'}}]}, b'[DONE]')

        def stop(chunk):
            if b'reasoning_content' in chunk:
                raise BrokenPipeError('Client pressed Stop')

        with self.assertRaises(BrokenPipeError):
            self.finalize(source, upstream_model='gpu/minicpm5-2b', on_write=stop)
        self.assertEqual(source.read_calls, 1)
        self.assertTrue(source.closed)

    def test_failure_updates_the_specific_private_service_breaker(self):
        for upstream, circuit in (('gpu/ornith-1.5-9b','gpu/ornith-1.5-9b'),
                                  ('gpu/minicpm5-2b','gpu/minicpm5-2b'),
                                  ('direct/gpt-4o-mini','codegpt-direct')):
            with self.subTest(upstream=upstream):
                source = self.observed_stream({'error':{'code':'provider_failed','message':'Failed'}}, b'[DONE]')
                h, state = self.finalize(source, upstream_model=upstream)
                self.assertEqual(h._json.call_args.args[0], 502)
                state.note_failure.assert_called_once_with(circuit)
                state.note_success.assert_not_called()

    def test_fallback_gpu_reasoning_is_forwarded_before_its_answer(self):
        original = self.observed_stream({'error':{'message':'Primary failed'}}, b'[DONE]')
        fallback = self.observed_stream(
            {'choices':[{'delta':{'reasoning_content':'Working'}}]},
            {'choices':[{'delta':{'content':'Recovered'},'finish_reason':'stop'}]}, b'[DONE]')
        observed = []

        def on_write(chunk):
            if b'reasoning_content' in chunk:
                observed.append(fallback.read_calls)

        h, state = self.finalize(original, upstream_model='omniroute/test',
            fallback={'enabled':True,'upstream':'gpu/ornith-1.5-9b'},
            urlopen=lambda *args, **kwargs:fallback, on_write=on_write)
        self.assertEqual(observed, [1])
        state.note_success.assert_called_once_with('gpu/ornith-1.5-9b')
        self.assertTrue(original.closed)
        self.assertTrue(fallback.closed)


if __name__ == '__main__':
    unittest.main()
