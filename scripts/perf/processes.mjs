import { realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import registryTools from './process-registry.cjs'

const { processTable, readRegistry, captureDescendants } = registryTools

export async function cleanupEngines(scratch, registry) {
  const registered = readRegistry(registry)
  const roots = [...new Set([scratch, realpathSync(scratch)])].map((path) => path + sep)
  const snapshot = () => captureDescendants(registry)
  const signalled = []
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const remaining = snapshot()
    for (const candidate of remaining) {
      // PID alone is insufficient: recheck its start identity immediately before kill.
      const [p] = processTable(candidate.pid)
      if (!p || p.startedAt !== candidate.startedAt) continue
      if (!roots.some((root) => p.command.includes(root))) throw new Error(`Refusing to signal PID ${p.pid}: command has no path under ${scratch}`)
      try { process.kill(p.pid, signal); signalled.push({ pid: p.pid, signal }) }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const deadline = performance.now() + 5000
    do {
      const survivors = snapshot()
      if (!survivors.length) return { registered: registered.length, signalled, survivors: [] }
      await delay(100)
    } while (performance.now() < deadline)
  }
  const survivors = snapshot()
  if (survivors.length) throw new Error(`Engine cleanup failed: surviving PIDs ${survivors.map((p) => p.pid).join(', ')}; scratch retained at ${scratch}`)
  return { registered: registered.length, signalled, survivors: [] }
}
