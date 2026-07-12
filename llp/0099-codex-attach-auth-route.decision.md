# LLP 0099: Codex attach routes by auth.json shape

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Gateway
**Author:** Kenny / Claude
**Date:** 2026-07-11
**Related:** LLP 0016, LLP 0045, LLP 0083

> `hyp attach codex` picks between two gateway routes by reading Codex's
> `auth.json`. An explicit `auth_mode` wins; when the field is absent, OAuth
> `tokens` without an `OPENAI_API_KEY` string infer the ChatGPT route.

## Context

Codex speaks the Responses wire protocol against two different upstreams
depending on how the user logged in:

- **API key** (`OPENAI_API_KEY`): `https://api.openai.com/v1/responses`.
- **ChatGPT subscription** (OAuth tokens): `https://chatgpt.com/backend-api/codex/responses`.

The gateway registers both upstream presets (LLP 0016), and attach must write
the matching `base_url` into Codex's `config.toml`: the local gateway port plus
either `/v1` or `/backend-api/codex`. Picking wrong is not a soft failure. A
subscription access token sent down the `/v1` route gets a 401 from OpenAI
("Missing scopes: api.responses.write"), because subscription tokens are not
scoped for the platform API.

Attach originally trusted a literal `auth_mode` field in
`~/.codex/auth.json` (honoring `CODEX_HOME`). Newer Codex versions stopped
writing that field: a subscription login now stores only
`{ OPENAI_API_KEY: null, tokens: {...}, last_refresh }`. Attach saw
`auth_mode: undefined`, defaulted to the `/v1` route, and every subscription
user hit the 401 above.

## Options considered

1. **Infer the mode from the file shape when `auth_mode` is absent.** OAuth
   `tokens` present and no `OPENAI_API_KEY` string means a subscription login;
   route to `/backend-api/codex`. An explicit `auth_mode` still wins.
2. **Default to the ChatGPT route.** Wrong for API-key users, who are a real
   population, and silently changes behavior for them.
3. **Ask the user at attach time.** Adds an interactive prompt to a path that
   must also run non-interactively (attach-on-join, LLP 0044), for a question
   the auth file can already answer.

## Decision

Option 1. `readCodexAuthMode` returns the explicit `auth_mode` when present;
otherwise it infers `'chatgpt'` when the file has an object `tokens` field and
no string `OPENAI_API_KEY`. Any other shape (API key present, empty file,
missing or malformed file) leaves the mode undefined and attach keeps the
`/v1` OpenAI route as the default.

The inference mirrors Codex's own fallback: Codex itself treats stored OAuth
tokens without an API key as a ChatGPT login, so attach agrees with what the
client will actually send.

## Consequences

- Subscription users attach correctly on Codex versions that no longer write
  `auth_mode`; older versions that do write it are unaffected.
- The route is decided at attach time, not per request. A user who switches
  login modes (e.g. `codex login` with an API key after a subscription login)
  must re-attach to move routes. This was already true before this decision.
- If Codex changes its `auth.json` schema again, the inference may need to
  follow. The shape check is deliberately narrow (object `tokens`, no string
  `OPENAI_API_KEY`) so schema drift fails toward the pre-existing default
  rather than misrouting API-key users.

## References

- `hypaware-core/plugins-workspace/codex/src/index.js` (`readCodexAuthMode`,
  `providerRouteForAuthMode`)
- `test/plugins/codex-auth-mode.test.js`
- LLP 0016 (gateway upstream presets), LLP 0045 (client attach design)
