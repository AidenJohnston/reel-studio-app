import { createRequire } from 'node:module'
import { readFileSync, realpathSync, writeFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { cleanupEngines } from './processes.mjs'
import { diskBytes, exec, fileHash, sampler } from './resources.mjs'

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const state = (app) => app.evaluate(() => globalThis.__rsPerf)

async function finished(page, after) {
  await page.waitForFunction((after) => window.__perfEvents.slice(after).some((e) => ['done', 'error', 'cancelled'].includes(e.type)), after, { timeout: 600000 })
  const event = await page.evaluate((after) => window.__perfEvents.slice(after).find((e) => ['done', 'error', 'cancelled'].includes(e.type)), after)
  if (event.type !== 'done') throw new Error(`Job ${event.type}: ${JSON.stringify(event)}`)
  if (!Number.isInteger(event.version) || event.version < 1) throw new Error('Completed job did not identify a final version')
  await page.getByTestId('player').waitFor({ state: 'visible', timeout: 30000 })
  await page.waitForFunction((version) => {
    const video = document.querySelector('[data-testid="player"]')
    return video instanceof HTMLVideoElement && video.readyState >= 2 && video.videoWidth > 0 && !!video.currentSrc
      && decodeURIComponent(new URL(video.currentSrc).pathname).endsWith(`/versions/v${version}/export.mp4`)
  }, event.version)
  return event
}

function phases(events, start, end) {
  const result = {}
  let last = start, phase = 'import'
  for (const e of events) {
    if (e.at < start || e.at > end || !e.phase || e.phase === phase) continue
    result[phase] = (result[phase] ?? 0) + e.at - last
    last = e.at
    phase = e.phase
  }
  result[phase] = (result[phase] ?? 0) + end - last
  return result
}

function projectCheck(projectDir) {
  const project = JSON.parse(readFileSync(join(projectDir, 'project.json')))
  const transcript = JSON.parse(readFileSync(join(projectDir, project.transcript.file)))
  return { version: project.version, captions: project.captions, cut: project.cut,
    transcriptHash: createHash('sha256').update(JSON.stringify(transcript.words)).digest('hex'),
    words: transcript.words.length,
    disk: Object.fromEntries(['media', 'work', 'versions'].map((folder) => [folder, diskBytes(join(projectDir, folder))])) }
}

export async function drive({ checkout, runDir, output, env, signal, note, adoptModel, modelSha256, clip, run, input, guard, beforeMeasurement }) {
  const require = createRequire(join(checkout, 'package.json'))
  const { _electron: electron } = require('@playwright/test')
  const executablePath = require('electron')
  if (!realpathSync(executablePath).startsWith(realpathSync(checkout) + sep)) throw new Error('Electron executable must belong to the scratch checkout')
  let app, sample, resourceTimer, resourceFailure
  const workAbort = new AbortController()
  const result = { clip, run, input, metrics: {}, loads: [] }
  const measureLoad = async (phase) => {
    const load = await beforeMeasurement(phase)
    result.loads.push({ phase, ...load })
    return load
  }
  const stop = () => { workAbort.abort(resourceFailure ?? signal.reason); if (app) void app.close() }
  const decode = async (file) => {
    const decoding = exec(env.REELENGINE_FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-'], { signal: workAbort.signal, maxBuffer: 1024 * 1024 })
    const exited = new Promise((resolve) => decoding.child.once('close', resolve))
    try { await decoding } finally { await exited }
  }
  try {
    signal.throwIfAborted()
    result.load = await measureLoad('startup')
    const start = performance.now()
    app = await electron.launch({ executablePath, args: [join(checkout, 'app')], cwd: checkout, env, artifactsDir: join(runDir, 'playwright'), timeout: 120000 })
    signal.addEventListener('abort', stop, { once: true })
    signal.throwIfAborted()
    result.runtimeVersions = await app.evaluate(() => process.versions)
    sample = sampler(app)
    resourceTimer = setInterval(() => { try { guard() } catch (error) { resourceFailure = error; stop() } }, 3000)
    const page = await app.firstWindow()
    page.setDefaultTimeout(30000)
    await page.setViewportSize({ width: 1280, height: 820 })
    await page.getByTestId('new-video').click()
    await page.getByRole('heading', { name: 'New video', exact: true }).waitFor()
    result.metrics.cold_interactive_ms = performance.now() - start
    result.app = await page.evaluate(() => window.reel.app.info())
    if (result.app.ai !== 'package' || result.app.engine.mode !== 'real') throw new Error(`Real app/engine required: ${JSON.stringify(result.app)}`)
    await page.evaluate(() => window.reel.ai.setActive('none'))
    result.provider = await page.evaluate(() => window.reel.ai.active())
    if (result.provider.id !== 'none') throw new Error('AI must be disabled for the deterministic first edit')
    await page.evaluate(() => { window.__perfEvents = []; window.reel.jobs.onEvent((e) => window.__perfEvents.push(e)) })
    if (adoptModel) {
      await measureLoad('model_adoption')
      if (!await page.evaluate(() => typeof window.reel.model.find === 'function')) throw new Error('This ref does not expose local model reuse')
      const at = performance.now()
      result.modelAdoption = await page.evaluate(() => window.reel.model.find())
      result.metrics.model_adoption_ms = performance.now() - at
      if (!result.modelAdoption.installed || !result.modelAdoption.reused) throw new Error('The app did not adopt the existing pinned model')
      const copy = join(env.REELSTUDIO_MODELS_DIR, 'small.en')
      if (await fileHash(join(copy, 'model.bin')) !== modelSha256) throw new Error('Adopted model bytes differ from the read-only source')
      result.modelAdoption.bytes = diskBytes(copy)
    }
    // Exercise the branch's real setup check rather than hard-code a faster thread count.
    const manualCheck = await page.evaluate(() => typeof window.reel.model.runCheck === 'function')
    const backgroundCheck = await app.evaluate(() => typeof globalThis.__rsPerfSpeechCheck === 'function')
    if (manualCheck || backgroundCheck) {
      await measureLoad('speech_setup')
      const at = performance.now()
      result.speechSetup = manualCheck ? await page.evaluate(() => window.reel.model.runCheck())
        : await app.evaluate(() => globalThis.__rsPerfSpeechCheck())
      result.speechSetupMs = performance.now() - at
      const settings = JSON.parse(readFileSync(join(env.REELSTUDIO_USER_DATA, 'settings.json')))
      result.speechCheck = settings.speechCheck
      result.speechCommand = (await state(app)).engines.filter((c) => c.command === 'speech-check').at(-1)
      result.setupPeaks = { ...sample.peaks }
      sample.peaks.engine_rss_mib = 0
      sample.peaks.engine_tree_rss_mib = 0
    }
    await measureLoad('first_edit')
    const before = await state(app)
    const mainStart = await app.evaluate(() => performance.now())
    const at = performance.now()
    await page.getByTestId('file-input').setInputFiles(join(runDir, 'input', input.name))
    const done = await finished(page, 0)
    result.metrics.first_edit_ms = performance.now() - at
    const after = await state(app)
    const end = after.events.find((e) => e.type === 'done' && e.jobId === done.jobId).at
    result.phases = phases(after.events, mainStart, end)
    for (const [phase, ms] of Object.entries(result.phases)) result.metrics[`phase_${phase}_ms`] = ms
    const projectDir = join(env.REELSTUDIO_ROOT, 'Projects', done.slug)
    result.firstEdit = projectCheck(projectDir)
    result.firstEditEngineCommands = after.engines.slice(before.engines.length)
    await page.getByTestId('nav-home').click()
    await page.getByTestId('project-card').waitFor()
    await measureLoad('open_project')
    const openStart = performance.now()
    await page.getByTestId('project-card').click()
    await page.getByTestId('edit-myself').click()
    await page.getByTestId('drawer').waitFor()
    result.metrics.open_project_ms = performance.now() - openStart
    await page.getByTestId('drawer-close').click()
    result.playback = await page.evaluate(async () => {
      const video = document.querySelector('[data-testid="player"]')
      video.muted = true
      video.currentTime = 0
      await video.play()
      // Start after play/seek state commits; the measured interval is five seconds of actual playback.
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const before = { ...window.__rsPerfCommits }
      const reactBefore = { ...window.__rsPerfReact }
      if (!reactBefore.renderers || !reactBefore.roots) throw new Error('React commit hook did not attach to the production renderer')
      const qualityBefore = video.getVideoPlaybackQuality()
      const start = performance.now(), time = video.currentTime
      await new Promise((resolve) => setTimeout(resolve, 5000))
      const elapsed = performance.now() - start, advanced = video.currentTime - time
      const counts = Object.fromEntries(Object.entries(window.__rsPerfCommits).map(([key, n]) => [key, n - (before[key] ?? 0)]))
      const quality = video.getVideoPlaybackQuality()
      video.pause()
      return { elapsed, advanced, counts, rootCommits: window.__rsPerfReact.roots - reactBefore.roots,
        decodedFrames: quality.totalVideoFrames - qualityBefore.totalVideoFrames,
        droppedFrames: quality.droppedVideoFrames - qualityBefore.droppedVideoFrames }
    })
    if (result.playback.advanced < 4.5) throw new Error(`Playback did not advance five seconds: ${JSON.stringify(result.playback)}`)
    result.metrics.reel_commits_5s = result.playback.counts.Reel ?? 0
    result.metrics.player_commits_5s = result.playback.counts.PhonePlayer ?? 0
    result.metrics.screen_react_commits_5s = result.playback.rootCommits
    result.metrics.decoded_frames_5s = result.playback.decodedFrames
    result.metrics.dropped_frames_5s = result.playback.droppedFrames
    result.rerenders = []
    for (let n = 0; n < 2; n++) {
      await page.getByTestId('edit-myself').click()
      await page.getByTestId('tab-captions').click()
      const buttons = page.getByTestId('cap-size').getByRole('radio')
      const target = n === 0 ? buttons.last() : buttons.first()
      if (await target.getAttribute('aria-checked') === 'true') throw new Error('Subtitle edit would be a no-op')
      await target.click()
      await measureLoad(`rerender_${n + 1}`)
      const eventOffset = await page.evaluate(() => window.__perfEvents.length)
      const start = performance.now()
      await page.getByTestId('make-version').click()
      const complete = await finished(page, eventOffset)
      const ms = performance.now() - start
      const check = projectCheck(projectDir)
      if (check.version <= (n ? result.rerenders[0].check.version : result.firstEdit.version)) throw new Error('Render did not create a new version')
      result.rerenders.push({ ms, check, event: complete })
    }
    result.metrics.rerender_1_ms = result.rerenders[0].ms
    result.metrics.rerender_2_ms = result.rerenders[1].ms
    result.disk = result.rerenders[1].check.disk
    for (const [folder, bytes] of Object.entries(result.disk)) result.metrics[`disk_${folder}_mib`] = bytes.logical / 1024 ** 2
    result.metrics.disk_project_mib = diskBytes(projectDir).logical / 1024 ** 2
    result.versions = []
    const visit = (folder) => {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (entry.name.endsWith('.mp4')) result.versions.push({ file: path.slice(projectDir.length + 1), sha256: hash(path), bytes: diskBytes(path).logical })
      }
    }
    visit(join(projectDir, 'versions'))
    for (const version of [result.firstEdit.version, ...result.rerenders.map((r) => r.check.version)]) {
      if (!result.versions.some((v) => v.file === `versions/v${version}/export.mp4`)) throw new Error(`Missing saved full render v${version}`)
    }
    // Independently decode the final output, so a fast failed render cannot count as success.
    const latest = result.versions.filter((v) => v.file.includes(`v${result.rerenders[1].check.version}`)).find((v) => !v.file.includes('draft'))
    if (!latest) throw new Error('Cannot find the final version output')
    await decode(join(projectDir, latest.file))
    result.outputDecoded = true
    if (note) {
      await page.evaluate(() => window.reel.ai.setActive('replay'))
      const eventOffset = await page.evaluate(() => window.__perfEvents.length)
      const commandsBefore = (await state(app)).engines.length
      await measureLoad('note')
      const start = performance.now()
      const reply = await page.evaluate((slug) => window.reel.projects.note(slug, 'Please follow the recorded benchmark editing steps.'), done.slug)
      if (!reply.jobId) throw new Error('Replay note did not start an editing job')
      await finished(page, eventOffset)
      result.metrics.note_ms = performance.now() - start
      result.note = projectCheck(projectDir)
      if (result.note.version <= result.rerenders[1].check.version) throw new Error('Replay note did not create a new final version')
      if (result.note.captions.style.size !== 126 || result.note.captions.style.color !== '#FFD60A') throw new Error('Replay note did not apply the requested subtitle style')
      result.note.commands = (await state(app)).engines.slice(commandsBefore)
      if (!result.note.commands.some((c) => c.command === 'render' && !c.args.includes('--draft') && c.code === 0 && c.result?.version === result.note.version)) throw new Error('Replay note did not complete a matching full render')
      result.metrics.note_render_calls = result.note.commands.filter((c) => c.command === 'render').length
      const file = join(projectDir, `versions/v${result.note.version}/export.mp4`)
      await decode(file)
      result.note.outputSha256 = hash(file)
    }
    await page.screenshot({ path: join(output, `${clip}-${run}.png`) })
    await sample.sample()
    if (sample.failure()) throw new Error(`Memory sampling failed: ${sample.failure()}`)
    Object.assign(result.metrics, sample.peaks)
    result.telemetry = await state(app)
    result.engineFailures = result.telemetry.engines.filter((c) => c.error || c.code !== 0)
    if (result.telemetry.engines.some((c) => c.command === 'render' && (c.error || c.code !== 0 || c.result?.verify?.ok === false))) throw new Error('A render failed its engine verification')
    for (const command of result.telemetry.engines) command.sampledRssMiB = sample.byPid[command.pid] ?? null
    const finals = result.firstEditEngineCommands.filter((c) => c.command === 'render' && !c.args.includes('--draft'))
    const finalPeaks = finals.map((c) => sample.byPid[c.pid]).filter(Number.isFinite)
    if (!finalPeaks.length) throw new Error('Missing first-final engine RSS samples')
    result.metrics.first_final_python_rss_mib = Math.max(...finalPeaks)
    const ipc = result.telemetry.ipc
    if (!ipc.length || ipc.some((r) => !r.ok)) throw new Error('Missing or failed detail IPC observations')
    result.metrics.ipc_detail_max_bytes = Math.max(...ipc.map((r) => r.bytes))
    result.metrics.ipc_detail_total_bytes = ipc.reduce((sum, r) => sum + r.bytes, 0)
    result.metrics.ipc_detail_updates = ipc.length
    result.sourceVersions = JSON.parse(readFileSync(join(checkout, 'node_modules', 'electron', 'package.json'))).version
    if (resourceFailure) throw resourceFailure
    signal.throwIfAborted()
  } catch (error) {
    result.error = resourceFailure?.stack ?? error.stack ?? String(error)
    if (resourceFailure) result.resourceFailure = String(resourceFailure)
    if (app) result.telemetry = await state(app).catch(() => null)
  } finally {
    clearInterval(resourceTimer)
    signal.removeEventListener('abort', stop)
    sample?.stop()
    if (app) {
      await app.close().catch(() => app.process().kill('SIGTERM'))
    }
    try { result.engineCleanup = await cleanupEngines(env.REELSTUDIO_PERF_SCRATCH, env.REELSTUDIO_PERF_PID_REGISTRY) }
    catch (error) { result.cleanupError = String(error); result.error ??= String(error) }
    writeFileSync(join(output, `${clip}-${run}.json`), JSON.stringify(result, null, 2) + '\n')
  }
  return result
}
