// @ts-check

/**
 * A lint over the product telemetry document, not a behavior check.
 *
 * The `pipeline.*` series are volume counted at the spool: capture counts every
 * row the intrinsic spool accepts (`src/core/cache/spool.js`) and write counts
 * every row its flush path materializes, both of them upstream of the export
 * seam that withholds a `local-only` directory. So a user who marked a
 * directory `local-only` still has its rows and bytes inside the numbers this
 * channel sends. That is safe (the record carries one aggregate value and a
 * `stage` label, `contract.js` matches the attribute key set exactly, and
 * nothing is sent outside `organization` collection) but it is not obvious,
 * and the doc is the only place a user can learn it.
 *
 * The facts are asserted as concepts rather than as sentences: a guard that
 * pins one verbatim sentence passes again as soon as the disclosure is
 * reworded around it, and prose is reworded for reasons that have nothing to
 * do with privacy.
 *
 * @ref LLP 0393#contract [tests]: the channel forwards approved aggregate fields and never customer content, so the doc may promise exactly that much
 * @ref LLP 0393#policy [tests]: collection defaults off and `local` grants no network permission, so the disclosure is scoped to organization collection
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { METRICS, PIPELINE_STAGES } from '../../src/core/product_telemetry/contract.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOC = 'docs/PRODUCT_TELEMETRY.md'

/** The subject: prose that raises the local-only case at all. */
const LOCAL_ONLY = [/local-only/i, /local_only/]

/**
 * The three facts the disclosure has to carry, as concepts rather than
 * sentences: a concept is satisfied by any one of its spellings, and a fact
 * only when every concept matches, so a reword survives and a deletion does
 * not.
 */
const DISCLOSURE = [
  {
    fact: 'that the counts include volume from capture marked local-only',
    concepts: [
      { of: 'the local-only marking', any: LOCAL_ONLY },
      { of: 'the counters it concerns', any: [/pipeline\.[a-z_]+/, /\bcount(?:s|ed|ers|ing)?\b/i, /\bgauges?\b/i] },
      {
        of: 'inclusion rather than exclusion',
        any: [
          /\binclud\w*/i,
          /\bcontribut\w*/i,
          /\bcount(?:s|ed)\b[^.]{0,80}\bevery\b/i,
          /\b(?:are|is|sits?|stays?|remains?)\b[^.]{0,40}\b(?:inside|within|part of)\b/i,
          /\b(?:not|never|no)\b[^.]{0,60}\b(?:filter\w*|exclud\w*|remov\w*|withh\w*|omit\w*)/i,
        ],
      },
    ],
  },
  {
    fact: 'that only aggregate counts and a stage label are transmitted',
    concepts: [
      {
        of: 'the aggregate-only bound',
        any: [
          /\baggregate\b/i,
          /\b(?:number|count|total)s?\b[^.]{0,30}\b(?:alone|only)\b/i,
          /\bonly\b[^.]{0,40}\b(?:number|count|total)s?\b/i,
          /\bvolume, not content\b/i,
        ],
      },
      { of: 'the stage label', any: [/`stage`/, /\bstage\b[^.]{0,20}\b(?:label|attribute|dimension)\b/i] },
      {
        of: 'what does not travel with it',
        any: [/\b(?:no|not|never|nothing)\b[^.]{0,120}\b(?:path|dataset|source id|session|content)/i],
      },
    ],
  },
  {
    fact: 'that this applies only under organization collection',
    concepts: [
      { of: 'organization mode', any: [/\borganization\b/i] },
      {
        of: 'the restriction to it',
        any: [
          /\b(?:nothing|none of \w+)\b[^.]{0,140}\borganization\b/i,
          /\bunless\b[^.]{0,140}\borganization\b/i,
          /\bonly\b[^.]{0,140}\borganization\b/i,
          /\borganization\b[^.]{0,200}\b(?:only|no|never|without|nothing)\b/i,
        ],
      },
    ],
  },
]

/**
 * The document's `##` sections, each carrying its whole body (nested headings
 * included), with whitespace collapsed so a claim split over several lines
 * still reads as one sentence to the patterns above.
 *
 * @param {string} text
 * @returns {{ title: string, text: string }[]}
 */
function sections(text) {
  const out = [{ title: '(preamble)', lines: /** @type {string[]} */ ([]) }]
  let fenced = false
  for (const raw of text.split('\n')) {
    if (/^```/.test(raw)) fenced = !fenced
    const heading = fenced ? null : /^## +(.*?)\s*$/.exec(raw)
    if (heading) out.push({ title: heading[1], lines: [] })
    else out[out.length - 1].lines.push(raw)
  }
  return out.map((s) => ({ title: s.title, text: s.lines.join(' ').replace(/\s+/g, ' ') }))
}

/** @param {{ of: string, any: RegExp[] }[]} concepts @param {string} text */
function missingConcepts(concepts, text) {
  return concepts.filter((c) => !c.any.some((re) => re.test(text))).map((c) => c.of)
}

test('the product telemetry doc discloses that pipeline counts include local-only capture', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, DOC), 'utf8')

  // One section has to carry all three facts: a reader who reaches the
  // local-only sentence and stops there has still been told the whole thing.
  const candidates = sections(text).filter((s) => LOCAL_ONLY.some((re) => re.test(s.text)))
  assert.ok(
    candidates.length > 0,
    `${DOC} never mentions local-only capture, so a reader is not told that the ` +
    'pipeline.* counts include volume from directories they marked local-only'
  )

  const failures = []
  for (const section of candidates) {
    const gaps = DISCLOSURE.map((claim) => ({ claim, missing: missingConcepts(claim.concepts, section.text) })).filter(
      (g) => g.missing.length > 0
    )
    if (gaps.length > 0) {
      failures.push(
        `section "${section.title}": ` +
        gaps.map((g) => `${g.claim.fact} is not stated (missing ${g.missing.join(', ')})`).join('; ')
      )
      continue
    }
    // Both enumerations are read from the contract rather than copied, so a
    // renamed series or a new stage value has to reach the promise the doc
    // makes about what the series carry.
    const series = Object.keys(METRICS).filter((name) => name.startsWith('pipeline.'))
    assert.ok(series.length > 0, 'contract.js declares no pipeline.* series, so this guard is aimed at nothing')
    for (const name of series) {
      assert.ok(
        text.includes(name),
        `${DOC} does not name the ${name} series, so its disclosure does not cover everything sent`
      )
    }
    for (const stage of PIPELINE_STAGES) {
      assert.ok(
        new RegExp(`\\b${stage}\\b`, 'i').test(section.text),
        `${DOC} section "${section.title}" promises only a stage label leaves, but does not say ` +
        `that '${stage}' is one of the values it can take`
      )
    }
    return
  }

  assert.fail(
    `${DOC} mentions local-only capture but no one section states all three facts a reader needs ` +
    '(the counts include it, only aggregate counts and a stage label are sent, and only under ' +
    `organization collection). ${failures.join(' | ')}`
  )
})
