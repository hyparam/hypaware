# LLP 0600: A newer config loads on an older client

**Type:** Decision
**Status:** Accepted
**Systems:** Config
**Author:** Kenny / Claude
**Date:** 2026-11-12
**Related:** LLP 0010, LLP 0025, LLP 0517, LLP 0578

> Adding a top-level config key was a breaking change for every client
> released before it. The shape check rejected a key it did not know, so an
> older client refused the whole revision that carried one, kept its
> previous config, and remembered the revision as bad until the etag
> changed, which an update to a client that understands the key does not
> do. Two changes make adding a key safe.

## Decision

<a id="unknown-keys"></a>**A reader of the organization's layer ignores a
top-level key it does not know.** `parseConfigShape` takes an
`allowUnknownKeys` option. With it, an unrecognized top-level key is skipped
and listed in the result instead of failing the document. A known key with a
bad value is still an error.

The option is passed wherever the client reads what the organization
served: the apply engine staging a pulled revision, and every read of the
stored central layer (boot, `hyp status`, setup). The apply engine logs
`config.unknown_keys_ignored` once per staged revision. Nothing is shown
to the person: a newer config on an older client is a normal state that
an update resolves.

**Authoring stays strict.** Without the option an unknown top-level key is
an error, as before. That is the default, so `hypaware-server`, which
validates a saved organization config with this function, still refuses a
misspelled key with no change on its side, and a person's own local config
file is checked exactly as it was. The party that writes a config knows
which keys exist; only the party reading one written for a newer client
has to be forgiving.

The served document is stored whole, unknown keys included, so a client
that later updates reads the key from the config it already has, without
another pull.

<a id="retry"></a>**A revision rejected before it was applied is retried on
the existing backoff.** A validation, plugin install, artifact hash, or
bundled version failure happens before anything is applied and never
restarts the daemon. Such a revision is now held back for the same 6 hours
as an unconfirmed one ([LLP 0517](./0517-unconfirmed-probation-is-retried.decision.md#retry))
and then tried again, instead of waiting for a new etag. The case that
needs this today is a config that pins a bundled plugin version newer than
the client's: the client updates to a matching release and was still stuck.

Nothing new is stored. The retry reads the `recorded_at` time the
remembered revision already carries, and a failed retry rewrites it.

A revision that was applied, ran, and was rolled back for a plain probation
expiry is unchanged: it waits for a new etag, as
[LLP 0025](./0025-remote-config-join-flow.spec.md#last-known-good-rollback)
settles. Retrying it would mean a restart every backoff.

## Consequences

- The server must run a release that knows a key before an organization
  can save it, as today. What changes is that clients older than that
  release no longer break when they pull it.
- A revision that stays invalid is re-validated every 6 hours, with one
  `config.apply_failed` log each time. A plugin install failure repeats its
  fetch on the same schedule.
- A client that updates picks up a revision it had rejected within 6
  hours, not at once.
- The log event `config.apply_retry_unconfirmed` is renamed
  `config.apply_retry`, since it now covers both kinds of retry.
- Only top-level keys are covered. Unknown keys inside `sinks`, `query`,
  `redaction`, and plugin entries are validated as before.
- Clients released before this change still reject a revision with an
  unknown key and still hold it until the etag changes.
