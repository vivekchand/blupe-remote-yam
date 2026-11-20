"""Optional, call-local subscription telemetry. No persistence or robot access.

Trusted hosts supply a callback accepting one independent event dictionary.
They own secret redaction, private capture consent and bounded persistence.
The callback must be nonblocking. Failure disables it for this call only.
"""
from contextlib import contextmanager
import functools
import inspect
import json
import logging
import math
import time
import uuid


MAX_EVENT_BYTES = 262144
MAX_EVENT_NODES = 4096
MAX_STRING_CHARACTERS = 262144
_LOG = logging.getLogger(__name__)


def async_callback(value):
    while isinstance(value, functools.partial):
        value = value.func
    return any(inspect.iscoroutinefunction(candidate) or inspect.isasyncgenfunction(candidate)
               for candidate in (value, getattr(value, '__call__', None)))


def discard_async_result(value):
    """Never await or cancel host work; close only a returned native coroutine."""
    if not (inspect.isawaitable(value) or inspect.isasyncgen(value)):
        return False
    if inspect.iscoroutine(value):
        try:
            value.close()
        except Exception:
            pass
    return True


def check_capture_shape(value, remaining=None, depth=0):
    """Reject large shapes before the JSON encoder allocates an escaped string."""
    remaining = [MAX_EVENT_NODES] if remaining is None else remaining
    remaining[0] -= 1
    if remaining[0] < 0 or depth > 16:
        raise ValueError('capture shape limit')
    if type(value) is str:
        if len(value) > MAX_STRING_CHARACTERS:
            raise ValueError('capture string limit')
    elif type(value) is dict:
        if len(value) * 2 > remaining[0]:
            raise ValueError('capture field limit')
        for key, child in value.items():
            if type(key) is not str:
                raise ValueError('capture key type')
            check_capture_shape(key, remaining, depth + 1)
            check_capture_shape(child, remaining, depth + 1)
    elif type(value) in (list, tuple):
        if len(value) > remaining[0]:
            raise ValueError('capture item limit')
        for child in value:
            check_capture_shape(child, remaining, depth + 1)
    elif value is not None and type(value) not in (bool, int, float):
        raise ValueError('capture value type')


def probe_settings(adapter):
    """Declared configuration only, not upstream resolved model or usage."""
    result = {}
    for name in ('reasoning_effort', 'response_speed'):
        try:
            value = getattr(adapter, name, None)
            if type(value) is str and len(value) <= 128:
                result['configured_' + name] = value
        except Exception:
            pass
    try:
        timeout = getattr(adapter, '_timeout_s', None)
        if type(timeout) in (int, float) and math.isfinite(timeout) and timeout > 0:
            result['configured_timeout_s'] = timeout
    except Exception:
        pass
    return result


def probe_response(value):
    """Only returned public tool decisions, never internal reasoning or CLI data."""
    try:
        output = value.get('output') if type(value) is dict else None
        if type(output) is not list:
            return {'coverage': 'structured_decision_unavailable'}
        decisions = []
        for item in output[:16]:
            if type(item) is not dict:
                continue
            kind, name = item.get('type'), item.get('name')
            if (type(kind) is str and kind == 'reasoning'
                    or any(type(item.get(key)) is str and item[key] == 'analysis' for key in ('channel', 'role'))):
                continue
            if ((kind is None or type(kind) is str and kind == 'function_call')
                    and type(name) is str and name in ('done', 'move_to', 'give_up')):
                decisions.append({key: item[key] for key in ('type', 'name', 'arguments') if key in item})
        return {'output': decisions, 'coverage': 'structured_probe_decisions',
                'omitted_items': len(output) - len(decisions)}
    except Exception:
        return {'coverage': 'structured_decision_unavailable'}


class SubscriptionObserver:
    """One call's sink; callback receives no live adapter or native data objects."""
    def __init__(self, callback=None):
        try:
            self.callback = callback if callable(callback) and not async_callback(callback) else None
        except Exception:
            self.callback = None
        self.call_id = uuid.uuid4().hex if self.callback is not None else None
        if callback is not None and self.callback is None:
            _LOG.warning('Subscription observer must be synchronous and callable; observation is disabled')

    def emit(self, name, state, **fields):
        if self.callback is None:
            return
        # Copy before callback: a host cannot change the real request/result.
        event = dict(call_id=self.call_id, name=name, state=state, clock_domain='runner_process', wall_time_ns=str(time.time_ns()),
                     monotonic_ns=str(time.monotonic_ns()), **fields)
        try:
            check_capture_shape(event)
            chunks, size = [], 0
            for chunk in json.JSONEncoder(ensure_ascii=True, allow_nan=False).iterencode(event):
                size += len(chunk)
                if size > MAX_EVENT_BYTES:
                    raise ValueError('capture limit')
                chunks.append(chunk)
            copied = json.loads(''.join(chunks))
        except Exception:
            # Preserve the boundary, but do not present a partial payload as exact.
            copied = {key: event[key] for key in ('call_id', 'name', 'state', 'clock_domain', 'wall_time_ns', 'monotonic_ns')}
            for key in ('provider', 'model', 'error_type', 'ready', 'verified', 'result_state',
                        'connection_verified', 'transport_coverage'):
                value = event.get(key)
                if value is None or type(value) is bool or type(value) is str and len(value) <= 256:
                    copied[key] = value
            copied['capture_coverage'] = 'payload_unavailable'
        try:
            returned = self.callback(copied)
            if discard_async_result(returned):
                self.callback = None
                _LOG.warning('Subscription observer returned async work; observation is disabled for this call')
        except Exception:
            self.callback = None
            _LOG.warning('Subscription observer failed; observation is disabled for this call')
        except BaseException:
            self.callback = None
            raise

    @contextmanager
    def span(self, name, **fields):
        report = {}
        self.emit(name, 'started', **fields)
        try:
            yield report
        except BaseException as exc:
            self.emit(name, 'error', error_type=type(exc).__name__, **fields)
            raise
        else:
            self.emit(name, 'returned', **fields, **report)


def observer_for(callback):
    return callback if isinstance(callback, SubscriptionObserver) else SubscriptionObserver(callback)
