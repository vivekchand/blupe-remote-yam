"""Bounds and exclusions of the public motion projection; no robot is involved."""
import json

import pytest

from remote_yam.public_motion import (MAX_ROWS, MOTION_KINDS, project_motion,
                                      project_motion_event)


def event(identity, kind, **details):
    return {'id': identity, 'timestamp': 1000.0 + identity, 'kind': kind,
            'message': 'PRIVATE_JOURNAL_MESSAGE', 'details': details}


def test_conversation_and_wire_kinds_never_enter_the_motion_channel():
    """The sharing consent protects these; motion must not route around it."""
    excluded = ['model_request', 'model_response', 'model_progress', 'steering_queued',
                'steering_included', 'http_exchange', 'http_connect', 'run_configuration',
                'depth_query', 'ik_kernel', 'error', 'model_error', 'model_failure',
                'joined', 'operator_requested', 'lifecycle', 'disconnect']
    for kind in excluded:
        assert kind not in MOTION_KINDS
        assert project_motion_event(event(1, kind, note='PRIVATE')) is None
    rows = project_motion([event(index, kind) for index, kind in enumerate(excluded, start=1)])
    assert rows == []


def test_published_rows_carry_no_free_text_from_the_journal():
    rows = project_motion([
        event(1, 'packet_submit', trajectory_id='trajectory_1', waypoint_count=3,
              cadence_hz=10, waypoints=[[1, 2], [3, 4]], note='PRIVATE_NOTE'),
        event(2, 'packet_error', stage='gateway', code='left_tip_outside_workspace',
              status='rejected', reported_progress=2, detail='PRIVATE_GATEWAY_DETAIL'),
    ])
    packed = json.dumps(rows)
    assert 'PRIVATE' not in packed
    assert rows[0] == {'id': 1, 't': 1001.0, 'kind': 'packet_submit',
                       'trajectory_id': 'trajectory_1', 'waypoint_count': 3, 'cadence_hz': 10}
    assert rows[1] == {'id': 2, 't': 1002.0, 'kind': 'packet_error', 'reported_progress': 2,
                       'stage': 'gateway', 'status': 'rejected',
                       'code': 'left_tip_outside_workspace'}


def test_measured_feedback_and_waypoint_vectors_are_bounded_numbers():
    rows = project_motion([
        event(1, 'observation', step_id=4, left_joints_deg=[1.5, 2, 3, 4, 5, 6, 7, 8],
              right_joints_deg=[-1, -2, -3, -4, -5, -6], left_gripper=0.25,
              right_gripper=float('nan')),
        event(2, 'packet_ready', first=list(range(40)), last=['PRIVATE', 2]),
        event(3, 'packet_completed', trajectory_id='t1', waypoint_count=2,
              feedback={'left_joints_deg': [9, 8, 7, 6, 5, 4], 'left_gripper': 1.0,
                        'secret': 'PRIVATE_FEEDBACK'}),
    ])
    assert rows[0]['left_joints_deg'] == [1.5, 2, 3, 4, 5, 6]
    assert rows[0]['left_gripper'] == 0.25
    # A nonfinite reading is absent, never a fabricated zero.
    assert 'right_gripper' not in rows[0]
    assert len(rows[1]['first']) == 16
    # One non-numeric member rejects the whole vector rather than inventing a gap.
    assert 'last' not in rows[1]
    assert rows[2]['feedback'] == {'left_joints_deg': [9, 8, 7, 6, 5, 4], 'left_gripper': 1.0}
    assert 'PRIVATE_FEEDBACK' not in json.dumps(rows)


def test_waypoint_progress_folds_to_one_advancing_row_per_trajectory():
    journal = [event(1, 'packet_submit', trajectory_id='t1', waypoint_count=120)]
    journal += [event(index, 'packet_progress', trajectory_id='t1',
                      progress_count=index - 1, waypoint_count=120)
                for index in range(2, 122)]
    journal.append(event(200, 'packet_progress', trajectory_id='t2',
                         progress_count=1, waypoint_count=5))
    rows = project_motion(journal)
    progress = [row for row in rows if row['kind'] == 'packet_progress']
    assert len(progress) == 2
    advanced = next(row for row in progress if row['trajectory_id'] == 't1')
    assert advanced['progress_count'] == 120
    # The submit row keeps its place; the advancing row does not jump to the end.
    assert rows[0]['kind'] == 'packet_submit'
    assert rows.index(advanced) == 1


def test_projection_is_bounded_and_keeps_the_most_recent_window():
    journal = [event(index, 'observation', step_id=index) for index in range(1, 600)]
    rows = project_motion(journal)
    assert len(rows) == MAX_ROWS
    assert rows[-1]['step_id'] == 599


@pytest.mark.parametrize('row', [
    None, 'packet_submit', {}, {'kind': 'packet_submit'},
    {'id': 1, 'kind': 'packet_submit'},
    {'id': True, 'timestamp': 1.0, 'kind': 'packet_submit'},
    {'id': 1, 'timestamp': 0, 'kind': 'packet_submit'},
    {'id': 1, 'timestamp': float('inf'), 'kind': 'packet_submit'},
    {'id': -1, 'timestamp': 1.0, 'kind': 'packet_submit'},
])
def test_malformed_records_are_dropped_rather_than_repaired(row):
    assert project_motion_event(row) is None


def test_tokens_and_identifiers_are_bounded():
    row = project_motion_event(event(1, 'policy_timing', stage='x' * 80,
                                     state='completed', duration_s=0.5,
                                     trajectory_id='y' * 200))
    assert 'stage' not in row
    assert 'trajectory_id' not in row
    assert row['state'] == 'completed'
    assert row['duration_s'] == 0.5


def test_non_sequence_input_is_survivable():
    for value in (None, 'events', 42, {'events': []}):
        assert project_motion(value) == []
