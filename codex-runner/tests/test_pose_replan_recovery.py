"""Zero-submit stale-plan recovery through the real native dispatch seam."""
import copy

import pytest

from test_trajectory_decision import hardware_decision_case


def recovery_case(callback=lambda *args: {'decision': 'allow'}):
    api, controller, provider, planning, old, _ = hardware_decision_case(callback)
    controller._command_step_id = 42
    provider.discards, provider.plans = [], []
    api.fresh['left_joints_deg'][0] = .41528
    api.fresh['images'] = {'top': {'url': '/fresh-top.jpg'}}

    def discard(points, **kwargs):
        provider.discards.append(copy.deepcopy((points, kwargs)))
        return True

    def build(prompt, observation, step):
        provider.plans.append(copy.deepcopy(observation))
        return [dict(step_id=step, left_joints_deg=[.8]+[0.]*5,
                     right_joints_deg=[0.]*6, left_gripper=1., right_gripper=.5)]

    provider.discard_unsubmitted_trajectory = discard
    provider.build_trajectory = build

    def dispatch():
        return controller._dispatch_trajectory(lambda *args: old, provider, 'Inert recovery test', planning,
            'guard-session', 'guard-episode', 'PRIVATE-LEASE', 42)

    return api, controller, provider, old, dispatch


def test_changed_pose_discards_old_packet_and_checks_a_new_plan_with_fresh_source():
    calls=[]
    api,c,p,old,dispatch=recovery_case(lambda *args:calls.append(copy.deepcopy(args)) or {'decision':'allow'})
    original=copy.deepcopy(old);dispatch()
    assert old==original and len(p.discards)==len(p.plans)==1
    points,kw=p.discards[0]
    assert points==old and kw['first_step_id']==42
    assert kw['context']['dispatched'] is False and kw['context']['executed_waypoints']==0
    assert kw['context']['reason_code']=='pre_dispatch_pose_changed'
    assert p.plans[0]['left_joints_deg'][0]==.41528
    assert p.plans[0]['images']=={'top':{'url':'/fresh-top.jpg'}}
    assert 'planning_scene' not in p.plans[0] and 'workspace_feedback' not in p.plans[0]
    assert p.plans[0]['step_id']==42 and p.plans[0]['lease_id']=='PRIVATE-LEASE'
    assert len(api.submitted)==1 and api.submitted[0]!=old
    assert calls[0][0]==api.submitted[0] and calls[0][1]['left_joints_deg'][0]==.41528
    assert len(calls)==1 and c._packets_submitted==1
    rows=c._interactions.snapshot()['events']
    recoveries=[r['details'] for r in rows if r['kind']=='plan_recovery']
    assert len(recoveries)==1 and recoveries[0]['retry_count']==1 and recoveries[0]['dispatched'] is False


def test_continuous_drift_exhausts_two_replans_without_submitting_or_weakening_gate():
    api,c,p,old,dispatch=recovery_case()
    def drift(api,stage,index):
        if stage=='robot':api.fresh['left_joints_deg'][0]+=.4
    api.hook=drift
    with pytest.raises(RuntimeError,match='recovery limit reached'):dispatch()
    assert len(p.plans)==len(p.discards)==2 and not api.submitted and c._trajectory is None
    events=[r['details'] for r in c._interactions.snapshot()['events'] if r['kind']=='plan_recovery']
    assert [r['state'] for r in events]==['replanning','replanning','exhausted']
    assert events[-1]['retry_count']==events[-1]['retry_limit']==2


@pytest.mark.parametrize('field,bad',[
    ('left_gripper',None),('right_gripper',float('nan')),('right_joints_deg',[0.]*5),
    ('right_joints_deg',[float('nan')]*6),('settled',False),('source','simulation'),
    ('robot_id','foreign'),('mode','EXECUTING'),('mode','HOMING'),('observed_at',0.),
    ('safety',{'ok':True,'estop_engaged':True}),
])
def test_drift_plus_invalid_or_unsafe_feedback_is_terminal_not_recoverable(field,bad):
    api,c,p,old,dispatch=recovery_case();api.fresh[field]=bad
    with pytest.raises(RuntimeError):dispatch()
    assert not p.plans and not p.discards and not api.submitted


@pytest.mark.parametrize('change',['stop','attempt','session','episode','lease','robot','provider','api','origin','deadline'])
def test_discard_race_cannot_start_a_new_model_or_dispatch(change):
    import time
    api,c,p,old,dispatch=recovery_case()
    original=p.discard_unsubmitted_trajectory
    def discard(*args,**kwargs):
        original(*args,**kwargs)
        if change=='stop':c._stop_event.set()
        elif change=='provider':c._provider=object()
        elif change=='api':c._session_api=object()
        elif change=='origin':api._base_url='https://foreign.invalid'
        elif change=='deadline':c._run_duration_s=1;c._run_started_at=time.time()-2
        else:setattr(c,'_'+change+'_id','replaced')
        return True
    p.discard_unsubmitted_trajectory=discard
    dispatch()
    assert len(p.discards)==1 and not p.plans and not api.submitted


def test_authoritative_session_change_after_discard_prevents_replanning():
    api,c,p,old,dispatch=recovery_case()
    def change(api,stage,index):
        if stage=='session' and index==3:api.live['active_trajectory']={}
    api.hook=change
    with pytest.raises(RuntimeError,match='Session changed'):dispatch()
    assert len(p.discards)==1 and not p.plans and not api.submitted


@pytest.mark.parametrize('answer',[False,None,{},'yes'])
def test_discard_requires_explicit_true_acknowledgement(answer):
    api,c,p,old,dispatch=recovery_case()
    p.discard_unsubmitted_trajectory=lambda *a,**k:answer
    with pytest.raises(RuntimeError,match='discard was not confirmed'):dispatch()
    assert not p.plans and not api.submitted


def test_guard_refusal_of_replanned_packet_is_never_retried():
    calls=[]
    api,c,p,old,dispatch=recovery_case(lambda *a:calls.append(1) or {'decision':'reject'})
    with pytest.raises(RuntimeError,match='refused this packet'):dispatch()
    assert len(p.plans)==len(p.discards)==len(calls)==1 and not api.submitted


def test_transport_uncertainty_is_never_replanned():
    api,c,p,old,dispatch=recovery_case();c._submit_attempts=1
    def unavailable(*a):raise RuntimeError('unknown transport outcome')
    api.submit_trajectory=unavailable
    with pytest.raises(RuntimeError,match='unknown transport outcome'):dispatch()
    assert len(p.plans)==len(p.discards)==1


@pytest.mark.parametrize('change',['attempt','robot','api','origin'])
def test_recursive_entry_cannot_adopt_a_new_source_between_last_check_and_new_call(change):
    api,c,p,old,dispatch=recovery_case()
    original=c._dispatch_trajectory
    def enter(*args,**kwargs):
        if kwargs.get('_pose_replans'):
            if change=='api':c._session_api=object()
            elif change=='origin':api._base_url='https://foreign.invalid'
            else:setattr(c,'_'+change+'_id','replaced')
        return original(*args,**kwargs)
    c._dispatch_trajectory=enter
    dispatch()
    assert len(p.discards)==1 and not p.plans and not api.submitted


def test_no_drift_does_not_trigger_recovery_or_a_second_plan():
    api,c,p,old,dispatch=recovery_case();api.fresh['left_joints_deg'][0]=.25
    dispatch()
    assert api.submitted==[old] and not p.discards and not p.plans


@pytest.mark.parametrize('change',['cursor','active'])
def test_recursive_entry_rechecks_local_cursor_and_active_packet_before_model(change):
    api,c,p,old,dispatch=recovery_case();original=c._dispatch_trajectory
    def enter(*args,**kwargs):
        if kwargs.get('_pose_replans'):
            if change=='cursor':c._command_step_id+=1
            else:c._trajectory={'state':'accepted'}
        return original(*args,**kwargs)
    c._dispatch_trajectory=enter
    with pytest.raises(RuntimeError,match='Command cursor changed'):dispatch()
    assert len(p.discards)==1 and not p.plans and not api.submitted


def test_real_policy_pending_tool_and_camera_lifecycle_through_native_recovery_seam():
    import json
    from unittest.mock import patch
    from remote_yam.robocurve_policy import OpenAIAdapter
    from test_unsubmitted_replanning import Cameras, Geometry, response
    api,c,_,planning,_,_=hardware_decision_case()
    cameras=Cameras()
    provider=OpenAIAdapter('inert-key','inert-model',camera_source=cameras)
    provider._geometry=Geometry();provider.interaction_sink=c._interactions.add
    c._provider=provider;c._command_step_id=42
    api.fresh['left_joints_deg'][0]=.41528
    planning['source']='hardware'
    with patch.object(provider,'_post_json',side_effect=[response('old_tool',.2),response('fresh_tool',.15)]) as model:
        c._dispatch_trajectory(provider.build_trajectory,provider,'Inert closed loop',planning,
            'guard-session','guard-episode','PRIVATE-LEASE',42)
    assert model.call_count==2 and cameras.calls==2
    outputs=[json.loads(row['output']) for row in provider._history if row.get('type')=='function_call_output']
    assert len(outputs)==1 and outputs[0]['status']=='not_executed' and outputs[0]['steps']==0
    assert provider._pending['call_id']=='fresh_tool'
    assert len(api.submitted)==1 and api.submitted[0][0]['left_joints_deg']==[.15]*6
    assert c._packets_submitted==1
