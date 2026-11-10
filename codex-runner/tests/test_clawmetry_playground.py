"""Isolated composition checks, not camera, hardware or production validation."""
import asyncio
from contextlib import suppress
import json
import shutil
import sys
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import pytest

import clawmetry_playground
from clawmetry_playground import ClawMetryPlayground
from local_playground import LocalPlayground
from playground import Visitor
from remote_yam.interactions import InteractionLog
from remote_yam.providers import ScriptedAdapter
from remote_yam.session import MockSessionAPI


ORIGIN = 'http://127.0.0.1:8794'
PLUGIN = 'clawmetry_pro.robotics.blupe_playground'
SECRET = 'fixture-provider-key-do-not-publish'


@pytest.fixture
def app_factory(tmp_path, monkeypatch):
    for name in ('YAM_SOCIAL_DATABASE', 'YAM_RUN_NAMES_DATABASE', 'YAM_SUBMISSION_DATABASE',
                 'YAM_ASSESSMENT_DATABASE', 'YAM_TASK_CLOUD_DATABASE'):
        monkeypatch.setenv(name, str(tmp_path / (name + '.sqlite3')))
    monkeypatch.delenv('YAM_ASPIRE_CONFIG', raising=False)
    monkeypatch.setitem(sys.modules, PLUGIN, None)
    apps = []

    def create(cls=ClawMetryPlayground, **options):
        api = MockSessionAPI(auto_activate=False)
        providers = Mock(side_effect=lambda *args: ScriptedAdapter([]))
        app = cls(public_origin=ORIGIN, session_api=None,
                  camera_origin='http://127.0.0.1:8089', development=True,
                  hardware_control=True, api_factory=lambda: api,
                  provider_factory=providers, **options)
        apps.append(app)
        return app, api, providers

    yield create
    for app in apps:
        for visitor in list(app.visitors.values()):
            with suppress(Exception):
                visitor.close()
        shutil.rmtree(app.root, ignore_errors=True)


def install_plugin(monkeypatch, attach):
    for name in ('clawmetry_pro', 'clawmetry_pro.robotics'):
        package = ModuleType(name)
        package.__path__ = []
        monkeypatch.setitem(sys.modules, name, package)
    module = ModuleType(PLUGIN)
    module.attach_controller = attach
    monkeypatch.setitem(sys.modules, PLUGIN, module)


def call(app, path, payload=None, session=None, *, headers=None, method=None):
    """Use the same ASGI request/cookie pattern as the local playground tests."""
    request_headers = {'host': '127.0.0.1:8794', 'origin': ORIGIN,
                       'content-type': 'application/json'}
    if session:
        request_headers.update(cookie=session[0], **{'x-yam-runner-token': session[1]})
    for key, value in (headers or {}).items():
        if value is None:
            request_headers.pop(key, None)
        else:
            request_headers[key] = value

    async def invoke():
        messages = []

        async def receive():
            return {'type': 'http.request', 'body': json.dumps(payload or {}).encode()}

        async def send(message):
            messages.append(message)

        await app({'type': 'http', 'method': method or ('POST' if payload is not None else 'GET'),
                   'path': path, 'query_string': b'',
                   'headers': [(k.encode(), v.encode()) for k, v in request_headers.items()]},
                  receive, send)
        response_headers = dict(messages[0]['headers'])
        raw = b''.join(message.get('body', b'') for message in messages[1:])
        body = json.loads(raw) if response_headers[b'content-type'].startswith(b'application/json') else raw
        cookie = response_headers.get(b'set-cookie', b'').decode().split(';')[0]
        next_session = (cookie, body.get('csrf')) if cookie else session
        return messages[0]['status'], body, response_headers, next_session

    return asyncio.run(invoke())


def session(app):
    code, _, _, browser = call(app, '/api/session', {})
    assert code == 200
    return browser


@pytest.mark.parametrize('cls,default', [(LocalPlayground, 120), (ClawMetryPlayground, 300)])
@pytest.mark.parametrize('provider', ['dream', 'dream_flash'])
@pytest.mark.parametrize('explicit', [None, 120])
def test_clawmetry_dream_five_minute_default_reaches_queue(app_factory, tmp_path, cls, default, provider, explicit):
    credentials = tmp_path / 'inert-dream-credentials'
    credentials.write_text('inert fixture, no provider connection')
    app, api, _ = app_factory(cls, dream_credentials_file=str(credentials), dream_python=sys.executable)
    # Keep the actual configured metadata and launch validation, with an inert
    # adapter and a queue that never grants control. No SDK or robot connection.
    app.extra_providers[provider] = lambda model, directory: ScriptedAdapter([])
    code, metadata, _, _ = call(app, '/api/session', {})
    assert code == 200
    visitor = next(iter(app.visitors.values()))
    assert metadata['dream_providers'][provider]['default_run_duration_s'] == default
    payload = dict(provider=provider, model=app.dream_providers[provider]['model'],
                   prompt='Duration fixture only', runner_name='Duration fixture')
    if explicit is not None:
        payload['run_duration_s'] = explicit
    original = dict(payload)
    app.launch(visitor, payload)
    assert visitor.controller.status()['run_duration_s'] == (explicit or default)
    assert api.create_requests[0].get('run_duration_s', 300) == (explicit or default)
    assert payload == original
    assert api.action_log == []


def test_composition_preserves_existing_hosted_product_hooks(app_factory):
    class Product(LocalPlayground):
        def page(self):
            return super().page().replace(b'<!-- application-head -->', b'<meta name="product" content="fixture">')

        def new_visitor(self):
            capability, visitor = super().new_visitor()
            visitor.product_marker = 'own-product-session'
            return capability, visitor

        async def session_extension(self, cookies, visitor):
            inherited, headers = await super().session_extension(cookies, visitor)
            return {**inherited, 'product_session': visitor.product_marker}, headers

        async def status_extension(self, visitor, state):
            return {'product_observation': visitor.product_marker}

        async def public_extension(self, scope, receive, send, headers):
            if scope['path'] == '/product-public':
                await self.json(send, 200, {'public_product_hook': True})
                return True
            return await super().public_extension(scope, receive, send, headers)

        async def action_extension(self, path, visitor, payload, cookies, send):
            if path == '/api/product-action':
                await self.json(send, 200, {'product_action': visitor.product_marker})
                return True
            return await super().action_extension(path, visitor, payload, cookies, send)

    composed = clawmetry_playground.with_clawmetry(Product)
    app, api, _ = app_factory(composed)
    code, page, _, _ = call(app, '/')
    assert code == 200 and b'<meta name="product"' in page
    assert page.count(clawmetry_playground.HEAD) == 1
    code, result, _, browser = call(app, '/api/session', {})
    assert code == 200 and result['product_session'] == 'own-product-session'
    assert call(app, '/product-public')[1] == {'public_product_hook': True}
    assert call(app, '/api/product-action', {}, browser)[1] == {'product_action': 'own-product-session'}
    status = call(app, '/api/status', session=browser)[1]
    assert status['telemetry']['product_observation'] == 'own-product-session'
    assert status['telemetry']['state'] == 'observing'
    assert not api.create_requests


def test_composition_helper_is_idempotent_and_preserves_subclass_relationship():
    composed = clawmetry_playground.with_clawmetry(LocalPlayground)
    assert issubclass(composed, LocalPlayground)
    assert clawmetry_playground.with_clawmetry(composed) is composed
    assert clawmetry_playground.with_clawmetry(ClawMetryPlayground) is ClawMetryPlayground


@pytest.mark.parametrize('value', [None, object, LocalPlayground.__name__, LocalPlayground.__new__(LocalPlayground)])
def test_composition_helper_rejects_non_hosted_classes(value):
    with pytest.raises(TypeError):
        clawmetry_playground.with_clawmetry(value)


def run_payload():
    return {'provider': 'openai', 'model': 'gpt-6-astra', 'api_key': SECRET,
            'prompt': 'Inspect the fixture scene', 'runner_name': 'Isolated test'}


def attachment(identity, source_session_id=None):
    return SimpleNamespace(
        receipt=Mock(return_value={'state': 'recording', 'recording_id': identity,
                                   'source_session_id': source_session_id,
                                   'written_events': 3}), close=Mock())


def test_optional_page_preserves_native_ui_and_does_not_admit_a_robot(app_factory):
    normal, normal_api, _ = app_factory(LocalPlayground)
    observed, observed_api, _ = app_factory()
    _, native_page, _, _ = call(normal, '/')
    code, composed_page, _, _ = call(observed, '/')
    assert code == 200
    assert composed_page.replace(clawmetry_playground.HEAD, b'<!-- application-head -->', 1) == native_page
    for path in clawmetry_playground.ASSETS:
        assert path.encode() in composed_page
        assert path.encode() not in native_page
    assert not normal.visitors and not observed.visitors
    assert not normal_api.create_requests and not observed_api.create_requests


@pytest.mark.parametrize('path', list(clawmetry_playground.ASSETS))
def test_assets_are_optional_public_files_behind_existing_host_guard(app_factory, path):
    normal, _, _ = app_factory(LocalPlayground)
    observed, api, _ = app_factory()
    code, body, headers, _ = call(observed, path)
    name, content_type = clawmetry_playground.ASSETS[path]
    assert code == 200
    assert body == (clawmetry_playground.STATIC / name).read_bytes()
    assert body
    assert headers[b'content-type'].decode() == content_type
    assert call(normal, path)[0] != 200
    assert call(observed, path, headers={'host': 'attacker.invalid'})[0] == 421
    assert call(observed, path + '/../private')[0] != 200
    assert not observed.visitors and not api.create_requests


@pytest.mark.parametrize('failure', ['missing', 'constructor'])
def test_optional_plugin_failure_preserves_native_run_status_and_stop(
        app_factory, monkeypatch, caplog, failure):
    if failure == 'constructor':
        install_plugin(monkeypatch, Mock(side_effect=RuntimeError(SECRET)))
    app, api, providers = app_factory()
    browser = session(app)
    code, result, _, _ = call(app, '/api/run', run_payload(), browser)
    assert code == 200 and result['ok']
    assert len(api.create_requests) == 1
    assert providers.call_args.args[:3] == ('openai', SECRET, 'gpt-6-astra')
    code, state, _, _ = call(app, '/api/status', session=browser)
    assert code == 200 and state['status'] == 'queued'
    assert state['telemetry']['state'] == 'observing'
    assert 'recording' not in state['telemetry']
    assert SECRET not in json.dumps(state)
    assert SECRET not in caplog.text
    code, result, _, _ = call(app, '/api/stop', {}, browser)
    assert code == 200 and result['ok']
    assert not api.action_log and not api.trajectory_log


def test_attachment_uses_own_controller_and_live_secret_and_sharing_callbacks(
        app_factory, monkeypatch):
    attach = Mock(side_effect=lambda *args, **kwargs: attachment('local-recording'))
    install_plugin(monkeypatch, attach)
    app, _, _ = app_factory()
    session(app)
    session(app)
    first, second = app.visitors.values()
    assert attach.call_args_list[0].args == (first.controller,)
    assert attach.call_args_list[1].args == (second.controller,)
    callbacks = attach.call_args_list[0].kwargs
    initial = set(callbacks['secrets']())
    assert first.csrf in initial
    assert second.csrf not in initial
    first.saved_keys.update(openai=SECRET, anthropic=None)
    provider = ScriptedAdapter([])
    provider._api_key = 'fixture-new-provider-key'
    first.controller._provider = provider
    assert set(callbacks['secrets']()) >= initial | {SECRET, 'fixture-new-provider-key'}
    assert None not in callbacks['secrets']()
    first.saved_keys['openai'] = 'fixture-replaced-key'
    assert SECRET not in callbacks['secrets']()
    for shared in (False, True, False):
        first.controller._run_share_conversation = shared
        first.controller._share_conversation = not shared
        assert callbacks['source_shared']() is shared


def test_status_receipt_is_requested_only_from_authenticated_visitors_own_attachment(
        app_factory, monkeypatch):
    receipts = [attachment('recording-first'), attachment('recording-second')]
    attach = Mock(side_effect=receipts)
    install_plugin(monkeypatch, attach)
    app, _, _ = app_factory()
    first_browser, second_browser = session(app), session(app)
    for browser, visitor, receipt in zip(
            (first_browser, second_browser), app.visitors.values(), receipts):
        assert call(app, '/api/run', run_payload(), browser)[0] == 200
        receipt.receipt.return_value['source_session_id'] = visitor.controller._session_id
    code, state, _, _ = call(app, '/api/status', session=first_browser)
    assert code == 200
    assert state['telemetry']['recording']['recording_id'] == 'recording-first'
    assert 'recording-second' not in json.dumps(state)
    receipts[0].receipt.assert_called_once_with()
    receipts[1].receipt.assert_not_called()
    code, state, _, _ = call(app, '/api/status', session=second_browser)
    assert code == 200
    assert state['telemetry']['recording']['recording_id'] == 'recording-second'
    assert 'recording-first' not in json.dumps(state)


@pytest.mark.parametrize('captured,recorded', [
    (None, None), (None, 'sess_new'), ('sess_old', 'sess_new'), ('sess_current', None),
])
def test_receipt_without_matching_captured_source_is_unconfirmed(
        app_factory, monkeypatch, captured, recorded):
    recording = attachment('must-not-be-confirmed', recorded)
    install_plugin(monkeypatch, Mock(return_value=recording))
    app, _, _ = app_factory()
    session(app)
    visitor = next(iter(app.visitors.values()))
    state = {'session_id': captured, 'public_run': None}
    metadata = asyncio.run(app.status_extension(visitor, state))
    assert metadata['recording'] == {'state': 'waiting', 'persistence': 'unconfirmed'}
    assert 'must-not-be-confirmed' not in json.dumps(metadata)


def test_run_switch_during_receipt_cannot_confirm_a_different_status_snapshot(
        app_factory, monkeypatch):
    recording = attachment('new-recording')
    install_plugin(monkeypatch, Mock(return_value=recording))
    app, api, _ = app_factory()
    browser = session(app)
    visitor = next(iter(app.visitors.values()))
    old = api.create_session('Old isolated source')['session_id']
    new = api.create_session('New isolated source')['session_id']
    visitor.controller._session_id = old

    def after_status_snapshot():
        visitor.controller._session_id = new
        return {'state': 'recording', 'recording_id': 'new-recording',
                'source_session_id': new, 'written_events': 3}

    recording.receipt.side_effect = after_status_snapshot
    code, state, _, _ = call(app, '/api/status', session=browser)
    assert code == 200 and state['session_id'] == old
    assert visitor.controller._session_id == new
    assert state['telemetry']['recording'] == {'state': 'waiting', 'persistence': 'unconfirmed'}
    assert 'new-recording' not in json.dumps(state)


def test_receipt_failure_does_not_replace_native_status_or_disclose_error(
        app_factory, monkeypatch, caplog):
    recording = attachment('not-returned')
    recording.receipt.side_effect = RuntimeError(SECRET)
    install_plugin(monkeypatch, Mock(return_value=recording))
    app, _, _ = app_factory()
    browser = session(app)
    visitor = next(iter(app.visitors.values()))
    visitor.saved_keys['openai'] = SECRET
    code, state, _, _ = call(app, '/api/status', session=browser)
    assert code == 200 and state['status'] == 'idle'
    assert state['telemetry']['recording'] == {'state': 'unavailable'}
    for private in (SECRET, browser[0].split('=', 1)[1], browser[1]):
        assert private not in json.dumps(state)
    assert SECRET not in caplog.text


@pytest.mark.parametrize('cls', [LocalPlayground, ClawMetryPlayground])
def test_throwing_status_extension_is_contained_and_base_response_stays_native(
        app_factory, monkeypatch, cls):
    app, _, _ = app_factory(cls)
    browser = session(app)
    hook = AsyncMock(side_effect=RuntimeError(SECRET))
    monkeypatch.setattr(app, 'status_extension', hook)
    code, state, _, _ = call(app, '/api/status', session=browser)
    assert code == 200 and state['status'] == 'idle'
    assert state['telemetry'] == {'state': 'unavailable', 'public_run_shared': False}
    assert SECRET not in json.dumps(state)
    hook.assert_awaited_once()


def test_standalone_status_does_not_gain_optional_metadata(app_factory):
    app, _, _ = app_factory(LocalPlayground)
    code, state, _, _ = call(app, '/api/status', session=session(app))
    assert code == 200 and 'telemetry' not in state


@pytest.mark.parametrize('path,payload,headers,expected', [
    ('/api/status', None, {'host': 'attacker.invalid'}, 421),
    ('/api/status', None, {'cookie': ''}, 401),
    ('/api/status', None, {'sec-fetch-site': 'cross-site'}, 403),
    ('/api/run', {}, {'origin': 'https://attacker.invalid'}, 403),
    ('/api/run', {}, {'x-yam-runner-token': 'not-the-csrf-token'}, 403),
    ('/api/run', {}, {'content-type': 'text/plain'}, 415),
])
def test_composition_preserves_host_origin_visitor_and_csrf_guards(
        app_factory, monkeypatch, path, payload, headers, expected):
    app, api, providers = app_factory()
    browser = session(app)
    hook = AsyncMock(return_value={'state': 'observing'})
    monkeypatch.setattr(app, 'status_extension', hook)
    code, _, _, _ = call(app, path, payload, browser, headers=headers)
    assert code == expected
    hook.assert_not_called()
    providers.assert_not_called()
    assert not api.create_requests and not api.action_log


@pytest.mark.parametrize('shared', [False, True])
def test_native_public_run_respects_source_sharing_and_preserves_private_journal(
        app_factory, shared):
    app, _, _ = app_factory()
    owner_browser, viewer_browser = session(app), session(app)
    owner, viewer = app.visitors.values()
    owner.controller._share_conversation = shared
    owner.controller._run_share_conversation = shared
    viewer.controller._share_conversation = not shared
    # A completed source journal is selected by the same native public-run path.
    owner.controller._status = 'stopped'
    owner.controller._provider = ScriptedAdapter([])
    owner.runner_session_id = 'fixture-local-selection'
    owner.runner_task = 'Public queue task'
    journal = InteractionLog(owner.directory / ('run_' + 'a' * 32))
    journal.add('model_progress', 'Private source summary sentinel', progress_type='summary')
    owner.controller._interactions = journal
    code, state, _, _ = call(app, '/api/status', session=viewer_browser)
    assert code == 200
    assert state['public_run']['run_id'] == journal.directory.name
    assert state['telemetry']['public_run_shared'] is shared
    if shared:
        assert state['public_run']['events'][0]['message'] == 'Private source summary sentinel'
    else:
        assert state['public_run']['events'] == []
        assert 'Private source summary sentinel' not in json.dumps(state)
    _, own_state, _, _ = call(app, '/api/status', session=owner_browser)
    assert own_state['interactions']['events'][0]['message'] == 'Private source summary sentinel'


def test_local_unshared_recording_cannot_be_attested_by_matching_queue_record(
        app_factory):
    app, _, _ = app_factory()
    session(app)
    owner = next(iter(app.visitors.values()))
    owner.controller._share_conversation = False
    owner.controller._interactions = InteractionLog(owner.directory / ('run_' + 'b' * 32))
    identity = owner.controller._interactions.directory.name
    state = {'public_run': {'run_id': identity, 'episode_id': 'ep_distinct'},
             'queue_snapshot': {'public_run': {'run_id': identity}}}
    metadata = asyncio.run(app.status_extension(owner, state))
    assert metadata['public_run_shared'] is False


@pytest.mark.parametrize('published_id,expected', [('ep_selected', True), ('ep_other', False), (None, False)])
def test_public_episode_requires_matching_published_identity_not_local_recording(
        app_factory, published_id, expected):
    app, _, _ = app_factory()
    session(app)
    visitor = next(iter(app.visitors.values()))
    visitor.controller._interactions = InteractionLog(visitor.directory / ('run_' + 'c' * 32))
    state = {'public_run': {'run_id': 'ep_selected'},
             'queue_snapshot': {'public_run': {'run_id': published_id}}}
    metadata = asyncio.run(app.status_extension(visitor, state))
    assert metadata['public_run_shared'] is expected


@pytest.mark.parametrize('source_fails', [False, True])
@pytest.mark.parametrize('plugin_fails', [False, True])
def test_attachment_cleanup_follows_native_close_and_cannot_replace_its_outcome(
        app_factory, monkeypatch, caplog, source_fails, plugin_fails):
    app, _, _ = app_factory()
    order, native_result = [], object()
    original_close = Visitor.close

    class NativeCloseError(Exception):
        pass

    native_error = NativeCloseError('native close failure')

    def source_close(visitor):
        order.append('native-start')
        original_close(visitor)
        order.append('native-finished')
        if source_fails:
            raise native_error
        return native_result

    recording = attachment('cleanup-recording')

    def recorder_close():
        order.append('attachment')
        if plugin_fails:
            raise RuntimeError(SECRET)

    recording.close.side_effect = recorder_close
    install_plugin(monkeypatch, Mock(return_value=recording))
    with patch.object(Visitor, 'close', source_close):
        _, visitor = app.new_visitor()
    if source_fails:
        with pytest.raises(NativeCloseError) as caught:
            visitor.close()
        assert caught.value is native_error
    else:
        assert visitor.close() is native_result
    assert order == ['native-start', 'native-finished', 'attachment']
    assert visitor.retired and not visitor.directory.exists()
    assert SECRET not in caplog.text


@pytest.mark.parametrize('enabled', [False, True])
def test_cli_flag_selects_optional_composition_without_starting_a_provider(enabled):
    from run import main
    argv = ['run.py', '--no-browser'] + (['--clawmetry'] if enabled else [])
    with patch.object(sys, 'argv', argv), patch('local_playground.serve') as serve, \
            patch('run.ensure_codex_runtime') as install, patch('run.login_codex') as login:
        main()
    assert serve.call_args.args[0].clawmetry is enabled
    install.assert_not_called()
    login.assert_not_called()


@pytest.mark.parametrize('enabled,expected', [(False, LocalPlayground), (True, ClawMetryPlayground)])
def test_launcher_uses_existing_fleet_and_keeps_native_control_options(monkeypatch, enabled, expected):
    from local_playground import serve
    monkeypatch.setenv('YAM_GROOT_KEY_FILE', '')
    monkeypatch.setenv('YAM_DREAM_CREDENTIALS', '')
    args = SimpleNamespace(port=18794, session_api=None, camera_origin=None,
                           allow_hardware_control=False, provider='auto', no_browser=True,
                           no_share_conversation=True, clawmetry=enabled)
    with patch('multi_robot.fleet') as fleet, patch('uvicorn.Config') as config, \
            patch('uvicorn.Server') as server:
        serve(args)
    assert fleet.call_args.args[0] is expected
    options = fleet.call_args.args[1]
    assert options['hardware_control'] is False
    assert options['share_conversation'] is False
    assert options['public_origin'] == 'http://127.0.0.1:18794'
    assert options['local_codex'] and options['local_claude']
    server.return_value.run.assert_called_once()
    config.return_value.bind_socket.return_value.close.assert_called_once()


def test_terminal_public_model_uses_source_configuration_after_provider_cleanup(app_factory):
    app, _, _ = app_factory()
    owner_browser, viewer_browser = session(app), session(app)
    owner, viewer = app.visitors.values()
    owner.controller._status = 'timed_out'
    owner.controller._provider = None
    owner.controller._run_configuration = {'provider':'dream', 'model':'dreamlabs/dream-1-beta',
                                           'system_prompt':'PRIVATE_SOURCE_CONFIGURATION'}
    owner.controller._run_share_conversation = True
    owner.runner_session_id = 'fixture-completed-source'
    owner.runner_task = 'Task whose provider has closed'
    journal=InteractionLog(owner.directory/('run_'+'c'*32))
    journal.add('model_progress','Published terminal update',progress_type='summary')
    owner.controller._interactions=journal
    # Another visitor's next provider is never this run's identity.
    viewer.controller._provider=ScriptedAdapter([])
    code,state,_,_=call(app,'/api/status',session=viewer_browser)
    assert code==200
    assert state['public_run']['model_name']=='dreamlabs/dream-1-beta'
    assert 'PRIVATE_SOURCE_CONFIGURATION' not in json.dumps(state['public_run'])
    assert owner.controller.status()['provider'] is None
    assert owner.controller.status()['source_model']=={'provider':'dream','model':'dreamlabs/dream-1-beta'}
    owner.controller._run_configuration=None
    assert call(app,'/api/status',session=viewer_browser)[1]['public_run']['model_name']=='Model not recorded'


def motion_owner(app):
    """Give the station's visitor a journal with one complete packet lifecycle."""
    visitor = next(iter(app.visitors.values()))
    visitor.controller._interactions = InteractionLog(visitor.directory / ('run_' + 'd' * 32))
    journal = visitor.controller._interactions
    journal.add('run_configuration', 'PRIVATE_CONFIGURATION', configuration={'task': 'PRIVATE_TASK'})
    journal.add('model_response', 'move_to: {"note":"PRIVATE_NOTE"}')
    journal.add('packet_submit', 'Sending 3 waypoints to AWS', trajectory_id='t1',
                cadence_hz=10, waypoint_count=3, waypoints=[[1, 2], [3, 4], [5, 6]])
    journal.add('packet_progress', 'Executing waypoint 1/3', trajectory_id='t1',
                step_id=1, progress_count=1, waypoint_count=3)
    journal.add('packet_progress', 'Executing waypoint 2/3', trajectory_id='t1',
                step_id=2, progress_count=2, waypoint_count=3)
    journal.add('observation', 'Measured arm feedback received', step_id=2,
                left_joints_deg=[1, 2, 3, 4, 5, 6], right_joints_deg=[6, 5, 4, 3, 2, 1],
                left_gripper=0.5, right_gripper=0.25)
    return visitor, journal.directory.name


def test_station_motion_publishes_without_the_conversation_sharing_consent(app_factory):
    """Moves are numeric and publish for every station run; notes do not."""
    app, _, _ = app_factory()
    session(app)
    owner, identity = motion_owner(app)
    owner.controller._share_conversation = False
    state = {'public_run': {'run_id': identity, 'episode_id': 'ep_distinct'}}
    metadata = asyncio.run(app.status_extension(owner, state))
    assert metadata['public_run_shared'] is False
    motion = metadata['motion']
    assert motion['run_id'] == identity
    assert motion['source'] == 'station_journal'
    assert [row['kind'] for row in motion['rows']] == [
        'packet_submit', 'packet_progress', 'observation']
    assert motion['rows'][1]['progress_count'] == 2
    assert motion['rows'][2]['left_joints_deg'] == [1, 2, 3, 4, 5, 6]
    assert 'PRIVATE_' not in json.dumps(motion)


def test_motion_for_another_host_is_named_rather_than_shown_empty(app_factory):
    app, _, _ = app_factory()
    session(app)
    visitor = next(iter(app.visitors.values()))
    visitor.controller._interactions = InteractionLog(visitor.directory / ('run_' + 'e' * 32))
    state = {'public_run': {'run_id': 'ep_from_another_station'}}
    metadata = asyncio.run(app.status_extension(visitor, state))
    assert metadata['motion'] == {'run_id': 'ep_from_another_station',
                                  'source': 'remote_host', 'rows': []}


def test_unreadable_journal_reports_a_gap_instead_of_an_idle_robot(app_factory):
    app, _, _ = app_factory()
    session(app)
    owner, identity = motion_owner(app)

    class Unreadable:
        directory = owner.controller._interactions.directory

        @property
        def lock(self):
            raise RuntimeError('journal is unavailable')

    owner.controller._interactions = Unreadable()
    metadata = asyncio.run(app.status_extension(owner, {'public_run': {'run_id': identity}}))
    assert metadata['motion'] == {'run_id': identity, 'source': 'unavailable', 'rows': []}


def test_idle_station_publishes_no_motion_key(app_factory):
    app, _, _ = app_factory()
    session(app)
    visitor = next(iter(app.visitors.values()))
    assert 'motion' not in asyncio.run(app.status_extension(visitor, {'public_run': None}))


def test_unchanged_journal_is_not_reprojected_for_every_poll(app_factory, monkeypatch):
    """Every visitor polls once a second; an idle journal must stay cheap."""
    app, _, _ = app_factory()
    session(app)
    owner, identity = motion_owner(app)
    calls = []
    original = clawmetry_playground.project_motion
    monkeypatch.setattr(clawmetry_playground, 'project_motion',
                        lambda events, **kwargs: calls.append(len(events)) or original(events, **kwargs))
    state = {'public_run': {'run_id': identity}}
    first = asyncio.run(app.status_extension(owner, state))
    repeat = asyncio.run(app.status_extension(owner, state))
    assert len(calls) == 1
    assert repeat['motion'] == first['motion']
    owner.controller._interactions.add('packet_completed', 'Completed 3 waypoints; arms settled',
                                       trajectory_id='t1', waypoint_count=3)
    after = asyncio.run(app.status_extension(owner, state))
    assert len(calls) == 2
    assert after['motion']['rows'][-1]['kind'] == 'packet_completed'


@pytest.mark.parametrize('cls,enabled', [(LocalPlayground, False), (ClawMetryPlayground, True)])
@pytest.mark.parametrize('name', ['dream', 'dream_flash'])
def test_only_clawmetry_factory_opts_into_native_prequeue_preparation(app_factory, tmp_path, cls, enabled, name):
    credentials = tmp_path / 'inert-dream-credentials'
    credentials.write_text('inert fixture, never loaded')
    app, api, _ = app_factory(cls, dream_credentials_file=str(credentials), dream_python=sys.executable)
    policy = app.extra_providers[name](app.dream_providers[name]['model'], tmp_path / 'inert-worker')
    try:
        assert app.dream_providers[name].get('preparation_before_queue', False) is enabled
        assert callable(getattr(policy, 'prepare_before_session', None)) is enabled
        assert policy.public_config().get('preparation_before_queue', False) is enabled
        assert not api.create_requests and policy._worker is None
    finally:
        policy.close_transport()


def test_prequeue_admission_retains_public_activity_journal_identity_and_episode_owner(app_factory, tmp_path):
    import threading
    import time
    from test_dream_policy import Worker
    credentials = tmp_path/'inert-credentials'
    credentials.write_text('synthetic only')
    entered, release = threading.Event(), threading.Event()
    class HeldWorker(Worker):
        def call(self, command, **kwargs):
            assert command == 'configure'
            entered.set()
            assert release.wait(3)
            return super().call(command, **kwargs)
    app, api, _ = app_factory(dream_credentials_file=str(credentials), dream_python=sys.executable,
                              dream_worker_factory=HeldWorker)
    code, _, _, browser = call(app, '/api/session', {})
    assert code == 200
    visitor = next(iter(app.visitors.values()))
    # Exercise actual preparation/admission but never activate a lease/event loop.
    visitor.controller._run_loop = lambda *args: None
    try:
        response = app.launch(visitor, dict(provider='dream', model=app.dream_providers['dream']['model'],
            prompt='Inert hosted preparation fixture', runner_name='Actual fixture person',
            email='private-fixture@example.test', x_handle='inert_fixture'))
        assert entered.wait(1)
        assert response['preparation_before_queue'] is True
        assert not api.create_requests and visitor.runner_session_id is None
        assert not app.social_database.exists()
        code, state, _, _ = call(app, '/api/status', session=browser)
        assert code == 200 and state['public_run']['status'] == 'preparing'
        run_id = state['public_run']['run_id']
        assert run_id and state['public_run']['runner_name'] == 'Actual fixture person'
        assert 'private-fixture@example.test' not in json.dumps(state['public_run'])
        assert 'inert_fixture' not in json.dumps(state['public_run'])
        release.set()
        visitor.controller._worker.join(3)
        assert not visitor.controller._worker.is_alive()
        sid = visitor.controller.status()['session_id']
        assert sid and len(api.create_requests) == 1
        with visitor.controller._lock:
            visitor.controller._status = 'preparing'
            visitor.controller._episode_id = 'ep_inert_hosted_prequeue'
        app.remember_runner(visitor)
        app.remember_assessment_owner(visitor)
        assert visitor.runner_session_id == sid
        assert not app.social_database.exists()  # Background-only optional contact writes.
        app.flush_runner_contacts(visitor)
        import sqlite3
        with sqlite3.connect(app.social_database) as database:
            rows = database.execute('SELECT session_id,runner_name,x_handle,email FROM run_socials').fetchall()
        assert rows == [(sid, 'Actual fixture person', 'inert_fixture', 'private-fixture@example.test')]
        assert not visitor.pending_runner_contacts
        assert 'ep_inert_hosted_prequeue' in visitor.episode_ids
        code, state, _, _ = call(app, '/api/status', session=browser)
        assert code == 200 and state['public_run']['run_id'] == run_id
        assert state['public_run']['runner_name'] == 'Actual fixture person'
        assert state['public_run']['episode_id'] == 'ep_inert_hosted_prequeue'
        app.run_assessments.assess('ep_inert_hosted_prequeue', 'Failure', 0, visitor.assessment_session)
        assessment = app.run_assessments.detail('ep_inert_hosted_prequeue', visitor.assessment_session)
        assert assessment['label'] == 'Failure'
        # A replacement attempt cannot inherit the stale task/name or ownership.
        with visitor.controller._lock:
            visitor.controller._attempt_id = 'replacement-attempt'
            visitor.controller._session_id = 'replacement-session'
            visitor.controller._episode_id = 'ep_unowned_replacement'
        app.remember_runner(visitor)
        app.remember_assessment_owner(visitor)
        assert visitor.runner_session_id == sid
        assert 'ep_unowned_replacement' not in visitor.episode_ids
        code, state, _, _ = call(app, '/api/status', session=browser)
        assert code == 200 and state['public_run'] is None
        assert not state['whats_running']
        assert not api.action_log and not api.trajectory_log
    finally:
        release.set()
        with visitor.controller._lock:
            visitor.controller._session_id = locals().get('sid')
        visitor.controller.stop()
        provider = visitor.controller._provider
        if provider is not None:
            provider.close_transport()


def test_public_activity_uses_detached_attribution_when_another_launch_interleaves(app_factory):
    app, api, _ = app_factory()
    code, _, _, browser = call(app, '/api/session', {})
    assert code == 200
    visitor = next(iter(app.visitors.values()))
    controller = visitor.controller
    controller._provider = ScriptedAdapter([])
    controller._attempt_id = 'old-attempt'
    controller._source_conversation_attempt_id = 'old-attempt'
    controller._session_id = 'old-session'
    controller._episode_id = 'ep_old_attribution'
    controller._status = 'running'
    controller._run_started_at = None
    controller._run_duration_s = 300
    controller._run_share_conversation = True
    visitor.runner_session_id = 'old-session'
    visitor.runner_binding = dict(attempt_id='old-attempt', task='Old task', name='Old runner',
                                  last_launch=1., launch_requested_at=1.)
    original = app.runner_attribution
    def interleaved(owner, state):
        snapshot = original(owner, state)
        with controller._lock:
            controller._attempt_id = 'new-attempt'
            controller._session_id = 'new-session'
            controller._episode_id = 'ep_new_attribution'
            controller._run_share_conversation = False
            owner.runner_name, owner.runner_task, owner.runner_session_id = 'New runner', 'New private task', 'new-session'
            owner.runner_binding = dict(attempt_id='new-attempt', task='New private task', name='New runner',
                                       last_launch=2., launch_requested_at=2.)
        return snapshot
    app.runner_attribution = interleaved
    code, state, _, _ = call(app, '/api/status', session=browser)
    assert code == 200
    run = state['public_run']
    assert run['attempt_id'] == 'old-attempt' and run['episode_id'] == 'ep_old_attribution'
    assert run['task'] == 'Old task' and run['runner_name'] == 'Old runner'
    assert run['source_conversation_shared'] is True
    assert 'New private task' not in json.dumps(run)
    assert not api.create_requests and not api.action_log


def test_stop_never_flushes_private_pending_contacts(app_factory):
    app, api, _ = app_factory()
    code, _, _, browser = call(app, '/api/session', {})
    assert code == 200
    visitor = next(iter(app.visitors.values()))
    visitor.pending_runner_contacts['inert-attempt'] = dict(session_id='inert-session',
        name='Private fixture', handles={'email':'private-fixture@example.test'})
    app.flush_runner_contacts = Mock(side_effect=AssertionError('Stop must not write contacts'))
    code, _, _, _ = call(app, '/api/stop', {}, session=browser)
    assert code == 200 and not app.flush_runner_contacts.called
    assert not app.social_database.exists() and not api.action_log
