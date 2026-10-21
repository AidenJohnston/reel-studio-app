import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { exec } from './resources.mjs'

export async function cleanupEngines(scratch, registry) {
  const registered = existsSync(registry) ? readFileSync(registry, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
  if (registered.some(({ pid }) => !Number.isInteger(pid) || pid <= 1)) throw new Error('Invalid engine PID registry')
  const pids = new Set(registered.map(({ pid }) => pid))
  const roots = [...new Set([scratch, realpathSync(scratch)])].map((path) => path + sep)
  const snapshot = async () => {
    const { stdout } = await exec('ps', ['-axo', 'pid=,pgid=,stat=,command='])
    return stdout.trim().split('\n').map((line) => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
      if (!match) throw new Error(`Cannot parse process row: ${line}`)
      return { pid: Number(match[1]), group: Number(match[2]), status: match[3], command: match[4] }
    }).filter((p) => !p.status.startsWith('Z') && (pids.has(p.pid) || pids.has(p.group) || roots.some((root) => p.command.includes(root))))
  }
  const signalled = []
  // Detached FFmpeg inherits the engine's group. Its input/output arguments must
  // identify this scratch directory even when its executable is read-only elsewhere.
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    const remaining = await snapshot()
    for (const p of remaining) {
      if (!roots.some((root) => p.command.includes(root))) throw new Error(`Refusing to signal PID ${p.pid}: command has no path under ${scratch}`)
      try { process.kill(p.pid, signal); signalled.push({ pid: p.pid, signal }) }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    const deadline = performance.now() + 5000
    do {
      const survivors = await snapshot()
      if (!survivors.length) return { registered: registered.length, signalled, survivors: [] }
      await delay(100)
    } while (performance.now() < deadline)
  }
  const survivors = await snapshot()
  if (survivors.length) throw new Error(`Engine cleanup failed: surviving PIDs ${survivors.map((p) => p.pid).join(', ')}; scratch retained at ${scratch}`)
  return { registered: registered.length, signalled, survivors: [] }
}
