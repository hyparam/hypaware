"""LangGraph Python callbacks backed by HypAware's shared local recorder.

No network sender or separately managed service. LangChain is already supplied
by the application's LangGraph installation; everything else is standard library.
"""
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import uuid
import weakref

from langchain_core.callbacks import BaseCallbackHandler

_MAX_BYTES = 512 * 1024
_TIMEOUT = 10


def _encode(value):
    stack = [value]
    budget = _MAX_BYTES
    nodes = 0
    while stack:
        item = stack.pop()
        nodes += 1
        if nodes > 16384:
            raise ValueError('event_limit')
        if isinstance(item, str):
            if len(item) > _MAX_BYTES:
                raise ValueError('event_limit')
            budget -= len(item.encode('utf-8'))
        elif isinstance(item, dict):
            if len(item) > 4096:
                raise ValueError('event_limit')
            for key, val in item.items():
                key = str(key)
                if len(key) > _MAX_BYTES:
                    raise ValueError('event_limit')
                budget -= len(key.encode('utf-8')) + 4
                if budget < 0:
                    raise ValueError('event_limit')
                stack.append(val)
        elif isinstance(item, (list, tuple)):
            if len(item) > 4096:
                raise ValueError('event_limit')
            stack.extend(item)
        if budget < 0 or len(stack) > 16384:
            raise ValueError('event_limit')
    body = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(body) > _MAX_BYTES:
        raise ValueError('event_limit')
    return body + b'\n'


def _message(value):
    content = value.content
    if isinstance(content, list):
        if len(content) > 4096:
            raise ValueError('event_limit')
        content = [b for b in content if isinstance(b, dict) and b.get('type') in ('text', 'output_text')]
    metadata = getattr(value, 'response_metadata', {}) or {}
    return {k: v for k, v in {
        'id': value.id, 'type': value.type, 'name': getattr(value, 'name', None),
        'content': content, 'tool_calls': getattr(value, 'tool_calls', None),
        'tool_call_id': getattr(value, 'tool_call_id', None),
        'usage_metadata': getattr(value, 'usage_metadata', None),
        'response_metadata': {'model_name': metadata.get('model_name') or metadata.get('model')},
    }.items() if v is not None}


def _worker(child, requests, replies):
    try:
        while True:
            body = requests.get()
            if body is None:
                return
            remaining = memoryview(body)
            while remaining:
                written = child.stdin.write(remaining)
                if not written:
                    raise RuntimeError('helper_failed')
                remaining = remaining[written:]
            child.stdin.flush()
            line = child.stdout.readline(4097)
            if not line.endswith(b'\n') or len(line) > 4096:
                raise RuntimeError('helper_failed')
            replies.put(json.loads(line))
    except Exception:
        # Scalar failure only; never expose the request or provider exceptions.
        try:
            replies.put_nowait(None)
        except queue.Full:
            pass


def _cleanup(child, requests, worker):
    if child.poll() is None:
        child.kill()
    try:
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        pass
    try:
        requests.put_nowait(None)
    except queue.Full:
        pass
    if threading.current_thread() is not worker:
        worker.join(timeout=1)
    for stream in (child.stdin, child.stdout):
        stream.close()


# @ref LLP 0548#python: Python adapts the callbacks; the existing recorder owns policy, projection and durable acknowledgement
class HypAwareCallback(BaseCallbackHandler):
    raise_error = False
    run_inline = False

    def __init__(self, *, session_id=None, cwd=None, module_path=None, node_path='node'):
        self.session_id = session_id or str(uuid.uuid4())
        if not isinstance(self.session_id, str) or not self.session_id.strip() or len(self.session_id) > 4096:
            raise ValueError('session_id must be 1 to 4096 characters')
        self._cwd = str(Path(cwd or os.getcwd()).resolve())
        self._module = str(Path(module_path or Path.home() / '.config/hypaware/langgraph.mjs').resolve())
        self._node = node_path
        self._lock = threading.RLock()
        self._child = None
        self._finalizer = None
        self._closed = False
        self._failed = False
        self._local_drops = 0
        self._last_error = ''
        self._status = {'queued': 0, 'dropped': 0, 'policyDrops': 0, 'active_callbacks': 0,
                        'session_id': self.session_id, 'lastError': ''}

    def _exchange(self, body):
        self._requests.put(body, timeout=_TIMEOUT)
        result = self._replies.get(timeout=_TIMEOUT)
        if not isinstance(result, dict):
            raise RuntimeError('helper_failed')
        self._status = {**result, 'session_id': self.session_id}

    def _open(self):
        bridge = Path(__file__).resolve().parent.parent / 'src/python_bridge.js'
        self._child = subprocess.Popen([self._node, str(bridge)], stdin=subprocess.PIPE,
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        self._requests = queue.Queue(maxsize=1)
        self._replies = queue.Queue(maxsize=1)
        worker = threading.Thread(target=_worker, args=(self._child, self._requests, self._replies), daemon=True)
        self._finalizer = weakref.finalize(self, _cleanup, self._child, self._requests, worker)
        worker.start()
        self._exchange(_encode({'method': 'init', 'modulePath': self._module,
                               'options': {'sessionId': self.session_id, 'cwd': self._cwd}}))

    def _send(self, method, args):
        if self._closed:
            return
        if self._failed:
            raise RuntimeError('helper_failed')
        # Encode before launching a process or placing anything in a queue.
        body = _encode({'method': method, 'args': args})
        try:
            if self._child is None:
                self._open()
            self._exchange(body)
        except Exception:
            self._failed = True
            if self._finalizer:
                self._finalizer()
            raise

    def _safe(self, action):
        if not self._lock.acquire(timeout=_TIMEOUT):
            self._local_drops += 1
            self._last_error = 'callback_busy'
            return
        try:
            action()
        except Exception as error:
            self._local_drops += 1
            self._last_error = 'event_limit' if str(error) == 'event_limit' else 'recording_failed'
        finally:
            self._lock.release()

    def status(self):
        with self._lock:
            return {**self._status, 'dropped': self._status['dropped'] + self._local_drops,
                    'lastError': self._last_error or self._status['lastError'], 'closed': self._closed}

    def close(self):
        with self._lock:
            self._closed = True
            if self._finalizer:
                self._finalizer()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def on_chain_start(self, serialized, inputs, *, run_id, parent_run_id=None, **kwargs):
        # Only root boundaries affect recorder state. Never serialize graph state.
        if parent_run_id is None:
            self._safe(lambda: self._send('handleChainStart', [{}, {}, str(run_id), None]))

    def on_chain_end(self, outputs, *, run_id, parent_run_id=None, **kwargs):
        if parent_run_id is not None:
            return
        self._safe(lambda: self._send('handleChainEnd', [{}, str(run_id)]))

    def on_chain_error(self, error, *, run_id, parent_run_id=None, **kwargs):
        if parent_run_id is not None:
            return
        self._safe(lambda: self._send('handleChainError', [{'name': type(error).__name__}, str(run_id)]))

    def on_chat_model_start(self, serialized, messages, *, run_id, parent_run_id=None, **kwargs):
        def capture():
            if len(messages) > 512 or sum(map(len, messages)) > 512:
                raise ValueError('event_limit')
            params = kwargs.get('invocation_params') or {}
            self._send('handleChatModelStart', [{}, [[_message(m) for m in batch] for batch in messages],
                str(run_id), str(parent_run_id) if parent_run_id else None,
                {'invocation_params': {'tools': params.get('tools')}}, [], kwargs.get('metadata') or {}, kwargs.get('name')])
        self._safe(capture)

    def on_llm_end(self, response, *, run_id, **kwargs):
        def capture():
            if len(response.generations) > 512 or sum(map(len, response.generations)) > 512:
                raise ValueError('event_limit')
            self._send('handleLLMEnd', [{'generations': [[{'message': _message(g.message)} for g in batch]
                                                        for batch in response.generations]}, str(run_id)])
        self._safe(capture)

    def on_llm_error(self, error, *, run_id, **kwargs):
        self._safe(lambda: self._send('handleLLMError', [{'name': type(error).__name__}, str(run_id)]))

    def on_tool_start(self, serialized, input_str, *, run_id, parent_run_id=None, **kwargs):
        self._safe(lambda: self._send('handleToolStart', [{}, kwargs.get('inputs') if isinstance(kwargs.get('inputs'), dict) else input_str, str(run_id),
            str(parent_run_id) if parent_run_id else None, [], kwargs.get('metadata') or {},
            kwargs.get('name') or (serialized or {}).get('name'), kwargs.get('tool_call_id')]))

    def on_tool_end(self, output, *, run_id, **kwargs):
        self._safe(lambda: self._send('handleToolEnd', [
            {'content': output.content, 'tool_call_id': getattr(output, 'tool_call_id', None)}
            if hasattr(output, 'content') else output, str(run_id)]))

    def on_tool_error(self, error, *, run_id, **kwargs):
        self._safe(lambda: self._send('handleToolError', [{'name': type(error).__name__}, str(run_id)]))


def create_hypaware_callback(**options):
    return HypAwareCallback(**options)
