// @ts-check

// Launching a `.cmd`/`.bat` target on win32.
//
// Node refuses to spawn a command script directly (EINVAL, the
// CVE-2024-27980 fix): a script only runs through cmd.exe, and cmd.exe has
// no argv - it re-parses the command line as text, twice for a script,
// because the script's own `%*` is read again as batch text. The spawns
// that already go through a shell on win32 (`global_install.js`,
// `self_update.js`) may do so because they pass only fixed bare tokens;
// the launchers this module serves carry free text - `hyp ask`'s framed
// question, `hyp report fix`'s server-fetched recommendation title - so
// the line is escaped here instead, the way cross-spawn escapes it, and
// handed to `ComSpec /d /s /c` with `windowsVerbatimArguments` so Node
// adds no quoting of its own on top.
//
// @ref LLP 0581#decision [implements]: the one escaped cmd.exe transport for .cmd client launches

/**
 * The characters cmd.exe gives meaning to outside of its (unreliable)
 * quoting, each defeated with a caret. The caret before `%` is also what
 * defeats `%NAME%` expansion: the variable cmd looks up ends in the caret,
 * matches nothing, and the caret pass then removes the caret.
 */
const CMD_METACHARS = /([()\][%!^"`<>&|;, *?])/g

/**
 * Is this a target only cmd.exe can run?
 *
 * @param {string} file
 */
export function isCmdFile(file) {
  return /\.(cmd|bat)$/i.test(file)
}

/**
 * One argument, escaped to survive cmd.exe's double parse of a script's
 * command line.
 *
 * First the MSVCRT argv rules the script's eventual interpreter reads
 * (backslashes double before a quote, the quote itself is escaped, trailing
 * backslashes double, the whole wrapped in quotes), then every cmd
 * metacharacter caret-escaped twice - once per parse, since `%*` inside the
 * script is batch text parsed again.
 *
 * A line break cannot be carried at all: cmd ends a command at it, quoted
 * or not, and the script's `%*` re-parse ends a batch line there too, so
 * what follows one would run rather than be passed. Each run of them is
 * collapsed to a single space - the launch prompts this module exists for
 * read the same to the client either way - rather than refused, which
 * would leave every multi-line prompt unlaunchable.
 *
 * @param {string} arg
 */
function escapeCmdArgument(arg) {
  let out = String(arg).replace(/[\r\n]+/g, ' ')
  out = out.replace(/(\\*)"/g, '$1$1\\"')
  out = out.replace(/(\\*)$/, '$1$1')
  out = `"${out}"`
  return out.replace(CMD_METACHARS, '^$1').replace(CMD_METACHARS, '^$1')
}

/**
 * How to spawn `binPath` with `args` through cmd.exe: the command to start,
 * the argv to hand it, and the spawn options that keep Node from quoting
 * the line a second time. `binPath` may be a bare name - cmd.exe resolves
 * it over PATH and PATHEXT exactly as a typed command - or an absolute
 * script path; it is caret-escaped once, since only cmd parses the command
 * position.
 *
 * A NUL byte is refused outright: no Windows command line can carry one,
 * and truncating at it would launch the client on a prompt silently cut
 * where an attacker chose.
 *
 * @param {string} binPath
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} [env] where ComSpec is read from; the calling
 *   process's own environment backs an env that does not carry it
 * @returns {{ command: string, args: string[], options: { windowsVerbatimArguments: true } }}
 */
export function cmdFileSpawnPlan(binPath, args, env = process.env) {
  for (const arg of [binPath, ...args]) {
    if (arg.includes('\0')) throw new Error('cannot launch through cmd.exe: an argument carries a NUL byte')
  }
  const line = [String(binPath).replace(CMD_METACHARS, '^$1'), ...args.map(escapeCmdArgument)].join(' ')
  return {
    command: env.ComSpec ?? process.env.ComSpec ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    options: { windowsVerbatimArguments: true },
  }
}
