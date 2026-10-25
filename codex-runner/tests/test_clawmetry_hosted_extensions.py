"""Generic hosted extension guards; no provider credentials or network calls."""
from contextlib import suppress
import json
from pathlib import Path
import shutil
import sys
from unittest.mock import Mock

import pytest

import clawmetry_hosted
from clawmetry_playground import ClawMetryPlayground
from local_playground import LocalPlayground, PUBLIC_SESSION_API
from playground import HostedRunner
from test_clawmetry_playground import (
    PLUGIN, SECRET, app_factory, attachment, call, install_plugin, run_payload, session,
)


class HostedExtension(ClawMetryPlayground):
    """A trusted application can retain its own generic runtime hooks."""


@pytest.fixture(autouse=True)
def no_private_policy_configuration(monkeypatch):
    for name in ('YAM_ASPIRE_CONFIG', 'YAM_LOCAL_POLICY_CONFIG'):
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def hosted_apps(tmp_path, monkeypatch):
    for name in ('YAM_SOCIAL_DATABASE', 'YAM_RUN_NAMES_DATABASE', 'YAM_SUBMISSION_DATABASE'):
        monkeypatch.setenv(name, str(tmp_path / (name + '.sqlite3')))
    monkeypatch.setitem(sys.modules, PLUGIN, None)
    # Factory construction must neither fetch data nor connect a model/robot.
    monkeypatch.setattr('urllib.request.urlopen', Mock(side_effect=AssertionError('Unexpected network')))
    created = []

    def create(*args, **kwargs):
        result = clawmetry_hosted.create_app(*args, **kwargs)
        created.append(result)
        return result

    yield create
    for fleet in created:
        for app in fleet.apps.values():
            for visitor in app.visitors.values():
                with suppress(Exception):
                    visitor.close()
            shutil.rmtree(app.root, ignore_errors=True)


@pytest.mark.parametrize('custom', [False, True])
def test_hosted_factory_preserves_defaults_and_native_restrictions(hosted_apps, custom):
    options = {'runner_type': HostedExtension} if custom else {}
    fleet = hosted_apps('https://fixture.invalid', **options)
    catalog = json.loads((Path(clawmetry_hosted.__file__).parent / 'config/robots.json').read_text())
    assert set(fleet.apps) == {robot['id'] for robot in catalog}
    for app in fleet.apps.values():
        assert type(app) is (HostedExtension if custom else ClawMetryPlayground)
        assert app.origin == 'https://fixture.invalid' and app.secure
        assert app.hardware_control and not app.simulation
        assert not app.local_codex and not app.local_claude
        assert not app.groot_key_file and not app.astra_endpoint
        assert app.max_sessions == 8
        assert app.api_factory()._base_url == PUBLIC_SESSION_API
        assert not app.visitors


def test_hosted_factory_preserves_selected_session_api_and_read_only_mode(hosted_apps):
    fleet = hosted_apps('https://fixture.invalid', session_api='https://session.fixture.invalid',
                        allow_hardware_control=False, runner_type=HostedExtension)
    assert all(not app.hardware_control and app.api_factory()._base_url == 'https://session.fixture.invalid'
               for app in fleet.apps.values())


@pytest.mark.parametrize('origin', ['http://fixture.invalid', 'https://fixture.invalid/path',
                                    'https://user:password@fixture.invalid'])
def test_custom_runner_keeps_native_origin_validation(hosted_apps, origin):
    with pytest.raises(ValueError):
        hosted_apps(origin, runner_type=HostedExtension)


@pytest.mark.parametrize('value', [None, object, HostedRunner, LocalPlayground,
                                  'HostedExtension', HostedExtension.__new__(HostedExtension)])
def test_hosted_factory_rejects_untrusted_runner_shapes_before_construction(monkeypatch, value):
    factory = Mock()
    monkeypatch.setattr(clawmetry_hosted, 'fleet', factory)
    with pytest.raises(TypeError):
        clawmetry_hosted.create_app('https://fixture.invalid', runner_type=value)
    factory.assert_not_called()


def test_telemetry_secret_override_is_dynamic_and_keeps_default_visitor_scope(app_factory, monkeypatch):
    supplied = ['additional-secret-fixture-a']

    class Extension(ClawMetryPlayground):
        def telemetry_secrets(self, visitor):
            values = tuple(supplied)
            visitor.public_redactor.remember(values)
            return super().telemetry_secrets(visitor) + values

    attach = Mock(side_effect=lambda *args, **kwargs: attachment('fixture-recording'))
    install_plugin(monkeypatch, attach)
    app, api, _ = app_factory(Extension)
    first_browser, second_browser = session(app), session(app)
    first, second = app.visitors.values()
    callback = attach.call_args_list[0].kwargs['secrets']
    initial = set(callback())
    assert first.csrf in initial and second.csrf not in initial
    assert supplied[0] in initial
    first.saved_keys['openai'] = SECRET
    supplied[:] = ['additional-secret-fixture-b']
    assert set(callback()) == {first.csrf, SECRET, supplied[0]}
    # A later override is resolved when invoked, rather than bound at attach.
    monkeypatch.setattr(app, 'telemetry_secrets', lambda visitor: (visitor.csrf, 'replacement-fixture'))
    assert callback() == (first.csrf, 'replacement-fixture')
    assert call(app, '/api/status', session=first_browser)[0] == 200
    assert call(app, '/api/status', session=second_browser)[0] == 200
    assert not api.create_requests and not api.action_log and not api.trajectory_log


@pytest.mark.parametrize('malformed', [None, 'not-a-secret-sequence', {'invalid': object()}])
def test_secret_override_never_silently_converts_malformed_data_to_empty_success(
        app_factory, monkeypatch, malformed):
    attach = Mock(side_effect=lambda *args, **kwargs: attachment('fixture-recording'))
    install_plugin(monkeypatch, attach)
    app, api, _ = app_factory()
    browser = session(app)
    callback = attach.call_args.kwargs['secrets']
    monkeypatch.setattr(app, 'telemetry_secrets', lambda visitor: malformed)
    # The private consumer must observe invalid input and fail closed itself.
    assert callback() is malformed
    assert call(app, '/api/status', session=browser)[0] == 200
    assert not api.create_requests and not api.action_log and not api.trajectory_log


def test_throwing_secret_supplier_is_not_replaced_by_empty_secrets_and_native_flow_survives(
        app_factory, monkeypatch, caplog):
    class Extension(ClawMetryPlayground):
        def telemetry_secrets(self, visitor):
            raise RuntimeError(SECRET)

    def consume_during_attach(controller, **options):
        options['secrets']()
        raise AssertionError('A throwing secret supplier must reach the consumer')

    install_plugin(monkeypatch, consume_during_attach)
    app, api, _ = app_factory(Extension)
    browser = session(app)
    assert next(iter(app.visitors.values()))._clawmetry_attachment is None
    assert call(app, '/api/run', run_payload(), browser)[0] == 200
    assert call(app, '/api/status', session=browser)[0] == 200
    assert call(app, '/api/stop', {}, browser)[0] == 200
    assert SECRET not in caplog.text
    assert len(api.create_requests) == 1 and not api.action_log and not api.trajectory_log
