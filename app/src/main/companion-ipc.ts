// The main-process side of Settings > Phone and browser: the "Phone and browser" switch, pairing codes, the paired list, and
// the companion server's lifetime (main/companion/). Electron's pieces come in from index.ts, so this file is tested
// without Electron (test/companion-ipc.test.ts).
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { DevicesStatus } from '../shared/api'
import { pairingFragment, type Scope } from '../shared/contract'
import { createDeviceRegistry, type DeviceKind } from './companion/devices'
import { startCompanionServer, type CompanionServer } from './companion/server'
import { contractEvent, createCompanionService, type ServiceDeps } from './companion/service'
import type { SecretStore } from './posting-ipc'
import { writeJson } from './store'

type Handle = (channel: string, fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown) => void

export interface CompanionIpcDeps {
  handle: Handle
  send: (channel: string, v: unknown) => void
  /** Where devices and the switch are kept (the settings folder). */
  dir: string
  secrets: SecretStore | null
  /** The renderer build folder holding companion.html. */
  staticDir: string
  service: Omit<ServiceDeps, 'installationId'>
  /** The address a phone can reach (phone-share lanAddresses), or null when there's none. */
  address: () => string | null
  openExternal: (url: string) => Promise<void>
  log: (line: string) => void
}

interface Saved {
  on: boolean
  /** The port devices were paired on: their saved pairing names it, so it's kept between launches. */
  port: number | null
}

export const NO_NETWORK = "This computer isn't on a Wi-Fi or cable network a phone can reach. Connect it to your home network, then turn this on again."
export const PORT_FAILED = "Reel Studio couldn't open a connection for your phone. Turn this off and on again; if it still fails, restart Reel Studio."

export function registerCompanionIpc(d: CompanionIpcDeps) {
  const file = join(d.dir, 'companion.json')
  const devices = createDeviceRegistry({ dir: d.dir, secrets: d.secrets, log: d.log })
  const service = createCompanionService({ ...d.service, installationId: () => devices.installationId() })
  let server: CompanionServer | null = null
  let saved: Saved = { on: false, port: null }
  let problem: string | null = null
  let pairingUrl: { url: string; expiresAt: number; kind: DeviceKind; notes: boolean } | null = null
  let pairingTimer: NodeJS.Timeout | undefined
  // Every change to whether the server runs goes through this one chain, so a switch flipped while the server is
  // still starting (or at launch, while init runs) ends in the state the switch shows.
  let lifetime: Promise<void> = Promise.resolve()
  let touched = false

  async function readSaved(): Promise<Saved> {
    try {
      const s = JSON.parse(await fs.readFile(file, 'utf8'))
      return { on: s.on === true, port: Number.isInteger(s.port) && s.port > 0 && s.port < 65536 ? s.port : null }
    } catch {
      return { on: false, port: null }
    }
  }

  async function status(): Promise<DevicesStatus> {
    if (pairingUrl && pairingUrl.expiresAt <= Date.now()) pairingUrl = null
    return {
      on: saved.on,
      address: server ? `${server.host}:${server.port}` : null,
      problem,
      devices: await devices.list(),
      pairing: pairingUrl,
      computer: d.service.computer
    }
  }

  const changed = async (): Promise<void> => d.send('devices:change', await status())
  devices.onChange(() => {
    // A device just paired: the code is used up, so the pairing sheet on the computer closes.
    if (pairingUrl && !devices.pairingOpen()) pairingUrl = null
    void changed()
  })

  async function start(): Promise<void> {
    if (server) return
    const host = d.address()
    if (!host) {
      problem = NO_NETWORK
      return
    }
    try {
      server = await startCompanionServer({ host, port: saved.port ?? undefined, staticDir: d.staticDir, devices, service, log: d.log })
      problem = null
      if (saved.port !== server.port) {
        saved = { ...saved, port: server.port }
        await writeJson(file, saved)
      }
      d.log('[companion] on')
    } catch (e) {
      d.log(`[companion] could not start: ${String(e)}`)
      problem = PORT_FAILED
    }
  }

  async function close(): Promise<void> {
    devices.cancelPairing()
    pairingUrl = null
    const s = server
    server = null
    await s?.stop()
  }

  /** Brings the server in line with the switch (`saved.on`), after any change already under way. */
  function settle(): Promise<void> {
    const run = lifetime.then(async () => {
      if (saved.on && !server) await start()
      else if (!saved.on && server) await close()
      if (!saved.on) problem = null
    })
    lifetime = run.catch(() => {})
    return run
  }

  async function setOn(on: boolean): Promise<DevicesStatus> {
    touched = true
    saved = { ...saved, on }
    await writeJson(file, saved)
    await settle()
    await changed()
    return status()
  }

  async function pair(kind: DeviceKind, notes: boolean): Promise<DevicesStatus> {
    if (!saved.on) await setOn(true)
    else await settle()
    if (!server) return status()
    const scopes: Scope[] = notes ? ['view', 'note'] : ['view']
    const p = devices.startPairing(kind, scopes)
    pairingUrl = { url: `${server.origin}/#${pairingFragment(p.pairing, p.secret)}`, expiresAt: p.expiresAt, kind, notes }
    clearTimeout(pairingTimer)
    pairingTimer = setTimeout(() => void changed(), p.expiresAt - Date.now() + 50)
    pairingTimer.unref?.()
    await changed()
    return status()
  }

  d.handle('devices:status', () => status())
  d.handle('devices:setOn', (_e, on: unknown) => setOn(on === true))
  d.handle('devices:pair', (_e, kind: unknown, notes: unknown) => pair(kind === 'browser' ? 'browser' : 'phone', notes !== false))
  d.handle('devices:cancelPair', async () => {
    devices.cancelPairing()
    pairingUrl = null
    await changed()
    return status()
  })
  d.handle('devices:openInBrowser', async (_e, notes: unknown) => {
    const s = await pair('browser', notes !== false)
    if (s.pairing) await d.openExternal(s.pairing.url)
    return s
  })
  d.handle('devices:remove', async (_e, id: unknown) => {
    if (typeof id !== 'string') throw { code: 'BAD_REQUEST', userMessage: 'That device is no longer paired.' }
    await devices.remove(id)
    server?.revoke(id)
    return status()
  })

  return {
    /** At launch: on again if it was on. */
    async init(): Promise<void> {
      const read = await readSaved()
      // a switch flipped before this read finished wins over what was saved
      if (!touched) saved = read
      await settle()
    },
    /** Every desktop broadcast passes through here; devices hear the ones they follow. */
    publish(channel: string, payload: unknown): void {
      if (!server) return
      const e = contractEvent(channel, payload)
      if (e) server.publish(e)
    },
    /** At quit: the switch stays as it is for the next launch. */
    stop: (): Promise<void> => {
      const run = lifetime.then(close)
      lifetime = run.catch(() => {})
      return run
    },
    /** For tests and the e2e: the live server's origin. */
    origin: (): string | null => server?.origin ?? null
  }
}
