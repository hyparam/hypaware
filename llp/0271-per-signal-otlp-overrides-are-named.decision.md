# LLP 0271: A per-signal OTLP variable in the user's environment is named, at attach and in status

**Type:** Decision
**Status:** Accepted
**Systems:** Config, Plugins, Daemon
**Author:** Phil / Claude
**Date:** 2026-08-18
**Related:** LLP 0114, LLP 0253, LLP 0257, LLP 0258, LLP 0262
**Tracker:** hyparam/hypaware#858

> The OTLP environment contract lets a per-signal key outrank the general
> endpoint an `otel` attach writes, so one variable in the user's shell sends
> every Claude Code event somewhere else, or nowhere, while every HypAware
> surface reports healthy. Attach reads the process environment as well as the
> settings `env` block it wrote, an empty value counts as set, and `hyp status`
> raises the same finding as its own diagnostic. It is a warning in both
> places: the environment is the user's, not ours to refuse or rewrite.

## Context

LLP 0258 #env-keys settles the nine keys an `otel` attach writes and manages,
`OTEL_EXPORTER_OTLP_ENDPOINT` among them. The OTLP environment-variable
contract ranks a per-signal key above the general one, so
`OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` decides where log records go whatever the
general endpoint says. That much was already known: `settings.js` carried the
key list and a warning.

What the warning could not see is where those keys actually come from. Attach
writes exactly its nine keys and never a per-signal one, so the settings `env`
block it inspected was essentially guaranteed not to hold one; the check could
only fire on a hand-edited settings file. In practice the keys are exported
from a shell profile, a launchd variable, or a collector that was switched off
months earlier and left its `set -x` lines behind.

The resulting failure is total and silent. Found on a real machine (issue
#858): a fish profile still exported `OTEL_EXPORTER_OTLP_LOGS_ENDPOINT` and
`OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` from variables that no longer resolved,
so both were exported as the empty string. Claude Code sessions launched from
that shell captured nothing; sessions launched from any other shell captured
perfectly. Meanwhile `hyp client attach claude` printed success with the right
endpoint, `hyp status` showed `attached (otel)` with a started
`claude-telemetry` source, the settings file was byte-perfect, and the raw-body
spool kept growing - because `OTEL_LOG_RAW_API_BODIES` is a file path, which
endpoint precedence cannot touch. The one observable that looks most like proof
of life is precisely the signal that survives the failure, and the bodies
accumulate as orphans until the LLP 0253 cap evicts them.

## Decision

### Attach reads the process environment, not only the block it wrote {#attach-reads-the-process-environment}

**The per-signal check runs over the process environment and the settings `env`
block, and says which one it found the key in.** The environment is where these
keys live; the settings block is the case that essentially does not happen. A
key present in both is one finding, not two - the user has one problem, and a
doubled warning list is a warning list people learn to skip.

The two sources are named apart because the repair is not the same: a settings
entry is removed by editing a file HypAware already manages, an exported
variable by editing the shell profile or launchd entry that sets it, and only
the first is somewhere a reader would think to look.

Values are still never echoed. An endpoint or a headers value is exactly where
a collector token lives, and this string is printed, logged, and serialised
into `--json`.

### It stays a warning {#warning-not-refusal}

**Attach warns and writes; it does not refuse, and it does not unset or
override the user's variable.** Three reasons, and none of them is timidity.

The environment attach can see is the shell `hyp client attach` ran in, which is not
necessarily the shell Claude Code will launch from - that is the whole shape of
the bug, in reverse. Refusing on that evidence would block an attach that is
about to work fine. Unsetting is not available either: a process cannot reach
into the shell that spawned it, and writing the key into the settings `env`
block to shadow it would make HypAware manage a key LLP 0258 #env-keys
deliberately leaves alone, and would silently break a collector the user may
still be relying on. What is left is to say it, loudly, with the value's key
name and the fact that it outranks what was just written.

### An empty value counts as set {#empty-counts-as-set}

**An empty-string per-signal value is treated as present, in both surfaces.**
This is not an edge case bolted on for completeness: it is the variant found in
the wild, and it is the worst one, because an empty endpoint blackholes rather
than redirecting - there is not even a collector holding the data. A truthiness
test is exactly what misses it. Absent (`undefined`, or a JSON `null` in the
settings block) still reads as absent.

### The key list, and what is deliberately outside it {#the-key-list}

**The list is the per-signal endpoint, protocol, and headers keys for the two
signals attach turns on, plus the general headers key.**

```
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT
OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
OTEL_EXPORTER_OTLP_LOGS_PROTOCOL
OTEL_EXPORTER_OTLP_METRICS_PROTOCOL
OTEL_EXPORTER_OTLP_LOGS_HEADERS
OTEL_EXPORTER_OTLP_METRICS_HEADERS
OTEL_EXPORTER_OTLP_HEADERS
```

The headers keys are on the list from the other side of the same hazard: they
carry a collector's credential, and it would now ride requests aimed at a
loopback listener that never asked for it. The per-signal ones outrank the
general one, so all three belong.

**A warning names the signal it is about.** The same false-alarm argument that
splits the headers keys off applies one entry over: a per-signal key outranks
only its own signal, and the two carry different things. A shell exporting
nothing but `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` to a collector, an ordinary
setup, loses the token and cost counters while every prompt and response still
reaches the listener, so a blanket "none of it is captured" is false for that
user on every `hyp status` run. Both surfaces name the signal, and only an
override of both signals gets the blanket claim.

**Traces are deliberately absent.** Attach turns on the logs and metrics
exporters and nothing else (LLP 0258 #env-keys), so
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` redirects nothing HypAware captures.
Warning about it would be a false alarm, and a warning list with a false alarm
in it is how the true ones get ignored.

The list lives in core rather than in the `claude` plugin, because attach and
`hyp status` both have to apply the same precedence rule and a second copy of
it would drift.

### Status names it too {#status-names-it-too}

**`hyp status` raises `client_telemetry_env_override`, a `warning`-severity
diagnostic, when an `otel`-attached client's environment carries one of these
keys.** This is the third leg beside LLP 0257 S17b's `client_telemetry_stale`
and S17's `capture_gap`: the gap line notices the silence only after a
threshold of transcript activity and cannot name a cause, the stale line
watches a port that is not what moved here, and this one is the cause, in hand
before any capture has been lost. It is LLP 0114 #fallback-is-visible applied
once more - a redirected export is visible, not merely silently wrong.

Non-degrading, like every other attach-drift warning, and for a reason worth
being explicit about: `hyp status` reads the environment of the shell it was
run from. That makes the finding a strong lead rather than a proof, and a
`healthy` overall with a named warning is the honest rendering of a strong
lead. It is gated on the client being configured and `otel`-attached, so it
cannot fire at a user who has no stake in these keys at all.

## Consequences

- A machine with a leftover collector export is told, at the moment of attach
  and on every `hyp status`, which key is taking its telemetry and that
  removing it or pointing it at the same local listener is the fix.
- The empty-endpoint blackhole - the variant with no receiving collector and so
  no other trace anywhere - is named as loudly as a redirect.
- A user running a genuine second collector on the traces signal is not warned
  at all, which keeps the warning meaningful for the signals that matter.
- `hyp status` reading process environment is new for this diagnostic: no other
  status line reasons about the invoking shell, and any future one has to carry
  the same "strong lead, not proof" caveat.
