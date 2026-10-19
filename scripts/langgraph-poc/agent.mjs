// Real LangGraph + real provider adapters. Fixture HTTP replies are labeled.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { Capture, flush, message, requireFixture } from './capture.mjs'

const { StateGraph, MessagesAnnotation, START, END } = requireFixture('@langchain/langgraph')
const { ToolNode } = requireFixture('@langchain/langgraph/prebuilt')
const { ChatOpenAI } = requireFixture('@langchain/openai')
const { ChatAnthropic } = requireFixture('@langchain/anthropic')
const { HumanMessage, SystemMessage } = requireFixture('@langchain/core/messages')
const { tool } = requireFixture('@langchain/core/tools')
const { z } = requireFixture('zod')
const [mode, directory, runId, scenario, endpoint] = process.argv.slice(2)

if (mode === 'flush') {
  console.log(JSON.stringify(await flush(directory, endpoint)))
} else {
  let server
  try {
    const live = mode === 'live'
    let origin
    if (!live) {
      server = http.createServer(async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const anthropic = req.url?.startsWith('/v1/messages')
        const last = body.messages.at(-1)
        const usedTool = last.role === 'tool' ||
          (Array.isArray(last.content) && last.content.some(c => c.type === 'tool_result'))
        const call = !usedTool
        const response = anthropic ? {
          id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
          content: call ? [{ type: 'tool_use', id: 'call_anthropic_fixture', name: 'add', input: { a: 19, b: 23 } }]
            : [{ type: 'text', text: '42' }],
          stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null,
          usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
        } : {
          id: 'chatcmpl_fixture', object: 'chat.completion', created: 1, model: body.model,
          choices: [{ index: 0, finish_reason: call ? 'tool_calls' : 'stop', message: call
            ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_openai_fixture', type: 'function',
              function: { name: 'add', arguments: '{"a":19,"b":23}' } }] }
            : { role: 'assistant', content: '42' } }],
          usage: { prompt_tokens: 15, completion_tokens: 3, total_tokens: 18, prompt_tokens_details: { cached_tokens: 4 } },
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(response))
      })
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
      origin = `http://127.0.0.1:${server.address().port}`
    }
    const models = live ? ['gpt-6.1-sol', 'gpt-6-luna'].map(model => new ChatOpenAI({
      model, useResponsesApi: true, reasoning: { effort: 'low' },
      maxTokens: 1024, maxRetries: 0, timeout: 45000,
    })) : [
      new ChatOpenAI({ model: 'fixture-openai', apiKey: 'fixture', maxRetries: 0,
        configuration: { baseURL: `${origin}/v1` } }),
      new ChatAnthropic({ model: 'fixture-anthropic', apiKey: 'fixture', maxRetries: 0,
        clientOptions: { baseURL: origin } }),
    ]
    let attempts = 0
    const failOnce = scenario === 'outage'
    const add = tool(({ a, b }) => {
      if (++attempts === 1 && failOnce) throw new Error('synthetic transient failure')
      return String(a + b)
    }, { name: 'add', description: 'Add two numbers', schema: z.object({ a: z.number(), b: z.number() }) })
    const unused = tool(() => 'unused', { name: 'unused', description: 'Not needed for arithmetic', schema: z.object({}) })
    const system = new SystemMessage('You are an arithmetic assistant. Use add, then answer with only the number.')
    const outputs = []
    const child = (model, name) => new StateGraph(MessagesAnnotation)
      .addNode('model', async (state, config) => {
        const result = await model.bindTools([add, unused]).invoke(state.messages, config)
        outputs.push(message(result))
        return { messages: [result] }
      })
      .addNode('tools', new ToolNode([add], { handleToolErrors: false }), {
        retryPolicy: { maxAttempts: 2, initialInterval: 10, jitter: false, retryOn: () => true },
      })
      .addEdge(START, 'model')
      .addConditionalEdges('model', state => state.messages.at(-1).tool_calls?.length ? 'tools' : END)
      .addEdge('tools', 'model').compile({ name })
    const reviewer = child(models[1], 'reviewer-agent')
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('researcher', child(models[0], 'researcher-agent'))
      .addNode('reviewer', async (state, config) => reviewer.invoke({ messages: [system, new HumanMessage(
        `Another agent answered ${state.messages.at(-1).text}. Independently use the add tool for 19 + 23, then answer with only the number.`
      )] }, config))
      .addEdge(START, 'researcher').addEdge('researcher', 'reviewer').addEdge('reviewer', END)
      .compile({ name: 'supervisor' })
    const production = process.env.HYP_LANGGRAPH_PRODUCTION === '1'
    /** @type {any} */
    const capture = production
      ? (await import('../../hypaware-core/plugins-workspace/langgraph/src/recorder.js')).createHypAwareCallback({ sessionId: `${runId}:${scenario}` })
      : new Capture(directory, runId, scenario, `${runId}:${scenario}`)
    const result = await graph.invoke({ messages: [system, new HumanMessage(
      'Use the add tool to calculate 19 + 23, then answer with only the number. If a previous agent has already called it, verify that result and answer only the number.'
    )] }, { callbacks: [capture], configurable: { thread_id: capture.sessionId ?? capture.threadId }, recursionLimit: 12 })
    assert.equal(result.messages.at(-1).text.trim(), '42')
    assert.equal(capture.active.size, 0, 'every callback start has an end')
    const expected = { scenario, mode, final: result.messages.at(-1).text,
      outputs, toolAttempts: attempts, completedSpans: capture.completed, recorder: production ? capture.status() : undefined,
      projectContext: (await capture.project).context, systemText: system.content }
    fs.writeFileSync(path.join(path.dirname(directory), `${scenario}-expected.json`), JSON.stringify(expected, null, 2))
    console.log(JSON.stringify({ ...expected, outputs: undefined, delivery: production ? { transport: 'local-journal' } : await flush(directory, endpoint) }))
  } finally {
    if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
  }
}
