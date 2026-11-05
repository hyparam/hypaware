# LLP 0581: A `.cmd` client launches through cmd.exe on an escaped line

**Type:** Decision
**Status:** Draft
**Systems:** CLI, Plugins, Windows
**Author:** Kenny / Claude
**Date:** 2026-11-04
**Related:** LLP 0198 (#real-launch, #path-probe: the launch this decision carries onto win32), LLP 0456 (the launcher order is unchanged by how the spawn happens), LLP 0460 (the spawn-failure exits this transport reports into), LLP 0580 (the prior win32 decision in this series)

## Summary

On win32 an npm-installed client CLI resolves to a `.cmd` shim, and Node refuses to spawn one directly (`EINVAL`, the CVE-2024-27980 fix): a command script only runs through cmd.exe. `hyp ask`, `hyp report generate`/`fix`, and the OpenCode history runner therefore could not start any npm-installed client on Windows. This decision routes exactly those targets through `ComSpec /d /s /c` on a command line this codebase escapes itself (`src/core/util/cmd_file.js`), because the arguments carry free text - the framed question, a server-fetched recommendation title, session ids and SQL - which rules out `shell: true`'s unescaped join.

## Context

cmd.exe has no argv. It re-parses the command line as text, and for a script it parses twice: the script's own `%*` is read again as batch text. Whatever quoting the caller produced is therefore re-interpreted - `&` runs a second command, `|` pipes, `%NAME%` expands an environment variable (inside quotes too, which is how `%CMDCMDLINE%` smuggles quotes and operators into a "quoted" argument), and a line break ends the command, quoted or not.

The repo already spawns through a shell on win32 in two places (`global_install.js`, `self_update.js`), both annotated with the rule that makes them safe: a shell means the arguments are not escaped, so callers may pass only fixed, bare tokens. The launch seams this decision covers are the opposite case - LLP 0198 #real-launch hands the client the user's prompt as argv, and `hyp report fix` builds that prompt from a fetched page's title.

## Options considered

1. **`shell: true`.** One line, and unsound for free text: Node documents that no escaping happens. Rejected.
2. **Resolve the shim's target and spawn `node cli.js` directly.** Bypasses cmd.exe entirely, but hard-codes npm's shim layout, breaks for every non-npm `.cmd`, and silently diverges from what typing the command does. Rejected.
3. **Refuse `.cmd` targets.** Honest, and what the suite shipped with (the skip reason read "deferred"). It leaves `hyp ask` dead for every npm-installed client on Windows, while `.exe` installs work - a split users cannot see from the error. Rejected as the end state; it was the right interim.
4. **Escape the line for cmd.exe's double parse and spawn `ComSpec /d /s /c` with `windowsVerbatimArguments`.** The cross-spawn approach, implemented in-repo (no new runtime dependency): MSVCRT argv quoting first, then every cmd metacharacter caret-escaped twice - once per parse. The caret is also what defeats `%NAME%` expansion: the name cmd looks up ends in the caret and matches nothing. **Chosen.**

## Decision

<a id="decision"></a>`src/core/util/cmd_file.js` owns the transport. `launchClient` uses it when the resolved binary is a `.cmd`/`.bat` on win32 (an `.exe`, including the native Claude Code install, keeps the direct spawn, and POSIX is untouched); the OpenCode history runner uses it for its bare `opencode` command, which cmd.exe resolves over PATH and PATHEXT exactly as a typed command. Two inputs cannot be carried and are not pretended to be:

- <a id="newlines"></a>**Line breaks collapse to a single space, per run.** cmd ends a command at a line break wherever it sits, and the script's `%*` re-parse ends a batch line there too, so what follows one would execute rather than be passed. The launch prompts this transport exists for read the same to the client either way; refusing instead would leave every multi-line prompt unlaunchable, which is the whole `hyp ask` frame.
- **A NUL byte refuses the launch** (it surfaces as the ordinary spawn-failure path of LLP 0460): no Windows command line can carry one, and truncating would hand the client a prompt cut where an attacker chose.

The escaping is verified against a live cmd.exe, not only as string assertions: `test/core/cmd-file.test.js` round-trips adversarial arguments - quote and backslash edges, `%PATH%`, `&`-injection, pipes, carets, globs - through an npm-style shim that re-expands `%*`, asserts byte-for-byte argv fidelity, and asserts the injection probe created nothing.

## Consequences

- `hyp ask`, the wizard first-ask, and `hyp report generate`/`fix` start npm-installed clients on Windows; the ask suite's eight launch-driving tests and the two hung-OpenCode kill tests run on win32 instead of skipping.
- A prompt's internal line breaks do not survive the `.cmd` transport (they become spaces). POSIX and `.exe` launches carry them verbatim, so the collapse is a property of the transport, not of the prompt builders.
- A hung or killed command through cmd.exe kills cmd.exe itself; a grandchild the script spawned can outlive it. The OpenCode runner's timeout classification already treats the kill as the deadline it is.
- A missing binary through cmd.exe is cmd's 9009 exit, not a spawn `ENOENT`; the OpenCode runner's missing-binary classification reads both.
