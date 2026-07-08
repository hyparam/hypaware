// @ts-check

/**
 * @import { CommandRegistration, CommandRegistry } from '../../../hypaware-plugin-kernel-types.js'
 */

/**
 * Registry-backed help rendering shared by every path that prints help
 * for a command group or a single command: the bare group commands
 * (`hyp query`, `hyp daemon`, ...), the dispatcher's central `--help`
 * interception, and the synthesized help for groups with no bare
 * command of their own (plugin namespaces like `graph`).
 *
 * Summaries always come from the live command registry, so group help
 * and top-level help can never drift apart.
 */

/** @param {string | undefined} token */
export function isHelpFlag(token) {
  return token === '--help' || token === '-h'
}

/**
 * Direct visible children of a group, with summaries. A child whose
 * exact command is registered contributes its summary; a child that
 * only exists as a deeper prefix (e.g. `a b c` with no `a b`) gets a
 * synthesized subcommand listing.
 *
 * @param {Pick<CommandRegistry, 'list'>} registry
 * @param {string} group
 * @returns {{ name: string, summary: string }[]}
 */
export function listGroupChildren(registry, group) {
  const prefix = `${group} `
  /** @type {Map<string, string>} */
  const summaries = new Map()
  /** @type {Map<string, Set<string>>} */
  const grandchildren = new Map()
  for (const cmd of registry.list()) {
    if (cmd.hidden || !cmd.name.startsWith(prefix)) continue
    const restTokens = cmd.name.slice(prefix.length).split(' ')
    const child = restTokens[0]
    if (restTokens.length === 1) {
      summaries.set(child, cmd.summary)
    } else {
      let set = grandchildren.get(child)
      if (!set) grandchildren.set(child, (set = new Set()))
      set.add(restTokens[1])
    }
  }
  /** @type {{ name: string, summary: string }[]} */
  const children = []
  const names = new Set([...summaries.keys(), ...grandchildren.keys()])
  for (const name of [...names].sort()) {
    const summary = summaries.get(name) ?? synthesizeGroupSummary([...(grandchildren.get(name) ?? [])].sort())
    children.push({ name, summary })
  }
  return children
}

/**
 * Fallback summary for a group with no bare command to speak for it:
 * name the subcommands so the row still tells the reader where to go.
 *
 * @param {string[]} childNames
 */
export function synthesizeGroupSummary(childNames) {
  return `Subcommands: ${childNames.join(', ')}`
}

/**
 * Render help for a command group: header (when a bare command supplies
 * a summary), usage, optional long help, and the subcommand table.
 *
 * @param {{
 *   stdout: { write(chunk: string): unknown },
 *   group: string,
 *   groupCommand?: Pick<CommandRegistration, 'summary' | 'usage' | 'help'>,
 *   children: { name: string, summary: string }[],
 * }} args
 */
export function renderGroupHelp({ stdout, group, groupCommand, children }) {
  if (groupCommand) {
    stdout.write(`hyp ${group} - ${groupCommand.summary}\n`)
    stdout.write('\n')
  }
  stdout.write(`usage: ${groupCommand?.usage ?? `hyp ${group} <subcommand> [args...]`}\n`)
  if (groupCommand?.help) {
    stdout.write('\n')
    stdout.write(`${groupCommand.help}\n`)
  }
  stdout.write('\n')
  stdout.write('Subcommands:\n')
  const nameWidth = Math.max(...children.map((c) => c.name.length), 8)
  for (const child of children) {
    stdout.write(`  ${child.name.padEnd(nameWidth)}  ${child.summary}\n`)
  }
  stdout.write('\n')
  stdout.write(`Run 'hyp ${group} <subcommand> --help' for subcommand-specific help.\n`)
}

/**
 * Render help for a single (leaf) command: summary, usage, and the
 * optional long help text.
 *
 * @param {{
 *   stdout: { write(chunk: string): unknown },
 *   command: Pick<CommandRegistration, 'name' | 'summary' | 'usage' | 'help'>,
 * }} args
 */
export function renderCommandHelp({ stdout, command }) {
  stdout.write(`hyp ${command.name} - ${command.summary}\n`)
  stdout.write('\n')
  stdout.write(`usage: ${command.usage}\n`)
  if (command.help) {
    stdout.write('\n')
    stdout.write(`${command.help}\n`)
  }
}

/**
 * Build the bare command for a group whose only job is help: `hyp
 * query`, `hyp daemon`, `hyp plugin`, ... With no args (or a help
 * flag) it renders the group's subcommand table from the registry; any
 * other token is an unknown subcommand. The registry is read at run
 * time, so subcommands registered later (plugin activation) appear.
 *
 * @param {{
 *   registry: Pick<CommandRegistry, 'list'>,
 *   name: string,
 *   summary: string,
 *   help?: string,
 * }} args
 * @returns {CommandRegistration}
 * @ref LLP 0009#layered-help [implements]: bare group commands render registry-backed subcommand tables; no hand-maintained lists
 */
export function makeGroupCommand({ registry, name, summary, help }) {
  const usage = `hyp ${name} <subcommand> [args...]`
  return {
    name,
    summary,
    usage,
    ...(help !== undefined ? { help } : {}),
    async run(argv, ctx) {
      const children = listGroupChildren(registry, name)
      if (argv.length === 0 || isHelpFlag(argv[0])) {
        renderGroupHelp({ stdout: ctx.stdout, group: name, groupCommand: { summary, usage, help }, children })
        return 0
      }
      ctx.stderr.write(`hyp ${name}: unknown subcommand '${argv[0]}'\n`)
      ctx.stderr.write(`  expected one of: ${children.map((c) => c.name).join(', ')}\n`)
      return 2
    },
  }
}
