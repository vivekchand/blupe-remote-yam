"""Explicit public projection of robot motion; never publish model or wire text.

The conversation projection in :mod:`remote_yam.public_conversation` stays behind
its per-run sharing consent. Motion is a separate, narrower channel: what the
station's arms were asked to do and what they reported back. Every published
field here is a number, a bounded token, or a timestamp. No free-form message,
model note, prompt, response, tool argument or wire payload crosses this line,
so a run that never consented to publishing its conversation still contributes
its movement timeline without leaking what it was asked to do.
"""
import math
import re

# Motion lifecycle, measured feedback and stage timing. Conversation kinds
# (model_request/model_response/model_progress/steering_*) are deliberately
# absent: those stay behind the sharing consent. So are http_exchange and
# http_connect, which carry provider wire payloads.
MOTION_KINDS = frozenset({
    'packet_ready', 'packet_submit', 'packet_dispatched', 'packet_accepted',
    'packet_progress', 'packet_completed', 'packet_error',
    'execution_timing', 'step_timing', 'observation',
    'tool_result', 'tool_error',
    'policy_timing', 'model_timing', 'ik_replay',
    'observation_refreshed', 'observation_retry', 'observation_failure',
    'observation_recovered', 'worker_recovery',
    'stop_requested', 'stopped', 'policy_complete', 'home_scene',
    'feedback_check', 'feedback_timeout', 'reconnecting',
})

# One advancing row per trajectory, matching the local journal's own compaction:
# a 10 Hz waypoint stream becomes a live counter rather than hundreds of rows.
ADVANCING_KINDS = frozenset({'packet_progress'})

COUNTS = ('step_id', 'progress_count', 'waypoint_count', 'cadence_hz', 'steps',
          'reported_progress', 'step')
DURATIONS = ('elapsed_s', 'duration_s', 'total_s', 'started_at')
TOKENS = ('stage', 'state', 'status', 'code', 'progress_type', 'reason_code')
ARMS = ('left', 'right')

TOKEN = re.compile(r'[A-Za-z0-9_.:-]{1,64}\Z')
TRAJECTORY = re.compile(r'[A-Za-z0-9_.:-]{1,160}\Z')
MAX_ROWS = 200
MAX_WAYPOINT_VALUES = 16


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) else None


def _count(value):
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 0 <= value <= 1_000_000_000 else None


def _token(value):
    if not isinstance(value, str) or not TOKEN.fullmatch(value):
        return None
    return value


def _waypoint(value):
    """A waypoint is a bounded vector of finite numbers; nothing else travels."""
    if not isinstance(value, (list, tuple)):
        return None
    numbers = [_finite(item) for item in value[:MAX_WAYPOINT_VALUES]]
    return numbers if numbers and all(item is not None for item in numbers) else None


def _joints(source, row):
    """Copy measured arm feedback, in the journal's own units and order."""
    for arm in ARMS:
        joints = source.get(arm + '_joints_deg')
        if isinstance(joints, (list, tuple)):
            values = [_finite(item) for item in joints[:6]]
            if any(item is not None for item in values):
                row[arm + '_joints_deg'] = values
        gripper = _finite(source.get(arm + '_gripper'))
        if gripper is not None:
            row[arm + '_gripper'] = gripper


def project_motion_event(event):
    """Return one bounded public row, or None when the kind is not published."""
    if not isinstance(event, dict):
        return None
    kind = event.get('kind')
    if kind not in MOTION_KINDS:
        return None
    identity = event.get('id')
    timestamp = _finite(event.get('timestamp'))
    if not isinstance(identity, int) or isinstance(identity, bool) or identity < 0:
        return None
    if timestamp is None or timestamp <= 0:
        return None
    details = event.get('details')
    details = details if isinstance(details, dict) else {}
    row = {'id': identity, 't': timestamp, 'kind': kind}

    trajectory = details.get('trajectory_id')
    if isinstance(trajectory, str) and TRAJECTORY.fullmatch(trajectory):
        row['trajectory_id'] = trajectory
    for name in COUNTS:
        value = _count(details.get(name))
        if value is not None:
            row[name] = value
    for name in DURATIONS:
        value = _finite(details.get(name))
        if value is not None:
            row[name] = value
    for name in TOKENS:
        value = _token(details.get(name))
        if value is not None:
            row[name] = value
    for name in ('first', 'last'):
        value = _waypoint(details.get(name))
        if value is not None:
            row[name] = value
    _joints(details, row)
    feedback = details.get('feedback')
    if isinstance(feedback, dict):
        measured = {}
        _joints(feedback, measured)
        if measured:
            row['feedback'] = measured
    return row


def project_motion(events, *, limit=MAX_ROWS):
    """Project a journal's events into the bounded public motion timeline."""
    if not isinstance(events, (list, tuple)):
        return []
    rows, advancing = [], {}
    for event in events:
        row = project_motion_event(event)
        if row is None:
            continue
        if row['kind'] in ADVANCING_KINDS:
            key = (row['kind'], row.get('trajectory_id'))
            previous = advancing.get(key)
            if previous is not None:
                rows[previous] = row
                continue
            advancing[key] = len(rows)
        rows.append(row)
    return rows[-limit:]
