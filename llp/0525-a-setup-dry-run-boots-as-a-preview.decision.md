# LLP 0525: A setup dry-run boots as a preview and creates no durable directories

**Type:** Decision
**Status:** Accepted
**Systems:** Core, Plugins, CLI
**Author:** Phil / Claude
**Date:** 2026-10-17
**Related:** LLP 0013, LLP 0524
**Extends:** LLP 0004 (#the-activation-context: a preview boot adds one
optional field to the context; #state-directories: on a preview boot the
kernel names the durable plugin dirs without creating them)

## Context

`hyp setup --dry-run` promises a preview: it prints what setup would decide
and changes nothing. The command itself kept that promise, but the boot in
front of it did not. Setup boots with every available plugin activated, and
activation as LLP 0004 specifies it hands each plugin scoped paths that the
kernel has already created. So a dry run in a fresh HOME left
`~/.hyp/hypaware/plugins/<name>/` and `~/.hyp/hypaware/cache/plugins/<name>/`
for every bundled plugin, plus the local-fs exports root, which that plugin
makes in its own `activate` (issue #2512). The sink pass after the boot would
also make a configured sink's directory.

Two shapes were on the table. Making activation lazy for every plugin would
fix the preview but change what every real boot promises its plugins. Running
the preview in a temporary state root would keep the boot unchanged but make
the displayed paths describe the wrong place, and would add a cleanup that has
to be complete. Neither is needed: the preview only has to stop the boot from
creating what it would otherwise create.

## Decision

<a id="preview-boot"></a>**An explicit setup dry-run boots as a preview.**
Dispatch reads `--dry-run` off a `setup` argv (any form, preset included, read
the way the command codec reads a boolean) and passes `preview` to the boot.
On a preview boot:

- `createPluginPaths` resolves `stateDir` and `cacheDir` to the same paths as
  a real boot, but does not create them. The per-boot temp dir is still made:
  it is outside the state root, and the boot that owns it reclaims it at
  teardown.
- Each plugin's activation context carries `preview: true`. A plugin must not
  create or change persistent state in `activate` when it is set: it registers
  and provides as usual, and leaves directories and files for a real boot. The
  field is absent on every other boot, so a real activation's context is
  unchanged.
- No sink is materialized, since opening one makes its directory.

Plugin selection, config reading and every decision the command prints are
the same as a real run, so the preview still describes the real target.

A malformed `--dry-run` value makes the argv a preview whatever follows it:
the codec refuses the first bad value, so the command never runs, and a
refused preview must not have created anything on the way either.

The preview covers the boot and the setup command, not the invocation's
consented product telemetry. When the user has opted in, the outer invocation
summary LLP 0393 requires is still recorded for a preview as for any other
command; that opt-in is the consent for it, and a fresh or unenrolled install
records nothing.

A real boot is unchanged: LLP 0004's promise that a plugin's scoped dirs exist
when `activate` runs still holds for every boot that is not a preview.

## Consequences

- A preview in a fresh HOME, or over an existing install, leaves the file and
  directory tree byte-for-byte as it found it, apart from the consented
  product-telemetry record above when the user has opted in.
- A plugin that creates directories in `activate` has to honor
  `ctx.preview`. The bundled plugins that did so (local-fs) now do.
- The setup guards that run before or during the command (the
  unsupported-platform refusal and the legacy-proxy preflight, LLP 0524) are
  unaffected and still refuse a preview the same way.
