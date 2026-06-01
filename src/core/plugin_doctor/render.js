// @ts-check

/**
 * @import { DoctorReport } from './types.d.ts'
 */

/**
 * Render a `DoctorReport` as human-readable lines. Mirrors the
 * repair-hint style of `hyp status`: a header, one line per diagnostic
 * with a ✓/✗/⚠ glyph and `[kind]` tag, indented `→ fix:` hints, and a
 * one-line summary footer.
 *
 * @param {DoctorReport} report
 * @returns {string}
 */
export function renderReport(report) {
  const lines = []
  const subject = report.pluginName ? `${report.pluginName} (${report.rootDir})` : report.rootDir
  lines.push(`plugin doctor: ${subject}`)

  if (report.diagnostics.length === 0) {
    lines.push('  ✓ no issues found')
  } else {
    for (const d of report.diagnostics) {
      const glyph = d.severity === 'error' ? '✗' : '⚠'
      lines.push(`  ${glyph} [${d.kind}] ${d.location}: ${indentContinuation(d.message)}`)
      for (const fix of d.repair) {
        lines.push(`      → fix: ${fix}`)
      }
    }
  }

  lines.push('')
  lines.push(summaryLine(report))
  return lines.join('\n') + '\n'
}

/**
 * @param {DoctorReport} report
 */
function summaryLine(report) {
  if (report.ok && report.warnCount === 0) return 'ok: 0 errors, 0 warnings'
  const parts = [`${report.errorCount} error(s)`, `${report.warnCount} warning(s)`]
  return `${report.ok ? 'ok' : 'failed'}: ${parts.join(', ')}`
}

/**
 * Keep multi-line messages (import stacks, activate throws) readable
 * under the bullet by indenting continuation lines.
 *
 * @param {string} message
 */
function indentContinuation(message) {
  return message.replace(/\n/g, '\n        ')
}
