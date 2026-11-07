"""Tracking evidence only: inert model responses and native MockSessionAPI."""
from copy import deepcopy
import json
from unittest.mock import Mock, patch

import pytest

from remote_yam.controller import RunnerController
from remote_yam.robocurve_policy import OpenAIAdapter, _unsubmitted_packet_digest
from remote_yam.session import MockSessionAPI
from test_robocurve_policy import Cameras, observation, response


def prepared(gripper=.9):
    provider = OpenAIAdapter('PRIVATE_KEY', 'inert-model', camera_source=Cameras())
    obs = {**observation(), 'observed_at': 100.}
    with patch.object(provider, '_post_json', return_value=response('move_to',
            {'targets': {'left_gripper': gripper}, 'note': 'PRIVATE_NOTE'})):
        points = provider.build_trajectory('PRIVATE_PROMPT', obs, 0)
    final = {**obs, **deepcopy(points[-1]), 'step_id': points[-1]['step_id'] + 1,
             'observed_at': 101., 'PRIVATE_CONTEXT': 'PRIVATE_VALUE'}
    return provider, points, final


def last_tool(provider):
    return json.loads(provider._history[-1]['output'])


def test_completion_uses_original_detached_endpoints_and_only_numerical_measured_evidence():
    provider, points, final = prepared()
    assert provider.completion_observer is None
    original = deepcopy(points)
    captured = []
    provider.completion_observer = captured.append
    # The caller owns the returned container. It cannot rewrite the retained
    # packet targets or evidence by mutating that container later.
    points[0]['left_joints_deg'][0] = 999.
    points[-1]['right_gripper'] = .1
    final['left_joints_deg'][0] += .001
    with (patch.object(provider._geometry, 'observe', side_effect=AssertionError('extra FK')),
            patch.object(provider, '_capture_frames', side_effect=AssertionError('extra camera'))):
        provider.trajectory_completed(final, len(points))
    assert len(captured) == 1
    value = captured[0]
    assert set(value) == {'schema', 'version', 'first_step_id', 'last_step_id', 'waypoint_count',
        'call_id', 'call_ordinal', 'packet_sha256', 'first_target', 'final_target', 'measured',
        'observation_step_id', 'observed_at', 'episode_id', 'source', 'settled', 'workspace_adjusted'}
    assert value['schema'] == 'learning.tracking_completion.v1' and value['version'] == 1
    assert value['first_target'] == original[0] and value['final_target'] == original[-1]
    assert value['packet_sha256'] == _unsubmitted_packet_digest(original, 'call_1')
    assert (value['first_step_id'], value['last_step_id'], value['waypoint_count']) == (0, original[-1]['step_id'], len(original))
    assert (value['call_id'], value['call_ordinal'], value['episode_id']) == ('call_1', 1, 'ep_test')
    assert value['observation_step_id'] == original[-1]['step_id']+1
    assert value['observed_at'] == 101. and value['settled'] is True
    assert value['source'] == 'simulation' and value['workspace_adjusted'] is False
    assert value['measured']['left_joints_deg'] == final['left_joints_deg']
    assert 'PRIVATE' not in repr(value) and 'lease' not in repr(value)
    assert last_tool(provider) == {'ok': True, 'steps': len(original), 'status': 'completed', 'cadence_hz': 10}
    assert provider._pending is None


def test_completion_callback_mutation_cannot_change_native_tool_result_or_caller_observation():
    provider, points, final = prepared()
    before = deepcopy(final)
    def mutate(value):
        value['first_target']['left_joints_deg'].clear()
        value['final_target']['right_joints_deg'][0] = 999
        value['measured']['left_joints_deg'][0] = 999
        value['call_id'] = 'different'
        value.clear()
    provider.completion_observer = mutate
    provider.trajectory_completed(final, len(points))
    assert final == before
    assert provider._history[-1]['call_id'] == 'call_1'
    assert last_tool(provider)['ok'] is True


@pytest.mark.parametrize('failure', [RuntimeError, BaseException, SystemExit, KeyboardInterrupt])
def test_callback_failure_isolated_and_never_changes_native_completion(failure):
    provider, points, final = prepared()
    provider.completion_observer = Mock(side_effect=failure('PRIVATE_ERROR'))
    provider.trajectory_completed(final, len(points))
    assert last_tool(provider)['status'] == 'completed' and provider._pending is None
    assert 'PRIVATE_ERROR' not in repr(provider._history[-1])


@pytest.mark.parametrize('cancel', [True, RuntimeError('inert cancellation failure')])
def test_cancelled_or_failing_cancellation_check_suppresses_only_optional_delivery(cancel):
    provider, points, final = prepared()
    provider.completion_observer = Mock()
    provider.cancelled = Mock(side_effect=cancel) if isinstance(cancel, Exception) else lambda: cancel
    provider.trajectory_completed(final, len(points))
    provider.completion_observer.assert_not_called()
    assert last_tool(provider)['ok'] is True and provider._pending is None


@pytest.mark.parametrize('field,value', [('step_id', 999), ('count', 999)])
def test_original_completion_cursor_and_count_validation_precede_callback(field, value):
    provider, points, final = prepared()
    provider.completion_observer = Mock()
    count = len(points)
    if field == 'count': count = value
    else: final[field] = value
    with pytest.raises(RuntimeError): provider.trajectory_completed(final, count)
    provider.completion_observer.assert_not_called()
    assert provider._pending is not None


@pytest.mark.parametrize('field,value', [('left_joints_deg', [0.]*5), ('right_joints_deg', [float('nan')]*6),
    ('left_joints_deg', [True]*6), ('right_joints_deg', [10**1000]*6), ('left_gripper', True),
    ('right_gripper', 2.), ('observed_at', None), ('observed_at', float('inf')),
    ('observed_at', 10**1000), ('settled', False), ('source', 'foreign'), ('episode_id', 'foreign'),
    ('episode_id', {'private': 'not copied'})])
def test_unsupported_measurements_suppress_evidence_without_tightening_native_completion(field, value):
    provider, points, final = prepared()
    provider.completion_observer = Mock()
    final[field] = value
    provider.trajectory_completed(final, len(points))
    provider.completion_observer.assert_not_called()
    assert last_tool(provider)['status'] == 'completed'


def test_legacy_pending_without_endpoint_snapshots_retains_native_completion():
    provider, points, final = prepared()
    del provider._pending['first_target']
    provider.completion_observer = Mock()
    provider.trajectory_completed(final, len(points))
    provider.completion_observer.assert_not_called()
    assert last_tool(provider)['status'] == 'completed'


def test_rebuild_replaces_endpoint_and_digest_binding_without_changing_model_call():
    provider, old, final = prepared()
    previous = deepcopy(provider._pending)
    obs = {**observation(), 'observed_at': 100.5}
    rebuilt = [{**deepcopy(old[0]), 'step_id': i} for i in range(2)]
    rebuilt[-1]['left_gripper'] = .85
    with patch.object(provider._geometry, 'build', return_value=rebuilt):
        assert provider.rebuild_pending_trajectory(obs, 0) == rebuilt
    retained = deepcopy(rebuilt)
    final = {**final, **deepcopy(rebuilt[-1]), 'step_id': 2}
    rebuilt[0]['left_joints_deg'][0] = 999
    captured = []
    provider.completion_observer = captured.append
    provider.trajectory_completed(final, 2)
    assert captured[0]['first_target'] == retained[0] and captured[0]['final_target'] == retained[-1]
    assert captured[0]['packet_sha256'] == _unsubmitted_packet_digest(retained, previous['call_id'])
    assert captured[0]['packet_sha256'] != previous['packet_sha256']
    assert captured[0]['call_id'] == previous['call_id'] and captured[0]['call_ordinal'] == 1


def test_workspace_adjusted_completion_is_labelled_ineligible_without_copying_raw_details():
    provider, points, final = prepared()
    provider.trajectory_adjusted({'workspace_recovery': 'adjusted', 'changed_waypoints': 1,
                                  'PRIVATE_GATEWAY_CONTEXT': 'never copied'})
    captured = []
    provider.completion_observer = captured.append
    provider.trajectory_completed(final, len(points))
    assert captured[0]['workspace_adjusted'] is True
    assert captured[0]['final_target'] == points[-1]
    assert 'PRIVATE' not in repr(captured)
    assert last_tool(provider)['feedback']['workspace_recovery'] == 'adjusted'


@pytest.mark.parametrize('code', ['joint_settle_timeout', 'final_position_mismatch'])
def test_failed_trajectory_never_emits_positive_completion(code):
    provider, points, _ = prepared()
    provider.completion_observer = Mock()
    provider.trajectory_failed(code, 'inert failure', len(points))
    provider.completion_observer.assert_not_called()
    assert last_tool(provider)['ok'] is False and provider._pending is None


def test_partial_workspace_failure_and_stale_plan_discard_never_emit_completion():
    provider, points, final = prepared(0.)
    assert len(points) > 1
    provider.completion_observer = Mock()
    provider.trajectory_failed('left_tip_outside_workspace', 'inert partial hold', 1,
        feedback=dict(recoverable=True, workspace_recovery='held', hold='measured_position',
            executed_waypoints=1, next_step_id=points[-1]['step_id']+1))
    provider.completion_observer.assert_not_called()
    assert last_tool(provider)['status'] == 'not_reached'
    provider, points, final = prepared()
    provider.completion_observer = Mock()
    fresh = {**final, 'source': 'hardware', 'jetson_id': 'yam-1', 'step_id': 0}
    assert provider.discard_unsubmitted_trajectory(points, first_step_id=0, observation=fresh,
        context=dict(first_step_id=0, episode_id='ep_test', robot_id='yam-1', session_id='session_test',
            reason_code='pre_dispatch_pose_changed', dispatched=False, executed_waypoints=0))
    provider.completion_observer.assert_not_called()
    assert last_tool(provider)['status'] == 'not_executed'


def test_native_mock_controller_completes_after_ordered_source_evidence_and_guard_refusal_emits_nothing():
    for decision in ('allow', 'reject'):
        provider = OpenAIAdapter('PRIVATE_KEY', 'inert-model', camera_source=Cameras())
        captured = []
        provider.completion_observer = captured.append
        session = MockSessionAPI()
        controller = RunnerController(session, trajectory_decision=lambda *a: {'decision': decision})
        controller.update_monitor_observation(session.get_robot_observation('yam-1'))
        def build(_, obs, first):
            return [{**{key: deepcopy(obs[key]) for key in ('left_joints_deg', 'right_joints_deg',
                       'left_gripper', 'right_gripper')}, 'step_id': first}]
        replies = [response('move_to', {'targets': {'left_gripper': .9}, 'note': 'inert'}),
                   response('done', {'summary': 'inert done', 'hindsight': 'none'}, 'call_2')]
        with patch.object(provider._geometry, 'build', side_effect=build), patch.object(provider, '_post_json', side_effect=replies):
            controller.join(provider, 'Inert fixture')
            controller._run_loop(None)
        if decision == 'reject':
            assert not captured and not session.trajectory_log
        else:
            assert len(captured) == len(session.trajectory_log) == 1
            value = captured[0]
            assert value['final_target'] == session.trajectory_log[0]['waypoints'][-1]
            assert value['episode_id'] == controller.status()['episode_id']
            assert value['source'] == 'simulation' and value['settled'] is True
            source_events = controller.status()['run_summary']['events']
            kinds = [event['type'] for event in source_events]
            assert kinds.count('trajectory_result') == 2
            assert kinds.index('trajectory_result') < kinds.index('trajectory_progress')
            assert controller._last_completed_trajectory_result['status'] == 'completed'
            assert controller.status()['status'] == 'stopped'
