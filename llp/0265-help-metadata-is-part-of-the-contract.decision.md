# LLP 0265: Help metadata is part of the command contract

**Type:** Decision
**Status:** Accepted
**Systems:** CLI
**Author:** neutral / Claude
**Date:** 2026-08-18
**Related:** LLP 0009 (#layered-help, #central-help-interception: the help system this extends), LLP 0062 (#bare-remote: the optional target name `remote login --help` has to admit), LLP 0137 (#pathway-defaults: the retention question `init --help` still described), LLP 0214 (#d1, #d2: the previous extension of the same help system)

> Extends [LLP 0009 #layered-help](./0009-cli-registry.spec.md) and
> [#central-help-interception](./0009-cli-registry.spec.md). Dispatch renders
> `summary` / `usage` / `help` straight off the registration, which makes the
> registration the *only* description a user gets, and nothing has been
> checking that it still matches the handler. Four registrations had drifted.
> This settles what a registration owes its handler, adds `hyp help <command>`,
> and gives the working-but-unlisted surfaces (`--version`, `-V`, `unattach`) a
> place in top-level help.

## Context {#context}

LLP 0009 #central-help-interception makes core the sole renderer of per-command
help: a command body never prints its own usage, so the `usage` and `help`
strings on the registration are the entire published interface of that command.
That is a good arrangement precisely because it is centralized, and a bad one
when nothing pins the strings to the code: a handler can grow a flag, drop a
question, or make a positional optional without a single test noticing that the
registration now lies.

The audit that produced issue #835 found four such lies at once (an `init`
walkthrough that no longer asks for retention, a `remote login` whose target
name became optional, a `daemon restart` that restarts rather than stops, a
`skills install` whose `--client` defaults to `all`), plus three surfaces that
work but appear nowhere: `--version`, `-V`, and the `unattach` alias. The
common cause is that help was treated as prose attached to a command rather
than as an assertion about it.

## Decision

<a id="registration-is-the-contract"></a>**A command's `summary`, `usage`, and
`help` are claims about its handler, and are tested as claims.** Every accepted
flag and positional appears in `usage`; an optional positional is spelled
`[name]`, not `<name>`; a summary describes the path the handler actually takes
first, with the fallback path (if any) explained in `help` and qualified as a
fallback. Where a command's shape is settled by an LLP, the registration
carries a `@ref` to it, so the next reader of the help text can see what
constrains it.

Tests assert the *semantic* claim, not the presence of a flag token: "the help
does not say the walkthrough asks for a retention window" is checkable and was
the defect; "the help mentions `--retention-days`" was already true while the
surrounding sentence was false.

<a id="platform-is-a-render-override"></a>**`hyp daemon install --platform
darwin|linux` is public, and requires `--dry-run`.** It was accepted by the
parser, omitted from public usage, and used in-repo only to render the other
platform's unit for inspection. Rendering another platform's plist or unit file
is a genuinely useful thing to be able to ask for and there is no reason to
hide it. Performing an *install* for another platform is not: the install
writes into this host's service directory and then calls this host's service
manager, so a cross-platform install can only produce a broken one. So the flag
is documented, and refused outside a dry run, in the same shape as the
pre-existing `--json requires --dry-run` rule.

<a id="help-verb"></a>**`hyp help <command...>` renders that command's help.**
It is rewritten to `hyp <command...> --help` and routed through ordinary
dispatch rather than answered separately. Routing is what makes it reach
plugin-contributed commands: top-level help renders before `bootKernel`
(LLP 0009 #top-level-help-lists-plugin-commands-without-booting) and so cannot
see them, while the rewritten argv boots normally and hits the same central
`--help` interception every other command help goes through. Bare `hyp help`
keeps its existing meaning, the top-level table, and `hyp help --version` (a
flag, not a command) is left alone.

Answering `hyp help query` with the top-level table was the worst available
behavior: it is indistinguishable from success, so the user reads the wrong
page believing they asked for it.

<a id="global-options"></a>**Top-level help names the global options and the
command aliases.** LLP 0009 #layered-help settles the *command* listing as one
row per top-level token; that is unchanged. `--help/-h` and `--version/-V` are
not commands and never had a row, and an alias routes without one by design, so
under a rule that only lists commands they were undiscoverable by construction.
They get two short sections after the command table instead:

```
Global options:
  --help, -h     show this list, or a command's help (`hyp help <command>` too)
  --version, -V  print the version (`hyp version` adds runtime detail)

Aliases:
  unattach       detach
```

The alias rows are read off the registry, so a new alias lists itself. Only
core aliases appear: top-level help lists plugin commands from their manifests,
which declare no aliases, and booting to find out is exactly the cost LLP 0009
refused to pay for help.

## Consequences {#consequences}

A registration change that contradicts its handler is now a test failure rather
than a documentation bug found in an audit. The cost is that `usage` strings
grow: `remote login` and `daemon install` both gained a flag list they had been
eliding. That is the intended trade; the alternative was a shorter line that
was not true.

`--platform` outside `--dry-run` now exits 2 where it previously attempted an
install. No caller in this repo used it that way, and the ones that would have
were wrong.
