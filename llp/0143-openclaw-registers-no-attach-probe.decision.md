# LLP 0143: OpenClaw registers no attach_probe, and json_path retires

**Type:** Decision
**Status:** Draft
**Systems:** Plugins, Config, CLI
**Author:** Phil / Claude
**Date:** 2026-07-29
**Related:** LLP 0044 (client attach on join), LLP 0045 (client attach design), LLP 0109 (OpenClaw client adapter), LLP 0115 (Claude Desktop managed-config attach), LLP 0142 (plugin-steered shadow providers)

> Once LLP 0142 stops writing to `openclaw.json`, there is no reversible
> settings-file write for the LLP 0044 loop to reverse. Follow the precedent
> already set for Claude Desktop: register no `attach_probe`, let
> `detachClientFromDisk` be an honest no-op. The `json_path` probe format
> LLP 0109 added to core then has zero consumers and is removed with it.

## Context

LLP 0045 Part 3 makes detach a single core, disk-driven, plugin-agnostic
undo keyed off the manifest `attach_probe`. The contract's precondition is
that attach performed a **reversible write to the client's own settings
file**, with the marker doubling as the backup.

LLP 0109 satisfied that precondition by inventing a third probe format,
`json_path`, because OpenClaw's config is strictly validated — a top-level
`_hypaware` key would stop the OpenClaw gateway from starting — so the undo
record had to ride inside the injected provider's free-form `headers` map.

LLP 0142 removes the write. There is nothing left on disk to reverse.

The corpus has already faced this exact shape and settled it.
LLP 0115#no-attach-on-join established that Claude Desktop registers no
`attach_probe`, because the LLP 0044 loop needs a reversible settings-file
write and a root-owned managed plist is not one. When a `json_path` probe
was reintroduced for Desktop anyway, it broke `hyp detach` on precisely the
machines where install had succeeded, and was removed (#444/#445) with the
reasoning that "an `attach_probe` is not a label, it is the input to
`probeClientAttachFromDescriptor` / `detachClientFromDisk`."

That is the same mistake available here: keeping a probe as a decorative
"this client is attached" marker after the write it described is gone.

One further fact makes this cheap: **OpenClaw is the sole remaining
`json_path` consumer.** After Desktop dropped its probe, the only
`"format": "json_path"` in the tree is
`hypaware-core/plugins-workspace/openclaw/hypaware.plugin.json`.

## Options considered

1. **Keep a `json_path` probe pointing at something inert** so `hyp status`
   still shows OpenClaw as attached. Rejected: a probe is an executable
   contract, not a label. A probe with no reversible write behind it either
   half-reverses or errors, and both are worse than saying nothing.
2. **Move the marker into HypAware state (`HYP_HOME`).** Rejected for the
   same reason LLP 0109 rejected it: it violates LLP 0045 Part 3, and
   breaks when state and the client's real configuration drift. The drift
   is now guaranteed rather than hypothetical, since the real state lives
   in OpenClaw's plugin registry.
3. **Register no `attach_probe`; state lives in OpenClaw's own plugin
   list.** Chosen.

## Decision

- `contributes.client` for OpenClaw declares **no** `attach_probe`.
  `skill_dir` (and `agent_dir` if added) stay, since those are labels and
  are read as such.
- `hyp detach --client openclaw` returns `{ changed: false }` at
  `detachClientFromDisk`'s existing no-probe guard — an honest no-op,
  matching Desktop.
- The retraction path is OpenClaw's own: uninstall or disable the HypAware
  OpenClaw plugin. Attach's forward path is likewise plugin installation,
  not a file write.
- Attach-on-join (LLP 0044) stays **inert** for OpenClaw, exactly as it is
  for Desktop, because the plugin registers no runtime `ctx.clients`
  adapter that writes settings.
- The `json_path` format is removed from core: the branch in
  `src/core/config/client_detach_disk.js`, its `probe.format === 'json_path'`
  guard, and the corresponding branch in `src/core/daemon/status.js`.
  `json` (marker-key) and `toml` (managed-block) remain.

The `MALFORMED_MARKER` guard and the refuse-over-half-reverse principle are
untouched. Nothing about `json`/`toml` clients changes.

## Consequences

- Core loses a whole probe/undo format that LLP 0109 added and that now has
  no callers — a net simplification of the attach surface, not a
  workaround.
- `hyp status` no longer reports OpenClaw attach state from disk. Whether
  it should learn to report it from OpenClaw's plugin registry instead is
  deliberately left open below; showing nothing is preferable to showing a
  probe that cannot be reversed.
- Anyone who attached under LLP 0109 keeps a `models.providers.hypaware`
  entry and a repointed `model.primary` in their `openclaw.json`, and
  removing the format removes the code that would have reversed it. This is
  accepted as a **breaking change**: the OpenClaw adapter has no meaningful
  installed base yet, so paying for a migration path costs more than it
  saves. No deprecation window, no one-release grace period — the format
  goes with the write it described.
- Anyone who did attach under LLP 0109 removes the leftovers by hand: delete
  the `models.providers.hypaware` block and restore `model.primary` to the
  `anthropic/<model>` value recorded in the marker's `prev` field. Worth one
  line in the release notes; not worth code.

## Open questions

- Should `hyp status` grow a plugin-registry-derived attach signal for
  clients with no settings-file probe (OpenClaw, Desktop)? That would serve
  both, and is worth its own LLP rather than being smuggled in here.

## References

- LLP 0044, 0045, 0109, 0115, 0142
- `src/core/config/client_detach_disk.js`, `src/core/daemon/status.js`
- `hypaware-core/plugins-workspace/openclaw/hypaware.plugin.json`
- `hypaware-core/plugins-workspace/claude-desktop/src/index.js`
