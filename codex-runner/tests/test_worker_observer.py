"""Controlled fixtures; no external model or robot calls."""
import json
import sys
import pytest
from remote_yam.worker_observer import WorkerObserver
from remote_yam.dream_policy import DreamWorker


def extension(tmp_path, code):
    path = tmp_path / 'extension.py'
    path.write_text(code)
    return path


def test_disabled_missing_and_failed_import_preserve_native_execution(tmp_path):
    assert WorkerObserver().drain() is None
    for path in (tmp_path/'missing.py', extension(tmp_path, "raise RuntimeError('secret-import-text')")):
        bridge = WorkerObserver(path)
        with bridge.prediction({'call_id': 'a'}): native = object()
        assert native is not None
        assert bridge.drain() == {'state': 'unavailable'}


@pytest.mark.parametrize('phase', ['install', 'enter', 'exit', 'drain', 'close'])
@pytest.mark.parametrize('exception', ['ValueError', 'SystemExit', 'KeyboardInterrupt'])
def test_extension_failures_cannot_replace_native_value_or_exception(tmp_path, phase, exception):
    path = extension(tmp_path, '''
from contextlib import contextmanager
class Observer:
    def install(self, client, *, source_trace=None):
        if PHASE == 'install': raise ValueError('secret')
    @contextmanager
    def prediction(self, context):
        if PHASE == 'enter': raise ValueError('secret')
        try: yield
        finally:
            if PHASE == 'exit': raise ValueError('secret')
    def drain(self):
        if PHASE == 'drain': raise ValueError('secret')
        return {'pending': 0}
    def close(self):
        if PHASE == 'close': raise ValueError('secret')
def create_observer(*, context_path): return Observer()
'''.replace('PHASE', repr(phase)).replace('ValueError', exception))
    bridge = WorkerObserver(path)
    bridge.install(object())
    native_error = RuntimeError('native error')
    with pytest.raises(RuntimeError) as caught:
        with bridge.prediction({'call_id': 'a'}): raise native_error
    assert caught.value is native_error
    with bridge.prediction({}): result = 'exact-native-result'
    assert result == 'exact-native-result'
    assert 'secret' not in json.dumps(bridge.drain())
    bridge.close()


def test_extension_cannot_suppress_native_exception(tmp_path):
    path = extension(tmp_path, '''
class CM:
    def __enter__(self): pass
    def __exit__(self, *args): return True
class Observer:
    def prediction(self, context): return CM()
def create_observer(*, context_path): return Observer()
''')
    with pytest.raises(KeyError, match='native'):
        with WorkerObserver(path).prediction({}): raise KeyError('native')


@pytest.mark.parametrize('value', ["{'artifacts': [{}]*65}", "{'payload': 'x'*32769}",
    "{'timing': float('nan')}", "{'deep': [[[[[[[[[[]]]]]]]]]]}", "['not-an-object']"])
def test_metadata_is_bounded_not_a_payload_transport(tmp_path, value):
    path = extension(tmp_path, f'''
class Observer:
    def drain(self): return {value}
def create_observer(*, context_path): return Observer()
''')
    assert WorkerObserver(path).drain() == {'state': 'unavailable'}


def controlled_sdk(tmp_path, version='1.0.0'):
    sdk=tmp_path/'sdk'; sdk.mkdir()
    (sdk/'dream.py').write_text(f'''
__version__={version!r}
class DreamProtocolError(RuntimeError): pass
class DreamClient:
    last_timing={{'rtt_ms':1}}
    def policy(self, config): assert config['_record'] is False
    def close(self): pass
    def reset_episode(self): pass
    def set_observation(self, *args, **kwargs): pass
    def get_action(self, commanded=None):
        if commanded == 'fail': raise DreamProtocolError('private-wire-error')
        return {{'q_l_chunk':[[0]*7]*2, 'q_r_chunk':[[0]*7]*2}}
''')
    return sdk


@pytest.mark.parametrize('failure', [False, True])
def test_real_worker_ipc_preserves_context_action_and_native_error(tmp_path, monkeypatch, failure):
    monkeypatch.setenv('PYTHONPATH', str(controlled_sdk(tmp_path)))
    path=extension(tmp_path, '''
from contextlib import contextmanager
print('observer import log')
class Observer:
    context=None
    def install(self, client, *, source_trace=None):
        print('observer install log')
        assert source_trace is not None
    @contextmanager
    def prediction(self, context):
        self.context=context
        print('observer enter log')
        try: yield
        finally: print('observer exit log')
    def drain(self):
        print('observer drain log')
        return {'pending':0, 'call_id': (self.context or {}).get('call_id')}
    def close(self): pass
def create_observer(*, context_path):
    assert context_path.endswith('private-config.json')
    return Observer()
''')
    worker=DreamWorker(sys.executable, tmp_path/'credentials-never-read', tmp_path/'worker',
        observer_module=path, observer_context_path=tmp_path/'private-config.json')
    try:
        assert worker.call('configure', checkpoint='dreamlabs/dream-1-beta')['ok']
        reply=worker.call('predict', ticks=[], first_step_id=0, commanded='fail' if failure else None,
                          observer_context={'call_id':'a'*32, 'episode_id':'ep_fixture'})
        assert reply['observer']=={'pending':0, 'call_id':'a'*32}
        if failure:
            assert reply['ok'] is False and reply['error_type']=='DreamProtocolError'
            assert 'private-wire-error' not in json.dumps(reply)
        else: assert reply['result']['action']['q_l_chunk']==[[0]*7]*2
        assert worker.call('reset')['observer']['call_id']=='a'*32
    finally: worker.close()


def test_pin_validation_precedes_observer_loading_and_environment_default_off(tmp_path, monkeypatch):
    monkeypatch.setenv('PYTHONPATH',str(controlled_sdk(tmp_path,'unexpected')))
    marker=tmp_path/'loaded'
    path=extension(tmp_path, f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
    monkeypatch.setenv('YAM_WORKER_OBSERVER_MODULE',str(path))
    for options in ({}, {'observer_module':path}):
        worker=DreamWorker(sys.executable,tmp_path/'no-credentials',tmp_path/'worker',**options)
        try:
            reply=worker.call('configure',checkpoint='dreamlabs/dream-1-beta')
            assert reply['ok'] is False and not marker.exists()
        finally: worker.close()


def test_null_factory_is_unavailable_not_a_ready_observer(tmp_path):
    path=extension(tmp_path,'def create_observer(*, context_path): return None')
    bridge=WorkerObserver(path)
    bridge.install(object())
    with bridge.prediction({}): native_result='native'
    assert native_result=='native'
    assert bridge.drain()=={'state':'unavailable'}


@pytest.mark.parametrize('exception',['SystemExit','KeyboardInterrupt'])
def test_extension_import_base_exception_is_unavailable(tmp_path,exception):
    path=extension(tmp_path,f"raise {exception}('private-extension-text')")
    assert WorkerObserver(path).drain()=={'state':'unavailable'}
