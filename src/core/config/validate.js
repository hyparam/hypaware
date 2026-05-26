// @ts-check

import { Attr, getLogger, withSpan } from '../observability/index.js'

/**
 * @import { BlobSinkConfigInstance, CapabilityName, ConfigRegistry, HypAwareV2Config, JsonObject, PluginManifest, PluginName, RequestSinkConfigInstance, ValidationError } from '../../../collectivus-plugin-kernel-types.d.ts'
 * @import { LoadedManifest } from '../manifest.js'
 */

/**
 * @import {
 *   ConfigValidationErrorKind,
 *   ConfigValidationError,
 *   V1DiagnosticKind,
 *   V1Diagnostic,
 *   PluginMetadata,
 *   ValidateContext,
 *   ValidateResult,
 * } from './types.d.ts'
 */

/**
 * Capability that a writer plugin must provide. Encoders register
 * themselves under this name (e.g. `@hypaware/format-parquet` and
 * `@hypaware/format-jsonl`).
 */
export const CAP_ENCODER = 'hypaware.encoder'

/**
 * Capability that a destination plugin must provide for a blob sink.
 * Local-fs, S3, and any future object store satisfy this. The
 * capability VALUE is a `BlobStore` object that consumers (table-format
 * plugins and the blob sink contribution) call into directly.
 */
export const CAP_BLOB_STORE = 'hypaware.blob-store'

/**
 * Capability a table-format writer provides. Table-format writers
 * (`@hypaware/format-iceberg`) layer directory layout + manifests on
 * top of an inner encoder and a blob store. Their capability VALUE is
 * a `TableFormatProvider`.
 */
export const CAP_TABLE_FORMAT = 'hypaware.table-format'

/**
 * Capability that a request destination provides. Request sinks
 * (`@hypaware/central`, `@hypaware/webhook`) advertise this; the
 * validator uses it to surface a useful error message when the user
 * accidentally pairs a writer with a request destination.
 */
export const CAP_HTTP_ENDPOINT = 'hypaware.http-endpoint'

/**
 * First-party plugin metadata baked into the kernel.
 *
 * @deprecated Prefer `buildPluginCatalog()` from `../plugin_catalog.js`
 * which derives the same data from bundled manifest files on disk.
 * This helper is retained only for tests and public-API consumers
 * that have not migrated to the catalog path yet.
 *
 * @returns {Map<PluginName, PluginMetadata>}
 */
export function firstPartyPluginMetadata() {
  return new Map(/** @type {[PluginName, PluginMetadata][]} */ ([
    ['@hypaware/ai-gateway', {
      provides: { 'hypaware.ai-gateway': '2.0.0' },
    }],
    ['@hypaware/claude', {
      requires: { 'hypaware.ai-gateway': '^2.0.0' },
    }],
    ['@hypaware/codex', {
      requires: { 'hypaware.ai-gateway': '^2.0.0' },
    }],
    ['@hypaware/gascity', {}],
    ['@hypaware/otel', {}],
    ['@hypaware/local-fs', {
      provides: { 'hypaware.blob-store': '1.0.0' },
    }],
    ['@hypaware/s3', {
      provides: { 'hypaware.blob-store': '1.0.0' },
    }],
    ['@hypaware/format-parquet', {
      requires: { 'hypaware.blob-store': '^1.0.0' },
      provides: { 'hypaware.encoder': '1.0.0' },
    }],
    ['@hypaware/format-jsonl', {
      requires: { 'hypaware.blob-store': '^1.0.0' },
      provides: { 'hypaware.encoder': '1.0.0' },
    }],
    ['@hypaware/format-iceberg', {
      requires: { 'hypaware.blob-store': '^1.0.0', 'hypaware.encoder': '^1.0.0' },
      provides: { 'hypaware.table-format': '1.0.0' },
    }],
    ['@hypaware/central', {
      provides: { 'hypaware.http-endpoint': '1.0.0' },
    }],
    ['@hypaware/webhook', {
      provides: { 'hypaware.http-endpoint': '1.0.0' },
    }],
  ]))
}

/**
 * Build a known-plugins map for `validateConfig` that includes both
 * first-party metadata and any installed third-party manifests
 * (`plugin-lock.json` entries). Each installed plugin contributes its
 * manifest `provides.capabilities` and `requires.capabilities` to the
 * cross-plugin validator so sink-pair and capability-ambiguity checks
 * work the same way they do for bundled plugins.
 *
 * First-party metadata always wins on collision — the boot path already
 * rejects installed plugins that shadow first-party names, but the
 * helper is defensive in case it is called outside the boot path (e.g.
 * `hyp config validate` from a host that has not booted).
 *
 * @param {LoadedManifest[]} installedManifests
 * @param {Map<PluginName, PluginMetadata>} [base]
 * @returns {Map<PluginName, PluginMetadata>}
 */
export function mergeInstalledManifestsIntoKnown(installedManifests, base) {
  const out = new Map(base ?? firstPartyPluginMetadata())
  for (const entry of installedManifests) {
    const name = /** @type {PluginName} */ (entry.manifest.name)
    if (out.has(name)) continue
    out.set(name, pluginMetadataFromManifest(entry.manifest))
  }
  return out
}

/**
 * Derive a `PluginMetadata` snapshot from a plugin manifest. Picks up
 * capability `provides` / `requires` only — schema-validated upstream
 * by `validateManifest` so the casts here are safe.
 *
 * @param {PluginManifest} manifest
 * @returns {PluginMetadata}
 */
function pluginMetadataFromManifest(manifest) {
  /** @type {PluginMetadata} */
  const meta = {}
  const provides = manifest.provides?.capabilities
  if (provides && Object.keys(provides).length > 0) {
    meta.provides = /** @type {Partial<Record<CapabilityName, string>>} */ ({ ...provides })
  }
  const requires = manifest.requires?.capabilities
  if (requires && Object.keys(requires).length > 0) {
    meta.requires = /** @type {Partial<Record<CapabilityName, string>>} */ ({ ...requires })
  }
  return meta
}

/**
 * Run kernel-level cross-plugin validation over a parsed v2 config.
 *
 * Rules:
 *
 *  1. Blob sink `writer` must require `hypaware.blob-store` and provide
 *     either `hypaware.encoder` (encoder writer) or
 *     `hypaware.table-format` (table-format writer). A writer that
 *     provides neither surfaces as
 *     `error_kind=sink_writer_invalid`. The `destination` must
 *     provide `hypaware.blob-store`; missing destination caps surface
 *     as `error_kind=sink_destination_invalid` for table-format writers
 *     (the new flow) and `error_kind=sink_pair_incompatible` for
 *     encoder writers (the legacy flow that existing configs depend on).
 *     For table-format writers, the optional inner encoder pin
 *     (`config.encoder`) must itself be a known plugin that provides
 *     `hypaware.encoder`; mismatches surface as
 *     `error_kind=sink_encoder_invalid`.
 *  2. Request sinks (`plugin` shape) cannot carry `writer` or
 *     `destination` keys. Caught by the schema parser but re-emitted
 *     here as `error_kind=request_sink_invalid_keys` for consistency.
 *  3. Every sink instance's `config.schedule` must be a standard
 *     5-field cron expression. Reject any DSL (e.g. `@hourly`).
 *  4. Every dataset named under `query.cache.retention.datasets` must be
 *     in the known dataset set.
 *  5. Capability ambiguity: when two known plugins provide the same
 *     capability at a compatible version, the user must pin the
 *     provider via `disambiguate`.
 *
 * Emits one `config.validate.error` log row per error, carrying
 * `error_kind`, `pointer`, and `message`.
 *
 * @param {HypAwareV2Config} config
 * @param {ValidateContext} [ctx]
 * @returns {Promise<ValidateResult>}
 */
export async function validateConfig(config, ctx = {}) {
  const knownPlugins = ctx.knownPlugins ?? firstPartyPluginMetadata()
  const knownDatasets = ctx.knownDatasets ?? new Set()
  const configRegistry = ctx.configRegistry
  const log = getLogger('config')

  const pluginCount = config.plugins?.length ?? 0
  const sinkCount = Object.keys(config.sinks ?? {}).length

  return withSpan(
    'config.validate',
    {
      [Attr.COMPONENT]: 'config',
      [Attr.OPERATION]: 'config.validate',
      plugin_count: pluginCount,
      sink_count: sinkCount,
    },
    async (span) => {
      /** @type {ConfigValidationError[]} */
      const errors = []

      checkDuplicatePlugins(config, errors)
      checkPluginsKnown(config, knownPlugins, errors)
      checkSinks(config, knownPlugins, errors)
      checkRetention(config, knownDatasets, errors)
      checkCapabilityAmbiguity(config, knownPlugins, errors)
      runPerPluginSectionValidators(config, configRegistry, errors)

      for (const e of errors) {
        log.error('config.validate.error', {
          [Attr.ERROR_KIND]: e.errorKind,
          pointer: e.pointer,
          message: e.message,
        })
      }

      if (errors.length > 0) {
        span.setAttribute('error_kind', errors[0].errorKind)
        span.setAttribute('status', 'failed')
      } else {
        span.setAttribute('status', 'ok')
      }

      return { ok: errors.length === 0, errors, pluginCount, sinkCount }
    },
    { component: 'config' }
  )
}

/**
 * @param {HypAwareV2Config} config
 * @param {ConfigValidationError[]} errors
 */
function checkDuplicatePlugins(config, errors) {
  if (!config.plugins) return
  /** @type {Map<PluginName, number>} */
  const seen = new Map()
  for (let i = 0; i < config.plugins.length; i += 1) {
    const entry = config.plugins[i]
    const prior = seen.get(entry.name)
    if (prior !== undefined) {
      errors.push({
        pointer: `/plugins/${i}`,
        errorKind: 'duplicate_plugin',
        message: `plugin '${entry.name}' is listed twice (also at /plugins/${prior})`,
      })
      continue
    }
    seen.set(entry.name, i)
  }
}

/**
 * @param {HypAwareV2Config} config
 * @param {Map<PluginName, PluginMetadata>} knownPlugins
 * @param {ConfigValidationError[]} errors
 */
function checkPluginsKnown(config, knownPlugins, errors) {
  if (!config.plugins) return
  for (let i = 0; i < config.plugins.length; i += 1) {
    const entry = config.plugins[i]
    if (!knownPlugins.has(entry.name)) {
      // For first-party only knowledge this catches typos against
      // declared plugins. Third-party plugins land in Phase 7; this
      // check should not fail then because the merged registry will
      // include the manifest entries the user actually installed.
      errors.push({
        pointer: `/plugins/${i}/name`,
        errorKind: 'plugin_unknown',
        message: `plugin '${entry.name}' is not a known first-party plugin and is not installed`,
      })
    }
  }
}

/**
 * @param {HypAwareV2Config} config
 * @param {Map<PluginName, PluginMetadata>} knownPlugins
 * @param {ConfigValidationError[]} errors
 */
function checkSinks(config, knownPlugins, errors) {
  if (!config.sinks) return
  for (const [name, raw] of Object.entries(config.sinks)) {
    const pointer = `/sinks/${name}`
    // Defensive: re-derive shape rather than trust schema layer alone.
    if ('writer' in raw || 'destination' in raw) {
      if ('plugin' in raw) {
        errors.push({
          pointer,
          errorKind: 'request_sink_invalid_keys',
          message: `sink '${name}' mixes writer/destination with plugin; pick one shape`,
        })
        continue
      }
      checkBlobSink(name, raw, knownPlugins, errors)
    } else if ('plugin' in raw) {
      checkRequestSink(name, raw, knownPlugins, errors)
    } else {
      errors.push({
        pointer,
        errorKind: 'sink_pair_incompatible',
        message: `sink '${name}' has neither writer/destination nor plugin`,
      })
      continue
    }
    checkSchedule(name, raw.config?.schedule, pointer, errors)
  }
}

/**
 * @param {string} name
 * @param {BlobSinkConfigInstance} sink
 * @param {Map<PluginName, PluginMetadata>} knownPlugins
 * @param {ConfigValidationError[]} errors
 */
function checkBlobSink(name, sink, knownPlugins, errors) {
  const pointer = `/sinks/${name}`
  const writerMeta = knownPlugins.get(sink.writer)
  const destMeta = knownPlugins.get(sink.destination)

  if (!writerMeta) {
    errors.push({
      pointer: `${pointer}/writer`,
      errorKind: 'sink_plugin_unknown',
      message: `sink '${name}': writer plugin '${sink.writer}' is unknown`,
    })
  }
  if (!destMeta) {
    errors.push({
      pointer: `${pointer}/destination`,
      errorKind: 'sink_plugin_unknown',
      message: `sink '${name}': destination plugin '${sink.destination}' is unknown`,
    })
  }
  if (!writerMeta || !destMeta) return

  const writerRequiresBlob = !!writerMeta.requires?.[CAP_BLOB_STORE]
  const writerProvidesEncoder = !!writerMeta.provides?.[CAP_ENCODER]
  const writerProvidesTableFormat = !!writerMeta.provides?.[CAP_TABLE_FORMAT]

  // Determine writer shape. A writer providing neither encoder nor
  // table-format is unusable as a blob-sink writer and earns the
  // dedicated `sink_writer_invalid` kind so callers can branch on it
  // separately from the generic encoder-shape mismatch covered by
  // `sink_pair_incompatible`.
  if (!writerProvidesEncoder && !writerProvidesTableFormat) {
    errors.push({
      pointer: `${pointer}/writer`,
      errorKind: 'sink_writer_invalid',
      message:
        `sink '${name}': writer '${sink.writer}' provides neither ${CAP_ENCODER} nor ${CAP_TABLE_FORMAT}` +
        ` — blob sinks need an encoder or table-format writer`,
    })
    return
  }

  if (writerProvidesEncoder) {
    // Legacy encoder-writer flow. Keep the existing error_kind so
    // callers that already grep for `sink_pair_incompatible` on bad
    // encoder pairings keep working.
    if (!writerRequiresBlob) {
      errors.push({
        pointer: `${pointer}/writer`,
        errorKind: 'sink_pair_incompatible',
        message:
          `sink '${name}': writer '${sink.writer}' must require ${CAP_BLOB_STORE} and provide ${CAP_ENCODER}` +
          ` (missing requires ${CAP_BLOB_STORE})`,
      })
    }
    const destProvidesBlob = !!destMeta.provides?.[CAP_BLOB_STORE]
    if (!destProvidesBlob) {
      const destProvidesHttp = !!destMeta.provides?.[CAP_HTTP_ENDPOINT]
      const hint = destProvidesHttp
        ? ` (provides ${CAP_HTTP_ENDPOINT} instead — only request sinks accept it)`
        : ''
      errors.push({
        pointer: `${pointer}/destination`,
        errorKind: 'sink_pair_incompatible',
        message: `sink '${name}': destination '${sink.destination}' does not provide ${CAP_BLOB_STORE}${hint}`,
      })
    }
    return
  }

  // Table-format writer flow. The destination still has to provide
  // `hypaware.blob-store` so the table-format sink can write bytes;
  // missing it earns `sink_destination_invalid` to distinguish the
  // table-format setup error from the legacy encoder-shape error.
  if (!writerRequiresBlob) {
    errors.push({
      pointer: `${pointer}/writer`,
      errorKind: 'sink_writer_invalid',
      message:
        `sink '${name}': writer '${sink.writer}' provides ${CAP_TABLE_FORMAT} but does not require ${CAP_BLOB_STORE}` +
        ` (table-format writers must declare a blob-store dependency)`,
    })
  }
  const destProvidesBlob = !!destMeta.provides?.[CAP_BLOB_STORE]
  if (!destProvidesBlob) {
    const destProvidesHttp = !!destMeta.provides?.[CAP_HTTP_ENDPOINT]
    const hint = destProvidesHttp
      ? ` (provides ${CAP_HTTP_ENDPOINT} instead — only request sinks accept it)`
      : ''
    errors.push({
      pointer: `${pointer}/destination`,
      errorKind: 'sink_destination_invalid',
      message:
        `sink '${name}': destination '${sink.destination}' does not provide ${CAP_BLOB_STORE}${hint}` +
        ` (table-format writer '${sink.writer}' needs a blob-store destination)`,
    })
  }

  // Optional inner-encoder pin. When set, the named plugin must be
  // known and itself provide `hypaware.encoder`. Unknown plugins land
  // in `sink_plugin_unknown` for consistency with /writer and
  // /destination; missing-encoder lands in the dedicated kind.
  const encoderPin = typeof sink.config?.encoder === 'string' ? sink.config.encoder : undefined
  if (encoderPin) {
    const encoderMeta = knownPlugins.get(/** @type {PluginName} */ (encoderPin))
    if (!encoderMeta) {
      errors.push({
        pointer: `${pointer}/config/encoder`,
        errorKind: 'sink_plugin_unknown',
        message: `sink '${name}': encoder plugin '${encoderPin}' is unknown`,
      })
    } else if (!encoderMeta.provides?.[CAP_ENCODER]) {
      errors.push({
        pointer: `${pointer}/config/encoder`,
        errorKind: 'sink_encoder_invalid',
        message: `sink '${name}': encoder plugin '${encoderPin}' does not provide ${CAP_ENCODER}`,
      })
    }
  }
}

/**
 * @param {string} name
 * @param {RequestSinkConfigInstance} sink
 * @param {Map<PluginName, PluginMetadata>} knownPlugins
 * @param {ConfigValidationError[]} errors
 */
function checkRequestSink(name, sink, knownPlugins, errors) {
  const pointer = `/sinks/${name}`
  const meta = knownPlugins.get(sink.plugin)
  if (!meta) {
    errors.push({
      pointer: `${pointer}/plugin`,
      errorKind: 'sink_plugin_unknown',
      message: `sink '${name}': plugin '${sink.plugin}' is unknown`,
    })
    return
  }
  if (!meta.provides?.[CAP_HTTP_ENDPOINT]) {
    errors.push({
      pointer: `${pointer}/plugin`,
      errorKind: 'sink_pair_incompatible',
      message: `sink '${name}': request plugin '${sink.plugin}' must provide ${CAP_HTTP_ENDPOINT}`,
    })
  }
}

/**
 * Validate a 5-field cron expression. The grammar is intentionally
 * narrow: standard minute hour day-of-month month day-of-week with
 * `star`, step (e.g. `star slash N`), range (`N-M`), or
 * comma-separated lists. No `@hourly`, no seconds field, no
 * timezones.
 *
 * @param {string} name
 * @param {unknown} schedule
 * @param {string} pointer
 * @param {ConfigValidationError[]} errors
 */
function checkSchedule(name, schedule, pointer, errors) {
  if (schedule === undefined) return
  if (typeof schedule !== 'string' || schedule.length === 0) {
    errors.push({
      pointer: `${pointer}/config/schedule`,
      errorKind: 'sink_schedule_invalid',
      message: `sink '${name}': schedule must be a 5-field cron string`,
    })
    return
  }
  if (!isCronExpression(schedule)) {
    errors.push({
      pointer: `${pointer}/config/schedule`,
      errorKind: 'sink_schedule_invalid',
      message:
        `sink '${name}': schedule '${schedule}' is not a valid 5-field cron expression. ` +
        `Use standard cron grammar (e.g. '0 * * * *'); DSL aliases like @hourly are rejected.`,
    })
  }
}

/**
 * @param {HypAwareV2Config} config
 * @param {Set<string>} knownDatasets
 * @param {ConfigValidationError[]} errors
 */
function checkRetention(config, knownDatasets, errors) {
  const datasets = config.query?.cache?.retention?.datasets
  if (!datasets) return
  for (const ds of Object.keys(datasets)) {
    if (knownDatasets.size === 0) {
      // No dataset registry yet (Phase 6 default). The retention entry is
      // not actionable until Phase 7 wires dataset discovery; emit the
      // warning so users see it during validate runs but the error is
      // still real (an unknown dataset reference).
    }
    if (!knownDatasets.has(ds)) {
      errors.push({
        pointer: `/query/cache/retention/datasets/${ds}`,
        errorKind: 'dataset_unknown',
        message: `dataset '${ds}' is not registered; cannot apply retention`,
      })
    }
  }
}

/**
 * @param {HypAwareV2Config} config
 * @param {Map<PluginName, PluginMetadata>} knownPlugins
 * @param {ConfigValidationError[]} errors
 */
function checkCapabilityAmbiguity(config, knownPlugins, errors) {
  if (!config.plugins || config.plugins.length === 0) return
  // Only inspect plugins the user actually enabled in `plugins[]`.
  const enabled = new Set(
    config.plugins
      .filter((p) => p.enabled !== false)
      .map((p) => p.name)
  )

  /** @type {Map<CapabilityName, PluginName[]>} */
  const providersByCap = new Map()
  for (const pluginName of enabled) {
    const meta = knownPlugins.get(pluginName)
    if (!meta?.provides) continue
    for (const capName of Object.keys(meta.provides)) {
      let arr = providersByCap.get(capName)
      if (!arr) {
        arr = []
        providersByCap.set(capName, arr)
      }
      arr.push(pluginName)
    }
  }

  const pins = config.disambiguate ?? {}
  for (const [capName, providers] of providersByCap.entries()) {
    if (providers.length < 2) continue
    const pinned = pins[capName]
    if (typeof pinned === 'string' && providers.includes(pinned)) continue
    errors.push({
      pointer: `/disambiguate/${capName}`,
      errorKind: 'capability_ambiguous',
      message:
        `capability '${capName}' is provided by ${providers.sort().join(', ')}; ` +
        `add disambiguate.${capName} = <one of the providers>`,
    })
  }
}

/**
 * Dispatch to per-plugin section validators. The config registry
 * already emits one log per `ValidationError`, so this routine only
 * needs to roll them up into the cross-plugin error list using a
 * fixed `config_section_invalid` error_kind so smoke harnesses can
 * grep by it.
 *
 * @param {HypAwareV2Config} config
 * @param {ConfigRegistry | undefined} registry
 * @param {ConfigValidationError[]} errors
 */
function runPerPluginSectionValidators(config, registry, errors) {
  if (!registry || !config.plugins) return
  for (let i = 0; i < config.plugins.length; i += 1) {
    const entry = config.plugins[i]
    const result = registry.validatePluginConfig(entry.name, entry.config ?? {})
    if (!result.ok) {
      for (const err of result.errors) {
        errors.push({
          pointer: err.pointer || `/plugins/${i}/config`,
          errorKind: 'config_section_invalid',
          message: err.message,
        })
      }
    }
  }
}

/* ---------- Phase 8 V1 diagnostics ---------- */

const CLIENT_PLUGINS = /** @type {ReadonlySet<PluginName>} */ (
  new Set(/** @type {PluginName[]} */ (['@hypaware/claude', '@hypaware/codex']))
)
const ENCODER_PLUGINS = /** @type {ReadonlySet<PluginName>} */ (
  new Set(/** @type {PluginName[]} */ (['@hypaware/format-parquet', '@hypaware/format-jsonl']))
)
const LOCAL_FS_PLUGIN = /** @type {PluginName} */ ('@hypaware/local-fs')
const AI_GATEWAY_PLUGIN = /** @type {PluginName} */ ('@hypaware/ai-gateway')

/**
 * Walk a v2 config and report Phase 8 V1 diagnostic findings. The
 * checks are advisory: they do not fail `hyp config validate` (so a
 * partially configured walkthrough output still passes), but they
 * give `hyp status` a concrete list of "what's wrong and how to fix
 * it" lines.
 *
 * Each diagnostic carries one or more `repair` strings — concrete
 * commands the operator can run. The status renderer surfaces them
 * verbatim under each diagnostic line.
 *
 * @param {HypAwareV2Config | null | undefined} config
 * @returns {V1Diagnostic[]}
 */
export function diagnoseV1Config(config) {
  /** @type {V1Diagnostic[]} */
  const out = []
  if (!config) return out

  const enabledByName = enabledPluginIndex(config)
  const gatewayConfig = enabledByName.get(AI_GATEWAY_PLUGIN)

  for (const clientName of CLIENT_PLUGINS) {
    if (!enabledByName.has(clientName)) continue
    if (gatewayConfig === undefined) {
      out.push({
        kind: 'client_without_gateway',
        pointer: pluginPointer(config, clientName),
        message:
          `client plugin '${clientName}' is enabled but '${AI_GATEWAY_PLUGIN}' is not — ` +
          `attach commands will fail until the gateway is enabled.`,
        repair: [
          `hyp init --from-file <config.json>  # re-run picker to add the gateway`,
          `hyp attach --client ${clientName === '@hypaware/claude' ? 'claude' : 'codex'}`,
        ],
      })
    }
  }

  if (enabledByName.has(/** @type {PluginName} */ ('@hypaware/claude'))) {
    if (gatewayConfig !== undefined && !gatewayHasUpstreamProvider(gatewayConfig, 'anthropic')) {
      out.push({
        kind: 'gateway_missing_anthropic_upstream',
        pointer: pluginPointer(config, AI_GATEWAY_PLUGIN),
        message:
          `'@hypaware/claude' is enabled but the gateway has no Anthropic upstream — ` +
          `Claude requests will have nowhere to forward.`,
        repair: [
          `hyp init --from-file <config.json>  # re-run picker to add the upstream`,
          `hyp attach --client claude`,
        ],
      })
    }
  }

  if (enabledByName.has(/** @type {PluginName} */ ('@hypaware/codex'))) {
    if (
      gatewayConfig !== undefined &&
      !gatewayHasUpstreamProvider(gatewayConfig, 'openai') &&
      !gatewayHasUpstreamProvider(gatewayConfig, 'chatgpt')
    ) {
      out.push({
        kind: 'gateway_missing_openai_upstream',
        pointer: pluginPointer(config, AI_GATEWAY_PLUGIN),
        message:
          `'@hypaware/codex' is enabled but the gateway has no OpenAI or ChatGPT upstream — ` +
          `Codex requests will have nowhere to forward.`,
        repair: [
          `hyp init --from-file <config.json>  # re-run picker to add the upstream`,
          `hyp attach --client codex`,
        ],
      })
    }
  }

  if (config.sinks) {
    for (const [name, raw] of Object.entries(config.sinks)) {
      if (!('writer' in raw) && !('destination' in raw)) continue
      const writer = 'writer' in raw && typeof raw.writer === 'string' ? raw.writer : null
      const destination = 'destination' in raw && typeof raw.destination === 'string' ? raw.destination : null
      if (destination !== LOCAL_FS_PLUGIN) continue
      if (writer !== null && enabledByName.has(writer) && ENCODER_PLUGINS.has(writer)) continue
      out.push({
        kind: 'sink_missing_encoder',
        pointer: `/sinks/${name}`,
        message:
          `sink '${name}' targets '${LOCAL_FS_PLUGIN}' but no encoder plugin ` +
          `(${[...ENCODER_PLUGINS].join(' or ')}) is enabled — local export will produce no files.`,
        repair: [
          `hyp init --from-file <config.json>  # re-run picker and pick "local Parquet export"`,
        ],
      })
    }
  }

  return out
}

/**
 * @param {HypAwareV2Config} config
 * @returns {Map<PluginName, JsonObject>}
 */
function enabledPluginIndex(config) {
  /** @type {Map<PluginName, JsonObject>} */
  const out = new Map()
  for (const entry of config.plugins ?? []) {
    if (entry.enabled === false) continue
    out.set(/** @type {PluginName} */ (entry.name), entry.config ?? {})
  }
  return out
}

/**
 * @param {HypAwareV2Config} config
 * @param {PluginName} name
 */
function pluginPointer(config, name) {
  const idx = (config.plugins ?? []).findIndex((p) => p.name === name)
  if (idx < 0) return '/plugins'
  return `/plugins/${idx}`
}

/**
 * Inspect an ai-gateway config block for an upstream that targets a
 * given provider. Matches by explicit `provider` field, by the
 * `name` (`anthropic` / `openai` / `chatgpt`), or by `base_url` host. The gateway
 * config shape is intentionally loose, so check all three.
 *
 * @param {JsonObject} gatewayConfig
 * @param {'anthropic'|'openai'|'chatgpt'} provider
 */
function gatewayHasUpstreamProvider(gatewayConfig, provider) {
  const upstreams = gatewayConfig?.upstreams
  if (!Array.isArray(upstreams)) return false
  const hostHint =
    provider === 'anthropic' ? 'anthropic.com'
    : provider === 'chatgpt' ? 'chatgpt.com'
    : 'openai.com'
  for (const raw of upstreams) {
    if (!raw || typeof raw !== 'object') continue
    const u = /** @type {Record<string, unknown>} */ (raw)
    if (typeof u.provider === 'string' && u.provider === provider) return true
    if (typeof u.name === 'string' && u.name === provider) return true
    if (typeof u.base_url === 'string' && u.base_url.includes(hostHint)) return true
  }
  return false
}

/* ---------- cron grammar ---------- */

const CRON_FIELDS = /** @type {const} */ ([
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day_of_month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day_of_week', min: 0, max: 7 },
])

/**
 * @param {string} expression
 * @returns {boolean}
 */
export function isCronExpression(expression) {
  if (typeof expression !== 'string') return false
  // Whitelist visible ASCII to keep the rejector tight against
  // unicode lookalikes; cron has no concept of whitespace beyond the
  // ASCII space character.
  if (!/^[ -~]+$/.test(expression)) return false
  if (expression.startsWith('@')) return false
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== CRON_FIELDS.length) return false
  for (let i = 0; i < CRON_FIELDS.length; i += 1) {
    if (!isCronField(fields[i], CRON_FIELDS[i].min, CRON_FIELDS[i].max)) return false
  }
  return true
}

/**
 * @param {string} field
 * @param {number} min
 * @param {number} max
 */
function isCronField(field, min, max) {
  if (field.length === 0) return false
  for (const part of field.split(',')) {
    if (!isCronPart(part, min, max)) return false
  }
  return true
}

/**
 * @param {string} part
 * @param {number} min
 * @param {number} max
 */
function isCronPart(part, min, max) {
  if (part === '*') return true
  // Step form: `*/N` or `N-M/N`
  const stepMatch = part.match(/^([^/]+)\/(\d+)$/)
  if (stepMatch) {
    const stepValue = Number(stepMatch[2])
    if (!Number.isInteger(stepValue) || stepValue <= 0) return false
    return isCronPart(stepMatch[1], min, max)
  }
  // Range form: `N-M`
  const rangeMatch = part.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    const lo = Number(rangeMatch[1])
    const hi = Number(rangeMatch[2])
    if (!isFinite(lo) || !isFinite(hi)) return false
    if (lo < min || hi > max || lo > hi) return false
    return true
  }
  // Single value
  if (/^\d+$/.test(part)) {
    const n = Number(part)
    return n >= min && n <= max
  }
  return false
}
