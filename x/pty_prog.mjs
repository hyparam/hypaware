import process from 'node:process'
import { askYesNo } from '../src/core/cli/confirm.js'
const res = await askYesNo({ stdin: process.stdin, stderr: process.stderr }, 'Delete everything? [y/N] ')
process.stderr.write(`\nRESULT=${res}\n`)
process.exit(0)
