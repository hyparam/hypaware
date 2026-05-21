// @ts-check

import { logs, SeverityNumber } from '@opentelemetry/api-logs'
import { LoggerProvider, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http'

import { JsonlLogRecordExporter } from './jsonl_exporters.js'
import { devTelemetryDir } from './env.js'
import { Attr, buildAttrs } from './attrs.js'

const OTLP_EXPORT_TIMEOUT_MS = 1_000

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
 * tracer. Also configures a stderr mirror in dev mode so a developer
 * watching the smoke harness sees decisions live.
 *
 * @param {object} args
 * @param {import('./env.js').ObservabilityEnv} args.env
 * @param {import('@opentelemetry/resources').Resource} args.resource
 * @returns {{ provider: LoggerProvider|null, exporters: object[] }}
 */
export function installLoggerProvider({ env, resource }) {
  /** @type {object[]} */
  const exporters = []
  /** @type {import('@opentelemetry/sdk-logs').LogRecordProcessor[]} */
  const processors = []

  if (env.devTelemetry) {
    const dir = devTelemetryDir(env.stateDir)
    const jsonlExporter = new JsonlLogRecordExporter({ dir })
    processors.push(new SimpleLogRecordProcessor(jsonlExporter))
    exporters.push(jsonlExporter)
  }

  if (!env.devTelemetry && env.otlpEndpoint) {
    const otlpExporter = new OTLPLogExporter({
      url: env.otlpEndpoint.replace(/\/$/, '') + '/v1/logs',
      timeoutMillis: OTLP_EXPORT_TIMEOUT_MS,
    })
    processors.push(new SimpleLogRecordProcessor(otlpExporter))
    exporters.push(otlpExporter)
  }

  if (processors.length === 0) {
    return { provider: null, exporters: [] }
  }

  const provider = new LoggerProvider({
    resource,
    processors,
  })
  logs.setGlobalLoggerProvider(provider)
  return { provider, exporters }
}

/**
 * Resolve a structured logger scoped to the given component. The
 * returned object emits OTel LogRecords through the global provider
 * and, in dev mode, mirrors each call to stderr.
 *
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
    otelLogger.emit({
      severityNumber,
      severityText: SEVERITY_TEXT[severityNumber],
      body: message,
      attributes,
    })
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
