"""Dependency-free transport tests; real SDK coverage lives in python_agent.py."""
import concurrent.futures
import json
from pathlib import Path
import sys
import types
from types import SimpleNamespace

# Only the callback interface is stubbed. All IPC, policy, projection, journal
# and lifecycle code below is production code, running in separate processes.
callbacks = types.ModuleType('langchain_core.callbacks')
callbacks.BaseCallbackHandler = object
sys.modules['langchain_core'] = types.ModuleType('langchain_core')
sys.modules['langchain_core.callbacks'] = callbacks
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'hypaware-core/plugins-workspace/langgraph/python'))
import hypaware_langgraph as sdk

module_path, node_path, cwd, mode = sys.argv[1:5]
if mode == 'timeout':
    Path(module_path).write_text('await new Promise(resolve => setTimeout(resolve, 60000))\n')
    sdk._TIMEOUT = 1


def make(session='python-test'):
    return sdk.create_hypaware_callback(module_path=module_path, node_path=node_path, cwd=cwd, session_id=session)


def model(capture, suffix='one'):
    metadata = {'ls_provider': 'openai', 'ls_model_name': 'test-model',
                'langgraph_checkpoint_ns': 'researcher:one|model:two'}
    human = SimpleNamespace(id='human', type='human', content='19 + 23', response_metadata={})
    capture.on_chat_model_start({}, [[human]], run_id='model-' + suffix, parent_run_id='root',
        metadata=metadata, invocation_params={'tools': [{'type': 'function', 'function': {'name': 'add'}}]})
    reply = SimpleNamespace(id='reply', type='ai', content=[{'type': 'text', 'text': '42'},
        {'type': 'reasoning', 'text': 'MUST_NOT_CAPTURE'}], tool_calls=[],
        response_metadata={'model_name': 'test-model'},
        usage_metadata={'input_tokens': 15, 'output_tokens': 3, 'total_tokens': 18,
                        'input_token_details': {'cache_read': 4}})
    capture.on_llm_end(SimpleNamespace(generations=[[SimpleNamespace(message=reply)]]), run_id='model-' + suffix)


with make() as capture:
    capture.on_chain_start({}, {}, run_id='root')
    if mode == 'capture':
        model(capture)
        capture.on_tool_start({'name': 'add'}, "{'a': 19}", run_id='tool', parent_run_id='root',
            tool_call_id='call', inputs={'a': 19}, metadata={'langgraph_checkpoint_ns': 'researcher:one|tools:two'})
        capture.on_tool_end(SimpleNamespace(content='42', tool_call_id='call'), run_id='tool')
    elif mode == 'privacy':
        model(capture)
        assert capture.status()['queued'] == 0, capture.status()
        config = Path(cwd) / 'config.json'
        config.write_text(json.dumps({'version': 2, 'plugins': [{'name': '@hypaware/langgraph'}]}))
        model(capture, 'enabled')
        assert capture.status()['queued'] == 1, capture.status()
        config.write_text(json.dumps({'version': 2, 'plugins': [{'name': '@hypaware/langgraph', 'recording': False}]}))
        model(capture, 'disabled')
        assert capture.status()['queued'] == 1, capture.status()
    elif mode == 'concurrent':
        def one(i):
            capture.on_tool_start({'name': 'add'}, '{}', run_id=str(i), tool_call_id=str(i))
            capture.on_tool_end('42', run_id=str(i))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(one, range(20)))
        assert capture.status()['queued'] == 20, capture.status()
        assert capture.status()['active_callbacks'] == 0, capture.status()
    elif mode in ('failure', 'timeout'):
        if mode == 'failure':
            capture._child.kill()
            capture._child.wait()
        model(capture)
        assert capture.status()['dropped'] > 0, capture.status()
        assert capture.status()['lastError'] == 'recording_failed', capture.status()
    elif mode == 'bounds':
        capture.on_tool_start({'name': 'add'}, 'x' * (600 * 1024), run_id='too-large')
        assert capture.status()['dropped'] == 1, capture.status()
        assert capture.status()['active_callbacks'] == 0, capture.status()
        circular = {}
        circular['self'] = circular
        try:
            sdk._encode(circular)
            raise AssertionError('circular event was accepted')
        except ValueError:
            pass
    capture.on_chain_end({}, run_id='root')
    status = capture.status()
    pid = capture._child.pid
assert capture._child.poll() is not None, 'close must reap the helper'
print(json.dumps({'status': status, 'helper_pid': pid, 'closed': capture.status()['closed']}))
