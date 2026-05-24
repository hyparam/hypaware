// @ts-check

import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { gascityDatasetRegistration } from './dataset.js'
import { runAttach, runDetach, runList } from './commands.js'
import { startGascitySource } from './source.js'
import { gascityInitPreset } from './init.js'
import { setGascityRuntime } from './runtime.js'

/**
 * @import { PluginActivationContext } from '../../../../collectivus-plugin-kernel-types.d.ts'
 * @import { ExtendedSourceRegistry } from '../../../../src/core/registry/types.d.ts'
 */

/**
 * Activate the `@hypaware/gascity` plugin.
 *
 * Registers:
 *  - source `gascity` (configSection: `gascity`)
 *  - dataset `gascity_messages`
 *  - commands `gascity attach|detach|list`
 *  - init preset `gascity`
 *  - skill `hypaware-gascity`
 *
 * Activation does NOT start the source — `gascity attach` is the
 * lifecycle trigger, mirroring the donor's "configure first, attach
 * on demand" UX. The source starts on the first attach and reloads
 * on every subsequent attach/detach.
 *
 * @param {PluginActivationContext} ctx
 */
export async function activate(ctx) {
  ctx.sources.register({
    name: 'gascity',
    plugin: '@hypaware/gascity',
    summary: 'Gascity supervisor subscription source',
    configSection: 'gascity',
    start: startGascitySource,
  })

  ctx.query.registerDataset(gascityDatasetRegistration())

  ctx.commands.register({
    name: 'gascity attach',
    plugin: '@hypaware/gascity',
    summary: 'Subscribe to a gascity supervisor',
    usage: 'hyp gascity attach <city> [--api-url <url>]',
    run: runAttach,
  })
  ctx.commands.register({
    name: 'gascity detach',
    plugin: '@hypaware/gascity',
    summary: 'Unsubscribe from a gascity supervisor',
    usage: 'hyp gascity detach <city>',
    run: runDetach,
  })
  ctx.commands.register({
    name: 'gascity list',
    plugin: '@hypaware/gascity',
    summary: 'List attached gascity supervisors',
    usage: 'hyp gascity list',
    run: runList,
  })

  ctx.initPresets.register({
    name: 'gascity',
    plugin: '@hypaware/gascity',
    summary: 'Initialize a HypAware install pointed at gascity',
    run: gascityInitPreset,
  })

  const skillSourceDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'skills',
    'hypaware-gascity'
  )
  ctx.skills.register({
    name: 'hypaware-gascity',
    plugin: '@hypaware/gascity',
    clients: ['claude', 'codex'],
    sourceDir: skillSourceDir,
    projectLocal: true,
  })

  setGascityRuntime({
    cities: [],
    ctx,
    sources: /** @type {ExtendedSourceRegistry} */ (ctx.sources),
    log: ctx.log,
    started: false,
  })
}
