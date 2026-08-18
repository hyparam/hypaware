// @ts-check

import { parseCommandArgv } from './verb_codec.js'

/**
 * @import { CommandRunContext } from '../../../hypaware-plugin-kernel-types.js'
 * @import { CoreCommandArgSpec } from '../../../src/core/cli/types.js'
 */

/**
 * One argument-validation contract for the core command set.
 *
 * Before this module a command either declared a schema and rejected
 * unknown input, or hand-read the two tokens it cared about and dropped
 * the rest, so `hyp daemon status --jsn` printed the human table and
 * exited 0 while `hyp sink maintain --jsn` exited 2. A script cannot tell
 * those apart, and around destructive commands the quiet reading is the
 * dangerous one.
 *
 * Each entry below is the whole surface of one command: the schema its
 * parser enforces AND the usage line the registry advertises, so the two
 * are the same authored object rather than two strings kept in step by
 * hand. `core_commands.js` reads `usage` from here.
 *
 * @ref LLP 0266#usage-agreement [implements]: usage line and parser schema are one declaration, so neither can advertise a flag the other rejects
 */

/** @type {Record<string, CoreCommandArgSpec>} */
export const CORE_COMMAND_ARGS = {
  'version': {
    usage: 'hyp version',
    schema: { type: 'object', properties: {} },
  },
  'status': {
    usage: 'hyp status [--json]',
    schema: { type: 'object', properties: { json: { type: 'boolean', default: false } } },
  },
  'ask': {
    usage: 'hyp ask ["question"] [--list]',
    schema: {
      type: 'object',
      properties: {
        question: { type: 'string', greedy: true },
        list: { type: 'boolean', default: false },
      },
      positional: ['question'],
    },
  },
  'backfill list': {
    usage: 'hyp backfill list [--json]',
    schema: { type: 'object', properties: { json: { type: 'boolean', default: false } } },
  },
  'daemon status': {
    usage: 'hyp daemon status [--json]',
    schema: { type: 'object', properties: { json: { type: 'boolean', default: false } } },
  },
  'daemon start': {
    usage: 'hyp daemon start',
    schema: { type: 'object', properties: {} },
  },
  'daemon stop': {
    usage: 'hyp daemon stop',
    schema: { type: 'object', properties: {} },
  },
  'daemon restart': {
    usage: 'hyp daemon restart',
    schema: { type: 'object', properties: {} },
  },
  'daemon uninstall': {
    usage: 'hyp daemon uninstall',
    schema: { type: 'object', properties: {} },
  },
  'plugin list': {
    usage: 'hyp plugin list [--json]',
    schema: { type: 'object', properties: { json: { type: 'boolean', default: false } } },
  },
  'plugin info': {
    usage: 'hyp plugin info <plugin>',
    schema: {
      type: 'object',
      properties: { plugin: { type: 'string' } },
      positional: ['plugin'],
      required: ['plugin'],
    },
  },
  'plugin outdated': {
    usage: 'hyp plugin outdated [--json]',
    schema: { type: 'object', properties: { json: { type: 'boolean', default: false } } },
  },
  'plugin remove': {
    usage: 'hyp plugin remove <plugin>',
    schema: {
      type: 'object',
      properties: { plugin: { type: 'string' } },
      positional: ['plugin'],
      required: ['plugin'],
    },
  },
  'query schema': {
    usage: 'hyp query schema <dataset>',
    schema: {
      type: 'object',
      properties: { dataset: { type: 'string' } },
      positional: ['dataset'],
      required: ['dataset'],
    },
  },
  'query status': {
    usage: 'hyp query status',
    schema: { type: 'object', properties: {} },
  },
  'query refresh': {
    usage: 'hyp query refresh [dataset]',
    schema: {
      type: 'object',
      properties: { dataset: { type: 'string' } },
      positional: ['dataset'],
    },
  },
  'remote add': {
    usage: 'hyp remote add <name> <url>',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, url: { type: 'string' } },
      positional: ['name', 'url'],
      required: ['name', 'url'],
    },
  },
  'remote list': {
    usage: 'hyp remote list [--json]',
    schema: { type: 'object', properties: { json: { type: 'boolean', default: false } } },
  },
  'remote remove': {
    usage: 'hyp remote remove <name>',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      positional: ['name'],
      required: ['name'],
    },
  },
  'remote login': {
    // `<name>` in the old line, but a bare `hyp remote login` signs in to
    // the default target (LLP 0062 #bare-remote), so the target is optional.
    usage: 'hyp remote login [name] [--token-file <path>] [--org <org>] [--host <label>] [--browser] [--no-browser] [--no-forward] [--no-daemon]',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        'token-file': { type: 'string' },
        org: { type: 'string' },
        host: { type: 'string' },
        browser: { type: 'boolean', default: false },
        'no-browser': { type: 'boolean', default: false },
        'no-forward': { type: 'boolean', default: false },
        'no-daemon': { type: 'boolean', default: false },
      },
      positional: ['name'],
    },
  },
  'report render': {
    usage: 'hyp report render [<dir>] [--no-refresh-assets]',
    schema: {
      type: 'object',
      properties: {
        dir: { type: 'string' },
        'no-refresh-assets': { type: 'boolean', default: false },
      },
      positional: ['dir'],
    },
  },
  'report publish': {
    usage: 'hyp report publish <file-or-dir> --kind <kind> --period <period> [--title <title>] [--org <org>] [--remote <target>]',
    schema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        kind: { type: 'string' },
        period: { type: 'string' },
        title: { type: 'string' },
        org: { type: 'string' },
        remote: { type: 'string' },
      },
      positional: ['source'],
    },
  },
  'report list': {
    usage: 'hyp report list [--kind <kind>] [--period <period>] [--limit <n>] [--before <publishedAt>] [--org <org>] [--json] [--remote <target>]',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        period: { type: 'string' },
        limit: { type: 'string' },
        before: { type: 'string' },
        org: { type: 'string' },
        json: { type: 'boolean', default: false },
        remote: { type: 'string' },
      },
    },
  },
  'report get': {
    usage: 'hyp report get <kind> <period> <id> [path] [--output <file>] [--org <org>] [--remote <target>]',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        period: { type: 'string' },
        id: { type: 'string' },
        // One artifact path, but a shell splits nothing here: the greedy
        // array keeps every trailing token so `runReportGet` can rebuild
        // the '/'-separated suffix exactly as it did before.
        path: { type: 'array', items: { type: 'string' }, greedy: true },
        output: { type: 'string' },
        org: { type: 'string' },
        remote: { type: 'string' },
      },
      positional: ['kind', 'period', 'id', 'path'],
    },
  },
  'report delete': {
    usage: 'hyp report delete <kind> <period> <id> [--yes] [--org <org>] [--remote <target>]',
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string' },
        period: { type: 'string' },
        id: { type: 'string' },
        yes: { type: 'boolean', default: false },
        org: { type: 'string' },
        remote: { type: 'string' },
      },
      positional: ['kind', 'period', 'id'],
    },
  },
}

/**
 * The usage line registered for a core command, read from the one place
 * it is authored.
 *
 * @param {string} name
 * @returns {string}
 */
export function coreUsage(name) {
  const spec = CORE_COMMAND_ARGS[name]
  if (!spec) throw new Error(`no argument spec for core command '${name}'`)
  return spec.usage
}

/**
 * Parse a core command's argv against its declared spec, reporting the
 * refusal itself: an unknown flag, an unexpected positional, or a missing
 * required one is a usage error (exit 2) on stderr, never a quiet
 * fall-through. A non-leading `--help` prints usage on stdout and exits 0
 * (a leading one never reaches the command; dispatch renders registry
 * help for it).
 *
 * @param {string} name registered command name, e.g. `daemon status`
 * @param {string[]} argv
 * @param {CommandRunContext} ctx
 * @returns {{ ok: true, params: Record<string, unknown> } | { ok: false, code: number }}
 * @ref LLP 0266#one-contract [implements]: one refusal, written once, so a misspelled flag cannot mean exit 2 on one command and a different output mode on the next
 */
export function parseCoreCommandArgv(name, argv, ctx) {
  const spec = CORE_COMMAND_ARGS[name]
  if (!spec) throw new Error(`no argument spec for core command '${name}'`)
  const parsed = parseCommandArgv(argv, spec.schema, spec.aliases ? { aliases: spec.aliases } : {})
  if ('help' in parsed) {
    ctx.stdout.write(`usage: ${spec.usage}\n`)
    return { ok: false, code: 0 }
  }
  if (!parsed.ok) {
    ctx.stderr.write(`hyp ${name}: ${parsed.error}\n`)
    ctx.stderr.write(`usage: ${spec.usage}\n`)
    return { ok: false, code: 2 }
  }
  return { ok: true, params: parsed.params }
}
