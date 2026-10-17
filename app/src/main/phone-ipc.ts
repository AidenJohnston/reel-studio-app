// The main-process side of "Send to my phone": one share link at a time, only for a finished video
// inside the Reel Studio folder, stopped when the panel closes, after 15 minutes, or on quit.
import { BrowserWindow, ShareMenu, shell, type IpcMainInvokeEvent } from 'electron'
import { realpathSync, statSync } from 'node:fs'
import { basename, extname, resolve, sep } from 'node:path'
import type { PhoneEvent, PhoneShare } from '../shared/api'
import { lanAddresses, startShare, type LanAddress, type ShareServer } from './phone-share'

type Handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => void

export interface PhoneIpcDeps {
  handle: Handle
  /** Folders a shared video may live in (the Reel Studio root). */
  roots: () => string[]
  send: (channel: string, v: unknown) => void
  log: (line: string) => void
  test: boolean
}

const EMAIL_LIMIT = 20_000_000 // most mail services stop at 20-25 MB per message

let current: ShareServer | null = null

/** Only an .mp4 that really sits inside the Reel Studio folder (symlinks resolved), never anything else. */
function checkedVideo(p: unknown, roots: string[]): string {
  const bad = { code: 'NOT_FOUND', userMessage: 'I could not find that video. Export it again, then try once more.' }
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

export async function stopPhoneShare(): Promise<void> {
  const s = current
  current = null
  await s?.stop()
}

export function registerPhoneIpc(d: PhoneIpcDeps): void {
  d.handle('phone:start', async (_e, video: unknown, caption: unknown, address?: unknown): Promise<PhoneShare> => {
    const file = checkedVideo(video, d.roots())
    await stopPhoneShare()
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
        file,
        caption: typeof caption === 'string' ? caption.slice(0, 5000) : '',
        title: basename(file, extname(file)),
        host: pick.address,
        onEvent: (ev: PhoneEvent) => {
          if (ev.kind === 'stopped' && current === s) current = null
          d.send('phone:event', ev)
        }
      })
    } catch (err) {
      d.log(`[phone] could not start on ${pick.name}: ${(err as NodeJS.ErrnoException)?.code ?? 'error'}`)
      throw { code: 'PHONE_START', userMessage: 'I could not open a link on this network. Try a different network below, or use one of the other ways.' }
    }
    current = s
    d.log(`[phone] link open on ${pick.name} for 15 minutes`) // no token, no file name
    const wait = Number(d.test ? process.env.REELSTUDIO_PHONE_WAIT_MS : '') || 60_000
    return {
      url: s.url,
      address: pick.address,
      addresses: list.map(({ address: a, label, likely }) => ({ address: a, label, likely })),
      expiresAt: s.expiresAt,
      size: s.size,
      waitMs: wait
    }
  })

  d.handle('phone:stop', () => stopPhoneShare())

  d.handle('phone:emailSelf', async (_e, video: unknown) => {
    const file = checkedVideo(video, d.roots())
    const name = basename(file)
    const big = statSync(file).size > EMAIL_LIMIT
    const body = [
      'To get my video onto my phone:',
      '',
      `1. Attach the video "${name}" to this email (it is in the folder Reel Studio just opened: drag it in here).`,
      '2. Send this email to yourself.',
      '3. Open the email on your phone, tap the video, then Share > Save Video.',
      '',
      big ? 'Note: the video may be too big for email (most allow about 20 MB). If it will not send, use iCloud Drive or Google Drive.' : ''
    ].join('\n')
    const url = `mailto:?subject=${encodeURIComponent(`My video: ${basename(file, '.mp4')}`)}&body=${encodeURIComponent(body)}`
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
