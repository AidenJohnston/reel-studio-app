// One writer per project. Electron's single-instance lock (index.ts) is held by the OS until this process
// dies, so no second app can be running, and inside the app the job lane (jobs.ts) runs one job or manual
// edit per project at a time. work/.owner.lock makes that one writer exclusive across processes too: a job
// creates it exclusively and passes its token to every engine command and AI edit it runs, which go ahead
// only while the lock holds that token. Tools run by hand (the engine CLI, the AI dev CLI) claim the same
// lock for as long as they run, so neither side starts while the other has the project
// (engine/reelengine/owner.py, ai/src/owner.ts).
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { projectsDir } from './paths'

export const OWNER_LOCK = join('work', '.owner.lock')
/** What the app writes as `app`; anything else in a lock was written by a tool run by hand. */
const APP = 'Reel Studio'

export const PROJECT_IN_USE = {
  code: 'PROJECT_IN_USE',
  userMessage: 'A Reel Studio tool run outside the app is working on this video. Try again when it finishes.'
}

/** `token` goes to every engine command and AI edit the job runs (`--owner`). */
export interface ProjectOwner {
  token: string
  release(): Promise<void>
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The lock belongs to a tool run by hand that is still running. `unreadable`: what a lock that can't be read
 * counts as. A claim counts it as held, since a tool writes its lock just after creating it; startup clears it,
 * since a tool killed in between would otherwise keep the video closed for good. */
async function heldByHand(lock: string, unreadable: boolean): Promise<boolean> {
  let text: string
  try {
    text = await fs.readFile(lock, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ENOENT' && unreadable
  }
  let held: { app?: unknown; pid?: unknown }
  try {
    held = JSON.parse(text)
  } catch {
    return unreadable
  }
  return held?.app !== APP && (typeof held?.pid !== 'number' || alive(held.pid))
}

/** Throws PROJECT_IN_USE while a tool run by hand has the project. A lock this app left (a job whose engine was
 * stuck, or a previous run's, which startup clears) or one whose tool has exited is taken over. */
export async function claimProject(dir: string): Promise<ProjectOwner> {
  const token = randomUUID()
  const lock = join(dir, OWNER_LOCK)
  await fs.mkdir(dirname(lock), { recursive: true })
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await fs.open(lock, 'wx')
      try {
        await fh.writeFile(JSON.stringify({ app: APP, pid: process.pid, token }))
        await fh.sync()
      } finally {
        await fh.close()
      }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // a second EEXIST: something claimed it between the removal and this try
      if (attempt > 0 || (await heldByHand(lock, true))) throw PROJECT_IN_USE
      await fs.rm(lock, { force: true })
    }
  }
  return { token, release: () => fs.rm(lock, { force: true }) }
}

/** At startup, after leftover engines are stopped (orphans.ts) and before any job: every lock this app wrote was
 * left by an app that has quit or crashed, since this one holds the single-instance lock. `stillRunning`: projects
 * where something of that app's is still running; their locks stay, as does one a tool run by hand still holds. */
export async function clearStaleLocks(stillRunning: string[]): Promise<void> {
  const keep = new Set(stillRunning.map((dir) => resolve(dir)))
  const slugs = await fs.readdir(projectsDir()).catch(() => [] as string[])
  await Promise.all(slugs.filter((slug) => !keep.has(resolve(projectsDir(), slug))).map((slug) => clearStaleLock(join(projectsDir(), slug))))
}

/** Removes the project's lock unless a tool run by hand still holds it. */
export async function clearStaleLock(dir: string): Promise<void> {
  const lock = join(dir, OWNER_LOCK)
  if (!(await heldByHand(lock, false))) await fs.rm(lock, { force: true })
}
