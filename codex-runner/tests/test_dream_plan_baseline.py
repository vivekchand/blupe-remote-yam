"""Real adapter/controller, inert SDK and cameras: no model or robot traffic."""
import copy
import time
from types import SimpleNamespace

import pytest

from test_dream_policy import adapter
from test_trajectory_decision import hardware_decision_case


def dream_case(tmp_path, callback=lambda *args: {'decision': 'allow'}):
    api, controller, _, planning, _, _ = hardware_decision_case(callback)
    controller._command_step_id = 42
    planning['observed_at'] = api.stamp - 1.
    api.fresh['left_joints_deg'][0] = .4
    provider = adapter(tmp_path)
    controller._provider = provider
    provider._preparation = SimpleNamespace()
    provider.wait_ready = lambda cancelled: None
    from test_dream_policy import Worker
    provider._worker = Worker()
    provider._collector = SimpleNamespace()
    provider._prompt = provider._task_prompt = 'Inert fixture'
    provider.observation_source = lambda: copy.deepcopy(api.fresh)

    def ticks(*args):
        if len(args) > 1 and args[1] is not None:
            api.fresh['observed_at'] = max(time.time(), args[1] + .0001)
        tick = provider._capture_tick()
        tick['capture_generation'] = provider._history_generation
        provider._stream_available = True
        return [tick]
    provider._wait_for_ticks = ticks

    def dispatch():
        return controller._dispatch_trajectory(provider.build_trajectory, provider,
            'Inert fixture', planning, 'guard-session', 'guard-episode', 'PRIVATE-LEASE', 42)
    return api, controller, provider, planning, dispatch


def test_real_dream_packet_uses_its_actual_limiter_baseline_not_call_entry(tmp_path):
    decisions = []
    api, controller, provider, planning, dispatch = dream_case(tmp_path,
        lambda *args: decisions.append(copy.deepcopy(args)) or {'decision': 'allow'})
    measured = []
    provider.measured_step_displacement = lambda before, after: measured.append(copy.deepcopy(before)) or 0.
    dispatch()
    assert len(api.submitted) == len(decisions) == 1
    assert planning['left_joints_deg'][0] == 0.
    assert controller._trajectory['start_feedback']['left_joints_deg'][0] == .4
    assert measured[0]['left_joints_deg'][0] == .4
    assert decisions[0][2]['planning_observed_at'] == planning['observed_at']
    assert decisions[0][2]['packet_baseline_observed_at'] == api.stamp
    assert 'PRIVATE-LEASE' not in str(decisions[0][2])
    assert len([command for command, _ in provider._worker.calls if command == 'predict']) == 1
    rows=controller._interactions.snapshot()['events']
    selected=[e['details'] for e in rows if e['kind']=='observation' and e['details'].get('feedback_basis')=='provider_limiter_baseline']
    assert len(selected)==1 and selected[0]['left_joints_deg'][0]==.4
    assert selected[0]['observed_at']==api.stamp and selected[0]['planning_observed_at']==planning['observed_at']
    assert 'PRIVATE-LEASE' not in str(rows)


@pytest.mark.parametrize('field,value', [
    ('packet_sha256', 'a'*64), ('receipt_sha256', 'b'*64), ('generation', 123),
    ('first_step_id', 43), ('last_step_id', 45), ('waypoint_count', 1), ('cadence_hz', 20),
])
def test_mutated_receipt_never_reaches_guard_or_dispatch(tmp_path, field, value):
    decisions = []
    api, controller, provider, _, dispatch = dream_case(tmp_path,
        lambda *args: decisions.append(args) or {'decision':'allow'})
    consume = provider.consume_trajectory_baseline
    def tampered(*args, **kwargs):
        receipt = consume(*args, **kwargs)
        receipt[field] = value
        return receipt
    provider.consume_trajectory_baseline = tampered
    with pytest.raises(RuntimeError, match='baseline receipt'):
        dispatch()
    assert not api.submitted and not decisions
    assert controller._trajectory is None
    assert not [c for c, _ in provider._worker.calls if c == 'reset']


@pytest.mark.parametrize('field', ['plan_id','attempt_id','session_id','episode_id','lease_id','robot_id','api_origin','api_identity','first_step_id','cadence_hz'])
def test_context_mismatch_cannot_consume_dream_receipt(tmp_path, field):
    api, _, provider, _, dispatch = dream_case(tmp_path)
    original = provider.consume_trajectory_baseline
    def change(points, *, first_step_id, context):
        context[field] = 99 if field in ('api_identity','first_step_id','cadence_hz') else 'foreign'
        return original(points, first_step_id=first_step_id, context=context)
    provider.consume_trajectory_baseline = change
    with pytest.raises(RuntimeError, match='baseline receipt'):
        dispatch()
    assert not api.submitted


@pytest.mark.parametrize('stage', ['station','guard'])
@pytest.mark.parametrize('change', ['generation','cadence','pending'])
def test_retired_provider_baseline_during_check_cannot_authorize_packet(tmp_path, stage, change):
    def retire(provider):
        if change == 'generation': provider._history_generation += 1
        elif change == 'cadence': provider.trajectory_cadence_hz = 20
        else: provider._pending_plan = None
    holder = {}
    def guard(*args):
        if stage == 'guard': retire(holder['provider'])
        return {'decision':'allow'}
    api, controller, provider, _, dispatch = dream_case(tmp_path, guard)
    holder['provider'] = provider
    if stage == 'station':
        api.hook = lambda api, kind, index: retire(provider) if kind == 'robot' else None
    with pytest.raises(RuntimeError, match='baseline receipt'):
        dispatch()
    assert not api.submitted and controller._trajectory is None


def test_dream_drift_discards_exact_unused_packet_resets_and_repredicts(tmp_path):
    decisions=[]
    api, controller, provider, _, dispatch = dream_case(tmp_path,
        lambda *args: decisions.append(copy.deepcopy(args)) or {'decision':'allow'})
    planned=[]
    consume = provider.consume_trajectory_baseline
    def remember(points, **kwargs):
        planned.append(copy.deepcopy(points))
        return consume(points, **kwargs)
    provider.consume_trajectory_baseline = remember
    counts=[]
    def drift(api, kind, index):
        if kind == 'robot':
            counts.append(1)
            if len(counts) == 1:
                api.fresh['left_joints_deg'][0] += .4
                api.fresh['observed_at'] += .001
    api.hook = drift
    provider._commanded = {'completed_anchor': 'local-only'}
    dispatch()
    assert [c for c,_ in provider._worker.calls] == ['predict','reset','predict']
    assert len(planned) == 2 and api.submitted == [planned[1]] and len(decisions) == 1
    assert provider._worker.calls[-1][1]['commanded'] is None
    assert all(tick['capture_generation'] >= 2 for tick in provider._worker.calls[-1][1]['ticks'])
    assert controller._trajectory['start_feedback']['left_joints_deg'][0] == .8
    recovery = [e['details'] for e in controller._interactions.snapshot()['events'] if e['kind']=='plan_recovery']
    assert len(recovery)==1 and recovery[0]['retry_count']==1 and recovery[0]['executed_waypoints']==0
    assert all(e['first_step_id']==42 for e in [provider._plan_context])


def test_persistent_dream_drift_exhausts_existing_cap_without_dispatch(tmp_path):
    api, controller, provider, _, dispatch = dream_case(tmp_path)
    def drift(api, kind, index):
        if kind=='robot':
            api.fresh['left_joints_deg'][0] += .4
            api.fresh['observed_at'] += .001
    api.hook=drift
    with pytest.raises(RuntimeError, match='recovery limit'):
        dispatch()
    assert not api.submitted and controller._trajectory is None
    assert [c for c,_ in provider._worker.calls].count('predict')==3
    assert [c for c,_ in provider._worker.calls].count('reset')==2


@pytest.mark.parametrize('field,bad,code', [
    ('left_joints_deg',[0.]*5,'planning_joint_shape_invalid'),
    ('right_joints_deg',[float('nan')]*6,'planning_joint_nonfinite'),
    ('left_joints_deg',[True]*6,'planning_joint_nonfinite'),
    ('left_joints_deg',[10**1000]*6,'planning_joint_nonfinite'),
    ('left_gripper',None,'planning_gripper_invalid'),
    ('right_gripper',True,'planning_gripper_invalid'),
])
def test_malformed_current_feedback_is_typed_and_never_replanned(tmp_path, field, bad, code):
    api, controller, provider, _, dispatch = dream_case(tmp_path)
    def corrupt(api, kind, index):
        if kind=='robot': api.fresh[field]=bad
    api.hook=corrupt
    with pytest.raises(RuntimeError):dispatch()
    assert not api.submitted and [c for c,_ in provider._worker.calls]==['predict']
    reasons=[e['details'].get('reason_code') for e in controller._interactions.snapshot()['events'] if e['kind']=='feedback_check']
    assert code in reasons


@pytest.mark.parametrize('answer', [{'ok':False}, {}, None])
def test_unacknowledged_reset_does_not_predict_again(tmp_path, answer):
    api, controller, provider, _, dispatch = dream_case(tmp_path)
    original=provider._worker.call
    def call(command, **kwargs):
        if command=='reset':
            provider._worker.calls.append((command,kwargs));return answer
        return original(command,**kwargs)
    provider._worker.call=call
    def drift(api, kind, index):
        if kind=='robot':
            api.fresh['left_joints_deg'][0]+=.4;api.fresh['observed_at']+=.001
    api.hook=drift
    with pytest.raises(RuntimeError,match='confirm.*reset'):dispatch()
    assert not api.submitted and [c for c,_ in provider._worker.calls]==['predict','reset']


def test_receipt_is_detached_one_shot_and_cleared_after_completion(tmp_path):
    api, _, provider, _, dispatch = dream_case(tmp_path)
    dispatch()
    pending=provider._pending_plan
    receipt=copy.deepcopy(pending['receipt'])
    with pytest.raises(RuntimeError,match='baseline is unavailable'):
        provider.consume_trajectory_baseline(api.submitted[0],first_step_id=42,context=provider._plan_context)
    receipt['observation']['left_joints_deg'][0]=999
    assert pending['receipt']['observation']['left_joints_deg'][0]==.4
    provider.trajectory_completed({},len(api.submitted[0]))
    assert provider._pending_plan is None


@pytest.mark.parametrize('callback_answer',[{'decision':'reject'},None])
def test_dream_guard_refusal_is_terminal_and_never_replans(tmp_path,callback_answer):
    api,_,provider,_,dispatch=dream_case(tmp_path,lambda *args:callback_answer)
    with pytest.raises(RuntimeError):dispatch()
    assert not api.submitted and [c for c,_ in provider._worker.calls]==['predict']


@pytest.mark.parametrize('change',['stop','attempt','session','episode','lease','robot','provider','api','origin','deadline'])
def test_source_replacement_or_stop_during_sdk_reset_prevents_new_prediction(tmp_path,change):
    api,controller,provider,_,dispatch=dream_case(tmp_path)
    original=provider._worker.call
    def call(command,**kwargs):
        result=original(command,**kwargs)
        if command=='reset':
            if change=='stop':controller._stop_event.set()
            elif change=='provider':controller._provider=object()
            elif change=='api':controller._session_api=object()
            elif change=='origin':api._base_url='https://foreign.invalid'
            elif change=='deadline':controller._run_duration_s=1;controller._run_started_at=time.time()-2
            else:setattr(controller,'_'+change+'_id','changed')
        return result
    provider._worker.call=call
    def drift(api,kind,index):
        if kind=='robot':
            api.fresh['left_joints_deg'][0]+=.4;api.fresh['observed_at']+=.001
    api.hook=drift
    with pytest.raises(RuntimeError,match='reset'):dispatch()
    assert not api.submitted and [c for c,_ in provider._worker.calls]==['predict','reset']


@pytest.mark.parametrize('change',['packet','cursor','lease','episode','api','generation','dispatched','steps'])
def test_discard_requires_exact_unsubmitted_packet_and_source(tmp_path,change):
    api,_,provider,_,dispatch=dream_case(tmp_path)
    original=provider.discard_unsubmitted_trajectory
    def tampered(points,**kwargs):
        if change=='packet':points[0]['left_joints_deg'][0]+=.001
        elif change=='cursor':kwargs['first_step_id']+=1
        elif change=='lease':kwargs['context']['lease_id']='foreign'
        elif change=='episode':kwargs['observation']['episode_id']='foreign'
        elif change=='api':kwargs['context']['api_identity']+=1
        elif change=='generation':provider._history_generation+=1
        elif change=='dispatched':kwargs['context']['dispatched']=True
        else:kwargs['context']['executed_waypoints']=1
        return original(points,**kwargs)
    provider.discard_unsubmitted_trajectory=tampered
    def drift(api,kind,index):
        if kind=='robot':
            api.fresh['left_joints_deg'][0]+=.4;api.fresh['observed_at']+=.001
    api.hook=drift
    with pytest.raises((RuntimeError,ValueError)):dispatch()
    assert not api.submitted and [c for c,_ in provider._worker.calls]==['predict']


def test_ambiguous_transport_failure_never_discards_or_repredicts(tmp_path):
    from remote_yam.session import SessionAPIError
    api,_,provider,_,dispatch=dream_case(tmp_path)
    attempted=[]
    def fail(*args):
        attempted.append(1)
        raise SessionAPIError('Inert ambiguous dispatch')
    api.submit_trajectory=fail
    provider.discard_unsubmitted_trajectory=lambda *a,**kw:pytest.fail('Cannot replan a possibly sent packet')
    with pytest.raises(SessionAPIError):dispatch()
    assert len(attempted)==1 and [c for c,_ in provider._worker.calls]==['predict']


def test_no_installed_callback_never_enables_dream_baseline_contract(tmp_path):
    api,controller,provider,_,dispatch=dream_case(tmp_path,None)
    provider.prepare_trajectory_plan=lambda *args:pytest.fail('Feature off must not prepare receipts')
    dispatch()
    assert len(api.submitted)==1 and not api.calls
    assert provider._plan_context is None and provider._pending_plan is None


@pytest.mark.parametrize('method',['prepare_trajectory_plan','consume_trajectory_baseline','trajectory_baseline_current'])
@pytest.mark.parametrize('exception',[RuntimeError,SystemExit,KeyboardInterrupt])
def test_optional_baseline_failure_is_closed_and_does_not_publish_exception_text(tmp_path,method,exception):
    api,_,provider,_,dispatch=dream_case(tmp_path)
    def fail(*args,**kwargs):raise exception('private-inert-transport-text')
    setattr(provider,method,fail)
    with pytest.raises(RuntimeError) as error:dispatch()
    assert 'private-inert-transport-text' not in str(error.value) and not api.submitted


@pytest.mark.parametrize('bad_input',['old_generation','old_source_clock'])
def test_reset_requires_new_generation_and_newer_source_before_another_prediction(tmp_path,bad_input):
    api,_,provider,_,dispatch=dream_case(tmp_path)
    ticks=provider._wait_for_ticks
    def stale(*args):
        result=ticks(*args)
        if any(command=='reset' for command,_ in provider._worker.calls):
            if bad_input=='old_generation':result[-1]['capture_generation']=0
            else:result[-1]['observed_at']=api.stamp-1.
        return result
    provider._wait_for_ticks=stale
    def drift(api,kind,index):
        if kind=='robot':
            api.fresh['left_joints_deg'][0]+=.4;api.fresh['observed_at']+=.001
    api.hook=drift
    with pytest.raises(RuntimeError,match='fresh capture generation'):dispatch()
    assert not api.submitted and [c for c,_ in provider._worker.calls]==['predict','reset']


def run_collector_failure(provider, kind, *, recover=False):
    """Run the real failure branches, without cancelling the native source."""
    from remote_yam.dream_policy import DreamObservationError
    class CollectionDone(Exception):
        pass
    capture, wait = provider._capture_tick, provider._stop.wait
    count=[]
    def failing_capture():
        count.append(1)
        if len(count)==1:
            if kind=='generic':raise ValueError('Inert collector failure')
            raise DreamObservationError('Inert unavailable feedback',field='observation',retryable=kind=='transient')
        return capture()
    def bounded_wait(timeout):
        if recover and len(count)==1:return False
        raise CollectionDone()
    provider._capture_tick=failing_capture;provider._stop.wait=bounded_wait
    try:
        provider._collect()
    except CollectionDone:
        pass
    finally:
        provider._capture_tick=capture;provider._stop.wait=wait


@pytest.mark.parametrize('stage',['station','guard'])
@pytest.mark.parametrize('failure',['transient','terminal','generic','recovered_transient'])
def test_actual_collector_outage_retires_consumed_receipt_at_async_boundaries(tmp_path,stage,failure):
    holder={}
    def outage():
        provider=holder['provider'];old_generation=provider._history_generation
        run_collector_failure(provider,'transient' if failure=='recovered_transient' else failure,
                              recover=failure=='recovered_transient')
        assert provider._history_generation>old_generation and provider._pending_plan is None
        if failure=='recovered_transient':assert provider._stream_available and provider._failure is None
    def guard(*args):
        if stage=='guard':outage()
        return {'decision':'allow'}
    api,controller,provider,_,dispatch=dream_case(tmp_path,guard);holder['provider']=provider
    if stage=='station':api.hook=lambda api,kind,index:outage() if kind=='robot' else None
    with pytest.raises(RuntimeError,match='baseline receipt'):dispatch()
    assert not api.submitted and controller._trajectory is None and not provider._stop.is_set()
    assert [command for command,_ in provider._worker.calls]==['predict']


def test_outage_and_recovery_during_actual_predict_cannot_bind_old_inference_to_new_stream(tmp_path):
    api,_,provider,_,dispatch=dream_case(tmp_path)
    call=provider._worker.call
    def interrupted(command,**kwargs):
        result=call(command,**kwargs)
        if command=='predict':run_collector_failure(provider,'transient',recover=True)
        return result
    provider._worker.call=interrupted
    with pytest.raises(RuntimeError,match='capture generation changed'):dispatch()
    assert not api.submitted and [command for command,_ in provider._worker.calls]==['predict']


@pytest.mark.parametrize('stage',['station','guard'])
@pytest.mark.parametrize('clock_value',['expired','regressed','nan','infinity','overflow'])
def test_baseline_age_and_finite_wall_clock_rechecked_after_async_work(tmp_path,monkeypatch,stage,clock_value):
    holder={}
    def change_clock():
        now=holder['clock']
        now[0]={'expired':holder['stamp']+6.,'regressed':holder['stamp']-.1,
                'nan':float('nan'),'infinity':float('inf'),'overflow':10**1000}[clock_value]
    def guard(*args):
        if stage=='guard':change_clock()
        return {'decision':'allow'}
    api,controller,provider,_,dispatch=dream_case(tmp_path,guard)
    clock=[api.stamp];holder.update(clock=clock,stamp=api.stamp)
    monkeypatch.setattr(time,'time',lambda:clock[0])
    if stage=='station':api.hook=lambda api,kind,index:change_clock() if kind=='robot' else None
    with pytest.raises(RuntimeError,match='baseline receipt'):dispatch()
    assert not api.submitted and controller._trajectory is None
    assert [command for command,_ in provider._worker.calls]==['predict']
