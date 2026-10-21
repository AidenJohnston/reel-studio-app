import { execFile, execFileSync } from 'node:child_process'
import { createReadStream, readdirSync, lstatSync, statfsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { loadavg } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

export const exec = promisify(execFile)
export const GiB = 1024 ** 3

export async function fileHash(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export function diskBytes(path) {
  let logical = 0, allocated = 0, files = 0
  const inodes = new Set()
  const visit = (p) => {
    let s
    try { s = lstatSync(p) } catch (error) { if (error.code === 'ENOENT') return; throw error }
    if (s.isSymbolicLink()) return
    if (s.isDirectory()) {
      let names
      try { names = readdirSync(p) } catch (error) { if (error.code === 'ENOENT') return; throw error }
      for (const name of names) visit(join(p, name))
    }
    else {
      const inode = `${s.dev}:${s.ino}`
      if (inodes.has(inode)) return
      logical += s.size
      allocated += s.blocks * 512
      inodes.add(inode)
      files++
    }
  }
  visit(path)
  return { logical, allocated, files, apfsClonePhysicalUsage: 'not measured' }
}

// Fixed at 8 on the 12-core benchmark host to reject the previously accepted 26.44 load.
export const maxTrialLoad = 8

export function parseSwapUsage(text) {
  const match = text.match(/total\s*=\s*([\d.]+)([KMGT])\s+used\s*=\s*([\d.]+)([KMGT])/)
  if (!match) throw new Error(`Cannot parse vm.swapusage: ${text.trim()}`)
  const units = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }
  const totalBytes = Number(match[1]) * units[match[2]]
  const usedBytes = Number(match[3]) * units[match[4]]
  if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes) || usedBytes > totalBytes) throw new Error('Invalid vm.swapusage totals')
  return { totalBytes, usedBytes, usedFraction: totalBytes ? usedBytes / totalBytes : 0 }
}

export function requireAdmission({ signal, checkResources, record, readLoad = trialLoad }) {
  signal.throwIfAborted()
  checkResources()
  const load = readLoad()
  record(load)
  if (!load.accepted) throw new Error(`REFUSED before build: 1-minute load ${load.oneMinute.toFixed(2)} must be below ${load.threshold}`)
  return load
}

export function trialLoad(oneMinute = loadavg()[0], swap = parseSwapUsage(execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' }))) {
  return { at: new Date().toISOString(), oneMinute, swap, threshold: maxTrialLoad, accepted: Number.isFinite(oneMinute) && oneMinute < maxTrialLoad }
}

export async function waitForTrialLoad({ signal, checkResources, record, readLoad = trialLoad, retryMs = 30000 }) {
  for (;;) {
    signal.throwIfAborted()
    checkResources()
    const load = readLoad()
    record(load)
    if (load.accepted) return load
    console.log(`REFUSED trial: 1-minute load ${load.oneMinute.toFixed(2)} >= ${load.threshold}; retry in ${retryMs / 1000}s`)
    await delay(retryMs, undefined, { signal })
  }
}

export function guard(scratch, beforeBuild = false) {
  if (beforeBuild) process.stdout.write(execFileSync('df', ['-h', '/']))
  const fs = statfsSync('/')
  const pressure = Number(execFileSync('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).toString())
  if (fs.bavail * fs.bsize < 3 * GiB || pressure >= 4) throw new Error(`Resource stop: ${(fs.bavail * fs.bsize / GiB).toFixed(2)} GiB free, memory pressure ${pressure}; requires >=3 GiB and pressure <4`)
  const bytes = scratch ? diskBytes(scratch) : { logical: 0, allocated: 0 }
  if (Math.max(bytes.logical, bytes.allocated) >= 2 * GiB) throw new Error(`Resource stop: scratch reached ${(Math.max(bytes.logical, bytes.allocated) / GiB).toFixed(2)} GiB; limit 2 GiB`)
  return { freeBytes: fs.bavail * fs.bsize, pressure, scratch: bytes }
}

export function sampler(app) {
  const peaks = { main_rss_mib: 0, renderer_rss_mib: 0, engine_rss_mib: 0, engine_tree_rss_mib: 0 }
  const observed = new Set()
  const byPid = {}
  let busy = false, failure = null
  const sample = async () => {
    if (busy) return
    busy = true
    try {
      const [metrics, engines, ps] = await Promise.all([
        app.evaluate(({ app }) => app.getAppMetrics()),
        app.evaluate(() => globalThis.__rsPerf.engines.filter((e) => e.ms === undefined).map((e) => e.pid)),
        exec('ps', ['-axo', 'pid=,ppid=,rss='])
      ])
      for (const m of metrics) {
        const key = m.type === 'Browser' ? 'main_rss_mib' : m.type === 'Tab' ? 'renderer_rss_mib' : null
        if (key) peaks[key] = Math.max(peaks[key], m.memory.workingSetSize / 1024)
      }
      const rows = ps.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number))
      const tree = new Set(engines)
      let added
      do {
        added = false
        for (const [pid, ppid] of rows) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); added = true }
      } while (added)
      let total = 0
      for (const [pid, , rss] of rows) {
        if (tree.has(pid)) { total += rss / 1024; observed.add(pid) }
        if (engines.includes(pid)) {
          peaks.engine_rss_mib = Math.max(peaks.engine_rss_mib, rss / 1024)
          byPid[pid] = Math.max(byPid[pid] ?? 0, rss / 1024)
        }
      }
      peaks.engine_tree_rss_mib = Math.max(peaks.engine_tree_rss_mib, total)
    } catch (error) { failure = String(error) } finally { busy = false }
  }
  const timer = setInterval(sample, 200)
  return { peaks, byPid, observed, sample, stop: () => clearInterval(timer), failure: () => failure }
}
