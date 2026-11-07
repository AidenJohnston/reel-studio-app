// The main-process side of "Send to my phone": one share link at a time, only for a finished video
// inside the Reel Studio folder, stopped when the panel closes, after 15 minutes, or on quit.
import { app, BrowserWindow, ShareMenu, shell, type IpcMainInvokeEvent } from 'electron'
import { realpathSync, statSync } from 'node:fs'
import { basename, extname, resolve, sep } from 'node:path'
import type { PhoneEvent, PhoneShare, ReelPlan } from '../shared/api'
import { PHONE_WAIT_MS } from '../shared/phone-help'
import { cloudDriveAt, copyToCloudDrive, detectCloudDrives } from './cloud-drive'
import { lanAddresses, startShare, type LanAddress, type ShareServer } from './phone-share'

type Handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => void

export interface PhoneIpcDeps {
  handle: Handle
  /** Folders a shared video may live in (the Reel Studio root). */
  roots: () => string[]
  /** A reel's title and plan, read from its app.json; throws when it has none. */
  plan: (slug: string) => Promise<{ title: string; plan: ReelPlan }>
  send: (channel: string, v: unknown) => void
  log: (line: string) => void
  test: boolean
}

const EMAIL_LIMIT = 20_000_000 // most mail services stop at 20-25 MB per message

let current: ShareServer | null = null
/**
 * Every start and stop of the link, one after another. Two quick "Make a new code" clicks would otherwise both stop
 * the old link, both start one, and the first new link would be forgotten, still open, until its 15 minutes ran out.
 */
let lifetime: Promise<unknown> = Promise.resolve()
function inTurn<T>(run: () => Promise<T>): Promise<T> {
  const next = lifetime.then(run, run)
  lifetime = next.catch(() => {})
  return next
}
/** Cloud saves running now, by the id the renderer gave each, so Cancel stops the right one. */
const saves = new Map<string, AbortController>()

/** Why a copy onto a drive failed, in words: the error code says which. */
function cloudFailure(error: unknown, drive: string): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'ENOSPC' || code === 'EDQUOT') return `There isn't enough space on ${drive}. Free some up, then try again.`
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return `Reel Studio isn't allowed to write to ${drive}. Check the drive is signed in and its Reel Studio folder isn't read-only, then try again.`
  if (code === 'ENOENT' || code === 'ENOTCONN' || code === 'EIO') return `${drive} isn't reachable right now. Check it's signed in and connected, then try again.`
  return `The copy to ${drive} stopped partway. Check it's connected, then try again.`
}

/** Only an .mp4 that really sits inside the Reel Studio folder (symlinks resolved), never anything else. */
function checkedVideo(p: unknown, roots: string[]): string {
  const bad = { code: 'NOT_FOUND', userMessage: "That file isn't in the Reel Studio folder any more. Share it again." }
  if (typeof p !== 'string' || extname(p).toLowerCase() !== '.mp4') throw bad
  let real: string
  try {
    real = realpathSync.native(resolve(p))
  } catch {
    throw bad
  }
  const inside = roots.some((r) => {
    let root: string
    try {
      root = realpathSync.native(resolve(r))
    } catch {
      return false
    }
    return real.startsWith(root.endsWith(sep) ? root : root + sep)
  })
  if (!inside) throw bad
  return real
}

function addresses(test: boolean): LanAddress[] {
  // Tests may pin the address (loopback in CI, where there is no Wi-Fi and no firewall to click).
  const pinned = test ? process.env.REELSTUDIO_PHONE_HOST : undefined
  if (pinned) return [{ address: pinned, name: 'test', label: `Test network (${pinned})`, likely: true }]
  return lanAddresses()
}

async function stopNow(): Promise<void> {
  const s = current
  current = null
  await s?.stop()
}

export function stopPhoneShare(): Promise<void> {
  return inTurn(stopNow)
}

// Drive saves still copying. Quitting waits for them (index.ts, before-quit): a process that exits mid-save
// leaves a hidden temporary file in a folder that syncs to the phone.
const saving = new Set<Promise<unknown>>()

export function cloudSavesRunning(): number {
  return saving.size
}

// Quitting waits at most 15 s for drive saves. A stalled network or streaming drive must not keep a windowless
// process holding the single-instance lock, which makes reopening the app do nothing. Because the save
// publishes with a hard link, giving up only leaves a hidden temporary file, never a partial reel at the real name.
const QUIT_WAIT_MS = 15_000

export async function cloudSavesSettled(): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const capped = new Promise<void>((resolve) => (timer = setTimeout(resolve, QUIT_WAIT_MS)))
  await Promise.race([Promise.allSettled([...saving]), capped])
  clearTimeout(timer)
}

export function registerPhoneIpc(d: PhoneIpcDeps): void {
  const where = () => ({ platform: process.platform, home: app.getPath('home') })
  d.handle('cloud:drives', () => detectCloudDrives(where()))
  d.handle('cloud:save', async (_e, video: unknown, folder: unknown, id: unknown) => {
    const file = checkedVideo(video, d.roots())
    const drive = typeof folder === 'string' ? await cloudDriveAt(folder, where()) : null
    if (!drive) throw { code: 'CLOUD_MISSING', userMessage: `${typeof folder === 'string' && folder.includes('GoogleDrive') ? 'Google Drive' : 'That drive'} isn't on this computer any more. Open it, then try again.` }
    if (typeof id !== 'string' || saves.has(id)) throw { code: 'BAD_INPUT', userMessage: 'Try saving again.' }
    const stop = new AbortController()
    saves.set(id, stop)
    const save = copyToCloudDrive(file, drive.folder, { signal: stop.signal, onProgress: (pct) => d.send('cloud:progress', { id, pct }) })
    saving.add(save)
    try {
      return await save
    } catch (error) {
      if (stop.signal.aborted) throw { code: 'CANCELLED', userMessage: 'Stopped.' }
      d.log(`[cloud] save failed: ${error instanceof Error ? error.message : String(error)}`)
      throw { code: 'CLOUD_SAVE', userMessage: cloudFailure(error, drive.label) }
    } finally {
      saving.delete(save)
      saves.delete(id)
    }
  })
  d.handle('cloud:cancel', (_e, id: unknown) => {
    if (typeof id === 'string') saves.get(id)?.abort()
  })

  /** Opens the one link: a video or a plan, on the network asked for (or the likeliest one). */
  function open(what: { file: string; caption: string; title: string } | { plan: ReelPlan; title: string }, address: unknown): Promise<PhoneShare> {
    return inTurn(() => openNow(what, address))
  }
  async function openNow(what: { file: string; caption: string; title: string } | { plan: ReelPlan; title: string }, address: unknown): Promise<PhoneShare> {
    await stopNow()
    const list = addresses(d.test)
    if (!list.length)
      throw {
        code: 'NO_NETWORK',
        userMessage: 'This computer is not on Wi-Fi or a home network right now. Connect it to the same Wi-Fi as your phone, then try again.'
      }
    const pick = list.find((a) => a.address === address) ?? list[0]
    let s: ShareServer
    try {
      s = await startShare({
        ...('plan' in what ? { plan: what.plan, caption: '' } : { file: what.file, caption: what.caption }),
        title: what.title,
        host: pick.address,
        onEvent: (ev: PhoneEvent) => {
          if (ev.kind === 'stopped' && current === s) current = null
          d.send('phone:event', ev)
        }
      })
    } catch (err) {
      d.log(`[phone] could not start on ${pick.name}: ${(err as NodeJS.ErrnoException)?.code ?? 'error'}`)
      throw { code: 'PHONE_START', userMessage: "A link couldn't open on this network. Try a different network below, or use one of the other ways." }
    }
    current = s
    d.log(`[phone] link open on ${pick.name} for 15 minutes`) // no token, no file name
    const wait = Number(d.test ? process.env.REELSTUDIO_PHONE_WAIT_MS : '') || PHONE_WAIT_MS
    return {
      url: s.url,
      address: pick.address,
      addresses: list.map(({ address: a, label, likely }) => ({ address: a, label, likely })),
      expiresAt: s.expiresAt,
      size: s.size,
      waitMs: wait
    }
  }

  d.handle('phone:start', async (_e, video: unknown, caption: unknown, address?: unknown): Promise<PhoneShare> => {
    const file = checkedVideo(video, d.roots())
    return open({ file, caption: typeof caption === 'string' ? caption.slice(0, 5000) : '', title: basename(file, extname(file)) }, address)
  })
  // read from the reel's own app.json, never from the page: the link only ever shows what the reel holds
  d.handle('phone:startPlan', async (_e, slug: unknown, address?: unknown): Promise<PhoneShare> => {
    if (typeof slug !== 'string') throw { code: 'BAD_INPUT', userMessage: 'Try sending the plan again.' }
    return open(await d.plan(slug), address)
  })

  d.handle('phone:stop', () => stopPhoneShare())

  d.handle('phone:emailSelf', async (_e, video: unknown) => {
    const file = checkedVideo(video, d.roots())
    const name = basename(file)
    const big = statSync(file).size > EMAIL_LIMIT
    const body = [
      'To get my reel onto my phone:',
      '',
      `1. Attach the file "${name}" to this email (it is in the folder Reel Studio just opened: drag it in here).`,
      '2. Send this email to yourself.',
      '3. Open the email on your phone, tap the file, then Share > Save Video.',
      '',
      big ? 'Note: the file may be too big for email (most allow about 20 MB). If it will not send, use iCloud Drive or Google Drive.' : ''
    ].join('\n')
    const url = `mailto:?subject=${encodeURIComponent(`My reel: ${basename(file, '.mp4')}`)}&body=${encodeURIComponent(body)}`
    if (d.test) return
    await shell.openExternal(url)
    shell.showItemInFolder(file)
  })

  d.handle('phone:shareSheet', async (e, video: unknown) => {
    const file = checkedVideo(video, d.roots())
    if (d.test) return
    if (process.platform === 'darwin') {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      new ShareMenu({ filePaths: [file] }).popup({ window: win })
    } else {
      shell.showItemInFolder(file)
    }
  })
}
