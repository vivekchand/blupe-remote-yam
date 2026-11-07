"""Typed host rejection metadata never launches a provider or robot."""
import asyncio
import copy
import hashlib
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import playground


def admission():
    return dict(schema='clawmetry.intent_guard.v1', version=1, decision='reject', mode='block',
        outcome='intent_violation', reason_code='forbidden_color_requested',
        scope='explicit_color_intent', physical_permission_granted=False,
        summary='The saved rule forbids picking red objects.', config_hash='a'*64,
        task_hash=hashlib.sha256(b'Pick up the red block').hexdigest(),
        forbidden_colors=['red'], requested_colors=['red'], blocked_colors=['red'])


def response(error):
    class Boundary(playground.HostedRunner):
        async def http(self, scope, receive, send):
            raise error

        async def json(self, send, status, payload):
            await send({'status':status,'payload':payload})
    # No native runner construction, session, model, camera or control I/O.
    app=object.__new__(Boundary)
    result=[]
    async def send(message):result.append(message)
    asyncio.run(app({'type':'http'},None,send))
    return result[0]


def test_optional_trusted_admission_is_projected_and_copied_at_request_error_boundary():
    raw={**admission(),'api_key':'PRIVATE','task':'PRIVATE','targets':{'left':[1,2,3]}}
    error=playground.RequestError(409,'Blocked before model',guard_admission=raw)
    raw['forbidden_colors'].append('yellow')
    result=response(error)
    assert result['status']==409
    assert result['payload']=={'error':'Blocked before model','guard_admission':admission()}
    assert 'PRIVATE' not in str(result)


@pytest.mark.parametrize('field,value',[
    ('schema','forged'),('version',True),('decision','continue'),('mode','monitor'),
    ('physical_permission_granted',True),('config_hash','bad'),('task_hash','bad'),
    ('forbidden_colors',[]),('requested_colors',['purple']),('blocked_colors',[]),
    ('forbidden_colors',['red','red']),('outcome','unknown'),('summary',['untrusted']),
    ('reason_code','arbitrary'),('scope','physical_permission')])
def test_malformed_admission_is_omitted_without_changing_native_error(field,value):
    raw=copy.deepcopy(admission());raw[field]=value
    assert response(playground.RequestError(409,'Denied',guard_admission=raw))['payload']=={'error':'Denied'}


def test_legacy_error_and_subscription_setup_shape_is_unchanged():
    assert response(playground.RequestError(400,'Invalid choice'))['payload']=={'error':'Invalid choice'}
    assert response(playground.RequestError(409,'Login needed',setup={'state':'login_required'}))['payload']=={
        'error':'Login needed','subscription_setup':{'state':'login_required'}}


def test_clarification_metadata_has_no_invented_positive_color_request():
    raw=admission();raw.update(outcome='intent_uncertain',reason_code='color_intent_needs_clarification',
        requested_colors=[],blocked_colors=[])
    assert response(playground.RequestError(409,'Clarify',guard_admission=raw))['payload']['guard_admission']==raw
