"""Enforcement seam tests using the native controller and MockSessionAPI."""
import copy
import pytest
from remote_yam.controller import RunnerController
from remote_yam.session import MockSessionAPI
from test_trajectory_transport import TinyTrajectoryProvider


def run(callback=None, mutate=None, cadence_hz=10):
    session=MockSessionAPI()
    provider=TinyTrajectoryProvider()
    provider.trajectory_cadence_hz=cadence_hz
    if mutate:
        build=provider.build_trajectory
        provider.build_trajectory=lambda *args: mutate(build(*args))
    controller=RunnerController(session, trajectory_decision=callback)
    controller.update_monitor_observation(session.get_robot_observation('yam-1'))
    controller.join(provider,'Fixture trajectory')
    controller._run_loop(None)
    return session, controller


def test_default_none_retains_native_dispatch_and_completion():
    session, controller=run()
    assert len(session.trajectory_log)==1
    assert controller.status()['status']=='stopped'


def test_allow_callback_receives_detached_source_context_and_cannot_rewrite_packet():
    calls=[]
    def decide(points, observation, context):
        calls.append(copy.deepcopy((points,observation,context)))
        points[0]['left_joints_deg'][0]=99999
        observation['left_joints_deg'][0]=99999
        context['session_id']='another-session'
        return {'decision':'allow','waypoints':points}
    session, controller=run(decide)
    points, observation, context=calls[0]
    assert context['attempt_id']==controller.status()['attempt_id']
    assert context['session_id']==controller.status()['session_id']
    assert context['episode_id']==controller.status()['episode_id']
    assert context['cadence_hz']==10 and context['first_step_id']==0
    assert 'lease_id' not in context
    assert session.trajectory_log[0]['waypoints'][0]['left_joints_deg']==points[0]['left_joints_deg']
    assert controller.status()['status']=='stopped'


@pytest.mark.parametrize('answer',[{'decision':'reject'},None,True,{'decision':True},{'decision':'ALLOW'},{}])
def test_installed_refusal_or_malformed_result_never_submits(answer):
    session, controller=run(lambda *args:answer)
    assert session.trajectory_log==[]
    assert controller.status()['status']=='stopped'
    assert 'packet' in controller.status()['error'].lower()


@pytest.mark.parametrize('exception',[RuntimeError,SystemExit,KeyboardInterrupt])
def test_installed_failure_refuses_without_leaking_callback_text(exception):
    def fail(*args): raise exception('secret-provider-material')
    session, controller=run(fail)
    assert not session.trajectory_log
    assert 'secret-provider-material' not in str(controller.status())
    assert 'unavailable' in controller.status()['error']


@pytest.mark.parametrize('change',['stop','attempt','session','episode'])
def test_stop_or_source_replacement_during_callback_wins_over_allow(change):
    session=MockSessionAPI(); controller=None
    def decide(*args):
        with controller._lock:
            if change=='stop': controller._stop_event.set()
            else: setattr(controller, '_'+change+'_id', 'replaced-source')
        return {'decision':'allow'}
    controller=RunnerController(session,trajectory_decision=decide)
    controller.update_monitor_observation(session.get_robot_observation('yam-1'))
    controller.join(TinyTrajectoryProvider(),'Fixture')
    # One observation triggers planning; don't continue a deliberately replaced
    # mock session through the event loop after this race assertion.
    for _ in range(10):
        controller.process_next_event(.01)
        if change=='stop' and controller._stop_event.is_set(): break
        if change!='stop' and getattr(controller,'_'+change+'_id')=='replaced-source': break
    assert not session.trajectory_log
    assert controller._trajectory is None
    controller._close_events()


def test_numeric_schema_validation_happens_before_installed_callback():
    called=[]
    def malformed(points):
        points[0]['left_joints_deg'][0]=float('nan')
        return points
    session, controller=run(lambda *args:called.append(1), mutate=malformed)
    assert not called and not session.trajectory_log
    assert controller.status()['status']=='stopped'


def test_terminal_provider_identity_is_source_run_configuration():
    session,controller=run()
    controller._lifecycle({}, {'state':'timed_out', 'reason':'fixture-timeout'})
    assert controller._provider is None
    status=controller.status()
    assert status['provider'] is None
    assert status['source_model']=={'provider':'tiny_trajectory','model':'test'}
    status['source_model']['model']='next-run-picker'
    assert controller.status()['source_model']['model']=='test'
    controller._run_configuration=None
    assert controller.status()['provider'] is None
    assert controller.status()['source_model'] is None


def test_unknown_terminal_identity_is_not_an_astra_claim():
    from playground import model_display_name
    assert model_display_name(None)=='Model not recorded'
    assert model_display_name({})=='Model not recorded'
    assert model_display_name({'provider':'dream','model':'dreamlabs/dream-1-beta'})=='dreamlabs/dream-1-beta'
    assert model_display_name({'provider':'codex','model':'gpt-6-astra'})=='Astra'
    assert model_display_name({'provider':'molmoact2'})=='MolmoAct2'
    assert model_display_name({'provider':'dreamzero'})=='DreamZero'
    assert model_display_name({'provider':'local_raise_lower'})=='Built-in policy'


@pytest.mark.parametrize('cadence_hz', [10, 20, 30])
def test_guard_context_preserves_selected_upstream_cadence(cadence_hz):
    contexts=[]
    session, controller=run(lambda points, observation, context: contexts.append(context) or {'decision':'allow'}, cadence_hz=cadence_hz)
    assert contexts[0]['cadence_hz']==cadence_hz
    assert session.trajectory_log[0]['cadence_hz']==cadence_hz


class GuardFeedbackSession:
    """Inert authoritative station/session reads; submit only records arguments."""
    def __init__(self, stamp):
        self.stamp=stamp;self.calls=[];self.submitted=[];self.controller=None;self.hook=None
        self.live=dict(session_id='guard-session',status='running',episode_id='guard-episode',
                       lease_id='PRIVATE-LEASE',latest_observation_step=42,active_trajectory=None)
        self.fresh=dict(jetson_id='yam-1',source='hardware',observed_at=stamp,settled=True,homed=True,
                        mode='API_ACTIVE',safety=dict(ok=True,estop_engaged=False,contact_count=0),
                        left_joints_deg=[.1]+[0.]*5,right_joints_deg=[0.]*6,left_gripper=1.,right_gripper=.995)
    def get_session(self, sid):
        self.calls.append('session')
        if self.hook:self.hook(self,'session',self.calls.count('session'))
        return copy.deepcopy(self.live)
    def get_robot_observation(self, robot):
        self.calls.append('robot')
        if self.hook:self.hook(self,'robot',1)
        return {'observation':copy.deepcopy(self.fresh)}
    def submit_trajectory(self,sid,episode,lease,trajectory,cadence,points):
        self.submitted.append(copy.deepcopy(points))
        return dict(schema_version=1,accepted=True,duplicate=False,session_id=sid,episode_id=episode,
                    lease_id=lease,trajectory_id=trajectory,first_step_id=points[0]['step_id'],
                    last_step_id=points[-1]['step_id'],waypoint_count=len(points),dispatched_at=self.stamp)


def hardware_decision_case(callback=lambda *args:{'decision':'allow'}, first_step_id=42):
    import time
    from types import SimpleNamespace
    session=GuardFeedbackSession(time.time())
    session.live['latest_observation_step']=first_step_id
    provider=SimpleNamespace(public_config=lambda:{'provider':'inert_guard_fixture'})
    controller=RunnerController(session,trajectory_decision=callback)
    controller._provider=provider;controller._status='running'
    controller._session_id='guard-session';controller._episode_id='guard-episode'
    controller._lease_id='PRIVATE-LEASE';controller._attempt_id='guard-attempt'
    session.controller=controller
    observation=dict(session.fresh,observed_at=session.stamp-15.,left_joints_deg=[0.]*6,right_gripper=1.)
    observation.update(step_id=first_step_id,episode_id='guard-episode',lease_id='PRIVATE-LEASE')
    packet=[dict(step_id=first_step_id,left_joints_deg=[0.]*6,right_joints_deg=[0.]*6,left_gripper=1.,right_gripper=.5)]
    def dispatch():
        return controller._dispatch_trajectory(lambda *args:packet,provider,'inert fixture',observation,
            'guard-session','guard-episode','PRIVATE-LEASE',first_step_id)
    return session,controller,provider,observation,packet,dispatch


def test_guard_uses_fresh_authoritative_feedback_without_rewriting_planning_packet():
    captured=[]
    session,controller,provider,planning,packet,dispatch=hardware_decision_case(
        lambda *args:captured.append(copy.deepcopy(args)) or {'decision':'allow'})
    original=copy.deepcopy(packet);dispatch()
    assert session.calls==['session','robot','session']
    assert session.submitted==[original] and packet==original
    assert planning['observed_at']==session.stamp-15.
    received,observed,context=captured[0]
    assert observed['observed_at']==session.stamp and observed['right_gripper']==.995
    assert observed['settled_after']==observed['observed_at']
    assert context['planning_observed_at']==planning['observed_at']
    assert context['decision_feedback_observed_at']==session.stamp
    assert context['observed_at']==session.stamp and context['decision_feedback_basis']=='pre_dispatch_authoritative'
    assert 'lease_id' not in context and 'PRIVATE-LEASE' not in str(context)
    assert controller._trajectory['start_feedback']['right_gripper']==1., 'planning baseline is retained separately'
    rows=controller._interactions.snapshot()['events']
    measured=[row for row in rows if row['kind']=='observation'][-1]['details']
    assert measured['observed_at']==session.stamp and measured['right_gripper']==.995
    assert measured['feedback_basis']=='pre_dispatch_authoritative'


def test_feature_off_does_not_add_any_feedback_reads():
    session,controller,provider,planning,packet,dispatch=hardware_decision_case(None)
    dispatch();assert not session.calls and session.submitted==[packet]


@pytest.mark.parametrize('field,bad',[('episode_id','other'),('lease_id','other'),('session_id','other'),
    ('latest_observation_step',43),('latest_observation_step',True),('active_trajectory',{}),('status','stopped')])
@pytest.mark.parametrize('which_read',[1,2])
def test_unmatched_authoritative_session_never_reaches_guard_or_dispatch(field,bad,which_read):
    called=[]
    session,controller,provider,planning,packet,dispatch=hardware_decision_case(lambda *args:called.append(args))
    def change(api,stage,index):
        if stage=='session' and index==which_read:api.live[field]=bad
    session.hook=change
    with pytest.raises(RuntimeError,match='Session changed'):dispatch()
    assert not called and not session.submitted and controller._trajectory is None


@pytest.mark.parametrize('field,bad',[('jetson_id','other'),('source','simulation'),('settled',False),
    ('safety',dict(ok=False,estop_engaged=False)),('safety',dict(ok=True,estop_engaged=True)),
    ('mode','DISABLED'),('mode','EXECUTING'),('mode','HOMING'),('left_gripper',None),('right_gripper',float('nan')),
    ('right_gripper',.98),('left_joints_deg',[.251]+[0.]*5),('left_joints_deg',[float('nan')]*6),
    ('observed_at',0.),('observed_at',True)])
def test_unsafe_unmeasured_or_materially_changed_feedback_refuses_original_packet(field,bad):
    called=[]
    session,controller,provider,planning,packet,dispatch=hardware_decision_case(lambda *args:called.append(args))
    session.fresh[field]=bad
    with pytest.raises(RuntimeError):dispatch()
    assert not called and not session.submitted and controller._trajectory is None


@pytest.mark.parametrize('stage,index',[('session',1),('robot',1),('session',2)])
@pytest.mark.parametrize('replacement',['stop','attempt','session','episode','lease','provider','robot','api','origin'])
def test_stop_or_source_change_at_each_feedback_read_wins(stage,index,replacement):
    called=[]
    session,controller,provider,planning,packet,dispatch=hardware_decision_case(lambda *args:called.append(args))
    def replace(api,current,number):
        if current!=stage or number!=index:return
        if replacement=='stop':controller._stop_event.set()
        elif replacement=='provider':controller._provider=object()
        elif replacement=='api':controller._session_api=object()
        elif replacement=='origin':session._base_url='https://replacement.invalid'
        else:setattr(controller,'_'+replacement+'_id','replacement')
    session.hook=replace;dispatch()
    assert not called and not session.submitted and controller._trajectory is None


def test_callback_still_cannot_mutate_fresh_observation_or_original_targets():
    def decide(points,observation,context):
        points[0]['right_gripper']=1.;observation['right_gripper']=0.;context['observed_at']=0.
        return {'decision':'allow'}
    session,controller,provider,planning,packet,dispatch=hardware_decision_case(decide)
    original=copy.deepcopy(packet);dispatch();assert session.submitted==[original]
    assert controller._monitor_observation['right_gripper']==.995 and planning['right_gripper']==1.


def test_provider_retained_containers_cannot_change_packet_during_feedback_io():
    received=[]
    session,controller,provider,planning,packet,dispatch=hardware_decision_case(
        lambda *args:received.append(copy.deepcopy(args)) or {'decision':'allow'})
    original=copy.deepcopy(packet)
    def mutate(api,stage,index):
        packet[0]['right_gripper']=1.;planning['right_gripper']=0.
    session.hook=mutate;dispatch()
    assert received[0][0]==original and session.submitted==[original]


def test_feedback_read_errors_do_not_leak_private_transport_text():
    session,controller,provider,planning,packet,dispatch=hardware_decision_case()
    def fail(*args):raise RuntimeError('PRIVATE_URL_WITH_CREDENTIAL')
    session.hook=fail
    with pytest.raises(RuntimeError,match='feedback is unavailable') as failure:dispatch()
    assert 'PRIVATE' not in str(failure.value) and not session.submitted


def test_first_guarded_packet_still_requires_native_homed_feedback():
    called=[]
    session,controller,provider,planning,packet,dispatch=hardware_decision_case(
        lambda *args:called.append(args),first_step_id=0)
    session.fresh['homed']=False
    with pytest.raises(RuntimeError,match='Hardware feedback blocked'):dispatch()
    assert not called and not session.submitted


@pytest.mark.parametrize('replacement',['stop','lease','provider','robot','api','origin'])
def test_source_change_during_fresh_callback_still_wins_over_allow(replacement):
    holder={}
    def decide(*args):
        controller=holder['controller']
        if replacement=='stop':controller._stop_event.set()
        elif replacement=='provider':controller._provider=object()
        elif replacement=='api':controller._session_api=object()
        elif replacement=='origin':session._base_url='https://replacement.invalid'
        else:setattr(controller,'_'+replacement+'_id','replacement')
        return {'decision':'allow'}
    session,controller,provider,planning,packet,dispatch=hardware_decision_case(decide)
    holder['controller']=controller;dispatch()
    assert session.calls==['session','robot','session'] and not session.submitted and controller._trajectory is None


@pytest.mark.parametrize('which_read',[1,2])
def test_missing_explicit_inactive_trajectory_evidence_cannot_authorize_dispatch(which_read):
    called=[]
    session,controller,provider,planning,packet,dispatch=hardware_decision_case(lambda *args:called.append(args))
    def remove(api,stage,index):
        if stage=='session' and index==which_read:api.live.pop('active_trajectory')
    session.hook=remove
    with pytest.raises(RuntimeError,match='Session changed'):dispatch()
    assert not called and not session.submitted
