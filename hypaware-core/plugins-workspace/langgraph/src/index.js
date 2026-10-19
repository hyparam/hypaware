import { ensureAiGatewayStorageContracts } from '../../ai-gateway/src/storage_contracts.js'
import { runSessionIgnore, runSessionStatus, runSessionUnignore } from '../../ai-gateway/src/session_command.js'
import { attachLangGraph } from './attach.js'
import { LANGGRAPH_CONFIG_SECTION, validateLangGraphConfig } from './config.js'
import { startLangGraphSource } from './listener.js'
import { pathToFileURL, fileURLToPath } from 'node:url'

/** @import { PluginActivationContext } from '../../../../hypaware-plugin-kernel-types.js' */
const PLUGIN_NAME = '@hypaware/langgraph'
export const configSection = { section: LANGGRAPH_CONFIG_SECTION, validate: validateLangGraphConfig }

/** @param {PluginActivationContext} ctx */
export async function activate(ctx) {
  ctx.configRegistry.registerSection({ plugin: PLUGIN_NAME, ...configSection })
  ensureAiGatewayStorageContracts(ctx)
  ctx.sources.register({ name: 'langgraph', plugin: PLUGIN_NAME,
    summary: 'Collect completed LangGraph callbacks from the local durable journal',
    configSection: LANGGRAPH_CONFIG_SECTION, start: startLangGraphSource })
  registerSessionCommands(ctx)
  // @ref LLP 0517#onboarding: global attach installs the importable callback module
  ctx.clients.registerClient({ name: 'langgraph', requiresEndpoint: false,
    async attach(attachCtx) {
      const result = await attachLangGraph({ env: ctx.env, dryRun: attachCtx.dryRun })
      const importUrl = pathToFileURL(result.settingsPath).href
      const example = `import { createHypAwareCallback } from ${JSON.stringify(importUrl)}\n` +
        `const capture = createHypAwareCallback({ sessionId: 'your-stable-conversation-id' })\n` +
        `await graph.invoke(input, { callbacks: [capture], configurable: { thread_id: capture.sessionId } })`
      const pythonPath = fileURLToPath(new URL('../python', import.meta.url))
      const pythonExample = `import sys\nsys.path.insert(0, ${JSON.stringify(pythonPath)})\n` +
        `from hypaware_langgraph import create_hypaware_callback\n\n` +
        `with create_hypaware_callback(session_id="your-stable-conversation-id",\n` +
        `    module_path=${JSON.stringify(result.settingsPath)}, node_path=${JSON.stringify(process.execPath)}) as capture:\n` +
        `    result = graph.invoke(input, config={"callbacks": [capture],\n` +
        `        "configurable": {"thread_id": capture.session_id}})`
      ctx.log.info('langgraph.attach.write', { component: 'langgraph', operation: 'client.attach',
        status: 'ok', changed: result.changed, dry_run: attachCtx.dryRun === true })
      if (attachCtx.json) attachCtx.stdout.write(JSON.stringify({ status: 'ok', client: 'langgraph',
        settings_path: result.settingsPath, changed: result.changed, dry_run: attachCtx.dryRun === true, example, python_example: pythonExample }) + '\n')
      else attachCtx.stdout.write(`${attachCtx.dryRun ? 'Would prepare' : 'Ready at'} ${result.settingsPath}\n\n` +
        `Add this callback to your JavaScript LangGraph application:\n\n${example}\n\n` +
        'Use one callback per conversation. Run your application, then check hyp status.\n' +
        `\nFor Python applications:\n\n${pythonExample}\n\n` +
        'For async graphs, use await graph.ainvoke with the same callback configuration.\n')
    },
  })
}

/** @param {PluginActivationContext} ctx */
function registerSessionCommands(ctx) {
  if (ctx.commands.get('session ignore')) return
  for (const command of [
    {
      name: 'session ignore',
      summary: 'Stop recording this AI session on every local recorder (saved until explicitly unignored)',
      usage: 'hyp session ignore [session-id] [--json]',
      run: runSessionIgnore,
    },
    {
      name: 'session unignore',
      summary: 'Resume recording this AI session',
      usage: 'hyp session unignore [session-id] [--json]',
      run: runSessionUnignore,
    },
    {
      name: 'session status',
      summary: 'Report whether this AI session is being dropped right now (fails closed)',
      usage: 'hyp session status [session-id] [--json]',
      run: runSessionStatus,
    },
  ]) {
    ctx.commands.register({
      ...command,
      plugin: PLUGIN_NAME,
      category: 'capture-movement',
      audience: 'everyday',
    })
  }
}
