// Loaded instead of the entry point, only by the scratch benchmark build.
const { ipcMain, app } = require('electron')
const childProcess = require('node:child_process')
const { registerProcess, captureDescendants } = require('./process-registry.cjs')
const { StringDecoder } = require('node:string_decoder')
const registry = process.env.REELSTUDIO_PERF_PID_REGISTRY
registerProcess(registry, process.pid)
// Persist observed descendants before their parents can exit and reparent them.
const processTimer = setInterval(() => captureDescendants(registry), 200)
processTimer.unref()
process.on('exit', () => captureDescendants(registry))
const state = globalThis.__rsPerf = { ipc: [], events: [], engines: [] }
const handle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, fn) => handle(channel, async (...args) => {
  const start = performance.now()
  const value = await fn(...args)
  if (channel === 'projects:get' || channel === 'projects:update') {
    state.ipc.push({ channel, at: start, ms: performance.now() - start,
      bytes: Buffer.byteLength(JSON.stringify(value), 'utf8'), ok: value.ok,
      words: value.value?.words?.length, versions: value.value?.versions?.length })
  }
  return value
})
app.on('browser-window-created', (_event, window) => {
  const send = window.webContents.send.bind(window.webContents)
  window.webContents.send = (channel, ...args) => {
    if (channel === 'job:event') state.events.push({ at: performance.now(), ...args[0] })
    return send(channel, ...args)
  }
})
const spawn = childProcess.spawn
childProcess.spawn = function (file, args, options) {
  const child = spawn.call(this, file, args, options)
  if (!args?.includes('reelengine')) return child
  if (child.pid) registerProcess(registry, child.pid)
  const index = args.indexOf('reelengine')
  const run = { command: args[index + 1], args: args.slice(index + 2), pid: child.pid,
    at: performance.now(), threads: options.env.REELENGINE_ASR_THREADS ?? null, progress: [], stderr: '' }
  state.engines.push(run)
  const decoder = new StringDecoder('utf8')
  let pending = ''
  child.stdout.on('data', (chunk) => {
    pending += decoder.write(chunk)
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end)
      pending = pending.slice(end + 1)
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event.event === 'progress') run.progress.push({ at: performance.now(), ...event })
      if (event.event === 'done') run.result = event.result
      if (event.event === 'error') run.error = event
    }
  })
  child.stderr.on('data', (chunk) => { run.stderr = (run.stderr + chunk.toString()).slice(-12000) })
  child.on('close', (code, signal) => Object.assign(run, { code, signal, ms: performance.now() - run.at }))
  return child
}
require(process.env.REELSTUDIO_PERF_ENTRY)
