"""Inert SDK preparation must complete before any robot session is created."""
import threading
import time

import pytest

from remote_yam.controller import RunnerController
from remote_yam.session import MockSessionAPI
from test_dream_policy import Worker, adapter


def wait_for(check):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(.01)
    assert check()


def fixture(tmp_path, *, result=None, api_factory=MockSessionAPI):
    entered, release = threading.Event(), threading.Event()
    class PreparingWorker(Worker):
        def call(self, command, **kwargs):
            if command == 'configure':
                self.calls.append((command, kwargs))
                entered.set()
                while not release.wait(.01):
                    if kwargs['cancelled']():
                        raise RuntimeError('Synthetic preparation cancelled')
                return result or {'ok': True, 'result': {'fully_ready': True,
                    'trajectory_variants': ['independent', 'coupled']}}
            raise AssertionError('No prediction, capture or robot IO in this fixture')
    policy = adapter(tmp_path, prepare_before_queue=True,
                     worker_pool=threading.BoundedSemaphore(1))
    policy.worker_factory = PreparingWorker
    api = api_factory(auto_activate=False)
    controller = RunnerController(api, share_conversation=False)
    return controller, policy, api, entered, release


def cleanup(controller, policy, release):
    release.set()
    controller.stop()
    policy.close_transport()
    if controller._worker:
        controller._worker.join(3)


def test_sdk_preparation_does_not_create_a_session_or_start_the_motion_clock(tmp_path):
    controller, policy, api, entered, release = fixture(tmp_path)
    try:
        controller.join_and_run(policy, 'Inert preparation fixture', run_duration_s=300)
        assert entered.wait(1)
        state = controller.status()
        assert state['status'] == 'preparing' and state['session_id'] is None
        assert state['run_started_at'] is None and state['run_duration_s'] == 300
        assert not api.create_requests and policy._collector is None
        command, options = policy._worker.calls[0]
        assert command == 'configure' and options['timeout'] == 360
        assert options['fully_prepare'] is True
        release.set()
        wait_for(lambda: bool(api.create_requests))
        assert controller.status()['status'] == 'queued'
        assert controller.status()['run_duration_s'] == 300
        assert policy._collector is None and not api.action_log and not api.trajectory_log
    finally:
        cleanup(controller, policy, release)


@pytest.mark.parametrize('cancel', ['stop', 'disconnect'])
def test_cancel_during_preparation_creates_no_queue_and_releases_worker_slot(tmp_path, cancel):
    controller, policy, api, entered, release = fixture(tmp_path)
    try:
        controller.join_and_run(policy, 'Inert preparation fixture')
        assert entered.wait(1)
        worker = policy._worker
        getattr(controller, cancel)()
        wait_for(worker.closed.is_set)
        wait_for(lambda: not controller._worker.is_alive())
        assert not api.create_requests
        assert policy.worker_pool.acquire(blocking=False)
        policy.worker_pool.release()
        assert not api.action_log
    finally:
        cleanup(controller, policy, release)


@pytest.mark.parametrize('result', [
    {'ok': False, 'error_type': 'SyntheticSDKError'},
    {'ok': True, 'result': {'fully_ready': False}},
    {'ok': True, 'result': {'fully_ready': True, 'trajectory_variants': ['independent']}},
])
def test_failed_or_incomplete_preparation_never_joins_queue(tmp_path, result):
    controller, policy, api, entered, release = fixture(tmp_path, result=result)
    try:
        controller.join_and_run(policy, 'Inert preparation fixture')
        assert entered.wait(1)
        worker = policy._worker
        release.set()
        wait_for(lambda: controller.status()['status'] == 'failed')
        wait_for(worker.closed.is_set)
        assert not api.create_requests and not api.action_log
        assert policy.worker_pool.acquire(blocking=False)
        policy.worker_pool.release()
    finally:
        cleanup(controller, policy, release)


@pytest.mark.parametrize('failure', ['queue', 'calibration', 'events', 'stop_during_events', 'disconnect_during_events',
    'stop_during_calibration', 'disconnect_during_calibration', 'replacement_during_calibration'])
def test_admission_failure_after_preparation_cleans_only_its_owned_session(tmp_path, failure):
    class API(MockSessionAPI):
        def create_session(self, *args, **kwargs):
            if failure == 'queue':
                raise RuntimeError('Synthetic queue refusal')
            return super().create_session(*args, **kwargs)
        def open_events(self, session_id):
            if failure == 'events':
                raise RuntimeError('Synthetic handshake failure')
            if failure in ('stop_during_events', 'disconnect_during_events'):
                getattr(controller, 'stop' if failure == 'stop_during_events' else 'disconnect')()
            self.opened = super().open_events(session_id)
            return self.opened
    controller, policy, api, entered, release = fixture(tmp_path, api_factory=API)
    try:
        controller.join_and_run(policy, 'Inert preparation fixture')
        assert entered.wait(1)
        worker = policy._worker
        if failure == 'calibration':
            def changed(*args):
                raise ValueError('Synthetic calibration changed')
            policy.configure_robot_workspace = changed
        if failure.endswith('_during_calibration'):
            def cancelled(*args):
                if failure == 'replacement_during_calibration':
                    controller._provider = adapter(tmp_path/'replacement')
                    controller._status = 'idle'
                else:
                    getattr(controller, 'stop' if failure == 'stop_during_calibration' else 'disconnect')()
            policy.configure_robot_workspace = cancelled
        release.set()
        wait_for(lambda: not controller._worker.is_alive())
        expected = {'stop_during_events':'stopped', 'disconnect_during_events':'disconnected',
            'stop_during_calibration':'stopped', 'disconnect_during_calibration':'disconnected',
            'replacement_during_calibration':'idle'}.get(failure, 'failed')
        assert controller.status()['status'] == expected
        wait_for(worker.closed.is_set)
        assert policy.worker_pool.acquire(blocking=False)
        policy.worker_pool.release()
        assert not api.action_log and not api.trajectory_log
        if failure in ('events', 'stop_during_events', 'disconnect_during_events'):
            assert len(api.create_requests) == 1
            assert all(row['status'] == 'stopped' for row in api._sessions.values())
            if failure in ('stop_during_events', 'disconnect_during_events'):
                assert api.opened._closed
        else:
            assert not api.create_requests
    finally:
        cleanup(controller, policy, release)


def test_ordinary_dream_retains_native_lease_first_preparation(tmp_path):
    policy = adapter(tmp_path, worker_pool=threading.BoundedSemaphore(1))
    try:
        assert not callable(getattr(policy, 'prepare_before_session', None))
        policy.start_preparation(lambda: False)
        assert policy._preparation is None
        policy.prepare_after_lease(lambda: False)
        assert policy._ready.wait(1)
        assert policy._worker.calls[0][1]['timeout'] == 180
    finally:
        policy.close_transport()


def test_total_preparation_budget_expires_while_waiting_for_worker_without_queue(tmp_path, monkeypatch):
    from types import SimpleNamespace
    import remote_yam.dream_policy as module
    from unittest.mock import Mock
    policy = adapter(tmp_path, prepare_before_queue=True, worker_pool=threading.Semaphore(0))
    policy.worker_factory = Mock(side_effect=AssertionError('No worker slot was granted'))
    clock = iter([0., 601., 601.])
    monkeypatch.setattr(module, 'time', SimpleNamespace(monotonic=lambda: next(clock)))
    try:
        with pytest.raises(RuntimeError, match='timed out before joining'):
            policy.prepare_before_session('Inert budget fixture')
        assert policy._stop.is_set() and policy._configure_timeout == 180
        assert not policy.worker_factory.called
        policy._preparation.join(1)
        assert not policy._preparation.is_alive()
    finally:
        policy.close_transport()


def test_stale_preparation_cannot_cancel_or_reset_replacement_home_state(tmp_path):
    from types import SimpleNamespace
    from unittest.mock import Mock
    controller = RunnerController(MockSessionAPI(auto_activate=False))
    old, replacement = adapter(tmp_path/'old'), adapter(tmp_path/'replacement')
    job = SimpleNamespace(close=Mock(), provider=replacement)
    controller._provider = replacement
    controller._status = 'preparing'
    controller._home_plan = job
    controller._home_registered = True
    try:
        with pytest.raises(RuntimeError, match='cancelled before joining'):
            controller._join_new(old, 'Stale fixture', prepared=True)
        assert controller._home_plan is job and controller._home_registered is True
        assert not job.close.called
    finally:
        old.close_transport()
        replacement.close_transport()
