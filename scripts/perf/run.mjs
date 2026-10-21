#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, homedir, platform, release, arch, totalmem } from 'node:os'
import { createHash } from 'node:crypto'
import { aggregate, compare, report } from './metrics.mjs'
import { cleanupEngines } from './processes.mjs'
import { fileHash as sha256, guard, waitForTrialLoad, maxTrialLoad } from './resources.mjs'
import { drive } from './drive.mjs'
import { noteFixture } from './fixtures.mjs'

const scripts = dirname(fileURLToPath(import.meta.url))
const repo = resolve(scripts, '../..')
const outputRoot = '/tmp/rs-perf-harness'
const method = 'real-electron-basic-plan-v2-load-guard'
const abort = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort(new Error(`Interrupted by ${signal}`)))

function parse(args) {
  const options = { ref: 'origin/main', runs: 3, long: false }
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === '--long') options.long = true
    else if (key === '--note') options.note = true
    else if (key === '--adopt-model') options.adoptModel = true
    else if (key === '--whole-ref') options.wholeRef = true
    else if (key === '--compare') {
      if (!args[i + 1] || !args[i + 2]) throw new Error('--compare requires before and after refs or result directories')
      options.compare = [args[++i], args[++i]]
    }
    else if (['--ref', '--runs', '--models', '--python', '--ffmpeg-dir', '--clip'].includes(key)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${key}`)
      options[key.slice(2)] = args[++i]
    } else throw new Error(`Unknown option ${key}`)
  }
  options.runs = Number(options.runs)
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error('--runs must be a positive integer')
  if (options.clip && !['aiden', 'long'].includes(options.clip)) throw new Error('--clip must be aiden or long')
  if (options.clip && options.long) throw new Error('Choose --clip or --long')
  return options
}

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
const safeName = (ref) => ref.replace(/[^a-zA-Z0-9._-]/g, '_')
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))

async function command(file, args, cwd, env = process.env, scratch) {
  if (scratch) { abort.signal.throwIfAborted(); guard(scratch) }
  console.log(`> ${file} ${args.join(' ')}`)
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: 'inherit', detached: true })
    let resourceError
    const stop = () => {
      try { process.kill(-child.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') reject(error) }
    }
    const timer = scratch ? setInterval(() => {
      try { guard(scratch) } catch (error) { resourceError = error; stop() }
    }, 3000) : null
    if (scratch) abort.signal.addEventListener('abort', stop, { once: true })
    const clean = () => { clearInterval(timer); abort.signal.removeEventListener('abort', stop) }
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clean()
      if (resourceError || abort.signal.aborted && scratch) reject(resourceError ?? abort.signal.reason)
      else if (code === 0) resolve()
      else reject(new Error(`${file} exited ${code ?? signal}`))
    })
  })
}

function instrument(checkout) {
  for (const [file, component] of [['screens/Reel.tsx', 'Reel'], ['components/Player.tsx', 'PhonePlayer']]) {
    const path = join(checkout, 'app/src/renderer/src', file)
    let source = readFileSync(path, 'utf8')
    const declaration = source.indexOf(`export function ${component}(`)
    const body = source.indexOf(') {', declaration)
    if (declaration < 0 || body < 0) throw new Error(`Cannot instrument ${component}: unsupported source contract`)
    source = source.slice(0, body + 3) + `\n  __perfCommit(() => { window.dispatchEvent(new CustomEvent('rs-perf-commit', { detail: '${component}' })) })\n` + source.slice(body + 3)
    writeFileSync(path, `import { useLayoutEffect as __perfCommit } from 'react'\n${source}`)
  }
  const entry = join(checkout, 'app/src/renderer/src/main.tsx')
  const source = readFileSync(entry, 'utf8')
  writeFileSync(join(checkout, 'app/src/renderer/src/perf-hook.ts'), `const state = { roots: 0, renderers: 0 }\nObject.assign(window, { __rsPerfReact: state, __REACT_DEVTOOLS_GLOBAL_HOOK__: {\n  supportsFiber: true, inject() { state.renderers++; return 1 },\n  onCommitFiberRoot() { state.roots++ }, onCommitFiberUnmount() {}\n} })\n`)
  writeFileSync(entry, `import './perf-hook'\n` + source.replace('createRoot(', `const perfCommits: Record<string, number> = { Reel: 0, PhonePlayer: 0 }\nObject.assign(window, { __rsPerfCommits: perfCommits })\nwindow.addEventListener('rs-perf-commit', (event) => {\n  if (event instanceof CustomEvent) perfCommits[event.detail] = (perfCommits[event.detail] ?? 0) + 1\n})\ncreateRoot(`))
  const mainPath = join(checkout, 'app/src/main/index.ts')
  const main = readFileSync(mainPath, 'utf8')
  if (main.includes('models.checkInBackground()')) {
    if (!main.includes('  registerIpc()\n')) throw new Error('Cannot expose background speech check: unsupported main entry contract')
    writeFileSync(mainPath, main.replace('  registerIpc()\n', '  registerIpc()\n  Object.assign(globalThis, { __rsPerfSpeechCheck: () => models.checkInBackground() })\n'))
  }
  copyFileSync(join(scripts, 'bootstrap.cjs'), join(checkout, 'app/perf-bootstrap.cjs'))
  const pkgPath = join(checkout, 'app/package.json')
  const pkg = json(pkgPath)
  pkg.main = './perf-bootstrap.cjs'
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
}

async function main() {
  const options = parse(process.argv.slice(2))
  if (options.compare) {
    const load = (ref) => json(existsSync(ref) ? join(ref, 'results.json') : join(outputRoot, safeName(ref), 'results.json'))
    const table = compare(...options.compare.map(load), { wholeRef: !!options.wholeRef })
    const file = join(outputRoot, `compare-${options.compare.map(safeName).join('-')}.md`)
    writeFileSync(file, table)
    console.log(table)
    return
  }
  if (platform() !== 'darwin') throw new Error('This runner requires macOS for memory-pressure checks and the installed read-only FFmpeg')
  const sha = git('rev-parse', '--verify', `${options.ref}^{commit}`)
  const resources = '/Applications/Reel Studio.app/Contents/Resources'
  const ffmpegDir = options['ffmpeg-dir'] ?? join(resources, 'ffmpeg')
  const model = options.models ?? process.env.REELSTUDIO_PERF_MODEL
  if (!model) throw new Error('Pass --models <existing small.en directory> or set REELSTUDIO_PERF_MODEL. No model is downloaded.')
  const modelDir = realpathSync(model)
  for (const file of ['model.bin', 'config.json', 'tokenizer.json']) if (!existsSync(join(modelDir, file))) throw new Error(`Missing model file ${file}`)
  const output = join(outputRoot, safeName(options.ref))
  mkdirSync(output, { recursive: true })
  const lockPath = join(outputRoot, '.lock')
  const lock = openSync(lockPath, 'wx')
  writeFileSync(lock, String(process.pid))
  let scratch, checkout, added = false
  const result = { method, ref: options.ref, sha, expectedRuns: options.runs, replayNote: !!options.note, adoptModel: !!options.adoptModel, startedAt: new Date().toISOString(), runs: [],
    harnessSha256: createHash('sha256').update(['run.mjs', 'drive.mjs', 'bootstrap.cjs', 'resources.mjs', 'processes.mjs', 'metrics.mjs', 'fixtures.mjs'].map((file) => readFileSync(join(scripts, file), 'utf8')).join('\n')).digest('hex'),
    host: { platform: platform(), release: release(), cpu: cpus()[0].model, cores: cpus().length, arch: arch(), memoryBytes: totalmem(),
      machineFingerprint: createHash('sha256').update(execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }).match(/"IOPlatformUUID" = "([^"]+)"/)[1]).digest('hex') },
    loadGuard: { oneMinuteBelow: maxTrialLoad }, loadChecks: [],
    notes: ['Fresh process/profile/cache per run; OS file caches are not flushed.', '200 ms sampled RSS can miss short peaks. Engine tree RSS sums simultaneous Python and media children.', 'Reel/PhonePlayer useLayoutEffect counters exist only in scratch builds. They count committed component renders, not every child commit.', 'Open-project time includes clicking Edit it myself and opening the drawer.', 'Phase spans use successive job phase transitions and are not additive engine command CPU time.', 'One ref is built at a time. One-minute load must be below 8 before each timed operation. Thermal drift is not controlled.'] }
  const save = () => {
    result.summary = aggregate(result.runs)
    writeFileSync(join(output, 'results.json'), JSON.stringify(result, null, 2) + '\n')
    writeFileSync(join(output, 'REPORT.md'), report(result))
  }
  try {
    guard(null, true)
    result.ffmpeg = { sha256: await sha256(join(ffmpegDir, 'ffmpeg')), version: execFileSync(join(ffmpegDir, 'ffmpeg'), ['-version'], { encoding: 'utf8' }).split('\n')[0] }
    result.model = { path: modelDir, sha256: await sha256(join(modelDir, 'model.bin')) }
    scratch = mkdtempSync('/tmp/rs-perf-build-')
    checkout = join(scratch, 'source')
    await command('git', ['worktree', 'add', '--detach', checkout, sha], repo)
    added = true
    result.dependencyLockSha256 = await sha256(join(checkout, 'package-lock.json'))
    guard(scratch, true)
    await command('npm', ['ci', '--no-audit', '--no-fund'], checkout, process.env, scratch)
    if (!existsSync(join(checkout, 'node_modules/electron/path.txt'))) {
      guard(scratch, true)
      await command('node', ['node_modules/electron/install.js'], checkout, process.env, scratch)
    }
    guard(scratch, true)
    await command(options.python ?? 'python3.11', ['-m', 'venv', join(scratch, 'venv')], checkout, process.env, scratch)
    const python = join(scratch, 'venv/bin/python')
    await command('uv', ['pip', 'install', '--python', python, '--no-cache', '-r', 'engine/requirements.txt'], checkout, process.env, scratch)
    result.runtime = { node: process.version, arch: arch(), python: execFileSync(python, ['--version'], { encoding: 'utf8' }).trim(),
      electron: json(join(checkout, 'node_modules/electron/package.json')).version, playwright: json(join(checkout, 'node_modules/@playwright/test/package.json')).version }
    result.pythonPackages = execFileSync('uv', ['pip', 'freeze', '--python', python], { encoding: 'utf8' }).trim().split('\n')
    instrument(checkout)
    guard(scratch, true)
    await command('npm', ['run', 'build'], checkout, process.env, scratch)
    result.resourcesBeforeRuns = guard(scratch)
    const clips = [join(homedir(), options.clip === 'long' ? 'Downloads/Video/IMG_7303.mov' : 'Downloads/Video/aiden-v1-new.mp4')]
    if (options.long) clips.push(join(homedir(), 'Downloads/Video/IMG_7303.mov'))
    const inputs = await Promise.all(clips.map(async (file) => ({ file, name: basename(file), sha256: await sha256(file) })))
    for (let run = 1; run <= options.runs; run++) for (const input of inputs) {
      guard(scratch)
      const runDir = join(scratch, 'run')
      mkdirSync(join(runDir, 'input'), { recursive: true })
      copyFileSync(input.file, join(runDir, 'input', input.name))
      mkdirSync(join(runDir, 'models'), { recursive: true })
      if (options.adoptModel) {
        const pin = json(join(checkout, 'engine/reelengine/models/speech-models.json'))['small.en']
        const snapshots = join(runDir, 'hf-cache/hub', `models--${pin.repo.replaceAll('/', '--')}`, 'snapshots')
        mkdirSync(snapshots, { recursive: true })
        symlinkSync(modelDir, join(snapshots, pin.revision))
      } else symlinkSync(modelDir, join(runDir, 'models/small.en'))
      const userData = join(runDir, 'user-data')
      mkdirSync(join(userData, 'ai'), { recursive: true })
      writeFileSync(join(userData, 'settings.json'), JSON.stringify({ firstRunDone: true, aiCarriedOver: true }))
      writeFileSync(join(userData, 'ai/ai-settings.json'), JSON.stringify({ active: 'none' }))
      const replay = join(runDir, 'note.json')
      writeFileSync(replay, JSON.stringify(noteFixture()))
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (/^REEL(STUDIO|ENGINE)_/.test(key)) delete env[key]
      for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_OVERRIDE_DIST_PATH', 'OMP_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'MKL_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS', 'PYTHONHOME', 'PYTHONPATH']) delete env[key]
      Object.assign(env, {
        REELSTUDIO_TEST: '1', REELSTUDIO_MOCK_AI: '0', REELSTUDIO_USER_DATA: userData,
        REELSTUDIO_ROOT: join(runDir, 'root'), REELSTUDIO_MODELS_DIR: join(runDir, 'models'),
        REELSTUDIO_ENGINE_DIR: join(checkout, 'engine'), REELSTUDIO_PYTHON: python,
        REELSTUDIO_PERF_ENTRY: join(checkout, 'app/out/main/index.js'),
        REELSTUDIO_PERF_SCRATCH: scratch, REELSTUDIO_PERF_PID_REGISTRY: join(scratch, 'engine-pids.jsonl'),
        REELENGINE_CACHE: join(runDir, 'engine-cache'), REELENGINE_MODELS: join(runDir, 'models'),
        REELENGINE_FFMPEG: join(ffmpegDir, 'ffmpeg'), REELENGINE_FFPROBE: join(ffmpegDir, 'ffprobe'),
        HF_HUB_OFFLINE: '1', HF_HOME: join(runDir, 'hf-cache'), HF_HUB_CACHE: join(runDir, 'hf-cache/hub'), HUGGINGFACE_HUB_CACHE: join(runDir, 'hf-cache/hub'), XDG_CACHE_HOME: join(runDir, 'cache'),
        TMPDIR: join(runDir, 'tmp') })
      if (options.note) Object.assign(env, { REELSTUDIO_DEV: '1', REELSTUDIO_REPLAY: replay })
      mkdirSync(env.TMPDIR, { recursive: true })
      const measured = await drive({ checkout, runDir, output, env, signal: abort.signal, note: options.note, adoptModel: options.adoptModel, modelSha256: result.model.sha256, clip: input.name, run, input: { name: input.name, sha256: input.sha256 }, guard: () => guard(scratch), beforeMeasurement: (phase) => waitForTrialLoad({ signal: abort.signal, checkResources: () => guard(scratch),
        record: (load) => { result.loadChecks.push({ clip: input.name, run, phase, ...load }); save() } }) })
      result.runtime.electronVersions = measured.runtimeVersions
      result.runs.push(measured)
      save()
      console.log(JSON.stringify({ clip: measured.clip, run, metrics: measured.metrics, error: measured.error }))
      if (measured.error) throw new Error(measured.error)
      rmSync(runDir, { recursive: true, force: true })
    }
  } catch (error) {
    result.error = error.stack ?? String(error)
    process.exitCode = 1
  } finally {
    const cleanupErrors = result.runs.flatMap((run) => run.cleanupError ? [run.cleanupError] : [])
    try {
      if (scratch) result.engineCleanup = await cleanupEngines(scratch, join(scratch, 'engine-pids.jsonl'))
      if (added && !cleanupErrors.length) {
        // All files in this worktree were created by this invocation, including instrumentation.
        await command('git', ['worktree', 'remove', '--force', checkout], repo)
      }
    } catch (error) {
      cleanupErrors.push(String(error))
    }
    try { if (scratch && !cleanupErrors.length) rmSync(scratch, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(String(error)) }
    if (cleanupErrors.length) { result.cleanupErrors = cleanupErrors; process.exitCode = 1 }
    closeSync(lock)
    rmSync(lockPath)
    result.finishedAt = new Date().toISOString()
    result.cleaned = cleanupErrors.length === 0 && (!scratch || !existsSync(scratch))
    save()
  }
  console.log(report(result))
  if (result.error) console.error(result.error)
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
