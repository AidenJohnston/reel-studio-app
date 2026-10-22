#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { aggregate, compare, report } from './metrics.mjs'

const scripts = dirname(fileURLToPath(import.meta.url))
const root = '/tmp/rs-perf-harness'
const { values, positionals: refs } = parseArgs({ allowPositionals: true, options: {
  runs: { type: 'string', default: '3' }, models: { type: 'string' },
  note: { type: 'boolean', default: false }, long: { type: 'boolean', default: false },
  resume: { type: 'boolean', default: false }, clip: { type: 'string' },
  'adopt-model': { type: 'boolean', default: false }
} })
const count = Number(values.runs)
if (!refs.length || !Number.isInteger(count) || count < 1) throw new Error('Pass git refs and a positive --runs count')
if (new Set(refs).size !== refs.length) throw new Error('Each git ref must appear once')

mkdirSync(root, { recursive: true })
const lockPath = join(root, '.suite-lock')
const lock = openSync(lockPath, 'wx')
writeFileSync(lock, String(process.pid))
const history = new Map(refs.map((ref) => [ref, []]))
const nameFor = (ref) => ref.replace(/[^a-zA-Z0-9._-]/g, '_')
const readResult = (path) => JSON.parse(readFileSync(path, 'utf8'))
const pinned = new Map()
let child, interrupted = false
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; child?.kill(signal) })

try {
  for (const ref of refs) {
    const first = join(root, nameFor(ref), 'round-1/results.json')
    const sha = values.resume && existsSync(first) ? readResult(first).sha
      : execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: join(scripts, '../..'), encoding: 'utf8' }).trim()
    pinned.set(ref, sha)
  }
  for (let round = 1; round <= count; round++) for (const ref of refs) {
    if (interrupted) throw new Error('Suite interrupted')
    const name = nameFor(ref)
    const output = join(root, name)
    const roundDir = join(output, `round-${round}`)
    const cached = values.resume && existsSync(join(roundDir, 'results.json'))
    const actualRef = pinned.get(ref)
    const childOutput = join(root, nameFor(actualRef))
    const args = [join(scripts, 'run.mjs'), '--ref', actualRef, '--runs', '1']
    if (values.models) args.push('--models', values.models)
    if (values.note) args.push('--note')
    if (values.long) args.push('--long')
    if (values.clip) args.push('--clip', values.clip)
    if (values['adopt-model']) args.push('--adopt-model')
    console.log(`${cached ? 'RESUME' : 'START'} round ${round}/${count}: ${ref} @ ${actualRef.slice(0, 12)}`)
    let code = 0
    if (!cached) {
      const log = openSync(join(root, `${name}-round-${round}.log`), 'w')
      try {
        code = await new Promise((resolve, reject) => {
          child = spawn(process.execPath, args, { stdio: ['ignore', log, log] })
          child.on('error', reject)
          child.on('close', resolve)
        })
      } finally { closeSync(log); child = null }
    }
    const result = readResult(join(cached ? roundDir : childOutput, 'results.json'))
    if (code !== 0 || result.error || !result.cleaned) throw new Error(`${ref} round ${round} failed: ${result.error ?? result.cleanupErrors ?? code}`)
    const expectedClips = values.long ? ['aiden-v1-new.mp4', 'IMG_7303.mov'] : [values.clip === 'long' ? 'IMG_7303.mov' : 'aiden-v1-new.mp4']
    if (result.sha !== actualRef || result.replayNote !== values.note || !!result.adoptModel !== values['adopt-model'] || JSON.stringify(result.runs.map((r) => r.clip)) !== JSON.stringify(expectedClips)) throw new Error(`Incompatible cached workload for ${ref}`)
    compare(result, result)
    const previous = history.get(ref)
    if (previous.length && previous[0].sha !== result.sha) throw new Error(`${ref} moved between rounds`)
    if (previous.length) compare(previous[0], result)
    mkdirSync(roundDir, { recursive: true })
    if (!cached) for (const file of ['results.json', 'REPORT.md', ...result.runs.flatMap((r) => [`${r.clip}-1.json`, `${r.clip}-1.png`])]) {
      copyFileSync(join(childOutput, file), join(roundDir, file))
    }
    previous.push(result)
    const combined = { ...previous[0], ref, expectedRuns: count, roundRobin: true,
      finishedAt: round === count ? result.finishedAt : null,
      runs: previous.flatMap((entry, index) => entry.runs.map((run) => ({ ...run, run: index + 1 }))),
      loadChecks: previous.flatMap((entry, index) => entry.loadChecks.map((load) => ({ ...load, run: index + 1 }))),
      builds: previous.map((entry) => ({ sha: entry.sha, startedAt: entry.startedAt, finishedAt: entry.finishedAt, cleaned: entry.cleaned })) }
    combined.summary = aggregate(combined.runs)
    writeFileSync(join(output, 'results.json'), JSON.stringify(combined, null, 2) + '\n')
    writeFileSync(join(output, 'REPORT.md'), report(combined))
    for (const run of combined.runs) {
      writeFileSync(join(output, `${run.clip}-${run.run}.json`), JSON.stringify(run, null, 2) + '\n')
      copyFileSync(join(output, `round-${run.run}`, `${run.clip}-1.png`), join(output, `${run.clip}-${run.run}.png`))
    }
    console.log(`FINISH round ${round}/${count}: ${ref}, ${result.sha.slice(0, 12)}`)
  }
} finally {
  closeSync(lock)
  rmSync(lockPath)
}
