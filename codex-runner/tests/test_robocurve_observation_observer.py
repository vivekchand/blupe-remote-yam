"""Optional private input evidence; all cameras and model responses are inert."""
import base64
import copy
import unittest
from unittest.mock import Mock, patch

from remote_yam.cameras import CameraFrame, MAX_FRAME_BYTES
from remote_yam.codex_policy import CodexAdapter
from remote_yam.providers import PolicyComplete
from remote_yam.robocurve_policy import OpenAIAdapter
from test_robocurve_policy import Cameras, observation, response


def frames():
    return [CameraFrame(name, b'\xff\xd8' + name.encode() + b'\xff\xd9', 124.,
        source_captured_at=123., view={'private_url': 'PRIVATE_CAMERA_URL'})
        for name in ('right', 'top', 'left')]


class ObservationObserverTests(unittest.TestCase):
    def provider(self, captured=None):
        cameras = Mock()
        cameras.capture_for_policy = None
        cameras.capture.return_value = frames() if captured is None else captured
        return OpenAIAdapter('PRIVATE_KEY', 'inert-model', camera_source=cameras), cameras

    def test_exact_selected_bytes_and_metadata_match_model_input_without_private_context(self):
        provider, cameras = self.provider()
        self.assertIsNone(provider.observation_observer)
        captured = []
        provider.observation_observer = captured.append
        obs = {**observation(), 'observed_at': 122., 'step_id': 7,
               'private_context': 'PRIVATE_OBSERVATION'}
        with patch.object(provider, '_post_json', return_value=response('give_up',
                {'reason': 'inert completion', 'hindsight': 'none'})) as post:
            with self.assertRaises(PolicyComplete):
                provider.build_trajectory('PRIVATE_PROMPT', obs, 8)
        cameras.capture.assert_called_once_with(obs)
        self.assertEqual(len(captured), 1)
        evidence = captured[0]
        self.assertEqual(set(evidence), {'schema', 'frames', 'first_step_id', 'call_ordinal',
            'observation_step_id', 'observed_at', 'episode_id', 'planning_only'})
        self.assertEqual({k: v for k, v in evidence.items() if k != 'frames'}, {
            'schema': 'clawmetry.policy.observation.v1', 'first_step_id': 8,
            'call_ordinal': 1, 'observation_step_id': 7, 'observed_at': 122.,
            'episode_id': 'ep_test', 'planning_only': False})
        images = [item for item in post.call_args.args[0]['input'][-1]['content']
                  if item['type'] == 'input_image']
        self.assertEqual([row['camera'] for row in evidence['frames']], ['top', 'left', 'right'])
        for row, image in zip(evidence['frames'], images):
            self.assertEqual(set(row), {'camera', 'jpeg', 'source_captured_at_s', 'received_at_s'})
            self.assertIs(type(row['jpeg']), bytes)
            self.assertEqual(row['jpeg'], base64.b64decode(image['image_url'].split(',', 1)[1]))
            self.assertEqual((row['source_captured_at_s'], row['received_at_s']), (123., 124.))
        self.assertNotIn('PRIVATE', repr(evidence))

    def test_saved_planning_frames_keep_missing_source_clock_and_do_not_acquire_cameras(self):
        provider, cameras = self.provider()
        captured = []
        provider.observation_observer = captured.append
        saved = [CameraFrame(name, b'saved-' + name.encode(), 50.) for name in ('top', 'left', 'right')]
        obs = {**observation(), 'planning_scene': {'PRIVATE': 'not copied'}, '_home_scene_frames': saved}
        provider._calls = 4
        provider._observation_message('PRIVATE_PROMPT', obs, 0)
        cameras.capture.assert_not_called()
        self.assertTrue(captured[0]['planning_only'])
        self.assertEqual(captured[0]['call_ordinal'], 5)
        self.assertIsNone(captured[0]['observed_at'])
        self.assertTrue(all(row['source_captured_at_s'] is None for row in captured[0]['frames']))
        self.assertNotIn('PRIVATE', repr(captured))

    def test_callback_cannot_mutate_prepared_model_images_or_observation(self):
        provider, _ = self.provider()
        obs = observation()
        original = copy.deepcopy(obs)
        def mutate(value):
            value['frames'][0]['jpeg'] = b'changed'
            value['frames'].clear()
            value['episode_id'] = 'different'
        provider.observation_observer = mutate
        message = provider._observation_message('inert', obs, 0)
        actual = [base64.b64decode(item['image_url'].split(',', 1)[1])
                  for item in message['content'] if item['type'] == 'input_image']
        self.assertEqual(actual, [next(f.jpeg for f in frames() if f.name == name)
                                  for name in ('top', 'left', 'right')])
        self.assertEqual(obs, original)

    def test_observer_exception_does_not_break_model_or_mark_camera_failure(self):
        provider, cameras = self.provider()
        provider.observation_observer = Mock(side_effect=RuntimeError('PRIVATE_FAILURE'))
        with patch.object(provider, '_post_json', return_value=response('give_up',
                {'reason': 'inert completion', 'hindsight': 'none'})) as post:
            with self.assertRaises(PolicyComplete):
                provider.build_trajectory('inert', observation(), 0)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(cameras.capture.call_count, 1)
        self.assertNotEqual(provider._vision_state, 'camera_error')

    def test_observer_base_exceptions_cannot_replace_prepared_message_or_model_behavior(self):
        for failure in (BaseException, SystemExit, KeyboardInterrupt):
            with self.subTest(failure=failure.__name__):
                provider, cameras = self.provider()
                expected, _ = self.provider()
                message = expected._observation_message('inert', observation(), 0)
                provider.observation_observer = Mock(side_effect=failure('PRIVATE_FAILURE'))
                with patch.object(provider, '_post_json', return_value=response('give_up',
                        {'reason': 'inert completion', 'hindsight': 'none'})) as post:
                    with self.assertRaises(PolicyComplete):
                        provider.build_trajectory('inert', observation(), 0)
                self.assertEqual(post.call_args.args[0]['input'][-1], message)
                self.assertEqual(post.call_count, 1)
                self.assertEqual(cameras.capture.call_count, 1)
                self.assertNotEqual(provider._vision_state, 'camera_error')

    def test_cancellation_before_capture_or_after_completed_capture_never_delivers_late_evidence(self):
        for cancel_during_capture in (False, True):
            with self.subTest(cancel_during_capture=cancel_during_capture):
                provider, cameras = self.provider()
                cancelled = [not cancel_during_capture]
                provider.cancelled = lambda: cancelled[0]
                provider.observation_observer = Mock()
                if cancel_during_capture:
                    def capture(_):
                        cancelled[0] = True
                        return frames()
                    cameras.capture.side_effect = capture
                with patch.object(provider, '_post_json') as post:
                    self.assertEqual(provider.build_trajectory('inert', observation(), 0), [])
                provider.observation_observer.assert_not_called()
                post.assert_not_called()
                self.assertEqual(cameras.capture.call_count, int(cancel_during_capture))

    def test_new_cancellation_check_exception_is_isolated_from_native_message(self):
        provider, _ = self.provider()
        provider.observation_observer = Mock()
        provider.cancelled = Mock(side_effect=RuntimeError('inert check failure'))
        self.assertEqual(provider._observation_message('inert', observation(), 0)['role'], 'user')
        provider.observation_observer.assert_not_called()

    def test_native_incomplete_or_malformed_frame_failure_prevents_callback(self):
        for captured in (frames()[:2], [*frames(), CameraFrame('extra', b'jpeg', 125.)],
                         [CameraFrame('top', None, 123.), *frames()[:1], frames()[2]]):
            with self.subTest(captured=captured):
                provider, _ = self.provider(captured)
                provider.observation_observer = Mock()
                with self.assertRaises((RuntimeError, TypeError)):
                    provider._observation_message('inert', observation(), 0)
                provider.observation_observer.assert_not_called()
                self.assertEqual(provider._vision_state, 'camera_error')

    def test_duplicate_and_oversized_custom_frame_source_behavior_is_unchanged(self):
        # Native camera sources own their bounds. This optional hook must not
        # impose a different acceptance policy on an injected/saved source.
        huge = CameraFrame('top', b'x' * (MAX_FRAME_BYTES + 1), 123.)
        captured = [*frames(), huge]
        before, before_cameras = self.provider(captured)
        after, after_cameras = self.provider(captured)
        delivered = []
        after.observation_observer = delivered.append
        self.assertEqual(before._observation_message('inert', observation(), 0),
                         after._observation_message('inert', observation(), 0))
        self.assertEqual(delivered[0]['frames'][0]['jpeg'], huge.jpeg)
        self.assertEqual(before_cameras.capture.call_count, after_cameras.capture.call_count)

    def test_codex_inherits_hook_without_authentication_or_process_launch(self):
        provider = CodexAdapter.__new__(CodexAdapter)
        provider._initialize_observation(Cameras())
        provider._initialize_policy(None)
        self.assertIsNone(provider.observation_observer)
        captured = []
        provider.observation_observer = captured.append
        message = provider._observation_message('inert', observation(), 0)
        self.assertEqual(message['role'], 'user')
        self.assertEqual(captured[0]['call_ordinal'], 1)
        self.assertEqual(len(captured[0]['frames']), 3)


if __name__ == '__main__':
    unittest.main()
