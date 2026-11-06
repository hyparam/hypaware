"""Real Python LangGraph integration run, with fixture or live chat models."""
import asyncio
import json
import os
from pathlib import Path
import sys

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, MessagesState, START, END
from langgraph.prebuilt import ToolNode
from langgraph.types import RetryPolicy

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'hypaware-core/plugins-workspace/langgraph/python'))
from hypaware_langgraph import create_hypaware_callback

mode, module_path, session_id, invocation = sys.argv[1:5]
attempts = 0


@tool
def add(a: int, b: int) -> str:
    """Add two numbers."""
    global attempts
    attempts += 1
    if attempts == 1:
        raise RuntimeError('synthetic transient failure')
    return str(a + b)


@tool
def unused() -> str:
    """Not needed for arithmetic."""
    return 'unused'


class FixtureModel(BaseChatModel):
    model_name: str

    @property
    def _llm_type(self):
        return 'hypaware-fixture'

    def _get_ls_params(self, **kwargs):
        return {'ls_provider': 'fixture', 'ls_model_name': self.model_name}

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        content = '42' if isinstance(messages[-1], ToolMessage) else ''
        calls = [] if content else [{'id': self.model_name + '-call', 'name': 'add', 'args': {'a': 19, 'b': 23}}]
        message = AIMessage(content=content, tool_calls=calls,
            usage_metadata={'input_tokens': 15, 'output_tokens': 3, 'total_tokens': 18,
                            'input_token_details': {'cache_read': 4}},
            response_metadata={'model_name': self.model_name})
        return ChatResult(generations=[ChatGeneration(message=message)])


if mode == 'live':
    models = [ChatOpenAI(model=name, use_responses_api=True, reasoning={'effort': 'low'},
                        max_tokens=1024, max_retries=0, timeout=45).bind_tools([add, unused])
              for name in ['gpt-6.1-sol', 'gpt-6-luna']]
else:
    from langchain_core.utils.function_calling import convert_to_openai_tool
    models = [FixtureModel(model_name=name).bind(tools=[convert_to_openai_tool(add), convert_to_openai_tool(unused)])
              for name in ['fixture-python-a', 'fixture-python-b']]

system = SystemMessage(content='You are an arithmetic assistant. Use add, then answer with only the number.')


def child(model, name):
    def ask(state, config):
        return {'messages': [model.invoke(state['messages'], config)]}
    async def ask_async(state, config):
        return {'messages': [await model.ainvoke(state['messages'], config)]}
    graph = StateGraph(MessagesState)
    graph.add_node('model', ask_async if invocation == 'async' else ask)
    graph.add_node('tools', ToolNode([add], handle_tool_errors=False),
                   retry_policy=RetryPolicy(max_attempts=2, initial_interval=0.01, jitter=False, retry_on=lambda error: True))
    graph.add_edge(START, 'model')
    graph.add_conditional_edges('model', lambda state: 'tools' if state['messages'][-1].tool_calls else END)
    graph.add_edge('tools', 'model')
    return graph.compile(name=name)


reviewer = child(models[1], 'reviewer-agent')


def review(state, config):
    return reviewer.invoke({'messages': [system, HumanMessage(content='Independently use add to calculate 19 + 23.')]}, config)


async def review_async(state, config):
    return await reviewer.ainvoke({'messages': [system, HumanMessage(content='Independently use add to calculate 19 + 23.')]}, config)


graph = StateGraph(MessagesState)
graph.add_node('researcher', child(models[0], 'researcher-agent'))
graph.add_node('reviewer', review_async if invocation == 'async' else review)
graph.add_edge(START, 'researcher')
graph.add_edge('researcher', 'reviewer')
graph.add_edge('reviewer', END)
compiled = graph.compile(name='supervisor')
with create_hypaware_callback(session_id=session_id, module_path=module_path,
                             node_path=os.environ.get('HYP_LANGGRAPH_NODE', 'node')) as capture:
    config = {'callbacks': [capture], 'configurable': {'thread_id': session_id}, 'recursion_limit': 12}
    inputs = {'messages': [system, HumanMessage(content='Use add to calculate 19 + 23, then answer only the number.')]}
    result = asyncio.run(compiled.ainvoke(inputs, config)) if invocation == 'async' else compiled.invoke(inputs, config)
    text = result['messages'][-1].text
    assert text.strip() == '42', text
    assert capture.status()['dropped'] == 0, capture.status()
    assert capture.status()['active_callbacks'] == 0, capture.status()
    print(json.dumps({'final': text, 'toolAttempts': attempts, 'recorder': capture.status(), 'invocation': invocation}))
