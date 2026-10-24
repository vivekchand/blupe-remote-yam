"""Native public copies must not reveal retained credentials or a later run's consent."""
import copy
import json

import pytest

from remote_yam.interactions import InteractionLog
from remote_yam.providers import ScriptedAdapter
from test_clawmetry_playground import app_factory, call, session


@pytest.fixture
def shared_source(app_factory):
    app, api, _ = app_factory()
    owner_browser, viewer_browser = session(app), session(app)
    owner, viewer = app.visitors.values()
    key = 'opaque-fixture-provider-token-586291'
    capability = 'opaque-fixture-session-capability-196725'
    lease = 'opaque-fixture-lease-751942'
    source_id = api.create_session('Isolated public-copy source')['session_id']
    api._session_capabilities = {source_id: capability}
    owner.saved_keys['openai'] = key
    owner.controller._provider = ScriptedAdapter([])
    owner.controller._provider._api_key = key
    owner.controller._status = 'stopped'
    owner.controller._session_id = source_id
    owner.controller._lease_id = lease
    owner.controller._share_conversation = True
    owner.controller._run_share_conversation = True
    owner.runner_session_id = source_id
    owner.runner_task = 'Public fixture task'
    journal = InteractionLog(owner.directory / ('run_' + 'd' * 32))
    owner.controller._interactions = journal
    secrets = (key, capability, lease, owner.csrf, owner_browser[0].split('=', 1)[1])
    journal.add('model_progress', 'Published summary ' + ' '.join(secrets), progress_type='summary')
    journal.add('model_request', 'Request recorded', request_text='Context ' + key,
                request_display={'input': [{'content': key}], 'headers': {'Authorization': capability},
                                 'nested': {'note': lease, key: owner.csrf}})
    return app, owner, owner_browser, viewer_browser, secrets, journal


@pytest.mark.parametrize('forget', [False, True])
def test_known_secrets_are_redacted_from_public_copy_even_after_forget(shared_source, forget):
    app, owner, owner_browser, viewer_browser, secrets, journal = shared_source
    original = copy.deepcopy(journal.snapshot())
    if forget:
        assert call(app, '/api/credentials/clear', {}, owner_browser)[0] == 200
        assert not owner.saved_keys and not owner.controller._provider._api_key
        publisher = owner.controller._conversation_publisher
        if publisher is not None:
            publisher._secrets = ()
    code, state, _, _ = call(app, '/api/status', session=viewer_browser)
    assert code == 200
    public = json.dumps(state['public_run'])
    for secret in secrets:
        assert secret not in public
    assert 'Published summary' in public and '[redacted]' in public
    assert journal.snapshot() == original


def test_a_later_run_cannot_authorize_an_older_private_status_snapshot(shared_source, monkeypatch):
    app, owner, _, viewer_browser, _, journal = shared_source
    owner.controller._share_conversation = False
    owner.controller._run_share_conversation = False
    status = owner.controller.status

    def old_snapshot_then_new_run():
        captured = status()
        owner.controller._share_conversation = True
        owner.controller._run_share_conversation = True
        owner.controller._interactions = InteractionLog(owner.directory / ('run_' + 'e' * 32))
        return captured

    monkeypatch.setattr(owner.controller, 'status', old_snapshot_then_new_run)
    code, state, _, _ = call(app, '/api/status', session=viewer_browser)
    assert code == 200
    assert state['public_run']['run_id'] == journal.directory.name
    assert state['public_run']['events'] == []
    assert state['public_run']['source_conversation_shared'] is False
    assert state['telemetry']['public_run_shared'] is False


def test_already_published_remote_copy_is_not_filtered_with_observers_unrelated_key(app_factory):
    app, api, _ = app_factory()
    browser = session(app)
    viewer = next(iter(app.visitors.values()))
    public_word = 'published-remote-scene-value'
    viewer.saved_keys['openai'] = public_word
    app.queue = api.get_queue_snapshot()
    app.queue['public_run'] = {'run_id': 'ep_remote', 'task': public_word, 'status': 'running',
                               'events': [{'id': 1, 'kind': 'model_response', 'message': public_word}]}
    code, state, _, _ = call(app, '/api/status', session=browser)
    assert code == 200
    assert state['public_run']['task'] == public_word
    assert state['public_run']['events'][0]['message'] == public_word


def test_owner_labels_and_local_queue_copy_mask_own_retained_credentials(shared_source):
    app, owner, _, viewer_browser, secrets, journal = shared_source
    key = secrets[0]
    owner.runner_name = 'Runner ' + key
    owner.runner_task = 'Task ' + key
    owner.controller._status = 'running'
    owner.controller._run_started_at = None
    owner.controller._run_duration_s = 300
    app.queue = owner.controller._session_api.get_queue_snapshot()
    entry = next(row for row in app.queue['entries'] if row['session_id'] == owner.runner_session_id)
    entry['prompt'] = key
    original = copy.deepcopy(journal.snapshot())
    code, state, _, _ = call(app, '/api/status', session=viewer_browser)
    assert code == 200
    assert key not in json.dumps(state)
    assert state['whats_running'][0]['task'] == 'Task [redacted]'
    assert owner.runner_name.endswith(key) and owner.runner_task.endswith(key)
    assert journal.snapshot() == original


def test_known_secret_matching_a_structural_field_never_breaks_native_status(shared_source):
    app, owner, _, viewer_browser, _, _ = shared_source
    owner.saved_keys['openai'] = 'runner_name'
    owner.controller._provider._api_key = 'runner_name'
    app.queue = owner.controller._session_api.get_queue_snapshot()
    code, state, _, _ = call(app, '/api/status', session=viewer_browser)
    assert code == 200
    assert state['queue_snapshot']['entries']
    assert state['telemetry']['state'] == 'observing'


@pytest.mark.parametrize('shared', [False, True])
def test_matched_local_episode_queue_publication_is_sanitized_before_any_selection(shared_source, shared):
    app, owner, _, viewer_browser, secrets, journal = shared_source
    key = secrets[0]
    owner.controller._episode_id = 'ep_owned_redaction_case'
    owner.controller._run_share_conversation = shared
    app.queue = owner.controller._session_api.get_queue_snapshot()
    app.queue['public_run'] = {'run_id': 'ep_owned_redaction_case', 'task': key,
        'status': 'running', 'events': [{'kind': 'model_response', 'message': key}]}
    original = copy.deepcopy(journal.snapshot())
    code, state, _, _ = call(app, '/api/status', session=viewer_browser)
    assert code == 200
    assert key not in json.dumps(state)
    assert state['public_run']['run_id'] == journal.directory.name
    published = state['queue_snapshot']['public_run']
    assert published['source_conversation_shared'] is shared
    assert published['task'] == '[redacted]'
    assert published['events'] == ([{'kind': 'model_response', 'message': '[redacted]'}] if shared else [])
    assert app.queue['public_run']['task'] == key
    assert journal.snapshot() == original


@pytest.mark.parametrize('previous_consent', [None, False, True])
def test_previous_owned_episode_remains_redacted_after_source_advances(shared_source, previous_consent):
    app, owner, _, viewer_browser, secrets, _ = shared_source
    key = secrets[0]
    owner.episode_ids.add('ep_owned_previous')
    if previous_consent is not None:
        owner.public_episode_consent['ep_owned_previous'] = previous_consent
    owner.controller._episode_id = 'ep_owned_next'
    app.queue = owner.controller._session_api.get_queue_snapshot()
    app.queue['public_run'] = {'run_id': 'ep_owned_previous', 'task': key,
        'status': 'completed', 'events': [{'kind': 'model_response', 'message': key}]}
    code, state, _, _ = call(app, '/api/status', session=viewer_browser)
    assert code == 200 and key not in json.dumps(state)
    published = state['queue_snapshot']['public_run']
    assert published['source_conversation_shared'] is (previous_consent is True)
    assert published['events'] == ([{'kind': 'model_response', 'message': '[redacted]'}]
                                    if previous_consent else [])


def test_history_retains_actual_source_consent_with_a_bounded_observation_cache(shared_source):
    app, owner, _, _, _, _ = shared_source
    owner.controller._share_conversation = False
    owner.controller._run_share_conversation = True
    for index in range(21):
        owner.controller._episode_id = f'ep_owned_{index}'
        app.remember_runner(owner)
    assert owner.public_episode_consent['ep_owned_0'] is True
    assert len(owner.public_episode_consent) == 20
    # Native history still proves ownership when the optional consent cache is
    # full; the public projection withholds notes for that unknown consent.
    assert 'ep_owned_20' in owner.episode_ids
    assert 'ep_owned_20' not in owner.public_episode_consent


def test_publication_attempt_and_consent_stay_bound_during_blocked_new_join(app_factory, monkeypatch):
    import threading
    app, api, _ = app_factory()
    session(app)
    viewer_browser = session(app)
    owner = next(iter(app.visitors.values()))
    controller = owner.controller
    controller._share_conversation = True
    first = controller.join(ScriptedAdapter([]), 'First isolated run')
    owner.runner_session_id = first['session_id']
    owner.runner_task = 'First isolated run'
    old_run, old_attempt = first['interactions']['run_id'], first['attempt_id']
    controller._status = 'stopped'
    controller._share_conversation = False
    entered, release = threading.Event(), threading.Event()
    create = api.create_session
    errors = []

    def blocked_create(prompt, *args, **kwargs):
        entered.set()
        assert release.wait(5)
        return create(prompt, *args, **kwargs)

    def join():
        try:
            controller.join(ScriptedAdapter([]), 'Next private run')
        except BaseException as exc:
            errors.append(exc)

    monkeypatch.setattr(api, 'create_session', blocked_create)
    worker = threading.Thread(target=join)
    worker.start()
    try:
        assert entered.wait(5)
        assert controller._attempt_id != old_attempt
        code, state, _, _ = call(app, '/api/status', session=viewer_browser)
        assert code == 200
        assert state['public_run']['run_id'] == old_run
        assert state['public_run']['attempt_id'] == old_attempt
        assert state['public_run']['source_conversation_shared'] is True
    finally:
        release.set()
        worker.join(5)
    assert not worker.is_alive() and not errors
    current = controller.status()
    assert current['source_conversation_attempt_id'] == current['attempt_id']
    assert current['source_conversation_shared'] is False


@pytest.mark.parametrize('failure', ['count', 'bytes', 'length', 'iteration'])
def test_retention_budget_failure_is_sticky_and_never_returns_unfiltered_text(failure):
    from remote_yam.public_conversation import PublicTextRedactor, PublicRedactionUnavailable, public_run_copy
    redactor = PublicTextRedactor()
    values = ([f'opaque-secret-{i}' for i in range(257)] if failure == 'count' else
              ['x' * 4097] if failure == 'length' else
              [str(i) + 'x' * 4000 for i in range(17)] if failure == 'bytes' else
              ['same'] * 1025)
    redactor.remember(values)
    redactor.remember(['new'])
    with pytest.raises(PublicRedactionUnavailable):
        redactor.copy({'message': 'secret'})
    result = public_run_copy({'run_id': 'opaque-secret', 'task': 'secret',
                             'status': 'running', 'events': [{'message': 'secret'}]}, redactor)
    assert result['events'] == [] and result['task'] is None and result['run_id'] is None
    assert result['status'] == 'running'


@pytest.mark.parametrize('payload', ['cycle', 'deep', 'large', 'invalid'])
def test_public_copy_limits_fail_closed_without_mutating_private_data(payload):
    from remote_yam.public_conversation import PublicTextRedactor, public_run_copy
    data = []
    if payload == 'cycle':
        data.append(data)
    elif payload == 'deep':
        for _ in range(22):
            data = [data]
    elif payload == 'large':
        data = ['x' * (2 * 1024 * 1024 + 1)]
    else:
        data = [object()]
    source = {'task': 'sensitive', 'events': data, 'run_started_at': 12.5}
    result = public_run_copy(source, PublicTextRedactor())
    assert result['events'] == [] and result['task'] is None
    assert result['run_started_at'] == 12.5
    assert source['events'] is data and source['task'] == 'sensitive'


def test_secret_added_while_copying_prevents_stale_redaction_snapshot(monkeypatch):
    import remote_yam.public_conversation as module
    redactor = module.PublicTextRedactor()
    original = module.public_text

    def concurrent_secret(value):
        redactor.remember(['newly-known-secret'])
        return original(value)

    monkeypatch.setattr(module, 'public_text', concurrent_secret)
    result = module.public_run_copy({'task': 'newly-known-secret', 'events': []}, redactor)
    assert result['task'] is None and result['events'] == []


def test_fail_closed_queue_copy_does_not_preserve_arbitrary_secret_field_names():
    from remote_yam.public_conversation import PublicTextRedactor, public_run_copy
    redactor = PublicTextRedactor()
    redactor.disable()
    source = {'opaque-secret-field-name': 'private', 'status': 'queued', 'position': 2}
    result = public_run_copy(source, redactor)
    assert 'opaque-secret-field-name' not in json.dumps(result)
    assert result['status'] == 'queued'
    assert source['opaque-secret-field-name'] == 'private'


def test_unavailable_redaction_keeps_native_status_and_stop_working(shared_source):
    app, owner, owner_browser, viewer_browser, secrets, journal = shared_source
    original = copy.deepcopy(journal.snapshot())
    owner.public_redactor.disable()
    code, state, _, _ = call(app, '/api/status', session=viewer_browser)
    assert code == 200
    assert state['public_run']['events'] == [] and state['public_run']['task'] is None
    assert all(secret not in json.dumps(state) for secret in secrets)
    assert journal.snapshot() == original
    assert call(app, '/api/stop', {}, owner_browser)[0] == 200
