// One writer per project (docs/ownership.md). Electron's single-instance lock (index.ts) means no second app runs,
// and inside the app the job lane (jobs.ts) runs one job or manual edit per project at a time. work/.owner.lock makes
// that one writer exclusive across processes too: the app's claim passes its token to every engine command and AI
// edit it runs, which go ahead only while the lock holds that token, and tools run by hand (the engine CLI, the AI
// dev CLI) claim the same lock for as long as they run (engine/reelengine/owner.py, ai/src/owner.ts).
import { promises as fs } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { processAlive, stillWorking } from './orphans'
import { OWNER_LOCK, projectsDir } from './paths'

export { OWNER_LOCK }
/** What the app writes as `app`; anything else in a lock was written by a tool run by hand. */
const APP = 'Reel Studio'

export const PROJECT_IN_USE = {
  code: 'PROJECT_IN_USE',
  userMessage: 'A Reel Studio tool run outside the app is working on this video. Try again when it finishes.'
}

/** `token` goes to every engine command and AI edit the claim's writer runs (`--owner`). */
export interface ProjectOwner {
  token: string
  release(): Promise<void>
}

interface Identity {
  app?: unknown
  pid?: unknown
  started?: unknown
  token?: unknown
  engines?: unknown
}

type Held = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'held'; who: Identity }

async function readLock(lock: string): Promise<Held> {
  let text: string
  try {
    text = await fs.readFile(lock, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' }
  }
  try {
    const who = JSON.parse(text)
    return who && typeof who === 'object' ? { kind: 'held', who } : { kind: 'unreadable' }
  } catch {
    return { kind: 'unreadable' }
  }
}

const startedOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A lock a tool run by hand holds, and may still write under: its process (pid and start time) runs, an engine it
 * recorded runs, or something running names the project's folder (orphans.ts). Unsure counts as still writing. */
async function handWriterAlive(dir: string, who: Identity): Promise<boolean> {
  if (typeof who.pid !== 'number' || (await processAlive(who.pid, startedOf(who.started)))) return true
  const engines = Array.isArray(who.engines) ? who.engines : []
  for (const e of engines) {
    const pid = (e as { pid?: unknown })?.pid
    if (typeof pid !== 'number' || (await processAlive(pid, startedOf((e as { started?: unknown }).started)))) return true
  }
  const working = await stillWorking([dir])
  return working === null || working.length > 0
}

/** Whether `dir`'s lock may be taken over: absent, this app's (a previous run's, or a job's whose engine was stuck,
 * which the job lane already keeps closed), or a tool's run by hand that has exited along with everything it started.
 * An unreadable lock is never proof of abandonment: it may be one being written on a disk without hard links. */
async function abandoned(dir: string, held: Held): Promise<boolean> {
  if (held.kind !== 'held') return held.kind === 'absent'
  if (held.who.app === APP) return true
  return !(await handWriterAlive(dir, held.who))
}

/** Creates the lock whole: the identity goes to a file of its own first, which then becomes the lock by a hard link
 * that fails if a lock exists. A disk with no hard links (FAT, exFAT) gets an exclusive create instead, and readers
 * never take a lock they can't read. False when a lock exists. */
async function createLock(lock: string, identity: object): Promise<boolean> {
  const text = JSON.stringify(identity)
  const tmp = `${lock}.${randomUUID()}.tmp`
  const fh = await fs.open(tmp, 'wx')
  try {
    await fh.writeFile(text)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await fs.link(tmp, lock)
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false
    // A disk with no hard links (FAT, exFAT; libuv names it EPERM, ENOTSUP or EISDIR): an exclusive create instead,
    // whose identity follows a moment later. A real failure fails this create too.
    try {
      await fs.writeFile(lock, text, { flag: 'wx' })
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
      throw err
    }
  } finally {
    await fs.rm(tmp, { force: true })
  }
}

/** Throws PROJECT_IN_USE while another writer may have the project (abandoned). */
export async function claimProject(dir: string): Promise<ProjectOwner> {
  const token = randomUUID()
  const lock = join(dir, OWNER_LOCK)
  await fs.mkdir(dirname(lock), { recursive: true })
  const identity = { app: APP, pid: process.pid, started: Math.round(Date.now() - process.uptime() * 1000), token }
  for (let attempt = 0; !(await createLock(lock, identity)); attempt++) {
    // a second refusal: something claimed it between the removal and this try
    if (attempt > 0 || !(await abandoned(dir, await readLock(lock)))) throw PROJECT_IN_USE
    await fs.rm(lock, { force: true })
  }
  return {
    token,
    release: async () => {
      const held = await readLock(lock)
      if (held.kind === 'held' && held.who.token === token) await fs.rm(lock, { force: true })
    }
  }
}

/** At startup, after leftover engines are stopped and scanned for (orphans.ts) and before any job: removes the
 * locks that may be taken over (abandoned). `stillRunning`: projects something of the last run's still writes to;
 * their locks stay. */
export async function clearStaleLocks(stillRunning: string[]): Promise<void> {
  const keep = new Set(stillRunning.map((dir) => resolve(dir)))
  const slugs = await fs.readdir(projectsDir()).catch(() => [] as string[])
  await Promise.all(slugs.filter((slug) => !keep.has(resolve(projectsDir(), slug))).map((slug) => clearStaleLock(join(projectsDir(), slug))))
}

/** Removes the project's lock when it may be taken over (abandoned). */
export async function clearStaleLock(dir: string): Promise<void> {
  const lock = join(dir, OWNER_LOCK)
  const held = await readLock(lock)
  if (held.kind !== 'absent' && (await abandoned(dir, held))) await fs.rm(lock, { force: true })
}
