"""Optional ClawMetry composition of the shared BluPe playground.

The panel observes existing status delivery. Recording is supplied only by an
installed, entitled private plugin; no robot or provider is created here.
"""
from __future__ import annotations

import logging
from pathlib import Path

from local_playground import LocalPlayground
from playground import HostedRunner

log = logging.getLogger(__name__)
STATIC = Path(__file__).resolve().parent / 'static'
ASSETS = {
    '/static/telemetry-status.js': ('telemetry-status.js', 'text/javascript; charset=utf-8'),
    '/static/clawmetry-widget.js': ('clawmetry-widget.js', 'text/javascript; charset=utf-8'),
    '/static/clawmetry-widget.css': ('clawmetry-widget.css', 'text/css; charset=utf-8'),
}
HEAD = b'''<link rel="stylesheet" href="/static/clawmetry-widget.css">
  <script src="/static/telemetry-status.js" defer></script>
  <script src="/static/clawmetry-widget.js" defer></script>'''


def _secrets(visitor):
    values = [visitor.csrf, *visitor.saved_keys.values()]
    key = getattr(visitor.controller._provider, '_api_key', None)
    if isinstance(key, str) and key:
        values.append(key)
    return tuple(value for value in values if isinstance(value, str) and value)


class ClawMetryMixin:
    """Compose with an existing hosted product without replacing its hooks."""

    def telemetry_secrets(self, visitor):
        """Supply known in-memory secrets to the optional private recorder."""
        return _secrets(visitor)

    def page(self):
        page = super().page()
        marker = b'<!-- application-head -->'
        return page.replace(marker, HEAD, 1) if marker in page else page.replace(b'</head>', HEAD + b'\n</head>', 1)

    async def public_extension(self, scope, receive, send, headers):
        asset = ASSETS.get(scope['path'])
        if asset is not None and scope['method'] == 'GET':
            name, content_type = asset
            await self.respond(send, 200, (STATIC / name).read_bytes(), content_type)
            return True
        return await super().public_extension(scope, receive, send, headers)

    def new_visitor(self):
        capability, visitor = super().new_visitor()
        # The optional private package owns all recording implementation.
        try:
            from clawmetry_pro.robotics.blupe_playground import attach_controller
            attachment = attach_controller(
                visitor.controller, capture_text=True,
                secrets=lambda: self.telemetry_secrets(visitor),
                source_shared=lambda: getattr(visitor.controller, '_run_share_conversation', False) is True,
                environment='simulation' if self.simulation else 'hardware',
            )
        except ImportError:
            attachment = None
        except Exception:
            log.warning('ClawMetry recording is unavailable; the playground continues normally')
            attachment = None
        visitor._clawmetry_attachment = attachment
        if attachment is not None:
            original_close = visitor.close

            def close():
                try:
                    return original_close()
                finally:
                    try:
                        attachment.close()
                    except Exception:
                        log.warning('ClawMetry cleanup is unavailable; native session cleanup is unchanged')

            visitor.close = close
        return capability, visitor

    async def status_extension(self, visitor, state):
        run = state.get('public_run')
        shared = False
        if isinstance(run, dict) and run.get('run_id'):
            # Locally hosted runs have recording identities. Public API runs
            # instead use episode identities; do not conflate the two.
            local_owner = None
            for candidate in tuple(self.visitors.values()):
                recording = getattr(candidate.controller, '_interactions', None)
                directory = getattr(recording, 'directory', None)
                if directory is not None and directory.name == run['run_id']:
                    local_owner = candidate
                    break
            if type(run.get('source_conversation_shared')) is bool:
                # Publication consent belongs to this captured run, not a
                # mutable preference for another task that may be launching.
                shared = run['source_conversation_shared']
            elif local_owner is not None:
                shared = False
            else:
                published = (state.get('queue_snapshot') or {}).get('public_run')
                shared = isinstance(published, dict) and published.get('run_id') == run['run_id']
        inherited = await super().status_extension(visitor, state)
        metadata = dict(inherited) if isinstance(inherited, dict) else {}
        metadata.update(state='observing', public_run_shared=shared)
        attachment = getattr(visitor, '_clawmetry_attachment', None)
        if attachment is not None:
            try:
                receipt = attachment.receipt()
                if (isinstance(receipt, dict) and state.get('session_id')
                        and receipt.get('source_session_id') == state['session_id']):
                    metadata['recording'] = receipt
                else:
                    metadata['recording'] = {'state': 'waiting', 'persistence': 'unconfirmed'}
            except Exception:
                metadata['recording'] = {'state': 'unavailable'}
        return metadata


class ClawMetryPlayground(ClawMetryMixin, LocalPlayground):
    """The shared local/media playground with optional ClawMetry composition."""


def with_clawmetry(runner_type):
    """Opt a hosted application subclass in without replacing billing hooks."""
    if not isinstance(runner_type, type) or not issubclass(runner_type, HostedRunner):
        raise TypeError('Choose an existing HostedRunner application class')
    if issubclass(runner_type, ClawMetryMixin):
        return runner_type
    return type('ClawMetry' + runner_type.__name__, (ClawMetryMixin, runner_type), {})
