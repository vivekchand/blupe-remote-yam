"""Optional service-owned worker observation, independent of model/control code."""
from contextlib import contextmanager, redirect_stdout
import importlib.util
import json
from pathlib import Path
import sys


class WorkerObserver:
    """Trusted local extension; its failure must never change native execution.

    The extension owns capture/redaction/storage. Only bounded metadata crosses
    the existing worker IPC. Module/config paths are never taken from a command.
    """
    def __init__(self, module_path=None, context_path=None):
        self.observer = None
        self._source_context = None
        self._retired = False
        self._close_attempted = False
        self._close_failed = False
        self.state = 'disabled' if not module_path else 'unavailable'
        if not module_path:
            return
        try:
            path = Path(module_path)
            if not path.is_absolute() or not path.is_file():
                return
            if context_path is not None and not Path(context_path).is_absolute():
                return
            spec = importlib.util.spec_from_file_location('_yam_service_worker_observer', path)
            module = importlib.util.module_from_spec(spec)
            # Standalone extensions may use dataclasses; no sys.path mutation.
            sys.modules[spec.name] = module
            with redirect_stdout(sys.stderr):
                spec.loader.exec_module(module)
                self.observer = module.create_observer(context_path=context_path)
            self.state = 'ready' if self.observer is not None else 'unavailable'
        except BaseException:
            self.observer = None

    def install(self, client, *, source_trace=None):
        if self.observer is not None:
            try:
                with redirect_stdout(sys.stderr):
                    self.observer.install(client, source_trace=source_trace)
            except BaseException:
                self.state = 'unavailable'

    def bind_source(self, context):
        """Retire capture before any SDK input from another native source."""
        if self._retired or self.observer is None:
            return
        try:
            source = tuple(context.get(name) for name in
                           ('attempt_id', 'session_id', 'episode_id', 'robot_id'))
            valid = all(value is None or isinstance(value, str) for value in source)
        except BaseException:
            source, valid = None, False
        if not valid or (self._source_context is not None and source != self._source_context):
            self.close()
            self.observer = None
            self.state = 'unavailable'
            self._retired = True
            return
        self._source_context = source

    @contextmanager
    def prediction(self, context):
        self.bind_source(context)
        manager = None
        if self.observer is not None:
            try:
                with redirect_stdout(sys.stderr):
                    manager = self.observer.prediction(dict(context))
                    manager.__enter__()
            except BaseException:
                manager = None
                self.state = 'unavailable'
        try:
            yield
        except BaseException:
            # Extensions cannot suppress or replace a native SDK exception.
            if manager is not None:
                try:
                    with redirect_stdout(sys.stderr):
                        manager.__exit__(*sys.exc_info())
                except BaseException:
                    self.state = 'unavailable'
            raise
        else:
            if manager is not None:
                try:
                    with redirect_stdout(sys.stderr):
                        manager.__exit__(None, None, None)
                except BaseException:
                    self.state = 'unavailable'

    def drain(self):
        if self.observer is None:
            return None if self.state == 'disabled' else {'state': self.state}
        try:
            with redirect_stdout(sys.stderr):
                value = self.observer.drain()
            if not isinstance(value, dict):
                raise ValueError('Observer metadata must be an object')
            def check(item, depth=0):
                if depth > 8:
                    raise ValueError('Observer metadata is too deep')
                if isinstance(item, dict):
                    if len(item) > 64:
                        raise ValueError('Observer metadata has too many fields')
                    for key, row in item.items():
                        if not isinstance(key, str):
                            raise ValueError('Observer metadata keys must be strings')
                        check(row, depth+1)
                elif isinstance(item, list):
                    if len(item) > 64:
                        raise ValueError('Observer metadata has too many rows')
                    for row in item:
                        check(row, depth+1)
                elif item is not None and type(item) not in (str, int, float, bool):
                    raise ValueError('Observer metadata must be JSON')
            check(value)
            encoded = json.dumps(value, allow_nan=False)
            if len(encoded.encode('utf-8')) > 32768:
                raise ValueError('Observer metadata exceeds IPC budget')
            detached = json.loads(encoded)  # Detached from extension buffers.
            if self.state != 'ready':
                detached['state'] = self.state
            return detached
        except BaseException:
            self.state = 'unavailable'
            return {'state': self.state}

    def close(self):
        if self._close_attempted:
            return not self._close_failed
        self._close_attempted = True
        if self.observer is not None:
            try:
                with redirect_stdout(sys.stderr):
                    self.observer.close()
            except BaseException:
                self.state = 'unavailable'
                self._close_failed = True
        return not self._close_failed
