# LLP 0552: The built-in remote is named `hypaware`, with `hyperparam` kept as an alias

**Type:** Decision
**Status:** Accepted
**Systems:** CLI, Query, MCP, Config
**Author:** Hernan / Claude
**Date:** 2026-10-21
**Related:** LLP 0062, LLP 0033, LLP 0494
**Extends:** LLP 0062

> LLP 0062 D1 shipped the built-in target under the name `hyperparam`, left
> over from before the HypAware brand, and the CLI printed that local key in
> what users read: `revoked agent token <id> on 'hyperparam'`, `minted agent
> token for 'hyperparam'`, `hyp remote list`. Issue #2798 asks for three
> things: messages that name the server, "revoked connection" for an OAuth
> connection id, and the built-in renamed to `hypaware` with `hyperparam`
> still working. This doc records the rename, the alias and the credential
> fallback the alias needs. It extends LLP 0062 D1 to D3; their shape (one
> built-in, a user entry of the same name wins, bare `--remote` resolves the
> default) is unchanged.

## Decision

### D1: The built-in is `hypaware`; `hyperparam` is an alias

<a id="alias"></a>`BUILTIN_REMOTES` holds `hypaware → https://api.hypaware.ai`
and `BUILTIN_DEFAULT_REMOTE` is `hypaware`. `BUILTIN_REMOTE_ALIASES` maps the
old name `hyperparam` to it. Every entry point that takes a remote name
(`--remote <name>`, `hyp remote login|mint|tokens|remove <name>`,
`hyp remote tokens revoke --remote <name>`, `hyp purge --remote <name>`,
`hyp mcp serve --remote <name>`) and `query.default_remote` resolve the name
through `canonicalRemoteName`: the user's own `query.remotes` entry of that
name wins, as LLP 0062 D1 already has it, else an alias maps to its built-in,
else the name is used as given. Config validation (LLP 0062 D3) accepts an
alias as a defined `default_remote`.

The alias is not a second registry entry. Listing it in the effective
registry would show the one server twice in `hyp remote list` and let two
logins store two sessions for it, so it is resolved at the boundary instead.

### D2: A credential stored under the old name still serves the built-in

<a id="credentials"></a>An install signed in before the rename holds its
session under the `hyperparam` key, and may export
`HYP_REMOTE_TOKEN_HYPERPARAM`. `legacyCredentialName(target, config)` names
that old key for the built-in `hypaware` target. The resolvers keep LLP 0058
D5's rule that an env override beats a stored record, so they read, in order:
`HYP_REMOTE_TOKEN_HYPAWARE`, `HYP_REMOTE_TOKEN_HYPERPARAM`, the `hypaware`
stored record, the `hyperparam` stored record. A refresh commits the rotated
session back to the key it read, so it never leaves two records behind. A new
login writes under `hypaware`, and from then on that record wins over the old
stored one; an exported `HYP_REMOTE_TOKEN_HYPERPARAM` still wins until the
user unsets it, as any env override does.

The fallback applies only while the user has neither their own `hypaware` nor
their own `hyperparam` entry in `query.remotes`. Either one may point at
another server, and a credential stored for one server is never sent to a
different one. A command decides this from the same read of the config file
that gives it the target's URL, so a config edit landing mid-command cannot
pair the old credential with another server. `hyp remote remove` treats the
old record as the built-in's and deletes it with the new one. `hyp purge`
deletes no credential: it uses the old record to authenticate the built-in's
session-data purge, so an install that has not signed in again can still
purge.

### D3: Messages name the server

<a id="messages"></a>The agent-token messages (`hyp remote mint --scope
query`, `hyp remote tokens`, `hyp remote tokens revoke`) name the server the
target points at, through `serverDisplayName` (HypAware Cloud for the
built-in, the host otherwise), not the local remote name. The remote name is
appended in parentheses only when more than one remote is configured, the
case where the server name alone can leave the reader unsure which entry was
used. Command suggestions keep the remote name, because it is the argument
the user types. A revoke of an OAuth connection id (`oauth-...`) says
"revoked connection".

## Consequences

- `hyp remote list` shows `hypaware`. Existing configs, `default_remote:
  "hyperparam"` values and `--remote hyperparam` in scripts keep working with
  no edit.
- Existing sessions keep working without a new login; the first login after
  the upgrade moves the install onto the `hypaware` key. An exported
  `HYP_REMOTE_TOKEN_HYPERPARAM` keeps winning until it is unset.
- Error lines that pair the remote with a command to run (`sign in again with
  'hyp remote login hypaware'`) still name the remote, now `hypaware`.
