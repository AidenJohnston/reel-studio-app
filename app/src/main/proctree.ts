// Kill a process and everything it started (python -> ffmpeg).
import { execFile } from 'node:child_process'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** True while any process is left in the group `pid` leads. Engines are spawned detached (their own
 * group) on macOS/Linux; Windows has no process groups, so this is never asked there. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function within(ms: number, gone: () => boolean): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) if (gone()) return true
  return gone()
}

/** Only ever the group: once the engine and its group are gone, its pid may already be someone else's. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    /* the group is gone */
  }
}

/** Ends the process and everything it started (SIGKILL after 1.5 s) and settles once they have exited:
 * false when something is still alive 5 s after SIGKILL. On Windows the engine's Job Object ends its
 * children with it (engine/reelengine/contain.py), and taskkill /T ends the whole tree; false when the
 * process itself is still alive 5 s later. */
export async function killTree(pid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      try {
        execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
      } catch {
        resolve() // Windows refused to start it at all (spawn UNKNOWN): the check below decides
      }
    })
    // taskkill can fail (access denied, or it could not be started): only the exit shows the engine
    // stopped. A number Windows has already handed on reads as alive too, which keeps the video closed.
    return within(5000, () => !isAlive(pid))
  }
  signalGroup(pid, 'SIGTERM')
  if (await within(1500, () => !groupAlive(pid))) return true
  signalGroup(pid, 'SIGKILL')
  return within(5000, () => !groupAlive(pid))
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
