import process from 'node:process'
import readline from 'node:readline/promises'

const variant = process.argv[2]
const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
function oldAskLineOnce(rl, input, prompt) {
  return new Promise((resolve) => {
    let settled = false
    const done = (line) => { if (settled) return; settled = true; resolve(line) }
    rl.once('close', () => done(null))
    rl.question(prompt).then(done, () => done(null))
    if (input.readableEnded === true) done(null)
  })
}
let answer
if (variant === 'old') answer = await oldAskLineOnce(rl, process.stdin, 'Delete everything? [y/N] ')
else answer = await Promise.race([rl.question('Delete everything? [y/N] '), new Promise(r => setTimeout(() => r('<HANG>'), 400))])
rl.close()
process.stderr.write(`\nANSWER=${JSON.stringify(answer)}\n`)
process.exit(0)
