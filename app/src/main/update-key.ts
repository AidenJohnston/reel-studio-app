// The buyer's download key, which turns on automatic updates. The updater (not in this file) sends it to
// dl.getreelstudio.com/u/ as `Authorization: Bearer <key>` with each update download, so the server can check the
// purchase is still active. It is sent nowhere else, and never with the daily "is there a newer version" check
// (main/update-check.ts), which stays anonymous.
//
// How the key gets here, with no typing:
//   1. The receipt email / thanks page links getreelstudio.com/updates.html#key=…, whose button opens
//      `reelstudio://updates?key=…`. The OS hands that link to the app: `open-url` on macOS, the command line
//      (first launch) or `second-instance` (already running) on Windows.
//   2. Settings > About > "Paste my download link": any link from the receipt email, or the page's link.
// Any web page can open a reelstudio:// link, and the key decides whose subscription this computer's updates and
// posting use, so a key from a link is saved only after the person says yes (confirmLink). A pasted one needs no
// question: the person copied it themselves.
//
// The key is a signed token (`v1.<claims>.<signature>`): the Stripe checkout id, the plan and an expiry, no
// name or email. Its claims are readable without the server's secret, which is how Settings can say "monthly".
// This file never imports electron: index.ts wires it to the settings store, and tests drive it with fakes.
import type { UpdateKeyStatus } from '../shared/api'

export const PROTOCOL = 'reelstudio'
/** The only `reelstudio://` link the app acts on. */
export const UPDATES_HOST = 'updates'
export const KEY_RE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
const MAX_KEY = 512
const MAX_INPUT = 4096

export interface UpdateKeyState {
  /** The download key, or null (automatic updates off). */
  updateKey: string | null
}

export const UPDATE_KEY_DEFAULTS: UpdateKeyState = { updateKey: null }


function validKey(k: unknown): k is string {
  return typeof k === 'string' && k.length <= MAX_KEY && KEY_RE.test(k)
}

/** The key from a `reelstudio://updates?key=…` link, or null for anything else (another host, path, scheme). */
export function keyFromProtocolUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > MAX_INPUT) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== `${PROTOCOL}:` || u.hostname !== UPDATES_HOST) return null
  if (u.pathname !== '' && u.pathname !== '/') return null
  const k = u.searchParams.get('key')
  return validKey(k) ? k : null
}

/** Windows passes the link on the command line: the first argument that is one, if any. */
export function keyFromArgv(argv: readonly string[]): string | null {
  for (const a of argv) {
    if (typeof a === 'string' && a.toLowerCase().startsWith(`${PROTOCOL}:`)) {
      const k = keyFromProtocolUrl(a)
      if (k) return k
    }
  }
  return null
}

/** Whatever the person pasted: the bare key, the `reelstudio://` link, the updates page link
 * (`…/updates.html#key=…`), a download link from the receipt email (`…/d/<key>/<file>`), or an update-page
 * link with `?token=…`. Only links on getreelstudio.com and its subdomains count. */
export function keyFromText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text || text.length > MAX_INPUT) return null
  if (validKey(text)) return text
  const viaProtocol = keyFromProtocolUrl(text)
  if (viaProtocol) return viaProtocol
  let u: URL
  try {
    u = new URL(text)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' || !(u.hostname === 'getreelstudio.com' || u.hostname.endsWith('.getreelstudio.com'))) return null
  const fromHash = /(?:^#|&)key=([^&]+)/.exec(u.hash)
  if (fromHash) {
    const k = decodeURIComponent(fromHash[1])
    if (validKey(k)) return k
  }
  const fromQuery = u.searchParams.get('token') ?? u.searchParams.get('key')
  if (validKey(fromQuery)) return fromQuery
  const fromPath = /^\/d\/([^/]+)\//.exec(u.pathname)
  if (fromPath && validKey(fromPath[1])) return fromPath[1]
  return null
}

/** The plan named inside the key (readable without the server's secret; the server checks the signature). */
export function planOf(key: string | null): 'monthly' | 'once' | null {
  if (!validKey(key)) return null
  try {
    const body = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const claims = JSON.parse(Buffer.from(body, 'base64').toString('utf8')) as { p?: unknown }
    return claims.p === 'monthly' || claims.p === 'once' ? claims.p : null
  } catch {
    return null
  }
}

export interface UpdateKeyDeps {
  load(): Promise<UpdateKeyState>
  save(patch: Partial<UpdateKeyState>): Promise<unknown>
  log(line: string): void
  /** Tell the page (Settings) the status changed. */
  send(s: UpdateKeyStatus): void
  /** Ask before saving a key from a link. `replacing`: a different key is saved now. True = yes. */
  confirmLink(o: { replacing: boolean }): Promise<boolean>
}

export function createUpdateKeyService(d: UpdateKeyDeps) {
  const status = (key: string | null): UpdateKeyStatus => ({ on: validKey(key), plan: planOf(key) })
  // Every change to the key runs one at a time, so the updater's "clear this key if it is still the saved one"
  // cannot read the old key while a new one is being saved and then erase the new one.
  let chain: Promise<unknown> = Promise.resolve()
  function serial<T>(f: () => Promise<T>): Promise<T> {
    const run = chain.then(f, f)
    chain = run.catch(() => undefined)
    return run
  }
  const store = (key: string, from: string): Promise<UpdateKeyStatus> =>
    serial(async () => {
      await d.save({ updateKey: key })
      const s = status(key)
      d.log(`[updates] automatic updates turned on (key from ${from}, plan ${s.plan ?? '?'})`) // never the key
      d.send(s)
      return s
    })
  const clear = (): Promise<UpdateKeyStatus> =>
    serial(async () => {
      await d.save({ updateKey: null })
      d.log('[updates] automatic updates turned off (key removed)')
      const s = status(null)
      d.send(s)
      return s
    })
  return {
    /** For the updater: the key to send to dl.getreelstudio.com/u/, or null. */
    async get(): Promise<string | null> {
      const k = (await d.load()).updateKey
      return validKey(k) ? k : null
    },
    async status(): Promise<UpdateKeyStatus> {
      return status((await d.load()).updateKey)
    },
    /** A `reelstudio://` link from the OS. null when it is not ours, carries no valid key, or the person said no
     * (then nothing changes). `asked`: the person was asked and said yes, so there is nothing more to tell them. */
    async fromLink(url: unknown): Promise<(UpdateKeyStatus & { asked: boolean }) | null> {
      const k = keyFromProtocolUrl(url)
      if (!k) {
        if (typeof url === 'string') d.log('[updates] ignored a reelstudio:// link that carries no valid key')
        return null
      }
      const current = (await d.load()).updateKey
      if (current === k) return { ...status(k), asked: false } // the same key again: nothing to ask
      if (!(await d.confirmLink({ replacing: validKey(current) }))) {
        d.log('[updates] a reelstudio:// link offered a download key; not saved (the person said no)')
        return null
      }
      return { ...(await store(k, 'link')), asked: true }
    },
    /** Settings > "Paste my download link". null when the text holds no key. */
    async fromText(text: unknown): Promise<UpdateKeyStatus | null> {
      const k = keyFromText(text)
      return k ? store(k, 'paste') : null
    },
    /** Settings > "Turn off". */
    clear,
    /** Whether `key` is the saved key, after any change already under way has finished. */
    isCurrent: (key: string): Promise<boolean> => serial(async () => (await d.load()).updateKey === key),
    /** The updater after the server answered 401 to `key`: turns automatic updates off only if `key` is still the
     * saved one. False when another key was saved meanwhile (that one is kept). */
    clearIfCurrent: (key: string): Promise<boolean> =>
      serial(async () => {
        if ((await d.load()).updateKey !== key) return false
        await d.save({ updateKey: null })
        d.log('[updates] automatic updates turned off (the update server did not accept the key)')
        d.send(status(null))
        return true
      })
  }
}

export type UpdateKeyService = ReturnType<typeof createUpdateKeyService>
