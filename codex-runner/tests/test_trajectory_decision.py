"""Enforcement seam tests using the native controller and MockSessionAPI."""
import copy
import pytest
from remote_yam.controller import RunnerController
from remote_yam.session import MockSessionAPI
from test_trajectory_transport import TinyTrajectoryProvider


def run(callback=None, mutate=None):
    session=MockSessionAPI()
    provider=TinyTrajectoryProvider()
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
