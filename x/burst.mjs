import readline from 'node:readline/promises'
import { Readable } from 'node:stream'
import { askLineOnce, queuedLineAsker } from '../src/core/cli/line_asker.js'

async function viaAskLineOnce(chunks, terminal) {
  const input = Readable.from(chunks)
  const out = { write: () => true }
  const rl = readline.createInterface({ input, output: out, ...(terminal === undefined ? {} : { terminal }) })
  try { return await askLineOnce(rl, input, 'Proceed? [y/N] ') } finally { rl.close() }
}
async function viaPlainQuestion(chunks, terminal) {
  const input = Readable.from(chunks)
  const out = { write: () => true }
  const rl = readline.createInterface({ input, output: out, ...(terminal === undefined ? {} : { terminal }) })
  try {
    return await Promise.race([rl.question('Proceed? [y/N] '), new Promise(r => setTimeout(() => r('<HANG>'), 300))])
  } finally { rl.close() }
}
async function viaQueued(chunks, terminal) {
  const input = Readable.from(chunks)
  const out = { write: () => true }
  const rl = readline.createInterface({ input, output: out, ...(terminal === undefined ? {} : { terminal }) })
  try { return await queuedLineAsker(rl, input, out)('Proceed? [y/N] ') } finally { rl.close() }
}

const cases = [
  ['single line', ['y\n']],
  ['two lines one burst', ['y\n3\n']],
  ['two lines separate chunks', ['y\n', '3\n']],
  ['line + trailing junk no newline', ['y\nzzz']],
  ['no newline only', ['y']],
  ['empty EOF', []],
]
for (const [name, chunks] of cases) {
  const a = await viaAskLineOnce(chunks)
  const p = await viaPlainQuestion(chunks)
  const q = await viaQueued(chunks)
  console.log(`${name.padEnd(32)} askLineOnce=${JSON.stringify(a)}  rl.question=${JSON.stringify(p)}  queued=${JSON.stringify(q)}`)
}
