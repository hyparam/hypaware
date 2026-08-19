# LLP 0290: Local inference is an out-of-tree lane; core owes it a precedence contract

**Type:** Decision
**Status:** Draft
**Systems:** Gateway, Plugins, Config
**Author:** Brendan / Claude
**Date:** 2026-08-18
**Related:** LLP 0016 (the gateway owns transport, adapters own wire shapes), LLP 0030 (`session_id` is the partition key), LLP 0157 (R5), LLP 0167 / 0193 / 0194 (the OpenClaw route that already lands `ollama` rows), LLP 0234 (recording follows the path anchor)

> Capturing a local inference server (Ollama, LM Studio, llama.cpp, vLLM) is
> **not bundled work**. The `hypaware.ai-gateway@2.0.0` capability already
> names "future custom integrations" as a consumer and the install path is
> complete, so the whole lane is buildable out of tree. What core owes is the
> one thing an out-of-tree author cannot secure for themselves: a **documented
> projector dispatch precedence**, because today such a plugin's correctness
> rests on outranking an undocumented priority number inside
> `@hypaware/codex`. This document settles ownership and records the design
> constraints any implementation must satisfy.

## Context {#context}

Ollama writes no conversation record. `~/.ollama` holds `models/`,
`config.json`, a keypair, `cache/`, and server logs whose lines carry method,
path, status, and latency but no prompt or completion text. There is no REPL
history file, so a terminal `ollama run` exists only in the process.

The desktop app is different: it keeps `chats`, `messages` (with `thinking`),
`tool_calls`, and `attachments` in
`~/Library/Application Support/Ollama/db.sqlite`. That is a local-store sweep
target on the claude-desktop pattern, unrelated to the proxy lane below.

HypAware already lands `ollama` rows by exactly one route: an OpenClaw turn
against an Ollama backend, projected by the transcript sweep because LLP 0193
made the exclusion a denylist of CLI backends rather than a vendor allowlist,
and stamped with its own turn's provider by LLP 0194. That works because
OpenClaw keeps a transcript. Nothing else that talks to `localhost:11434`
does.

## Decision {#decision}

### D1. The lane is not bundled {#ownership}

Every bundled adapter captures a **named client it can find and attach
to**: Claude Code, Codex, Claude Desktop, OpenClaw. Each discovers its
client's config, writes its own overrides, and reports what it changed.

A local-inference lane can do none of that. Ollama is a server, not a client;
it has no session concept and an open-ended population of callers; and the
lane's value depends entirely on the user editing each app's `base_url` by
hand, which HypAware cannot detect, perform, or verify. A bundled picker entry
would therefore advertise a capability that does nothing until per-app manual
work happens elsewhere.

Bundling would also commit this repo to ongoing compatibility with LM Studio,
llama.cpp, vLLM, and any OpenAI-compatible proxy, for a surface where the
per-install variation (which server, which port, which apps, which session
convention) is exactly the kind of thing config and a local plugin exist to
absorb.

So the lane ships **out of tree**: a user-authored or separately published
plugin on `hypaware.ai-gateway@2.0.0`. This is the case that capability was
designed for, and the install path (`src/core/plugin_install/`, with
`buildPluginCatalog` merging installed manifests over bundled ones) already
supports it.

### D2. Core owes a projector precedence contract {#core-owes}

`dispatchProjector` filters projectors by `match()`, sorts by priority then
registration sequence, and returns the first valid projection; a decline
(`undefined` or an empty `messages` array) continues the walk.

`@hypaware/codex`'s projector matches `isOpenAiChatPath(path)`, which is true
for `/v1/chat/completions` and a bare `/chat/completions`, at priority `100`.
Ollama's OpenAI-compatible surface is exactly those paths. So any out-of-tree
local-inference projector must outrank `100` or its rows are stamped by
Codex's provider resolution, reading `provider = 'openai'` with
`model = 'gemma4:12b'`: the precise defect LLP 0194 exists to fix, arriving
through a new door.

That number is presently an implementation detail of a sibling plugin. An
out-of-tree author has no way to depend on it and no way to notice when it
changes, and the failure is silent: rows keep arriving, mislabeled.

Core therefore owes:

- a **documented priority band** reserving a range above the bundled adapters
  for third-party projectors, published with the capability rather than
  discoverable only by reading Codex;
- a **test in this repo** that pins bundled projector priorities against that
  band, so a future bump to a bundled adapter fails here instead of silently
  degrading an installed plugin.

This is the whole of core's obligation for the repoint lane.

### D3. Constraints any implementation must satisfy {#constraints}

Recorded here because they were established while investigating, and because
an out-of-tree author would otherwise rediscover them the expensive way.

**Match on `upstream`, never on path.** `AiGatewayExchangeInput` carries
`upstream: string` beside `provider`, `path`, and the bodies. Matching on
path collides with Codex per {#core-owes}. The projector must also **never
decline** for its own upstream, since a decline hands the exchange straight
back to Codex.

**Synthesize `session_id`.** It is `nullable: false`, the partition key
(LLP 0030), and a stateless server supplies nothing to fill it. Two rungs: an
explicit request header first, exact for apps the user controls; otherwise a
hash of the conversation prefix (upstream, canonicalized system prompt,
canonicalized first user message), which is stable as a thread grows because
every request resends the whole history. The mechanism is the gateway's own
fallback message identity lifted from message to thread. Known failure: two
threads with identical prefixes merge, which is what makes the header rung
matter rather than being an optimization.

**Project assistant turns from the response only, never from request
history.** Every request resends the whole thread, so prompts and tool results
must be re-emitted each turn and collapse on the gateway's content-hash
identity. Assistant turns must not: an echoed assistant message is a lossy
copy of one the response already produced (the client drops `usage`, may drop
reasoning, and re-serializes `tool_calls`), so its hash differs and it does
NOT dedupe. Verified by running: a two-turn tool-calling thread produced the
same `tool_call` row twice until echoes were excluded. The bounded cost is
that a thread first seen at turn N recovers no assistant turn before N.

**Translate the tool wire forms.** The gateway's part schema is
Anthropic-shaped: `tool_use` blocks (`id`, `name`, `input`) become `tool_call`
rows with `tool_name` / `tool_call_id` / `tool_args`, and `tool_result` blocks
(`tool_use_id`) become `tool_result` rows the gateway back-fills the tool name
onto from its own lookup. An OpenAI assistant turn carrying `tool_calls` has
`content: null`, so a projector that reads only text drops the entire turn.
Streaming splits `function.arguments` across arbitrarily many fragments keyed
by `index`, which must be accumulated and assembled at end of stream.

**Target `/v1` first.** Ollama's OpenAI-compatible surface streams real SSE,
which the gateway's WHATWG eventsource parser already turns into
`stream_events`. Native `/api/chat` and `/api/generate` stream NDJSON, which
that parser yields nothing for, and a second parser selected by response
content type is core work, not plugin work. An implementation that wants the
native surface must come back here first.

### D4. Shadow mode is out of scope, and is the only part needing core work {#shadow}

Binding the server's own port (`OLLAMA_HOST=127.0.0.1:11435` on the server,
gateway on `11434`) is the only design that captures terminal `ollama run` and
apps with a hardcoded endpoint. It is deferred, and if revived it needs a new
request, because unlike the repoint lane it cannot be done out of tree and it
carries three findings that a future author should not have to rediscover:

- **`OLLAMA_HOST` is both the server bind and the CLI client target.**
  Verified 2026-08-18: with a live server on `11434`,
  `OLLAMA_HOST=127.0.0.1:19999 ollama list` reaches `19999` and fails. A
  user-session-wide set moves the CLI off the shadowed port along with the
  server, defeating the lane silently. It must be scoped to the server
  process, which the macOS desktop app (which spawns its own server and
  injects `OLLAMA_MODELS`, `OLLAMA_NO_CLOUD`) offers no seam for.
- **An unanswered port gets reclaimed.** The CLI tries to start a server at
  the address it is pointed at when nothing answers. With the daemon down, a
  client can bind a real Ollama to the shadowed port, after which capture is
  gone with no error anywhere.
- **Recording is unconditional on the reverse-proxy branch.**
  `shouldRecordProxyExchange` honors an upstream's `record_prefix`, but the
  caller short-circuits `recording` to true for reverse-proxy traffic and
  never reaches the anchor. Since the recorder buffers whole bodies with no
  size cap, a shadowed `11434` would buffer `ollama pull` blobs into the
  daemon heap. Extending that gate is core work.

It also puts the daemon in the hard path of all local inference on the
machine, which no current adapter does, against LLP 0157 R5's spirit.

## Consequences {#consequences}

- Nothing ships in this repo for the repoint lane except {#core-owes}: a
  documented band and a test. The plugin is somebody's own.
- The plugin is trivially replaceable and per-install tunable, which suits a
  surface whose every parameter varies by machine.
- `ollama run`, the desktop app, and hardcoded-endpoint apps stay uncaptured.
  That is the accepted cost of not doing D4.
- Bundled projector priorities become a published contract, mildly
  constraining future adapter work in exchange for making out-of-tree
  adapters viable at all.
- A user who declares only an upstream, with no plugin, still gets a working
  proxy and raw rows in `ai_gateway_exchanges`; only the projection into
  `ai_gateway_messages` needs the plugin.

## Open {#open}

- **What `ollama run` posts.** Assumed `/api/chat` with accumulated messages,
  which is what would make the {#constraints} prefix hash work for it. Older
  Ollama used `/api/generate` with a token `context` array carrying no message
  history. Only matters if D4 is revived.
- **Where the band boundary sits.** {#core-owes} asserts a reserved range
  above bundled adapters without fixing the numbers; the implementing plan
  picks them.
- **Whether the desktop `db.sqlite` sweep is worth a separate adapter.** Same
  vendor, entirely different mechanism, and it would capture the GUI app the
  proxy lane cannot.

## References

- LLP 0016: AI Gateway as a Plugin
- LLP 0030: Split `session_id` from `conversation_id` in ai_gateway_messages
- LLP 0193 / LLP 0194: the OpenClaw route that lands `ollama` rows today
- LLP 0234: recording follows the path anchor
