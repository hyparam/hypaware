// @ts-check

import { JsonlLogRecordExporter } from './jsonl_exporters.js'
import { devTelemetryDir } from './env.js'
import { Attr, buildAttrs } from './attrs.js'
import {
  currentLoggerProviderGeneration,
  guardTelemetryResult,
  logs,
  LoggerProvider,
  reportTelemetryFailure,
  SeverityNumber,
} from './runtime.js'
import { OtlpLogExporter } from './otlp_exporters.js'

/**
 * @import { ObservabilityEnv } from '../../../src/core/observability/types.js'
 */

const OTLP_EXPORT_TIMEOUT_MS = 1_000

/**
 * Emit seams already diagnosed on stderr, keyed by {@link EMIT_SEAM}: see
 * {@link reportTelemetryFailure} for what the bound buys.
 *
 * @type {Set<string>}
 */
const EMIT_FAILURES = new Set()

/**
 * The one emit seam this module guards. Keyed by the installed provider's
 * generation rather than by the seam's name alone: the exporter guard bounds
 * itself per provider instance, and a seam bounded process-wide would let the
 * first broken provider consume the report for every provider installed after
 * it, which is a broken provider nobody can diagnose by another route.
 *
 * The key is a getter so the quiet path pays nothing for it: with no provider
 * installed the emit returns nothing and neither guard ever reads it. The set
 * therefore holds one entry per provider that was installed and broke, which
 * is at most one per process in practice, because `installObservability` is
 * idempotent and installs exactly one.
 *
 * @type {{ channel: 'logs', source: string, key: string, reported: Set<string> }}
 */
const EMIT_SEAM = {
  channel: 'logs',
  source: 'Logger.emit',
  get key() { return `Logger.emit#${currentLoggerProviderGeneration()}` },
  reported: EMIT_FAILURES,
}

const SEVERITY_MAP = Object.freeze({
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
})

const SEVERITY_TEXT = Object.freeze({
  [SeverityNumber.DEBUG]: 'DEBUG',
  [SeverityNumber.INFO]: 'INFO',
  [SeverityNumber.WARN]: 'WARN',
  [SeverityNumber.ERROR]: 'ERROR',
})

/**
 * Install a LoggerProvider with the same exporter strategy as the
 * tracer. The stderr mirror is not configured here: it is a per-call-site
 * option on {@link getLogger}, and it works with no provider at all.
 *
 * @param {object} args
 * @param {ObservabilityEnv} args.env
 * @param {{ attributes: Record<string, string|number|boolean> }} args.resource
 * @returns {{ provider: LoggerProvider|null, exporters: object[] }}
 */
export function installLoggerProvider({ env, resource }) {
  const exporters = []

  if (env.devTelemetry) {
    const dir = devTelemetryDir(env.stateDir)
    const jsonlExporter = new JsonlLogRecordExporter({ dir })
    exporters.push(jsonlExporter)
  }

  if (!env.devTelemetry && env.otlpEndpoint) {
    const otlpExporter = new OtlpLogExporter({
      url: env.otlpEndpoint.replace(/\/$/, '') + '/v1/logs',
      timeoutMillis: OTLP_EXPORT_TIMEOUT_MS,
    })
    exporters.push(otlpExporter)
  }

  if (exporters.length === 0) {
    return { provider: null, exporters: [] }
  }

  const provider = new LoggerProvider({
    resource,
    exporters,
  })
  logs.setGlobalLoggerProvider(provider)
  return { provider, exporters }
}

/**
 * Resolve a structured logger scoped to the given component. The
 * returned object emits OTel LogRecords through the global provider
 * and, when `mirrorStderr` is set, mirrors each call to stderr.
 *
 * The mirror writes whether or not a provider is installed, which is the
 * property the containment-refusal reports rely on: on a default install
 * (no dev telemetry, no OTLP endpoint) the provider is null and the OTel
 * half of `emit` drops the record, so the mirror is the one channel that
 * exists without configuration.
 *
 * @ref LLP 0329#stderr-mirror [implements]: stderr is the channel of last resort a refusal report opts into per call site.
 * @param {string} component
 * @param {{ mirrorStderr?: boolean }} [opts]
 */
export function getLogger(component, opts = {}) {
  const otelLogger = logs.getLogger(`hypaware.${component}`)
  const mirror = opts.mirrorStderr ?? false

  /**
   * @param {keyof typeof SEVERITY_MAP} level
   * @param {string} message
   * @param {Record<string, unknown>} [fields]
   */
  function emit(level, message, fields) {
    const severityNumber = SEVERITY_MAP[level]
    const devRunId = process.env.DEV_RUN_ID
    const attributes = buildAttrs({
      hyp_component: component,
      ...(devRunId ? { [Attr.DEV_RUN_ID]: devRunId } : {}),
      ...fields,
    })
    // Beside the OTel emit, not behind it. LLP 0329#stderr-mirror rests the
    // whole guarantee on that word, and until hyparam/hypaware#1122 nothing
    // enforced it: anything thrown from the emit skipped the mirror below.
    // The exporters are guarded at the provider now, so this catch is the
    // second seam, for a globally installed provider that is not ours.
    try {
      // The result too, not just the throw: a foreign provider whose
      // `exportRecord` is async rejects rather than throws, and an unhandled
      // rejection ends the process rather than skipping one line.
      guardTelemetryResult(otelLogger.emit({
        severityNumber,
        severityText: SEVERITY_TEXT[severityNumber],
        body: message,
        attributes,
      }), EMIT_SEAM)
    } catch (error) {
      reportTelemetryFailure({ ...EMIT_SEAM, error })
    }
    if (mirror) {
      const tag = SEVERITY_TEXT[severityNumber]
      process.stderr.write(`[hypaware:${component}] ${tag} ${message} ${JSON.stringify(attributes)}\n`)
    }
  }

  return {
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [fields]
     */
    debug(message, fields) { emit('debug', message, fields) },
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [fields]
     */
    info(message, fields) { emit('info', message, fields) },
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [fields]
     */
    warn(message, fields) { emit('warn', message, fields) },
    /**
     * @param {string} message
     * @param {Record<string, unknown>} [fields]
     */
    error(message, fields) { emit('error', message, fields) },
  }
}
