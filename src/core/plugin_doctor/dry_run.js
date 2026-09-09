// @ts-check

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Attr, getLogger } from '../observability/index.js'
import { createActivationContext, createKernelRuntime } from '../runtime/activation.js'
import { createCommandRegistry } from '../registry/commands.js'
import { createVerbRegistry } from '../registry/verbs.js'
import { createPluginPaths } from '../runtime/paths.js'
import { createSourceRegistry } from '../registry/sources.js'

/**
 * @import { ActivePlugin, CommandRegistration, PluginManifest, SourceContribution, StartedSource } from '../../../hypaware-plugin-kernel-types.js'
 * @import { ExtendedSinkRegistry, ExtendedSourceRegistry } from '../../../src/core/registry/types.js'
 * @import { DryRunResult, RegisteredCommand, RegisteredSnapshot } from '../../../src/core/plugin_doctor/types.js'
 */

const DRY_RUN_ID = 'doctor-dryrun'

// Provider name used when pre-seeding capabilities other plugins would
// supply at runtime. Filtered back out of the snapshot so these stubs
// never count as contributions of the plugin under test.
const STUB_PROVIDER = '@doctor/stub-provider'

/**
 * Activate a single plugin in isolation so the doctor can see what its
 * `activate()` actually registers. Unlike the kernel loader
 * (`src/core/runtime/loader.js`), this:
 *
 * - builds a throwaway `KernelRuntime`, so registrations never touch the
 *   live kernel;
 * - roots all plugin paths in a fresh `mkdtemp` directory that is
 *   removed before returning, and points `ctx.env.HYP_HOME` at that same
 *   directory, so no state leaks into the caller's `<HYP_HOME>`;
 * - hands the plugin a source registry whose `start()` never runs the
 *   contribution. `@hypaware/otel` starts its own OTLP source from
 *   `activate()`, which binds a real port; a diagnostic pass must not
 *   take one, and it has no bearing on what the plugin registers;
 * - passes an empty config. A well-behaved plugin registers its
 *   contributions during `activate()` and defers config reads to
 *   `start()`/`create()`. A plugin that throws on missing config at
 *   activation surfaces as `activate_threw`, which is itself a finding;
 * - pre-seeds the capability registry with stub providers for every
 *   capability a bundled/installed plugin offers, so a plugin that calls
 *   `ctx.requireCapability()` during `activate()` resolves the handle
 *   instead of false-failing as `activate_threw`.
 *
 * Trust boundary: this is NOT a security sandbox. The entrypoint is
 * imported and `activate()` is run in-process with the real environment;
 * only `ctx.paths` (state/cache/temp) is isolated to a throwaway dir.
 * Run the doctor only on plugin code you trust, same as installing it.
 *
 * Import or activation failures are captured (never thrown) so the
 * doctor can report them alongside the static checks.
 *
 * Note: the entrypoint is loaded with dynamic `import()`, which caches
 * by resolved URL. Each CLI invocation is a fresh process so this never
 * bites in normal use; within one long-lived process (tests/smokes),
 * re-doctoring the *same* path returns the first-loaded module. Point
 * such callers at distinct directories.
 *
 * @param {PluginManifest} manifest
 * @param {string} rootDir Absolute path to the plugin directory.
 * @param {{ knownCapabilities?: Map<string, string[]> }} [opts]
 *   `knownCapabilities` maps a capability name to the versions other
 *   plugins provide; each is pre-seeded as a stub so `requireCapability`
 *   resolves during the dry run.
 * @returns {Promise<DryRunResult>}
 */
export async function dryRunActivate(manifest, rootDir, opts = {}) {
  const knownCapabilities = opts.knownCapabilities ?? new Map()
  const snapshot = emptySnapshot()
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'hyp-doctor-'))
  try {
    // Empty verb registry (no core verbs), so the kernel-projected
    // `query sql` command never counts as a contribution of the plugin
    // under test. The plugin's own `ctx.verbs.register` still projects its
    // commands into this registry, so a plugin that contributes a verb is
    // diagnosed exactly like one that contributes a command.
    const commandRegistry = createCommandRegistry()
    const runtime = createKernelRuntime({
      cacheRoot: path.join(tmpRoot, 'cache'),
      commandRegistry,
      verbRegistry: createVerbRegistry({ commandRegistry }),
      sourceRegistry: inertSourceRegistry(),
    })
    for (const [name, versions] of knownCapabilities) {
      for (const version of versions) {
        runtime.capabilities.provide(STUB_PROVIDER, name, version, capabilityStub())
      }
    }
    const paths = await createPluginPaths({
      pluginName: manifest.name,
      rootDir,
      stateRoot: tmpRoot,
      runId: DRY_RUN_ID,
      tmpRoot,
    })
    /** @type {ActivePlugin} */
    const plugin = { name: manifest.name, version: manifest.version, manifest, rootDir }
    // `ctx.env` defaults to `process.env`, which points a plugin that reads
    // `HYP_HOME` during `activate()` at the caller's real install:
    // `@hypaware/local-fs` mkdirs `<HYP_HOME>/exports` from `activate()`, so
    // merely diagnosing it wrote into the home directory this function
    // promises not to touch. Redirect `HYP_HOME` at the throwaway root the
    // rest of the dry run already uses. The rest of the environment is passed
    // through: this is a diagnostic, not a sandbox (see the trust boundary
    // above), and a plugin that reads `PATH` should see what it would see for
    // real.
    const env = { ...process.env, HYP_HOME: tmpRoot }
    const ctx = createActivationContext({ runtime, plugin, paths, config: {}, env })

    const entrypointAbs = path.resolve(rootDir, manifest.entrypoint)
    let mod
    try {
      mod = await import(pathToFileURL(entrypointAbs).href)
    } catch (err) {
      return { ok: false, error: { kind: 'entrypoint_import_failed', message: describe(err) }, registered: snapshot }
    }

    if (typeof mod.activate !== 'function') {
      return {
        ok: false,
        error: {
          kind: 'activate_missing',
          message: `entrypoint '${manifest.entrypoint}' does not export an activate() function`,
        },
        registered: snapshot,
      }
    }

    try {
      await mod.activate(ctx)
    } catch (err) {
      // Snapshot whatever registered before the throw. Partial output
      // still helps locate the failing registration.
      return {
        ok: false,
        error: { kind: 'activate_threw', message: describe(err) },
        registered: snapshotRegistry(runtime, commandRegistry),
      }
    }

    return { ok: true, registered: snapshotRegistry(runtime, commandRegistry) }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Read the registered names out of a kernel runtime after activation.
 * Sinks are read from `listContributions()` (a dry-run `register()` adds
 * a contribution, not a materialized handle). Pre-seeded stub
 * capabilities are excluded so only what the plugin itself provided
 * shows up.
 *
 * Every name here is the key its registry validated and indexed by, taken
 * through `registeredName`, not a fresh read of the record. The source,
 * dataset, init-preset and group registries store the object the plugin
 * passed, by reference, and `CommandRegistry`'s shallow copy still carries
 * the plugin's own `aliases`, so a re-read is the plugin answering the
 * question again, free to answer differently (issue #1538). An operator runs
 * `hyp plugin doctor` to see what a plugin claims before trusting it, so the
 * divergence has no symptom: the report renders as a well-formed list, of a
 * registry holding something else.
 *
 * `capabilities` is read plainly: `capabilities.list()` returns fresh
 * `{ name, version, provider }` objects built from the string arguments
 * `provide` was called with, so there is nothing plugin-controlled left to
 * read.
 *
 * `skills` and `agents` are contained but not verified. `skills.register` and
 * `agents.register` do build a registry-owned record out of the fields they
 * validated, but `list()` hands the elements of that array straight back
 * (`items.slice()` copies the array, not its entries) and `ctx.skills` and
 * `ctx.agents` are on the activation context, so a plugin that calls `list()`
 * inside its own `activate()` can install an accessor on the very record the
 * registry holds. Neither registry is keyed, so there is no key to resolve a
 * name back to and no divergence to detect here; the guard below can only stop
 * a throwing accessor costing the whole run, and closing the rest belongs in
 * those two registries (hyparam/hypaware#1552).
 *
 * @param {ReturnType<typeof createKernelRuntime>} runtime
 * @param {ReturnType<typeof createCommandRegistry>} commandRegistry
 *   The same registry `runtime` was built over. Passed separately because
 *   group descriptions are not commands, so `KernelRuntime.commands` (the
 *   plugin-facing `CommandRegistry`) does not expose `listGroups`.
 * @returns {RegisteredSnapshot}
 */
function snapshotRegistry(runtime, commandRegistry) {
  const sinks = /** @type {ExtendedSinkRegistry} */ (runtime.sinks)
  // One read for both buckets. `commands` and `commandDetails` describe the
  // same registrations, and two passes could disagree with each other as well
  // as with the registry.
  const commandDetails = readCommands(commandRegistry)
  return {
    sources: registeredNames(runtime.sources.list(), 'source', (_, name) => runtime.sources.get(name)),
    sinks: registeredNames(
      sinks.listContributions(),
      'sink',
      // Keyed by plugin and name together, so both halves have to be right.
      // `plugin` is taken off the registry's own wrapper rather than re-read
      // off the contribution, which is the best this side can do: `register`
      // builds the key from one read of `contribution.plugin` and the wrapper
      // from the next one, so the two can differ under a drifting accessor
      // (hyparam/hypaware#1553). A pair that misses is refused, which
      // under-reports a real sink rather than reporting a false name.
      (entry, name) => sinks.getContribution(entry.plugin, name),
      (entry) => entry.contribution
    ),
    datasets: registeredNames(runtime.query.listDatasets(), 'dataset', (_, name) => runtime.query.getDataset(name)),
    commands: commandDetails.map((c) => c.name),
    commandDetails,
    commandGroups: readCommandGroups(commandRegistry),
    // No registry accessor to resolve through, so `itself` makes the resolve
    // trivially true: what this buys is the containment, not the check.
    skills: registeredNames(runtime.skills.list(), 'skill', itself),
    agents: registeredNames(runtime.agents.list(), 'agent', itself),
    init_presets: registeredNames(runtime.initPresets.list(), 'init preset', (_, name) => runtime.initPresets.get(name)),
    capabilities: runtime.capabilities
      .list()
      .filter((c) => c.provider !== STUB_PROVIDER)
      .map((c) => c.name),
  }
}

/**
 * The default `stored`: every registry but the sink one lists the object it
 * holds.
 *
 * Doubles as the `resolve` for the two registries that are not keyed at all
 * (`skills`, `agents`), where it makes the check trivially true and leaves
 * only the containment `registeredName` wraps the read in.
 *
 * @param {any} record
 * @returns {object}
 */
function itself(record) {
  return record
}

/**
 * The key one record is registered under, or `undefined` when it does not read
 * back to one.
 *
 * The name is read exactly once and then resolved back through the registry: a
 * record that is not what the registry answers with for the name it just
 * claimed is not registered under that name, whatever it says. That is the
 * guard `readIdentity` already applies to a backfill provider in
 * `src/core/daemon/backfill_sweep.js`. The other remedy on the table is for
 * `list()` to hand back the key it ordered by, so a consumer cannot re-read at
 * all; that one belongs in the registries, not here.
 *
 * A refusal is reported and the record left out. A name this cannot vouch for
 * is the one thing the report may not carry, and dropping it without a word is
 * the same silence one entry smaller.
 *
 * Beyond the read: one lookup through the registry's own accessor, and nothing
 * allocated per record.
 *
 * @template T
 * @param {T} record
 * @param {string} kind What to call it in the report when it is refused.
 * @param {(record: T, name: string) => unknown} resolve
 *   What the registry answers for the name just read.
 * @param {(record: T) => object} [stored] The object the registry holds, when
 *   the listing wraps it.
 * @returns {string | undefined}
 */
function registeredName(record, kind, resolve, stored = itself) {
  let claimed = ''
  try {
    const held = stored(record)
    const read = /** @type {{ name?: unknown }} */ (held).name
    if (typeof read === 'string') claimed = read
    // Every `register` here refuses an empty name, so the empty string a
    // record that claimed nothing readable carries resolves to nothing.
    if (claimed.length > 0 && resolve(record, claimed) === held) return claimed
  } catch {
    // Reading the identity is what just failed. Whatever was read before the
    // throw still names the record better than nothing does.
  }
  reportUnreadable(kind, claimed)
  return undefined
}

/**
 * Every name in one registry's listing that reads back to its own key, in the
 * order the registry listed them. A record that does not is left out, having
 * said so.
 *
 * @template T
 * @param {T[]} records
 * @param {string} kind
 * @param {(record: T, name: string) => unknown} resolve
 * @param {(record: T) => object} [stored]
 * @returns {string[]}
 */
function registeredNames(records, kind, resolve, stored) {
  /** @type {string[]} */
  const names = []
  for (const record of records) {
    const name = registeredName(record, kind, resolve, stored)
    if (name !== undefined) names.push(name)
  }
  return names
}

/**
 * The registered commands, as the help checks read them.
 *
 * @param {ReturnType<typeof createCommandRegistry>} commandRegistry
 * @returns {RegisteredCommand[]}
 */
function readCommands(commandRegistry) {
  /** @type {RegisteredCommand[]} */
  const details = []
  for (const record of commandRegistry.list()) {
    const name = registeredName(record, 'command', (_, claimed) => commandRegistry.get(claimed))
    if (name === undefined) continue
    // `summary` and `hidden` are plugin-controlled too, and are read here
    // beside the guarded name. Neither is a key, so neither can misattribute a
    // finding, but an accessor that throws would escape `snapshotRegistry`,
    // which runs outside the dry run's own catch, and cost `hyp plugin doctor`
    // the whole run over one plugin. Contained to the same one entry a
    // refused name costs.
    /** @type {RegisteredCommand} */
    let detail
    try {
      detail = {
        name,
        summary: record.summary,
        aliases: registeredAliases(commandRegistry, record),
        hidden: record.hidden === true,
      }
    } catch {
      reportUnreadable('command', name, 'did not answer for its summary or hidden flag')
      continue
    }
    details.push(detail)
  }
  return details
}

/**
 * The alias spellings that actually dispatch to this command.
 *
 * `register` copies the registration shallowly, so `record.aliases` is still
 * the plugin's own value and iterating it here is another pass over a
 * plugin-controlled iterable, free to name spellings the alias index does not
 * hold (issue #1538). Each one is resolved back through the registry, which
 * finds a command by alias, and only those that come back as this command are
 * reported.
 *
 * That does not make the list complete. An iterable yielding fewer names than
 * were indexed under-reports, and nothing here can see it: the alias index is
 * private to the registry, so there is no set to compare against. Only `list()`
 * handing back the registry's own keys would close that.
 *
 * The `includes` scan is quadratic in one command's alias count, which is one
 * across the bundled set (17 aliases over 35 commands, none claiming two), and
 * costs nothing for the commands that claim none.
 *
 * @param {ReturnType<typeof createCommandRegistry>} commandRegistry
 * @param {CommandRegistration} record
 * @returns {string[]}
 */
function registeredAliases(commandRegistry, record) {
  /** @type {string[]} */
  const aliases = []
  try {
    for (const alias of record.aliases ?? []) {
      if (typeof alias !== 'string' || commandRegistry.get(alias) !== record) {
        reportUnreadable('command alias', typeof alias === 'string' ? alias : '')
        continue
      }
      // A repeat is dropped rather than refused: the alias index is a map, so
      // it holds one entry however many times the iterable names it.
      if (!aliases.includes(alias)) aliases.push(alias)
    }
  } catch {
    // A throw part way through the iterable reaches `snapshotRegistry`, which
    // runs outside the dry run's own catch, so one hostile `Symbol.iterator`
    // costs `hyp plugin doctor` the whole run rather than the plugin a
    // finding. Keep what was drained before it and say the rest went missing.
    reportUnreadable('command alias', '')
  }
  return aliases
}

/**
 * The registered group descriptions. `registerGroup` stores the object the
 * plugin passed, so the name is read under the same guard as every other one,
 * and the summary is read once beside it.
 *
 * @param {ReturnType<typeof createCommandRegistry>} commandRegistry
 * @returns {{ name: string, summary?: string }[]}
 */
function readCommandGroups(commandRegistry) {
  /** @type {{ name: string, summary?: string }[]} */
  const groups = []
  for (const record of commandRegistry.listGroups()) {
    const name = registeredName(record, 'command group', (_, claimed) => commandRegistry.getGroup(claimed))
    if (name === undefined) continue
    // Contained for the same reason the command detail above is: a throwing
    // `summary` accessor must cost this group its row, not the doctor its run.
    let summary
    try {
      summary = record.summary
    } catch {
      reportUnreadable('command group', name, 'did not answer for its summary')
      continue
    }
    groups.push({ name, ...(summary !== undefined ? { summary } : {}) })
  }
  return groups
}

/**
 * Say that one registration was left out of the snapshot, and why.
 *
 * On the stderr mirror as well as the log, the way `CommandRegistry`'s own
 * dropped-member warning is (LLP 0329#stderr-mirror): `hyp plugin doctor` runs
 * on a default install, where no log provider is installed and the OTel half
 * of the emit drops the record. The report itself goes to stdout, so the
 * mirror does not disturb `--json`.
 *
 * @param {string} kind
 * @param {string} claimed The name it claimed, or the empty string when it
 *   claimed nothing readable.
 * @param {string} [why] What was wrong with it, when it was not the name. The
 *   default clause is false about a record whose name read back fine and whose
 *   `summary` was the accessor that threw.
 */
function reportUnreadable(kind, claimed, why = 'is not registered under it') {
  const named = claimed.length > 0 ? `'${claimed}'` : 'an unreadable name'
  try {
    getLogger('plugin-doctor', { mirrorStderr: true }).warn(
      `hyp plugin doctor: a registered ${kind} claiming ${named} ${why}; left out of the report`,
      {
        [Attr.OPERATION]: 'doctor.snapshot',
        [Attr.STATUS]: 'degraded',
        [Attr.ERROR_KIND]: 'unregistered_contribution_name',
        contribution_kind: kind,
        claimed_name: claimed,
      }
    )
  } catch {
    // Nothing to say it on: the channel that would carry the report is the
    // thing that just failed. The entry stays out of the snapshot either way.
  }
}


/**
 * A source registry that records registrations but refuses to run them.
 * A plugin may start one of its own sources from `activate()` (see
 * `@hypaware/otel`, which binds the OTLP listener there), and the doctor
 * only ever reads back `list()`. Running the real `start()` would bind
 * ports and open files on behalf of a plugin the caller is merely
 * inspecting, and would fail outright on a host where the daemon already
 * holds the port.
 *
 * @ref LLP 0267#d4 [implements]: diagnosing a plugin must not take a port on its behalf
 * @returns {ExtendedSourceRegistry}
 */
function inertSourceRegistry() {
  const registry = createSourceRegistry()
  return {
    ...registry,
    /** @param {SourceContribution} contribution */
    register(contribution) {
      // Neutered at registration, not by overriding `start`. The registry
      // records the started handle in a map it closes over, so an override
      // that returned its own handle left `reload`/`status`/`started`
      // believing the source never started: a plugin that starts one of its
      // own sources from `activate()` and then reloads it would fail its dry
      // run as `activate_threw` under a kernel where it works. Routing the
      // no-op through the real `register` keeps the whole lifecycle
      // bookkeeping intact and runs nothing.
      //
      // A malformed contribution is passed through untouched so the real
      // `register` still rejects it: a source missing `start()` is a finding
      // about the plugin, not something the doctor should paper over.
      //
      // The stand-in delegates rather than copying. The guard below reads
      // `start` through the prototype chain while a spread carries own
      // enumerable properties and nothing else, so the two disagreed on a
      // contribution that is a class instance: what reached the real
      // `register` had lost whatever `name`, `plugin`, or `configSection`
      // the class supplies from its prototype, and the doctor reported a
      // fabricated `activate_threw` about a missing name against a plugin
      // the kernel registers and starts without complaint. Validating one
      // object and storing another is the same defect
      // `src/core/registry/commands.js` fixed by copying before it checks;
      // this registry stores by reference, so the fix here is the opposite
      // direction: hand it something that reads like the contribution rather
      // than a flattened copy of it.
      if (contribution && typeof contribution === 'object' && typeof contribution.start === 'function') {
        registry.register(neuter(contribution))
        return
      }
      registry.register(contribution)
    },
  }
}

/**
 * Wrap a source contribution so the registry stores the contribution it was
 * handed, minus a live `start()`. Every read but `start` forwards to the
 * original with the original as the receiver, so inherited fields, accessors,
 * and private state answer exactly as they do under the real kernel, and
 * neutering writes nothing to the plugin's own object. It does not make that
 * object read-only: a write, a define, a delete, and the extensibility
 * operations (`preventExtensions`, and the `seal` and `freeze` built on it)
 * all reach the contribution, because the real registry hands the
 * contribution out by reference and does not shield it either.
 *
 * @param {SourceContribution} contribution
 * @returns {SourceContribution}
 */
function neuter(contribution) {
  /**
   * @param {object} _target
   * @param {string | symbol} prop
   */
  function get(_target, prop) {
    if (prop === 'start') return inertStart
    // The receiver is the contribution, not the proxy, so an accessor that
    // reads a private field off `this` still finds it.
    return Reflect.get(contribution, prop, contribution)
  }

  /**
   * The descriptor `start` is reported and pinned with. It answers with the
   * inert function every read answers with, because a descriptor disagreeing
   * with the read trips a proxy invariant the moment anything compares the
   * two. An own accessor `start` keeps its kind and gets a substitute getter
   * rather than becoming a data property: reporting the real getter would
   * hand back the live `start()` this stand-in exists to keep unreachable,
   * but reporting a value instead changes the descriptor's kind, and
   * `Object.freeze(stored)` reads that kind back before it redefines. Told
   * the property is data, freeze sends `writable: false`, which an accessor
   * on the contribution refuses, and the plugin gets the fabricated
   * `activate_threw` this stand-in exists to avoid for the ordinary freeze
   * the kernel completes.
   *
   * @param {PropertyDescriptor} desc The contribution's own descriptor.
   * @returns {PropertyDescriptor}
   */
  function startDescriptor(desc) {
    if (desc.get === undefined && desc.set === undefined) return { ...desc, value: inertStart }
    return { get: inertStartGetter, set: desc.set, enumerable: desc.enumerable, configurable: desc.configurable }
  }

  /**
   * Undo `startDescriptor` on a descriptor coming back the other way. The
   * one a plugin reads off this stand-in names the inert function, and
   * forwarding that to the contribution writes this module's own function
   * onto the plugin's object, against the promise above that neutering
   * writes nothing there. Under the kernel
   * `defineProperty(stored, 'start', getOwnPropertyDescriptor(stored, 'start'))`
   * is an ordinary no-op, so whatever the contribution holds goes back in
   * and it stays one. A define naming a function of the plugin's own is left
   * alone: that one really is meant to land.
   *
   * The substitute has to be swapped back out whatever kind `start` now is,
   * not only when it is the kind the descriptor was read as. A plugin that
   * turns its own `start` from a data property into an accessor between the
   * read and the define leaves the two disagreeing, and a guard that gives up
   * on the mismatch forwards the stand-in's own function verbatim, which is
   * the write onto the plugin's object this exists to prevent.
   *
   * @param {PropertyDescriptor} desc
   * @returns {PropertyDescriptor}
   */
  function restoreStart(desc) {
    const own = Reflect.getOwnPropertyDescriptor(contribution, 'start')
    if (own === undefined) return desc
    if (desc.get !== inertStartGetter && desc.value !== inertStart) return desc
    if (own.get === undefined && own.set === undefined) {
      if (desc.get === undefined && desc.set === undefined) return { ...desc, value: own.value }
    } else if (desc.get !== undefined || desc.set !== undefined) {
      return { ...desc, get: own.get, set: own.set }
    }
    // Kinds disagree, so no descriptor carries the report across unchanged.
    // The define is the no-op the kernel takes it for: put back exactly what
    // the contribution holds now.
    return { ...own }
  }

  /**
   * Re-mirror onto the target what the contribution now says about the keys
   * the target already carries. Once `matchExtensibility` has hardened it the
   * target is a second copy of the contribution's shape, and a plugin holding
   * its own reference can still move that shape underneath it: a
   * `preventExtensions` leaves properties configurable, so a later `delete`
   * lands on the contribution alone and `ownKeys` then under-reports what the
   * non-extensible target holds; a later `freeze` clears `writable` on the
   * contribution alone and `getOwnPropertyDescriptor` then reports
   * non-writable against a writable target. Both throw a proxy invariant at
   * the plugin, so the two are reconciled before either trap answers. Only
   * keys the target already carries are visited, because those are the only
   * ones the target has to answer for; a fresh one carries none, so this costs
   * nothing until something puts a key there.
   *
   * Extensibility is not the thing that pins the target: an individual
   * `defineProperty` through the stand-in mirrors that property onto an
   * otherwise extensible target, non-configurable and all, and skipping the
   * reconcile while the target is still extensible left exactly those keys to
   * go stale. `defineProperty(stored, k, { configurable: false })` followed by
   * the plugin tightening `k` on its own reference threw
   * `getOwnPropertyDescriptor` at it, against a pair the kernel takes without
   * complaint.
   *
   * @param {object} target
   */
  function resync(target) {
    matchExtensibility(target)
    for (const prop of Reflect.ownKeys(target)) {
      const desc = Reflect.getOwnPropertyDescriptor(contribution, prop)
      if (desc === undefined) Reflect.deleteProperty(target, prop)
      else Reflect.defineProperty(target, prop, prop === 'start' ? startDescriptor(desc) : desc)
    }
  }

  /**
   * Bring the target up to the contribution's own keys, prototype, and
   * extensibility. A non-extensible target stops tolerating one that holds
   * nothing: `ownKeys` may then report only the keys the target itself
   * carries, `getOwnPropertyDescriptor` only the properties it carries, and
   * `getPrototypeOf` only its real prototype, which is the contribution until
   * this reparents it. Copying first is what lets the extensibility
   * operations forward to the contribution at all, so `Object.freeze(stored)`
   * freezes the object the kernel would have frozen rather than throwing
   * `ownKeys` at the plugin, and `Object.isFrozen(stored)` afterwards answers
   * from the same object the kernel would answer from.
   *
   * @param {object} target
   */
  function matchExtensibility(target) {
    if (Reflect.isExtensible(contribution) || !Reflect.isExtensible(target)) return
    for (const prop of Reflect.ownKeys(contribution)) {
      if (Reflect.getOwnPropertyDescriptor(target, prop) !== undefined) continue
      const desc = /** @type {PropertyDescriptor} */ (Reflect.getOwnPropertyDescriptor(contribution, prop))
      // Copied verbatim, so a frozen contribution reports frozen properties
      // and `Object.isFrozen(stored)` answers as the kernel would. `start`
      // carries the inert value reads answer with in place of the real one,
      // the single thing about the contribution this target may not repeat.
      Reflect.defineProperty(target, prop, prop === 'start' ? startDescriptor(desc) : desc)
    }
    Reflect.setPrototypeOf(target, Reflect.getPrototypeOf(contribution))
    Reflect.preventExtensions(target)
  }

  // A proxy may not answer a non-writable, non-configurable own property with
  // anything but the target's real value, so a contribution holding its own
  // `start` frozen cannot have it shadowed: the read inside `register` throws,
  // and the doctor reports the fabricated `activate_threw` this stand-in
  // exists to avoid, against a plugin the real registry accepts. Freezing a
  // registered object is ordinary defensive style, and nothing makes a plugin
  // do it before `register()`: freezing afterwards hardens the very object a
  // direct proxy would be targeting, and there is no re-deciding the target
  // once the proxy exists. So the target is always an empty object that
  // inherits from the contribution, never the contribution itself. Reads
  // resolve off the contribution either way.
  //
  // That target has no own properties and a prototype of its own, so the traps
  // below exist to hide it: without them the stored contribution enumerates as
  // `{}` and reports the wrong prototype, which is the same
  // store-a-different-shape defect this stand-in exists to close. `start` is
  // reported as the inert function the `get` trap already answers with, and a
  // descriptor is reported configurable unless something pinned that property
  // onto the target, because otherwise the target holds no non-configurable
  // property to pin one to.
  return new Proxy(Object.create(contribution), {
    get,
    /**
     * @param {object} target
     */
    ownKeys(target) {
      resync(target)
      return Reflect.ownKeys(contribution)
    },
    /**
     * @param {object} target
     * @param {string | symbol} prop
     */
    getOwnPropertyDescriptor(target, prop) {
      resync(target)
      const desc = Reflect.getOwnPropertyDescriptor(contribution, prop)
      if (desc === undefined) return undefined
      const shown = prop === 'start' ? startDescriptor(desc) : desc
      // A property the contribution holds non-configurable may only be
      // reported that way against a target carrying it non-configurable too,
      // so mirror it there rather than over-reporting it configurable: under
      // the kernel a plugin re-applying the descriptor it just read is an
      // ordinary no-op, and the `configurable: true` it never asked for is
      // exactly what the contribution then refuses. Reachable without anything
      // hardening the object at all, since `defineProperty(c, k, { value })`
      // leaves `k` non-configurable by default.
      //
      // `start` is the exception, and mirroring it here is measurably worse
      // rather than better. The only value its pin may carry is the inert one,
      // so pinning turns `defineProperty(stored, 'start', { value:
      // contribution.start })`, the no-op redefine the kernel performs and
      // `neuter` was fixed to keep working, back into a throw. The trap below
      // pins `start` only where the engine leaves no alternative. So a
      // `start` the contribution holds non-configurable keeps being reported
      // configurable and re-applying that descriptor stays refused: the read
      // half of the residual the define trap explains.
      if (prop !== 'start' && desc.configurable === false) Reflect.defineProperty(target, prop, desc)
      const pinned = Reflect.getOwnPropertyDescriptor(target, prop)
      if (pinned !== undefined && pinned.configurable === false) return shown
      return { ...shown, configurable: true }
    },
    getPrototypeOf: () => Reflect.getPrototypeOf(contribution),
    /**
     * Untrapped, `in` answered off the target: right by accident while the
     * target still inherited from the contribution, and wrong once a define
     * mirrored a key there that the plugin later dropped through its own
     * reference, or once `matchExtensibility` reparented the target away.
     * Everything else here resolves off the contribution, and `in` is no
     * different: a plugin that guards with it saw a key `ownKeys`,
     * `getOwnPropertyDescriptor` and `get` all agreed was gone.
     *
     * Reconciled only once the target has been hardened, which is the only
     * state in which it has to answer for its own keys: reporting a key gone
     * is refused for a non-extensible target that still holds it. Doing it
     * unconditionally would harden the target from an `in` check, pinning
     * `start` before anything asked, and turn the no-op redefine of a frozen
     * contribution's `start` into the residual the define trap describes.
     *
     * @param {object} target
     * @param {string | symbol} prop
     */
    has(target, prop) {
      if (!Reflect.isExtensible(target)) resync(target)
      return Reflect.has(contribution, prop)
    },
    /**
     * @param {object} target
     * @param {string | symbol} prop
     * @param {PropertyDescriptor} desc
     */
    defineProperty(target, prop, desc) {
      // The define has to reach the contribution: that is the object the real
      // registry stores and hands back, and the one every read here answers
      // from. Untrapped it landed on the inheriting target alone, so it
      // succeeded while the `get` trap kept answering from a contribution
      // that never got the property, and the next read of that property threw
      // the proxy invariant: the fabricated `activate_threw` this stand-in
      // exists to prevent. Forwarding first also keeps a define the kernel
      // refuses, on a contribution frozen whole, refused here.
      if (!Reflect.defineProperty(contribution, prop, prop === 'start' ? restoreStart(desc) : desc)) return false
      // Then mirror what the contribution ended up with, because a
      // non-configurable define may only be reported as having succeeded when
      // the target carries that property too.
      if (prop !== 'start') {
        const applied = /** @type {PropertyDescriptor} */ (Reflect.getOwnPropertyDescriptor(contribution, prop))
        Reflect.defineProperty(target, prop, applied)
        return true
      }
      // `start` stays off the target while it can (`matchExtensibility` is the
      // other thing that puts it there). The only value a pin may carry is the
      // inert one the `get` trap answers with, so a define naming the real
      // `start` as its value would be judged incompatible with that pin and
      // throw, which is the same fabricated `activate_threw` this trap exists
      // to prevent, against the ordinary no-op redefine the kernel accepts.
      // Unpinned, that redefine goes through, and the descriptor trap keeps
      // reporting `start` configurable for as long as nothing pins it.
      //
      // A define that spells `configurable: false` out is the exception and
      // has no way out: the engine throws whatever the trap returns unless the
      // target carries the property non-configurable too, so `start` has to be
      // pinned there or `Object.freeze(stored)` cannot complete. That is the
      // shape the kernel takes as a no-op and this stand-in still cannot: once
      // pinned non-configurable to the inert value, a later redefine naming a
      // `start` of the plugin's own is incompatible with the pin and throws:
      // by value for a data define, by getter identity for an accessor one.
      // Nothing the pin could hold closes that, because the one thing it may
      // not hold is the real `start`, and closing it needs the target to be
      // the contribution itself, which is exactly what this design avoids.
      // It costs only the define that spells `configurable: false` out and
      // names a function the plugin did not read back off this stand-in.
      if (desc.configurable === false) {
        const applied = /** @type {PropertyDescriptor} */ (Reflect.getOwnPropertyDescriptor(contribution, prop))
        Reflect.defineProperty(target, prop, startDescriptor(applied))
      }
      return true
    },
    /**
     * @param {object} target
     * @param {string | symbol} prop
     */
    deleteProperty(target, prop) {
      // Symmetrically: the kernel removes the property from the contribution,
      // or refuses to, where the untrapped trap silently no-opped against a
      // target that never held it.
      if (!Reflect.deleteProperty(contribution, prop)) return false
      Reflect.deleteProperty(target, prop)
      return true
    },
    /**
     * @param {object} _target
     * @param {string | symbol} prop
     * @param {unknown} value
     */
    set: (_target, prop, value) => Reflect.set(contribution, prop, value),
    /**
     * The contribution is what the kernel reparents, and what it refuses to
     * reparent once the plugin has hardened it. Untrapped, this landed on the
     * stand-in target: the contribution kept the prototype it had, and a
     * reparent the kernel rejects outright succeeded quietly here, which is
     * the one direction a dry run must never take, passing a plugin the
     * kernel throws at. The trap may not report success against a
     * non-extensible target unless the prototype is already the one it
     * carries, and it cannot: the target is only ever made non-extensible
     * alongside the contribution, whose own reparent then fails for the same
     * reason.
     *
     * @param {unknown} _target
     * @param {object | null} proto
     */
    setPrototypeOf: (_target, proto) => Reflect.setPrototypeOf(contribution, proto),
    /**
     * @param {object} target
     */
    isExtensible(target) {
      // A plugin may harden the contribution through its own reference, so the
      // two are reconciled on read rather than only when the hardening comes
      // through this proxy. The trap may not disagree with the target.
      matchExtensibility(target)
      return Reflect.isExtensible(target)
    },
    /**
     * @param {object} target
     */
    preventExtensions(target) {
      if (!Reflect.preventExtensions(contribution)) return false
      matchExtensibility(target)
      return true
    },
  })
}

/**
 * The `start()` every source gets under a dry run: it runs none of the
 * plugin's own start logic and hands back the minimal `StartedSource` the
 * registry requires. `reload`/`status` are deliberately absent, so the
 * registry takes its documented unsupported-reload and default-status paths
 * rather than reporting a behavior the real source may not have.
 *
 * @returns {Promise<StartedSource>}
 */
async function inertStart() {
  return { async stop() {} }
}

/**
 * The getter an own accessor `start` is reported through. It hands back the
 * same inert function every read of `start` answers with, so the descriptor
 * stays an accessor without the real one being reachable through it.
 *
 * @returns {() => Promise<StartedSource>}
 */
function inertStartGetter() {
  return inertStart
}

/**
 * A permissive no-op stand-in for a capability handle that another
 * plugin would normally provide. Real adapters (e.g. `@hypaware/claude`)
 * call methods on the handle *during* `activate()`, such as
 * `gateway.registerUpstreamPreset(...)` and `registerClient(...)`. A plain
 * object would throw on the first such call and abort activation before
 * the plugin registers its own contributions. This Proxy answers every
 * property access (and call) with itself, so activation runs to
 * completion and the declared-vs-registered diff stays meaningful. It
 * deliberately does NOT model real behavior. The doctor only checks
 * what the plugin registers via `ctx.*`, not what it does with a
 * capability it requires.
 *
 * @returns {unknown}
 */
function capabilityStub() {
  const target = function () {}
  /** @type {ProxyHandler<typeof target>} */
  const handler = {
    get(_t, prop) {
      // Don't masquerade as a thenable, or `await handle` would hang.
      if (prop === 'then') return undefined
      // Nor as something unprintable. A plugin that puts a value read off
      // the handle into a log attribute (`embed_model: embedder.model`)
      // reaches `String()`, and a proxy answering `Symbol.toPrimitive`,
      // `valueOf`, and `toString` with itself never yields a primitive, so
      // the conversion throws. The doctor would then report `activate_threw`
      // against a plugin whose only fault was logging what the stub returned.
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') return describeStub
      return proxy
    },
    apply() { return proxy },
    construct() { return proxy },
  }
  const proxy = new Proxy(target, handler)
  return proxy
}

/** @returns {string} */
function describeStub() {
  return '[doctor capability stub]'
}

/** @returns {RegisteredSnapshot} */
function emptySnapshot() {
  return {
    sources: [],
    sinks: [],
    datasets: [],
    commands: [],
    commandDetails: [],
    commandGroups: [],
    skills: [],
    agents: [],
    init_presets: [],
    capabilities: [],
  }
}

/** @param {unknown} err */
function describe(err) {
  if (err instanceof Error) {
    const head = err.stack ? err.stack.split('\n').slice(0, 3).join('\n') : err.message
    return head
  }
  return String(err)
}
