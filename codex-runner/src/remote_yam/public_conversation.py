"""Explicit public projection of model messages; never publish wire payloads."""
import json
import re
import math
import threading

from .public_task_progress import public_text


class PublicRedactionUnavailable(Exception):
    """A public copy cannot safely be made with the bounded known-secret set."""


class PublicTextRedactor:
    """Retain bounded in-memory secrets while this visitor's notes remain visible."""

    def __init__(self, *, max_secrets=256, max_secret_bytes=65536):
        self._known = set()
        self._bytes = 0
        self._available = True
        self._version = 0
        self._lock = threading.RLock()
        self.max_secrets = max_secrets
        self.max_secret_bytes = max_secret_bytes

    def disable(self):
        with self._lock:
            self._available = False
            self._known.clear()
            self._bytes = 0
            self._version += 1

    def remember(self, values):
        try:
            with self._lock:
                if not self._available:
                    return
                for index, value in enumerate(values):
                    if index >= 1024:
                        self.disable()
                        return
                    if not isinstance(value, str) or not value or value in self._known:
                        continue
                    size = len(value.encode('utf-8'))
                    if (len(value) > 4096 or len(self._known) >= self.max_secrets
                            or self._bytes + size > self.max_secret_bytes):
                        self.disable()
                        return
                    self._known.add(value)
                    self._bytes += size
                    self._version += 1
        except Exception:
            self.disable()

    def copy(self, value):
        with self._lock:
            if not self._available:
                raise PublicRedactionUnavailable()
            version = self._version
            secrets = sorted(self._known, key=len, reverse=True)
        nodes, characters = 20000, 2 * 1024 * 1024

        def clean_text(text):
            nonlocal characters
            characters -= len(text)
            if characters < 0:
                raise PublicRedactionUnavailable()
            for secret in secrets:
                text = text.replace(secret, '[redacted]')
            return public_text(text)

        def visit(item, depth=0):
            nonlocal nodes
            nodes -= 1
            if nodes < 0 or depth > 20:
                raise PublicRedactionUnavailable()
            if isinstance(item, str):
                return clean_text(item)
            if item is None or isinstance(item, (bool, int)):
                return item
            if isinstance(item, float):
                return item if math.isfinite(item) else None
            if isinstance(item, dict):
                if not all(isinstance(key, str) for key in item):
                    raise PublicRedactionUnavailable()
                return {clean_text(key): visit(part, depth + 1) for key, part in item.items()}
            if isinstance(item, (list, tuple)):
                return [visit(part, depth + 1) for part in item]
            raise PublicRedactionUnavailable()

        result = visit(value)
        with self._lock:
            if not self._available or self._version != version:
                raise PublicRedactionUnavailable()
        return result


def public_run_copy(value, redactor):
    """Sanitize only the owning local source, without changing its private journal."""
    try:
        return redactor.copy(value)
    except Exception:
        # Keep the public record shape and safe timing metadata;
        # arbitrary model text/details are unavailable, never returned unfiltered.
        # Queue data can add arbitrary keys. On failure even a field name may
        # contain a secret, so preserve only the known public record schema.
        allowed = {'run_id', 'attempt_id', 'episode_id', 'runner_name', 'task',
                   'launch_requested_at', 'status', 'events', 'error', 'step_timings',
                   'run_metrics', 'model_name', 'launch_route', 'task_progress',
                   'run_duration_s', 'run_started_at', 'run_ended_at', 'run_elapsed_s',
                   'source_conversation_shared', 'position', 'session_id', 'created_at'}
        result = {key: None for key in value if key in allowed}
        for key in ('launch_requested_at', 'run_duration_s', 'run_started_at', 'run_ended_at', 'run_elapsed_s'):
            number = value.get(key)
            if type(number) in (int, float) and abs(number) <= 1e15 and math.isfinite(number):
                result[key] = number
        status = value.get('status')
        if isinstance(status, str) and status in {'idle', 'queued', 'preparing', 'running', 'stopping', 'stopped',
                      'completed', 'failed', 'disconnected', 'safety_aborted', 'timed_out'}:
            result['status'] = status
        result.update(events=[], step_timings=[], runner_name='Anonymous', error=None,
                      source_conversation_shared=value.get('source_conversation_shared') is True,
                      warning='Public model text is unavailable.')
        return result


def request_images(content, recorder):
    if recorder is None:
        return []
    images = []
    name = 'Camera'
    for part in content:
        if part.get('type') == 'input_text':
            match = re.search(r"camera '(top|overhead|front|left|right)_cam'", part.get('text', ''))
            if match:
                name = match.group(1)
        elif part.get('type') == 'input_image':
            packed = recorder._pack(part['image_url'])
            digest = packed.rsplit('$blob:', 1)[-1]
            if re.fullmatch('[a-f0-9]{64}', digest):
                images.append({'name': name, 'digest': digest})
    return images


def response_text(raw):
    text = []
    output = raw.get('output') if isinstance(raw, dict) else None
    if not isinstance(output, list):
        return ''
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get('type') == 'message':
            content = item.get('content')
            if isinstance(content, list):
                text.extend(part['text'] for part in content
                            if isinstance(part, dict) and part.get('type') == 'output_text'
                            and isinstance(part.get('text'), str))
        elif item.get('type') == 'function_call':
            text.append(f"{item.get('name', 'Tool call')}: {item.get('arguments', '')}")
    return '\n\n'.join(text)


def project_events(events, run_id):
    output = []
    for event in events:
        if event.get('kind') not in {'model_request', 'model_response', 'model_progress', 'steering_queued', 'steering_included'}:
            continue
        details = event.get('details') or {}
        message = (details.get('request_text') or details.get('observation') or details.get('prompt')) if event['kind'] == 'model_request' else details.get('response')
        row = {key: event.get(key) for key in ('id', 'timestamp', 'kind')}
        row['message'] = message or event.get('message', '')
        if event['kind'] == 'model_request' and details.get('request_display'):
            row['request'] = details['request_display']
        if event['kind'] == 'model_progress':
            category = details.get('progress_type')
            if category not in {'summary', 'status'}:
                continue
            row['message'] = str(event.get('message', ''))[:4000]
            row['progress_type'] = category
        row['images'] = []
        for image in details.get('images', []) if event['kind'] == 'model_request' else []:
            digest = image.get('digest', '')
            if re.fullmatch('[a-f0-9]{64}', digest) and image.get('name') in {'top', 'overhead', 'front', 'left', 'right'}:
                row['images'].append({'name': image['name'], 'url': f'/api/public-images/{run_id}/{digest}'})
        output.append(row)
    return output


def request_display(payload, recorder):
    """Copy actual outbound fields; replace image bytes with recorded blob refs.

    Opaque encrypted reasoning is not conversation text and is excluded here.
    The original payload and exact private wire recording remain untouched.
    """
    import copy
    visible = copy.deepcopy(payload)
    visible['input'] = [item for item in visible.get('input', []) if item.get('type') != 'reasoning']
    if recorder is None:
        return None
    return recorder._pack(visible)


def request_text(payload):
    sections = []
    for item in payload.get('input', []):
        if item.get('role') not in {'system', 'developer', 'user'}:
            continue
        content = item.get('content', '')
        if isinstance(content, list):
            content = '\n'.join(part.get('text', '') for part in content if part.get('type') == 'input_text')
        sections.append(item['role'].capitalize() + ':\n' + str(content))
    return '\n\n'.join(sections)
