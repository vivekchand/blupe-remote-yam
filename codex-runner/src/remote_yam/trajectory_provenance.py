"""Private, exact local packet provenance. No transport or observation reads."""
from copy import deepcopy
import hashlib
import json
import math
from collections.abc import Mapping

from .feedback import feedback_decision
from .session import MAX_WAYPOINTS_PER_PACKET, _trajectory_waypoints

SCHEMA = 'yam.trajectory.baseline.v1'
SOURCE_KEYS = ('plan_id', 'attempt_id', 'session_id', 'episode_id', 'lease_id', 'robot_id',
               'api_origin', 'api_identity', 'first_step_id', 'cadence_hz')


class MovingMeasuredBaseline(ValueError):
    """A well-formed, safe source sample still reports ordinary execution."""


def finite(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def source_context(value):
    if not isinstance(value, Mapping) or set(value) != set(SOURCE_KEYS):
        raise ValueError('Missing packet source context')
    result = dict(value)
    for key in ('plan_id', 'attempt_id', 'session_id', 'episode_id', 'lease_id', 'robot_id'):
        if not isinstance(result[key], str) or not 1 <= len(result[key]) <= 512:
            raise ValueError('Invalid packet source context')
    origin = result['api_origin']
    if origin is not None and (not isinstance(origin, str) or len(origin) > 2048):
        raise ValueError('Invalid packet API identity')
    if (type(result['api_identity']) is not int or not 0 < result['api_identity'] < 2**128
            or type(result['first_step_id']) is not int or not 0 <= result['first_step_id'] < 2**63
            or type(result['cadence_hz']) not in (int, float) or result['cadence_hz'] not in (10, 20, 30)):
        raise ValueError('Invalid packet cursor or cadence')
    return result


def packet_digest(waypoints):
    if not isinstance(waypoints, list) or not 1 <= len(waypoints) <= MAX_WAYPOINTS_PER_PACKET:
        raise ValueError('Invalid packet')
    _trajectory_waypoints(waypoints, (6, 6))
    steps = [point.get('step_id') for point in waypoints]
    if (type(steps[0]) is not int or not 0 <= steps[0] < 2**63 or
            steps[0] + len(steps) >= 2**63 or
            any(type(step) is not int or step != steps[0] + i for i, step in enumerate(steps))):
        raise ValueError('Invalid packet cursor')
    return hashlib.sha256(json.dumps(waypoints, sort_keys=True, separators=(',', ':'),
                                    allow_nan=False).encode()).hexdigest()


def measured_baseline(value, robot_id, *, now=None):
    """Copy only raw station fields, never a model state or fabricated clock."""
    if (not isinstance(value, Mapping) or value.get('jetson_id') != robot_id
            or value.get('robot_id', robot_id) != robot_id or value.get('source') != 'hardware'
            or not finite(value.get('observed_at'))):
        raise ValueError('Invalid packet measured source')
    if ((value.get('homed') is not None and type(value['homed']) is not bool)
            or (value.get('mode') is not None and
                (not isinstance(value['mode'], str) or len(value['mode']) > 64))):
        raise ValueError('Invalid packet measured status')
    result = {key: deepcopy(value[key]) for key in
              ('jetson_id', 'robot_id', 'source', 'observed_at', 'settled', 'homed', 'mode') if key in value}
    safety = value.get('safety')
    if (not isinstance(safety, Mapping) or safety.get('active_contacts') not in (None, 0, [])
            or safety.get('contact_count') not in (None, 0)):
        raise ValueError('Missing measured safety feedback')
    result['safety'] = {key: deepcopy(safety[key]) for key in
                        ('ok', 'estop_engaged', 'contact_count') if key in safety}
    for side in ('left', 'right'):
        joints, grip = value.get(side+'_joints_deg'), value.get(side+'_gripper')
        if (not isinstance(joints, (list, tuple)) or len(joints) != 6
                or not all(finite(number) for number in joints) or not finite(grip) or not 0 <= grip <= 1):
            raise ValueError('Invalid measured joint or gripper feedback')
        result[side+'_joints_deg'], result[side+'_gripper'] = list(joints), grip
    if value.get('settled') is not True or value.get('mode') in ('EXECUTING', 'HOMING'):
        if (value.get('settled') is False and value.get('mode') in ('EXECUTING', 'API_ACTIVE')
                and safety.get('ok') is True and safety.get('estop_engaged') is False
                and now is not None and finite(now) and -2 <= now-result['observed_at'] <= 5):
            raise MovingMeasuredBaseline('Packet measured source is still moving')
        raise ValueError('Invalid packet measured source')
    if now is not None:
        if (not finite(now) or not -2 <= now-result['observed_at'] <= 5
                or feedback_decision(result, result, now=now)[0] != 'ready'):
            raise ValueError('Packet measured baseline is unavailable or stale')
    return result


def make_receipt(waypoints, observation, context, generation):
    context = source_context(context)
    if type(generation) is not int or not 0 <= generation < 2**63:
        raise ValueError('Invalid capture generation')
    digest = packet_digest(waypoints)
    if waypoints[0]['step_id'] != context['first_step_id']:
        raise ValueError('Packet cursor differs from planning source')
    result = dict(schema=SCHEMA, packet_sha256=digest, source=context, generation=generation,
        first_step_id=waypoints[0]['step_id'], last_step_id=waypoints[-1]['step_id'],
        waypoint_count=len(waypoints), cadence_hz=context['cadence_hz'],
        observation=measured_baseline(observation, context['robot_id']))
    result['receipt_sha256'] = receipt_digest(result)
    return result


def receipt_digest(value):
    return hashlib.sha256(json.dumps({key: item for key, item in value.items() if key != 'receipt_sha256'},
        sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def validate_receipt(receipt, waypoints, context, *, now, planning_observed_at):
    context = source_context(context)
    digest = packet_digest(waypoints)
    if not isinstance(receipt, dict):
        raise ValueError('Missing packet baseline receipt')
    baseline = measured_baseline(receipt.get('observation'), context['robot_id'], now=now)
    if receipt['observation'] != baseline:
        raise ValueError('Packet baseline is not a bounded raw observation')
    if (not isinstance(receipt, dict) or set(receipt) != {'schema', 'packet_sha256', 'source',
            'generation', 'first_step_id', 'last_step_id', 'waypoint_count', 'cadence_hz', 'observation', 'receipt_sha256'}
            or receipt.get('schema') != SCHEMA or source_context(receipt.get('source')) != context
            or type(receipt.get('generation')) is not int or not 0 <= receipt['generation'] < 2**63
            or type(receipt.get('first_step_id')) is not int or receipt['first_step_id'] != context['first_step_id']
            or type(receipt.get('last_step_id')) is not int or receipt['last_step_id'] != waypoints[-1]['step_id']
            or type(receipt.get('waypoint_count')) is not int or receipt['waypoint_count'] != len(waypoints)
            or type(receipt.get('cadence_hz')) not in (int, float) or receipt['cadence_hz'] != context['cadence_hz']
            or receipt.get('packet_sha256') != digest or receipt.get('receipt_sha256') != receipt_digest(receipt)):
        raise ValueError('Packet baseline identity changed')
    if not finite(planning_observed_at) or baseline['observed_at'] < planning_observed_at:
        raise ValueError('Packet baseline clock regressed')
    return baseline
