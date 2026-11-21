"""Fixed-profile preparation/recovery with inert workers, no model or robot."""
import copy
import json
import sys
import threading
from types import SimpleNamespace

import pytest

from remote_yam.dream_policy import MODELS
from remote_yam.dream_worker_pool import DreamWorkerPool

PROFILE={'binding':{'fingerprint':'a'*64,'robot_id':'fixture'},
         'urdfs':{'left':'<robot name="left"/>','right':'<robot name="right"/>'}}


class Worker:
    instances=[]
    mutate=False

    def __init__(self,*args):
        self.closed=False;self.commands=[]
        self.process=SimpleNamespace(poll=lambda:0 if self.closed else None)
        self.instances.append(self)

    def call(self,command,**payload):
        saved={key:copy.deepcopy(value) for key,value in payload.items() if key!='cancelled'}
        self.commands.append((command,saved))
        if self.mutate and payload.get('kinematics'):
            payload['kinematics']['binding']['fingerprint']='f'*64
        return {'ok':True,'result':{'fully_ready':True,'observer_cleanup_ok':True}}

    def close(self):self.closed=True


@pytest.fixture
def factory(tmp_path):
    credentials=tmp_path/'credential-fixture';credentials.write_text('inert')
    pools=[];Worker.instances=[];Worker.mutate=False
    def create(**options):
        pool=DreamWorkerPool(sys.executable,credentials,tmp_path/'work',worker_factory=Worker,
            recovery_delays=(.01,),prime_timeout=1,**options)
        pools.append(pool)
        return pool,credentials
    yield create
    for pool in pools:pool.close()


def test_prime_and_owner_recovery_retain_the_same_fixed_profile(factory,tmp_path):
    profile=copy.deepcopy(PROFILE)
    pool,credentials=factory(kinematics=profile)
    profile['binding']['fingerprint']='b'*64
    pool.prime(timeout=1)
    first=Worker.instances[-1]
    assert first.commands[0][0]=='prime'
    assert first.commands[0][1]['kinematics']==PROFILE
    handle=pool.factory(sys.executable,credentials,tmp_path/'visitor')
    assert handle.call('configure',checkpoint=MODELS['dream'][0],kinematics=copy.deepcopy(PROFILE))['ok']
    pool._discard(recover=False)
    assert handle.recover(checkpoint=MODELS['dream'][0]) is None
    replacement=Worker.instances[-1]
    assert first.closed and replacement is not first
    assert [name for name,_ in replacement.commands]==['prime','release','configure']
    assert replacement.commands[0][1]['kinematics']==PROFILE
    assert replacement.commands[2][1]['kinematics']==PROFILE
    handle.close()


def test_worker_payload_mutation_cannot_change_a_later_preparation(factory):
    pool,_=factory(kinematics=PROFILE);Worker.mutate=True
    pool.prime(timeout=1)
    pool._discard(recover=False)
    pool._restore(None,None)
    assert all(worker.commands[0][1]['kinematics']==PROFILE for worker in Worker.instances)


def test_default_profile_keeps_existing_prime_and_recovery_wire_commands(factory):
    pool,_=factory();pool.prime(timeout=1);pool._discard(recover=False);pool._restore(None,None)
    assert all('kinematics' not in payload for worker in Worker.instances for _,payload in worker.commands)


@pytest.mark.parametrize('value',[True,[],{'value':float('nan')},{'value':float('inf')},
    {'value':'x'*(256*1024)},{'value':'\u20ac'*(100*1024)}, {'value':object()}])
def test_invalid_profile_is_rejected_before_threads_or_workers(tmp_path,monkeypatch,value):
    monkeypatch.setattr(threading.Thread,'start',lambda *a:pytest.fail('Invalid profile started a thread'))
    with pytest.raises(ValueError,match='kinematics'):
        DreamWorkerPool(sys.executable,tmp_path/'unused',tmp_path/'unused-work',worker_factory=Worker,kinematics=value)
