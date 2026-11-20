import json
import functools
import gc
import warnings
from concurrent.futures import ThreadPoolExecutor
import threading
import unittest
from unittest.mock import Mock, patch

from playground import HostedRunner
from remote_yam.subscription_observer import SubscriptionObserver, probe_response
from remote_yam.subscription_setup import probe_subscription, verify_subscription


class SubscriptionObserverTests(unittest.TestCase):
    def adapter(self, model='selected-model'):
        adapter = Mock(model=model)
        adapter.reasoning_effort, adapter.response_speed, adapter._timeout_s = 'low', 'fast', 45
        adapter._api_key = 'PRIVATE_KEY_CANARY'
        adapter._post_json.return_value = {'output': [
            {'type': 'function_call', 'name': 'done', 'arguments': '{"summary":"Connection verified"}'}]}
        return adapter

    def test_actual_probe_boundaries_use_fixed_text_and_no_robot_or_auth_data(self):
        for provider, cls in [('codex', 'CodexAdapter'), ('claude', 'ClaudeAdapter')]:
            events, adapter = [], self.adapter()
            with self.subTest(provider=provider), patch(
                    f'remote_yam.{provider}_policy.{cls}', return_value=adapter) as factory:
                result = probe_subscription(provider, 'selected-model', observer=events.append)
            self.assertEqual(result, 'selected-model')
            factory.assert_called_once_with('selected-model', timeout_s=45)
            adapter._post_json.assert_called_once()
            adapter._workspace.cleanup.assert_called_once()
            self.assertEqual([(e['name'], e['state']) for e in events], [
                ('subscription.model', 'started'), ('subscription.model', 'returned'),
                ('subscription.validate', 'started'), ('subscription.validate', 'returned')])
            self.assertIn('Subscription connection check only', events[0]['inputs']['input'][0]['content'][0]['text'])
            self.assertEqual(events[0]['inputs']['tools'], [])
            self.assertEqual(events[0]['configured_reasoning_effort'], 'low')
            self.assertEqual(events[0]['configured_response_speed'], 'fast')
            self.assertEqual(events[0]['configured_timeout_s'], 45)
            self.assertEqual(events[0]['clock_domain'], 'runner_process')
            self.assertEqual(events[1]['outputs']['output'][0]['name'], 'done')
            self.assertTrue(events[-1]['connection_verified'])
            raw = json.dumps(events)
            for forbidden in ('PRIVATE_KEY_CANARY', '_workspace', 'stdout', 'stderr', 'native_owner', 'lease'):
                self.assertNotIn(forbidden, raw)

    def test_observer_mutation_cannot_change_real_model_input_or_result(self):
        adapter = self.adapter()
        def mutate(event):
            if 'inputs' in event:
                event['inputs']['input'].clear()
            if 'outputs' in event:
                event['outputs']['output'][0]['name'] = 'move_to'
        with patch('remote_yam.codex_policy.CodexAdapter', return_value=adapter):
            self.assertEqual(probe_subscription('codex', observer=mutate), 'selected-model')
        self.assertEqual(len(adapter._post_json.call_args.args[0]['input']), 1)
        self.assertEqual(adapter._post_json.return_value['output'][0]['name'], 'done')

    def test_native_error_identity_and_cleanup_survive_failed_observer(self):
        adapter, events = self.adapter(), []
        error = RuntimeError('PRIVATE_DIAGNOSTIC_CANARY')
        adapter._post_json.side_effect = error
        with patch('remote_yam.codex_policy.CodexAdapter', return_value=adapter):
            with self.assertRaises(RuntimeError) as caught:
                probe_subscription('codex', observer=events.append)
        self.assertIs(caught.exception, error)
        self.assertEqual(events[-1]['error_type'], 'RuntimeError')
        self.assertNotIn('PRIVATE_DIAGNOSTIC_CANARY', json.dumps(events))
        adapter._workspace.cleanup.assert_called_once()
        calls = []
        def broken(event):
            calls.append(event)
            raise RuntimeError('PRIVATE_CALLBACK_CANARY')
        adapter = self.adapter()
        with patch('remote_yam.codex_policy.CodexAdapter', return_value=adapter), self.assertLogs(
                'remote_yam.subscription_observer', level='WARNING') as logs:
            self.assertEqual(probe_subscription('codex', observer=broken), 'selected-model')
        self.assertEqual(len(calls), 1)
        self.assertNotIn('PRIVATE_CALLBACK_CANARY', str(logs.output))
        adapter._workspace.cleanup.assert_called_once()

    def test_returned_model_call_is_not_a_validated_connection(self):
        events, adapter = [], self.adapter()
        adapter._post_json.return_value = {'output': [{'name': 'move_to'}]}
        with patch('remote_yam.codex_policy.CodexAdapter', return_value=adapter):
            with self.assertRaisesRegex(RuntimeError, 'required completion'):
                probe_subscription('codex', observer=events.append)
        self.assertEqual(events[1]['state'], 'returned')
        self.assertEqual(events[-1]['name'], 'subscription.validate')
        self.assertEqual(events[-1]['state'], 'error')
        self.assertNotIn('connection_verified', events[-1])

    def test_missing_login_returns_same_setup_without_probe_or_model_span(self):
        setup, events = {'ready': False, 'state': 'login_required'}, []
        with patch('remote_yam.subscription_setup.subscription_status', return_value=setup), patch(
                'remote_yam.subscription_setup.probe_subscription') as probe:
            result = verify_subscription('codex', observer=events.append)
        self.assertIs(result, setup)
        probe.assert_not_called()
        self.assertNotIn('subscription.model', [e['name'] for e in events])
        self.assertEqual(events[-1]['state'], 'returned')
        self.assertFalse(events[-1]['ready'])
        self.assertFalse(events[-1]['verified'])

    def test_verification_failure_is_a_returned_negative_check_not_success(self):
        events = []
        setup = {'ready': True, 'label': 'Astra', 'state': 'ready'}
        with patch('remote_yam.subscription_setup.subscription_status', return_value=setup), patch(
                'remote_yam.subscription_setup.probe_subscription', side_effect=RuntimeError('private diagnostic')) as probe:
            result = verify_subscription('codex', 'selected-model', observer=events.append)
        self.assertFalse(result['ready'])
        self.assertFalse(events[-1]['verified'])
        self.assertEqual(events[-1]['result_state'], 'verification_failed')
        self.assertEqual(probe.call_count, 1)
        self.assertNotIn('private diagnostic', json.dumps(events))

    def test_disabled_observation_keeps_legacy_probe_signature(self):
        with patch('remote_yam.subscription_setup.subscription_status', return_value={
                'ready': True, 'label': 'Astra'}), patch(
                'remote_yam.subscription_setup.probe_subscription', return_value='selected-model') as probe:
            self.assertTrue(verify_subscription('codex', 'selected-model')['verified'])
        probe.assert_called_once_with('codex', 'selected-model')

    def test_oversize_capture_preserves_boundary_without_changing_native_result(self):
        events, adapter = [], self.adapter()
        adapter._post_json.return_value['output'][0]['arguments'] = 'x' * 300000
        with patch('remote_yam.codex_policy.CodexAdapter', return_value=adapter):
            self.assertEqual(probe_subscription('codex', observer=events.append), 'selected-model')
        self.assertEqual(events[1]['state'], 'returned')
        self.assertEqual(events[1]['capture_coverage'], 'payload_unavailable')
        self.assertNotIn('outputs', events[1])
        self.assertEqual(len(adapter._post_json.return_value['output'][0]['arguments']), 300000)

    def test_unsupported_capture_never_exposes_live_objects_or_changes_validation(self):
        events, adapter, opaque = [], self.adapter(), object()
        adapter._post_json.return_value['output'][0]['arguments'] = opaque
        with patch('remote_yam.codex_policy.CodexAdapter', return_value=adapter):
            self.assertEqual(probe_subscription('codex', observer=events.append), 'selected-model')
        returned = events[1]
        self.assertEqual(returned['capture_coverage'], 'payload_unavailable')
        self.assertNotIn('inputs', returned)
        self.assertNotIn('outputs', returned)
        self.assertTrue(all(value is None or type(value) in (str, bool) for value in returned.values()))
        self.assertIs(adapter._post_json.return_value['output'][0]['arguments'], opaque)
        self.assertTrue(events[-1]['connection_verified'])

    def test_native_process_interrupt_is_not_swallowed_as_an_observer_failure(self):
        adapter, events, interrupted = self.adapter(), [], KeyboardInterrupt()
        adapter._post_json.side_effect = interrupted
        with patch('remote_yam.codex_policy.CodexAdapter', return_value=adapter):
            with self.assertRaises(KeyboardInterrupt) as caught:
                probe_subscription('codex', observer=events.append)
        self.assertIs(caught.exception, interrupted)
        adapter._workspace.cleanup.assert_called_once()
        self.assertEqual(events[-1]['state'], 'error')
        self.assertEqual(events[-1]['error_type'], 'KeyboardInterrupt')

    def test_probe_projection_excludes_reasoning_and_unknown_response_fields(self):
        value = {'output': [{'type': 'reasoning', 'name': 'hidden', 'arguments': 'HIDDEN_CANARY'},
                            {'channel': 'analysis', 'name': 'hidden', 'arguments': 'ANALYSIS_CANARY'},
                            {'type': 'function_call', 'name': 'done', 'arguments': '{}', 'private': 'PRIVATE_CANARY'}],
                 'stderr': 'CLI_CANARY'}
        result = probe_response(value)
        self.assertEqual(result['omitted_items'], 2)
        self.assertEqual(len(result['output']), 1)
        for forbidden in ('HIDDEN_CANARY', 'ANALYSIS_CANARY', 'PRIVATE_CANARY', 'CLI_CANARY'):
            self.assertNotIn(forbidden, json.dumps(result))

    def test_probe_projection_keeps_only_known_public_decision_types_and_names(self):
        result = probe_response({'output': [
            {'type': 'message', 'name': 'done', 'arguments': 'WRONG_TYPE'},
            {'type': 'function_call', 'name': 'unknown', 'arguments': 'UNKNOWN_NAME'},
            {'type': {}, 'name': [], 'arguments': 'MALFORMED'},
            {'name': 'done', 'arguments': '{}'}]})
        self.assertEqual(result['output'], [{'name': 'done', 'arguments': '{}'}])
        self.assertEqual(result['omitted_items'], 3)

    def test_large_capture_shapes_are_rejected_before_json_encoding(self):
        deep = None
        for _ in range(30):
            deep = {'nested': deep}
        for payload in ('x' * 300000, [None] * 5000, deep):
            events = []
            sink = SubscriptionObserver(events.append)
            with patch('remote_yam.subscription_observer.json.JSONEncoder.iterencode') as encode:
                sink.emit('subscription.model', 'returned', outputs=payload)
                encode.assert_not_called()
            self.assertEqual(events[0]['capture_coverage'], 'payload_unavailable')
            self.assertNotIn('outputs', events[0])

    def test_callback_state_and_models_remain_call_local_under_concurrency(self):
        barrier, captures = threading.Barrier(2), {'one': [], 'two': []}
        def factory(model, **kwargs):
            adapter = self.adapter(model)
            result = adapter._post_json.return_value
            def execute(payload):
                barrier.wait(timeout=5)
                return result
            adapter._post_json.side_effect = execute
            return adapter
        with patch('remote_yam.codex_policy.CodexAdapter', side_effect=factory), patch(
                'remote_yam.subscription_setup.subscription_status', return_value={'ready': True, 'label': 'Astra'}):
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(verify_subscription, 'codex', model, observer=captures[model].append)
                           for model in ('one', 'two')]
                results = [future.result(timeout=10) for future in futures]
        self.assertEqual([result['model'] for result in results], ['one', 'two'])
        for model, events in captures.items():
            self.assertEqual({e['model'] for e in events if 'model' in e}, {model})
            self.assertEqual(len({e['call_id'] for e in events}), 1)
            self.assertTrue(events[-1]['verified'])
        self.assertNotEqual(captures['one'][0]['call_id'], captures['two'][0]['call_id'])

    def test_failed_callback_uses_legacy_probe_and_disabled_sink_creates_no_identity(self):
        def broken(event):
            raise RuntimeError('observer failure')
        with patch('remote_yam.subscription_observer.uuid.uuid4') as identity:
            SubscriptionObserver()
            identity.assert_not_called()
        with patch('remote_yam.subscription_setup.subscription_status', return_value={
                'ready': True, 'label': 'Astra'}), patch(
                'remote_yam.subscription_setup.probe_subscription', return_value='selected-model') as probe, self.assertLogs(
                'remote_yam.subscription_observer', level='WARNING'):
            self.assertTrue(verify_subscription('codex', 'selected-model', observer=broken)['verified'])
        probe.assert_called_once_with('codex', 'selected-model')

    def test_callback_and_factory_process_interrupts_preserve_identity_without_probe(self):
        for error in (KeyboardInterrupt(), SystemExit(7)):
            for where in ('callback', 'factory'):
                with self.subTest(kind=type(error).__name__, where=where):
                    app = object.__new__(HostedRunner)
                    def interrupted(*args, **kwargs):
                        raise error
                    app.subscription_observer = interrupted if where == 'factory' else lambda *args, **kwargs: interrupted
                    with patch('remote_yam.subscription_setup.subscription_status') as status, patch(
                            'remote_yam.subscription_setup.probe_subscription') as probe:
                        with self.assertRaises(type(error)) as caught:
                            app.verify_local_subscription(object(), 'codex', 'model', operation='run')
                    self.assertIs(caught.exception, error)
                    status.assert_not_called()
                    probe.assert_not_called()

    def test_callback_interrupt_after_model_return_preserves_identity_and_cleanup(self):
        for error in (KeyboardInterrupt(), SystemExit(7)):
            adapter, calls = self.adapter(), []
            def interrupted(event):
                calls.append(event)
                if event['state'] == 'returned':
                    raise error
            with patch('remote_yam.codex_policy.CodexAdapter', return_value=adapter):
                with self.assertRaises(type(error)) as caught:
                    probe_subscription('codex', observer=interrupted)
            self.assertIs(caught.exception, error)
            adapter._post_json.assert_called_once()
            adapter._workspace.cleanup.assert_called_once()
            self.assertEqual(len(calls), 2)

    def test_async_callbacks_and_factory_results_are_rejected_without_warnings_or_awaiting(self):
        entered = []
        async def async_callback(*args, **kwargs):
            entered.append('coroutine body')
        async def async_generator(*args, **kwargs):
            entered.append('generator body')
            yield None
        class AsyncCallable:
            async def __call__(self, *args, **kwargs):
                entered.append('async call body')
        callbacks = [async_callback, functools.partial(async_callback), AsyncCallable(),
                     functools.partial(AsyncCallable()), async_generator,
                     lambda event: async_callback(event)]
        for callback in callbacks:
            with self.subTest(callback_type=type(callback).__name__), warnings.catch_warnings(record=True) as captured:
                warnings.simplefilter('always')
                with patch('remote_yam.subscription_setup.subscription_status', return_value={
                        'ready': True, 'label': 'Astra'}), patch(
                        'remote_yam.subscription_setup.probe_subscription', return_value='selected-model') as probe:
                    self.assertTrue(verify_subscription('codex', 'model', observer=callback)['verified'])
                gc.collect()
                probe.assert_called_once_with('codex', 'model')
                self.assertEqual([w for w in captured if issubclass(w.category, RuntimeWarning)], [])
        app = object.__new__(HostedRunner)
        for factory in (async_callback, lambda *args, **kwargs: async_callback()):
            app.subscription_observer = factory
            with warnings.catch_warnings(record=True) as captured:
                warnings.simplefilter('always')
                with patch('remote_yam.subscription_setup.verify_subscription', return_value={'ready': False}) as verify:
                    app.verify_local_subscription(object(), 'codex', 'model', operation='check')
                gc.collect()
                verify.assert_called_once_with('codex', 'model')
                self.assertEqual([w for w in captured if issubclass(w.category, RuntimeWarning)], [])
        self.assertEqual(entered, [])

    def test_trusted_host_factory_is_opt_in_and_failure_preserves_verification(self):
        app, visitor, result = object.__new__(HostedRunner), object(), {'ready': False}
        with patch('remote_yam.subscription_setup.verify_subscription', return_value=result) as verify:
            self.assertIs(app.verify_local_subscription(visitor, 'codex', 'model', operation='run'), result)
            verify.assert_called_once_with('codex', 'model')
        callback, factory = Mock(), Mock(return_value=None)
        factory.return_value = callback
        app.subscription_observer = factory
        with patch('remote_yam.subscription_setup.verify_subscription', return_value=result) as verify:
            app.verify_local_subscription(visitor, 'codex', 'model', operation='check')
            verify.assert_called_once_with('codex', 'model', observer=callback)
        factory.assert_called_once_with(visitor, provider='codex', model='model', operation='check')
        factory.side_effect = RuntimeError('PRIVATE_FACTORY_CANARY')
        with patch('remote_yam.subscription_setup.verify_subscription', return_value=result) as verify, self.assertLogs(
                'playground', level='WARNING') as logs:
            self.assertIs(app.verify_local_subscription(visitor, 'codex', 'model', operation='run'), result)
            verify.assert_called_once_with('codex', 'model')
        self.assertNotIn('PRIVATE_FACTORY_CANARY', str(logs.output))


if __name__ == '__main__':
    unittest.main()
