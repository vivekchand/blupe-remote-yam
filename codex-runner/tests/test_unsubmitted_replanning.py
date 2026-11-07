"""Inert provider-only stale-plan discard. No HTTP/model/camera/robot I/O."""
import copy
import json
from unittest.mock import patch

import numpy as np
import pytest

from remote_yam.cameras import CameraFrame
from remote_yam.robocurve_policy import OpenAIAdapter


class Cameras:
    def __init__(self): self.calls = 0
    def capture(self, observation):
        self.calls += 1
        return [CameraFrame(name, b'\xff\xd8' + f'{name}:{self.calls}'.encode() + b'\xff\xd9', 100. + self.calls)
                for name in ('left', 'top', 'right')]


class Geometry:
    def __init__(self): self.start_rotations = object()
    def observe(self, observation):
        return np.zeros(12), np.zeros(14), [*observation['left_joints_deg'], observation['left_gripper'],
                                             *observation['right_joints_deg'], observation['right_gripper']]
    def build(self, targets, observation, first_step_id):
        return [dict(step_id=first_step_id + i, left_joints_deg=[targets['left_z']] * 6,
                     right_joints_deg=list(observation['right_joints_deg']),
                     left_gripper=observation['left_gripper'], right_gripper=observation['right_gripper']) for i in range(2)]


def response(call, target):
    return {'output': [{'type': 'function_call', 'id': 'fc_' + call, 'call_id': call,
                       'name': 'move_to', 'arguments': json.dumps({'targets': {'left_z': target}, 'note': 'Move conservatively'})}]}


@pytest.fixture
def planned():
    cameras = Cameras(); provider = OpenAIAdapter('inert-test-key', 'inert-model', camera_source=cameras)
    provider._geometry = Geometry()
    observation = dict(source='hardware', jetson_id='robot_test', episode_id='episode_test',
        lease_id='PRIVATE_LEASE', step_id=84, settled=True, left_joints_deg=[0.] * 6,
        right_joints_deg=[0.] * 6, left_gripper=1., right_gripper=1., observed_at=100.)
    with patch.object(provider, '_post_json', return_value=response('call_first', .2)):
        points = provider.build_trajectory('pick green pen', observation, 84)
    context = dict(robot_id='robot_test', episode_id='episode_test', session_id='session_test',
        first_step_id=84, reason_code='pre_dispatch_pose_changed', dispatched=False, executed_waypoints=0)
    return provider, cameras, observation, points, context


def discard(planned):
    provider, _, observation, points, context = planned
    return provider.discard_unsubmitted_trajectory(points, first_step_id=84, observation=observation, context=context)


def test_exact_pending_tool_discard_is_zero_motion_and_fresh_replanning(planned):
    provider, cameras, observation, points, context = planned
    orientation_reference = provider._geometry.start_rotations
    before = copy.deepcopy(points)
    assert discard(planned) is True
    assert points == before and provider._pending is None
    assert cameras.calls == 1 and provider._calls == 1, 'discard itself must not infer or capture'
    outputs = [item for item in provider._history if item.get('type') == 'function_call_output']
    assert len(outputs) == 1 and outputs[0]['call_id'] == 'call_first'
    result = json.loads(outputs[0]['output'])
    assert result['status'] == 'not_executed' and result['steps'] == 0 and result['dispatched'] is False
    assert 'new camera images' in result['instruction'] and 'Do not replay' in result['instruction']
    assert 'PRIVATE_LEASE' not in outputs[0]['output']
    fresh = {**observation, 'left_joints_deg': [0., 0., 0., 0., .4, 0.], 'observed_at': 110.}
    with patch.object(provider, '_post_json', return_value=response('call_fresh', .15)) as post:
        new = provider.build_trajectory('pick green pen', fresh, 84)
    assert cameras.calls == 2 and provider._calls == 2
    assert new != points and new[0]['step_id'] == 84
    assert provider._pending['call_id'] == 'call_fresh'
    assert provider._geometry.start_rotations is orientation_reference
    payload = post.call_args.args[0]
    observations = [item for item in payload['input'] if item.get('role') == 'user' and isinstance(item.get('content'), list)]
    assert len(observations) == 2
    assert '0.4' in observations[-1]['content'][0]['text']
    old_images = [item['image_url'] for item in observations[0]['content'] if item.get('type') == 'input_image']
    new_images = [item['image_url'] for item in observations[1]['content'] if item.get('type') == 'input_image']
    assert old_images != new_images


@pytest.mark.parametrize('mutate', [
    lambda x: x[3][0]['left_joints_deg'].__setitem__(0, .25),
    lambda x: x[3][-1].__setitem__('right_gripper', .9),
    lambda x: x[3].pop(),
    lambda x: x[3][0].__setitem__('step_id', 85),
    lambda x: x[4].__setitem__('episode_id', 'foreign'),
    lambda x: x[4].__setitem__('robot_id', 'foreign'),
    lambda x: x[4].__setitem__('dispatched', True),
    lambda x: x[4].__setitem__('executed_waypoints', 1),
    lambda x: x[4].__setitem__('reason_code', 'guard_refusal'),
    lambda x: x[2].__setitem__('lease_id', 'foreign'),
    lambda x: x[2].__setitem__('step_id', 85),
    lambda x: x[2].__setitem__('source', 'simulation'),
    lambda x: x[2].__setitem__('settled', False),
    lambda x: x[2].__setitem__('left_gripper', float('nan')),
    lambda x: x[2].__setitem__('right_joints_deg', [0.] * 5),
    lambda x: x[0]._pending.__setitem__('workspace_recovery', {'adjusted': True}),
    lambda x: x[0]._pending.pop('packet_sha256'),
    lambda x: x[0]._pending.__setitem__('call_id', 'foreign_call'),
])
def test_mismatch_never_mutates_pending_or_history(planned, mutate):
    mutate(planned)
    provider = planned[0]
    history, pending = copy.deepcopy(provider._history), copy.deepcopy(provider._pending)
    with pytest.raises(RuntimeError, match='does not match'):
        discard(planned)
    assert provider._history == history and provider._pending == pending
    assert planned[1].calls == 1 and provider._calls == 1


def test_cancelled_discard_is_terminal_without_tool_result(planned):
    provider = planned[0]; provider.cancelled = lambda: True
    before = copy.deepcopy(provider._history)
    with pytest.raises(RuntimeError): discard(planned)
    assert provider._history == before and provider._pending is not None


def test_discard_is_single_use_and_does_not_reset_failure_or_call_budget(planned):
    provider = planned[0]; provider._failures = 2
    assert discard(planned) is True
    after = copy.deepcopy(provider._history)
    with pytest.raises(RuntimeError): discard(planned)
    assert provider._history == after and provider._failures == 2 and provider._calls == 1


def test_rebuilt_pending_home_packet_replaces_immutable_digest(planned):
    provider, _, observation, points, context = planned
    provider._pending['targets'] = {'left_z': .1}
    rebuilt = provider.rebuild_pending_trajectory(observation, 84)
    assert rebuilt != points
    with pytest.raises(RuntimeError): discard(planned)
    planned[3][:] = rebuilt
    assert discard(planned) is True


@pytest.mark.parametrize('counts', [(5, 5), (5, 0), (6, 6)])
def test_packet_identity_preserves_inherited_robot_joint_widths(counts):
    from remote_yam.robocurve_policy import _unsubmitted_packet_digest
    packet = [dict(step_id=i, left_joints_deg=[0.] * counts[0],
                   right_joints_deg=[0.] * counts[1], left_gripper=1., right_gripper=1.) for i in range(2)]
    digest = _unsubmitted_packet_digest(packet, 'call-original')
    assert len(digest) == 64
    assert digest != _unsubmitted_packet_digest(packet, 'call-another')
    packet[1]['left_joints_deg'].append(0.)
    with pytest.raises(ValueError):
        _unsubmitted_packet_digest(packet, 'call-original')


def test_unsubmitted_recovery_stays_yam_only_for_inherited_shapes(planned):
    from remote_yam.robocurve_policy import _unsubmitted_packet_digest
    provider, _, observation, packet, _ = planned
    for point in packet:
        point['left_joints_deg'] = point['left_joints_deg'][:5]
        point['right_joints_deg'] = point['right_joints_deg'][:5]
    observation['left_joints_deg'] = observation['left_joints_deg'][:5]
    observation['right_joints_deg'] = observation['right_joints_deg'][:5]
    provider._pending.update(first_target=copy.deepcopy(packet[0]), final_target=copy.deepcopy(packet[-1]),
        packet_sha256=_unsubmitted_packet_digest(packet, provider._pending['call_id']))
    before = copy.deepcopy(provider._history)
    pending = copy.deepcopy(provider._pending)
    with pytest.raises(RuntimeError, match='does not match'):
        discard(planned)
    assert provider._history == before and provider._pending == pending
