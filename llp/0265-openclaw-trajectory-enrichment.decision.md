# LLP 0265: The OpenClaw sweep reads the run trajectory for the system prompt and tool set

**Type:** Decision
**Status:** Accepted
**Systems:** Plugins, Sources, Gateway
**Author:** Brendan / Claude
**Date:** 2026-08-18
**Related:** LLP 0026, LLP 0035, LLP 0157, LLP 0158, LLP 0167, LLP 0170, LLP 0171 (whose non-goal this lifts), LLP 0175, LLP 0194, LLP 0205

> The OpenClaw sweep gains a second file: the run trajectory OpenClaw
> already writes beside every session transcript. Two columns come out of
> it, `system_text` and `tools`, the two the transcript states nowhere.
> Both are stamped per message rather than per exchange, so the kernel's
> projected-message contract grows the pair the way it grew `model` and
> `provider` before it. OpenClaw truncates a recorded system prompt at two
> caps and announces only one, so what a row holds is described rather than
> assumed complete.

## Context {#context}

OpenClaw rows are the thinnest in `ai_gateway_messages`. On the machine this
was written from: 73 rows, `cwd` on all of them, `model` on half, and
`system_text`, `tools`, `client_version`, `entrypoint`, `git_branch`,
`tool_name`, `request_id` null on every one. Claude and Codex rows carry
most of that. The cause is not a projection gap, it is the source: the
session transcript LLP 0158's reader owns records the conversation and
nothing about the run that produced it.

The live lane would have both columns (the live projector reads `system` and
`tools` straight off the wire body, `projector.js`), but it cannot be relied
on for them: LLP 0175 has live capture misattributing and duplicating
sessions, and sweep-only is the documented safe mode until that is fixed.
Every OpenClaw row in the cache today came from the sweep.

The trajectory stream is the missing source, and it is already on disk. Every
session has a `<sessionId>.trajectory.jsonl` sibling (and a
`<sessionId>.trajectory-path.json` pointer to it), one `context.compiled`
event per run, carrying that run's compiled system prompt and its full tool
definitions. Reading it needs no OpenClaw config change, no plugin install,
and no protocol we do not already speak, which is what distinguishes it from
the other candidate source: OpenClaw's `diagnostics-otel` export is
OTLP/protobuf only (our listener is JSON only, `src/core/otlp/server.js`),
identity-stripped by design (session keys are replaced with `unknown`), and
gated on the user installing a plugin. That lane may still be worth building
for behavioral signal; it is not the way to fill these two columns.

LLP 0171#non-goals put "the trajectory-file and probe-session streams" out of
scope. That non-goal is lifted, for these two columns only.

## Decision {#decision}

### The trajectory is read, for two facts {#trajectory-reader}

**The sweep reads `context.compiled` events and takes `systemPrompt` and
`tools` from them, and nothing else.** The stream also carries prompt-cache
usage, compaction counts, abort and timeout classifications, harness
identity, the active plugin registry, and per-run tool calls. All of it is
left on disk. Each would need its own column or attribute contract, and a
half-modelled field is worse than an absent one; a later decision can take
more, from a reader that already exists.

### Per message, not per exchange {#per-message}

**`AiGatewayProjectedMessage` gains optional `system_text` and `tools`, and
the gateway's row builder prefers them over the exchange-level pair.** This
is `model`'s precedence (LLP 0026) and `provider`'s (LLP 0194), extended to
the pair they skipped, and for the same reason: a backfilled OpenClaw
exchange is a whole session, and OpenClaw compiles a fresh context per run.
One observed session ran with 23, then 21, then 26 tools under three
different system prompts. An exchange-level value would present one turn's
answer as every turn's.

No live projector sets either field, so live rows are byte-for-byte
unchanged: one request per exchange is one system prompt and one tool set,
where the exchange-level value is already exact.

### A message belongs to the run whose window covers it {#backfill-stamping}

**A run's window opens at its `context.compiled` and closes at its
`session.ended`; a run with no end is open until the next run compiles. A
message outside every window is stamped with nothing.** The last compiled
context is not evidence about a run that never compiled one: a turn that
failed before compiling, and a turn an embedded CLI harness owned, both
genuinely have no context, and inheriting the previous run's would be a
confident wrong answer in a column analyses group by.

**The match is on the session file's recording time, not the message's own
timestamp.** OpenClaw writes `session.started`, `context.compiled`, then the
turn's messages, so the record line's timestamp falls inside its own run's
window. The message envelope's timestamp does not: a webchat prompt carries
the moment the user sent it, seconds earlier, which lands before its own
run's compile. `OpenclawSessionMessage` therefore surfaces `recordedAtMs`
(the record LINE's timestamp) alongside `timestampMs` (the envelope's, which
remains what `message_created_at` is built from). The two are different
facts; only one of them orders the file.

### A recorded prompt is not a complete prompt {#truncated-prompts}

**`system_text` holds what the run recorded, and
`attributes.openclaw.system_prompt` says whether that is all of it.**
OpenClaw truncates a recorded system prompt at two caps, and only one of
them announces itself:

- **Past 32768 characters** (`TRAJECTORY_RUNTIME_DATA_STRING_MAX_CHARS`,
  hard-coded) the trajectory writer replaces the value with a
  `{ truncated: true, originalChars, limitChars }` stub. No text survives, so
  no text is stamped.
- **Below that**, the recording path still clips a long prompt to 20000
  characters and appends an ellipsis, writing an ordinary string with no
  marker. This is the dangerous one: it looks exactly like a complete
  prompt.

In the corpus this was verified against (33 runs), every string prompt
longer than a two-line probe was exactly 20001 characters ending in `…`, and
every other run was stubbed at 36k-41k. **No real agent run recorded a
complete system prompt.** A rule that stamped text whenever text was present
would therefore have put a clipped prompt in `system_text` on every
substantial run, with nothing anywhere saying so.

So truncation is detected, not assumed, three ways: the loud stub; a
recorded string shorter than the `chars` the run's own `trace.metadata`
report states for the prompt it assembled (a report `chars` of zero computed
nothing and is not evidence); and a recorded string ending in OpenClaw's
truncation ellipsis, the only trace the silent cap leaves. The ellipsis test
can fire on a prompt that genuinely ends that way, which costs a spurious
flag on a complete prompt where the alternative costs a clipped prompt
presented as complete.

The digest carries `chars` (the prompt's true assembled size), `hash` (the
content digest the run reported), `recorded_chars` (how much of it the
column holds), and `truncated`. Two runs of the same prompt stay joinable by
hash whether or not either recorded it, and no consumer has to infer
completeness from a column that cannot express it.

**Complete system-prompt text is not available from this source.** The wire
body is, and the live lane already reads it; that makes fixing LLP 0175 the
path to a complete `system_text` for OpenClaw, not any further work on the
trajectory.

### `tools` is the run's definitions, verbatim {#tools-verbatim}

**The `tools` array is stamped as OpenClaw compiled it**, name, description,
and parameter schema per entry, matching what the live lane would have taken
off the wire. It is not reduced to a name list: the column is JSON, sinks
already treat it as a wide repeated column worth dictionary-encoding
(`src/core/sinks/encoder.js`), and a name list is derivable from the full
value while the reverse is not.

## Consequences {#consequences}

- The sweep opens one more file per session. It is read after the
  `.hypignore` gate, so an ignored session's trajectory is never opened.
- Enrichment applies **from the next import onward**. Backfill dedupe skips
  rows already committed under the same `part_id`, so the sessions already in
  the cache keep their null columns until they are re-imported; this is the
  same boundary LLP 0194 accepted for `provider`.
- Rows from runs that recorded no trajectory keep both columns null, and the
  run's log line reports `run_context_count`, `messages_with_tools`, and
  `messages_with_system_text` separately so "no trajectory", "windowing miss",
  and "prompt over the cap" are distinguishable without re-reading files.
- `system_text` will be present for some turns of a session and absent for
  others, by design. A query that assumes one value per session is wrong
  about OpenClaw specifically, which is the truth the per-message contract
  exists to tell.
- Most OpenClaw rows carry a truncated or absent system prompt, and the
  digest is what makes that legible: `truncated` is set on far more rows than
  it is unset. Any consumer that treats `system_text` as the prompt sent to
  the model must filter on it.
- Fixing LLP 0175's live lane does not make this redundant: the live lane
  covers only steered providers, and the sweep is what covers the rest
  (LLP 0170's whole argument). Where both lanes see a turn, the columns
  agree, because both carry the same run's compiled context.
- A second reader now exists for a second OpenClaw file. LLP 0158's rule is
  unchanged and unthreatened: it says one reader per file, and this is the
  one reader of the trajectory.
