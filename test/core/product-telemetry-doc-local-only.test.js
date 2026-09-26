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
 * do with privacy. Matching is scoped to the single paragraph that raises the
 * `local-only` case (a blank-line-separated block), not the whole `##`
 * section, so pre-existing prose several paragraphs away cannot satisfy a
 * concept for free. Fact 1's polarity is bound to that paragraph too: an
 * inclusion spelling has to appear, and a bare exclusion claim (an exclusion
 * verb, or a restriction phrase like "leaves ... out" or "only ... you
 * agreed to share", applied to the marking or to the counters it covers,
 * however each is named, with no adjacent negation) fails the fact even if
 * an inclusion spelling also appears elsewhere in the paragraph.
 *
 * What this guard does not do, recorded here because a reader who trusts it
 * to do more is worse off than one who knows the edges. The exclusion
 * spellings are a list, not a closed account of English, so an inversion
 * phrased with a verb the list does not name still passes: substituting one
 * word in the shipped sentence is enough. Facts 2 and 3 are checked for
 * presence, not for polarity, so a paragraph that says the session id
 * travels, or that `local` delivers over the network, also passes. And one
 * qualifying paragraph passes the file, so a second paragraph contradicting
 * the first is unpoliced. What this guard does hold is deletion, reword, a
 * dropped series, and a dropped or renamed stage value.
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

/** An exclusion verb applied to the local-only marking or to the counters it covers. */
const EXCLUDE_VERB = '(?:filter\\w*|exclud\\w*|remov\\w*|withh\\w*|omit\\w*)'

/**
 * A noun that names the local-only marking itself, however the prose spells
 * it: not just the literal word "marking", but a flag, a label, a
 * designation, a setting, a mark, or the "directory marked"/"folder marked"
 * phrasing used elsewhere in this same doc.
 */
const MARKING_NOUN = '(?:marking|flag|label|designation|setting|mark|directory marked|folder marked)'

/**
 * A noun that names the counters the marking might be claimed to touch:
 * either a `pipeline.*` series by name, the generic "counters"/"counts", or
 * the "work" paraphrase the per-series enumeration used before.
 */
const COUNTERS_NOUN = '(?:pipeline\\.[a-z_]+|counters?|counts?|gauges?|\\bwork\\b)'

/** Either subject an exclusion claim can be pinned to. */
const EXCLUSION_SUBJECT = `(?:${MARKING_NOUN}|${COUNTERS_NOUN})`

/**
 * A restriction-style phrase that amounts to an exclusion claim without using
 * one of the `EXCLUDE_VERB` words: "leaves/keeps a row out", or an "only ...
 * you agreed to share"/"only ... shareable" restriction.
 */
const RESTRICTION_PHRASE = '(?:(?:leaves?|leaving|keeps?|keeping)\\b[^.]{0,10}\\bout\\b|only\\b[^.]{0,40}\\b(?:you (?:agreed|opted|chose)|shareable)\\b)'

/**
 * A bare "<subject> <excludes/leaves out/only ...>" claim with no negation
 * between the subject and the exclusion, whatever noun names the marking or
 * the counters and whatever verb or restriction phrase carries the
 * exclusion: the shape an inverted disclosure takes ("a `local-only` marking
 * filters them", "a `local-only` flag excludes those rows", "`pipeline.rows`
 * ... cover only rows you agreed to share"). The negative lookahead lets a
 * genuinely negated claim ("marking does not filter them") through, and the
 * bound on every quantifier keeps the match a single sentence's width so it
 * cannot walk across unrelated prose or backtrack unboundedly.
 */
const SUBJECT_EXCLUDES = new RegExp(
  `\\b${EXCLUSION_SUBJECT}\\b(?!` +
  `[^.]{0,40}\\b(?:not|never|no)\\b[^.]{0,40}(?:${EXCLUDE_VERB}|${RESTRICTION_PHRASE})` +
  `)[^.]{0,40}(?:${EXCLUDE_VERB}|${RESTRICTION_PHRASE})`,
  'i'
)

/**
 * The three facts the disclosure has to carry, as concepts rather than
 * sentences: a concept is satisfied when its `any` spellings have a match and
 * none of its `none` spellings do, and a fact only when every concept is
 * satisfied, so a reword survives, a deletion does not, and an inversion does
 * not pass just because it also happens to contain the right words elsewhere.
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
          /\bcover\w*/i,
          /\btake(?:s|n)?\s+in\b/i,
          /\bcount(?:s|ed)\b[^.]{0,80}\bevery\b/i,
          /\b(?:are|is|sits?|stays?|remains?)\b[^.]{0,40}\b(?:inside|within|part of)\b/i,
          new RegExp(`\\b(?:not|never|no)\\b[^.]{0,15}\\b${EXCLUDE_VERB}`, 'i'),
        ],
        // A doc that asserts the marking or the counters it covers is
        // EXCLUDED, with no adjacent negation, states the opposite of this
        // fact, even if it also contains an inclusion spelling somewhere
        // else in the same paragraph.
        none: [SUBJECT_EXCLUDES],
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
          /\bsummed\b/i,
          /\bsingle\b[^.]{0,20}\b(?:value|number|figure|reading|record)\b/i,
          /\b(?:number|count|total)s?\b[^.]{0,30}\b(?:alone|only)\b/i,
          /\bonly\b[^.]{0,40}\b(?:number|count|total)s?\b/i,
        ],
      },
      { of: 'the stage label', any: [/`stage`/, /\bstage\b[^.]{0,20}\b(?:label|attribute|dimension)\b/i] },
      {
        of: 'what does not travel with it',
        any: [/\b(?:no|not|never|nothing)\b[^.]{0,120}\b(?:path|dataset|source id|session)\b/i],
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
 * The document's paragraphs (blank-line-separated blocks), tagged with the
 * `##` section each falls under, with whitespace collapsed so a claim split
 * over several lines still reads as one string to the patterns above. Code
 * fences are tracked so a blank line inside one does not split a paragraph.
 *
 * @param {string} text
 * @returns {{ section: string, text: string }[]}
 */
function paragraphs(text) {
  const out = []
  let section = '(preamble)'
  let fenced = false
  let lines = /** @type {string[]} */ ([])
  const flush = () => {
    if (lines.length > 0) out.push({ section, lines })
    lines = []
  }
  for (const raw of text.split('\n')) {
    if (/^```/.test(raw)) fenced = !fenced
    const heading = fenced ? null : /^## +(.*?)\s*$/.exec(raw)
    if (heading) {
      flush()
      section = heading[1]
      continue
    }
    if (!fenced && raw.trim() === '') {
      flush()
      continue
    }
    lines.push(raw)
  }
  flush()
  return out.map((p) => ({ section: p.section, text: p.lines.join(' ').replace(/\s+/g, ' ') }))
}

/**
 * Which concepts a paragraph fails, and why: a concept with no `any` match at
 * all is reported as missing, but a concept that matches `any` and ALSO
 * matches one of its `none` patterns is reported as an asserted exclusion, so
 * a CI reader is not told a word is missing when the real problem is that the
 * paragraph states the opposite of the fact.
 *
 * @param {{ of: string, any: RegExp[], none?: RegExp[] }[]} concepts @param {string} text
 */
function missingConcepts(concepts, text) {
  const out = []
  for (const c of concepts) {
    const hasAny = c.any.some((re) => re.test(text))
    const hasNone = (c.none || []).some((re) => re.test(text))
    if (hasNone) out.push(`${c.of} (an exclusion is asserted here, not merely unstated)`)
    else if (!hasAny) out.push(c.of)
  }
  return out
}

/**
 * Whether `stage` is named as one of the contract's literal values, not just
 * present as an English word: `capture`, `write` and `export` already appear
 * in this paragraph's unrelated prose ("the capture and write stages sit
 * upstream of the export seam"), so a plain `\bstage\b` test never fails no
 * matter how the actual enumeration is edited.
 *
 * A value counts when the doc writes it as code, inline or inside a fenced
 * block, which is how this doc denotes every other contract literal. Reading
 * the notation beats guessing at the English, because the English is not
 * guessable in either direction: a phrase list wide enough to accept "one of"
 * or "either" is wide enough for an unrelated sentence in the same paragraph
 * to supply for free, which is the vacuity this check exists to remove, and
 * one narrow enough to exclude them rejects a truthful enumeration that
 * phrases itself as "always" or "limited to".
 *
 * @param {string} stage @param {string} text
 */
function stageListed(stage, text) {
  if (text.includes('`' + stage + '`')) return true
  const fenced = text.split('```').filter((_, i) => i % 2 === 1)
  return fenced.some((block) => new RegExp(`\\b${stage}\\b`).test(block))
}

test('the product telemetry doc discloses that pipeline counts include local-only capture', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, DOC), 'utf8')

  // One paragraph has to carry all three facts: a reader who reaches the
  // local-only sentence and stops there has still been told the whole thing.
  const candidates = paragraphs(text).filter((p) => LOCAL_ONLY.some((re) => re.test(p.text)))
  assert.ok(
    candidates.length > 0,
    `${DOC} never mentions local-only capture, so a reader is not told that the ` +
    'pipeline.* counts include volume from directories they marked local-only'
  )

  // Both enumerations are read from the contract rather than copied, so a
  // renamed series or a new stage value has to reach the promise the doc
  // makes about what the series carry.
  const series = Object.keys(METRICS).filter((name) => name.startsWith('pipeline.'))
  assert.ok(series.length > 0, 'contract.js declares no pipeline.* series, so this guard is aimed at nothing')

  const failures = []
  for (const candidate of candidates) {
    const gaps = DISCLOSURE.map((claim) => ({ claim, missing: missingConcepts(claim.concepts, candidate.text) })).filter(
      (g) => g.missing.length > 0
    )
    const missingSeries = series.filter((name) => !candidate.text.includes(name))
    const missingStages = PIPELINE_STAGES.filter((stage) => !stageListed(stage, candidate.text))

    if (gaps.length === 0 && missingSeries.length === 0 && missingStages.length === 0) return

    const parts = gaps.map((g) => `${g.claim.fact} is not stated (missing ${g.missing.join(', ')})`)
    if (missingSeries.length > 0) {
      parts.push(`the disclosure does not name ${missingSeries.join(', ')}, so it does not cover everything sent`)
    }
    if (missingStages.length > 0) {
      parts.push(
        `the disclosure's closed set of stage values does not list ${missingStages.join(', ')}`
      )
    }
    failures.push(`paragraph in section "${candidate.section}": ${parts.join('; ')}`)
  }

  assert.fail(
    `${DOC} mentions local-only capture but no one paragraph states all three facts a reader needs ` +
    '(the counts include it, only aggregate counts and a stage label are sent, and only under ' +
    `organization collection). ${failures.join(' | ')}`
  )
})
