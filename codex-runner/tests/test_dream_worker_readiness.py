"""Actual JSON-lines worker startup with an inert SDK; no robot or model API."""
import sys

import pytest

from remote_yam.dream_policy import DreamWorker
from test_dream_policy import Worker, adapter
from test_dream_worker_pool import resident, rows, wait_for


@pytest.fixture
def startup_sdk(resident, tmp_path):
    pool, credentials, trace, *_ = resident
    module=tmp_path/'sdk/dream.py'
    source=module.read_text()
    needle="    log('prepared-variant',variant='independent' if args[-2] is None else 'coupled')"
    source=source.replace(needle,needle+'''
    if args[-2] is not None:
        hold=os.environ.get('TEST_PREPARATION_HOLD')
        while hold and Path(hold).exists():time.sleep(.01)
        if os.environ.get('TEST_PREPARATION_FAIL')=='yes':raise RuntimeError('synthetic warmup failure')
''')
    module.write_text(source)
    return pool, credentials, trace


@pytest.mark.parametrize('pooled',[False,True])
@pytest.mark.parametrize('hz',[20,30])
def test_configuration_acknowledges_both_forms_before_prediction(startup_sdk,tmp_path,pooled,hz):
    pool,credentials,trace=startup_sdk
    before=len(rows(trace))
    worker=(pool.factory(sys.executable,credentials,tmp_path/'visitor') if pooled else
            DreamWorker(sys.executable,credentials,tmp_path/'raw'))
    try:
        reply=worker.call('configure',checkpoint='dreamlabs/dream-1-beta',action_hz=hz,fully_prepare=True)
        assert reply['ok'] and reply['result']['fully_ready'] is True
        assert reply['result']['trajectory_variants']==['independent','coupled']
        assert reply['result']['prepared_reused'] is pooled
        events=rows(trace)[before:]
        assert not any(e['kind']=='predict-start' for e in events)
        if not pooled or hz==30:
            assert [e['variant'] for e in events if e['kind']=='prepared-variant'][-2:]==['independent','coupled']
            assert any(e['stage']=='sdk_full_preparation' and e['status']=='ok' for e in reply['stage_timings'])
    finally:worker.close()


@pytest.mark.parametrize('cancel',[False,True])
def test_adapter_cannot_report_ready_while_coupled_warmup_is_pending(startup_sdk,tmp_path,monkeypatch,cancel):
    _,credentials,trace=startup_sdk
    hold=tmp_path/'hold-preparation';hold.touch()
    monkeypatch.setenv('TEST_PREPARATION_HOLD',str(hold))
    provider=adapter(tmp_path/'adapter')
    provider.python=sys.executable;provider.credentials=credentials;provider.worker_factory=DreamWorker
    events=[];provider.interaction_sink=lambda kind,message,**d:events.append((kind,message,d))
    before=len(rows(trace))
    try:
        provider.start_preparation(lambda:False)
        wait_for(lambda:any(e['kind']=='prepared-variant' and e['variant']=='coupled' for e in rows(trace)[before:]))
        assert not provider._ready.is_set()
        assert not any(e['kind']=='predict-start' for e in rows(trace)[before:])
        if cancel:
            provider.close_transport();provider._preparation.join(3)
            assert not provider._ready.is_set() and provider._worker.process.poll() is not None
        else:
            hold.unlink();provider.wait_ready(lambda:False)
            assert provider._ready.is_set()
            assert any(kind=='policy_timing' and d.get('stage')=='sdk_full_preparation' for kind,_,d in events)
        assert any(kind=='model_progress' and 'preparing trajectory solvers' in message for kind,message,_ in events)
    finally:
        hold.unlink(missing_ok=True);provider.close_transport()


def test_failed_coupled_warmup_does_not_acknowledge_readiness(startup_sdk,tmp_path,monkeypatch):
    _,credentials,trace=startup_sdk
    monkeypatch.setenv('TEST_PREPARATION_FAIL','yes')
    worker=DreamWorker(sys.executable,credentials,tmp_path/'failed')
    before=len(rows(trace))
    try:
        reply=worker.call('configure',checkpoint='dreamlabs/dream-1-beta',fully_prepare=True)
        assert reply['ok'] is False and reply['phase']=='configure'
        assert not reply.get('result',{}).get('fully_ready')
        assert any(e['stage']=='sdk_full_preparation' and e['status']=='error' for e in reply['stage_timings'])
        assert not any(e['kind']=='predict-start' for e in rows(trace)[before:])
    finally:worker.close()


@pytest.mark.parametrize('receipt',[None,{}, {'fully_ready':1,'trajectory_variants':['independent','coupled']},
    {'fully_ready':True,'trajectory_variants':['independent']},
    {'fully_ready':True,'trajectory_variants':['coupled','independent']}])
def test_adapter_requires_explicit_complete_readiness_receipt(tmp_path,receipt):
    instances=[]
    class OldWorker(Worker):
        def __init__(self,*args):super().__init__();instances.append(self)
        def call(self,command,**kwargs):
            self.calls.append((command,kwargs))
            return {'ok':True,'result':receipt}
    provider=adapter(tmp_path);provider.worker_factory=OldWorker
    try:
        provider.start_preparation(lambda:False)
        with pytest.raises(RuntimeError,match='not fully prepared'):provider.wait_ready(lambda:False)
        assert not provider._ready.is_set()
        assert instances[0].calls[0][1]['fully_prepare'] is True
        assert [c for c,_ in instances[0].calls]==['configure']
    finally:provider.close_transport()
