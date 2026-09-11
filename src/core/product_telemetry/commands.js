// @ts-check

import path from 'node:path'
import { parseCoreCommandArgv } from '../cli/command_args.js'
import { createOutbox } from './outbox.js'
import { effectivePolicy, productRoot, writePolicy } from './policy.js'

/** @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js' */

/** @param {NodeJS.ProcessEnv} env */
export function productStatus(env) {
  const root = productRoot(env)
  const effective = effectivePolicy(root)
  return {
    collection: effective.mode,
    policy: effective.reason,
    organization_destination:
      effective.policy?.mode === 'organization' ? effective.policy.url : null,
    vendor_sharing: 'unavailable',
    standalone_delivery: 'unavailable',
    ...createOutbox(root).status()
  }
}

/** @param {string[]} argv @param {CommandRunContext} ctx */
export async function runTelemetry(argv, ctx) {
  const parsed = parseCoreCommandArgv('telemetry', argv, ctx)
  if (!parsed.ok) return parsed.code
  const root = productRoot(ctx.env)
  const queue = createOutbox(root)
  const action = argv[0] ?? 'status'
  if (action === 'status' && argv.length <= 1) {
    ctx.stdout.write(JSON.stringify(productStatus(ctx.env), null, 2) + '\n')
    return 0
  }
  if (action === 'preview' && argv.length === 1) {
    const effective = effectivePolicy(root)
    const entry = queue.entries().find((e) => e.binding === effective.binding)
    ctx.stdout.write((entry?.wire ?? 'null') + '\n')
    return 0
  }
  if (action === 'off' && argv.length === 1) {
    writePolicy(root, 'off')
    queue.prune(null)
  } else if (
    action === 'enable' &&
    argv.length === 2 &&
    ['local', 'organization'].includes(argv[1])
  ) {
    if (argv[1] === 'local') writePolicy(root, 'local')
    else {
      const sinks = Object.values(ctx.config?.sinks ?? {}).filter(
        (s) => 'plugin' in s && s.plugin === '@hypaware/central'
      )
      if (sinks.length !== 1) {
        ctx.stderr.write(
          'hyp telemetry: organization reporting requires exactly one configured central sink\n'
        )
        return 2
      }
      const config = /** @type {any} */ (sinks[0]).config
      const identityPath =
        config?.identity?.persisted_path ??
        path.join(
          path.dirname(root),
          'plugins',
          '@hypaware/central',
          'identity.json'
        )
      writePolicy(root, 'organization', { url: config?.url, identityPath })
    }
    queue.prune(effectivePolicy(root).binding)
  } else {
    ctx.stderr.write(
      'usage: hyp telemetry [status|preview|off|enable local|enable organization]\n'
    )
    return 2
  }
  ctx.stdout.write(JSON.stringify(productStatus(ctx.env), null, 2) + '\n')
  return 0
}
