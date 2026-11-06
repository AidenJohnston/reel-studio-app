// Settings > Phone and browser (main/companion-ipc.ts), with the real server on loopback: the switch, the port a
// paired phone depends on, and the pairing sheet closing once a phone uses the code.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DevicesStatus } from '../src/shared/api'
import { pairMessage, parsePairingFragment, sign } from '../src/shared/contract'
import { fromHex } from '../src/shared/sha256'
import { registerCompanionIpc } from '../src/main/companion-ipc'

const staticDir = mkdtempSync(join(tmpdir(), 'rs-cipc-static-'))
mkdirSync(join(staticDir, 'assets'))
writeFileSync(join(staticDir, 'companion.html'), '<!doctype html>')

type Fn = (e: unknown, ...a: unknown[]) => unknown
const running: { stop(): Promise<void> }[] = []
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop()
})

function open(dir: string) {
  const handlers = new Map<string, Fn>()
  const pushed: DevicesStatus[] = []
  const r = registerCompanionIpc({
    handle: (c, fn) => handlers.set(c, fn as Fn),
    send: (c, v) => c === 'devices:change' && pushed.push(v as DevicesStatus),
    dir,
    secrets: null,
    staticDir,
    service: {
      list: async () => [], get: async () => { throw new Error('none') }, projectDir: (s) => join(dir, s), note: async () => ({ jobId: null }),
      cancel: async () => {}, timeline: async () => null, editorConnected: async () => false, appVersion: '0.1.4', computer: 'Test computer'
    },
    address: () => '127.0.0.1',
    openExternal: async () => {},
    log: () => {}
  })
  running.push(r)
  const call = (c: string, ...a: unknown[]): Promise<DevicesStatus> => Promise.resolve(handlers.get(c)!({}, ...a)) as Promise<DevicesStatus>
  return { r, call, pushed }
}

const reachable = (address: string): Promise<boolean> =>
  fetch(`http://${address}/api/time`).then((res) => res.ok, () => false)

describe('Phone and browser', () => {
  it('comes back on, on the same port, at the next launch, and stops listening when switched off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rs-cipc-'))
    const first = open(dir)
    const on = await first.call('devices:setOn', true)
    expect(on.address).toMatch(/^127\.0\.0\.1:\d+$/)
    await first.r.stop()

    const second = open(dir)
    await second.r.init()
    const again = await second.call('devices:status')
    expect(again.address).toBe(on.address)
    expect(await reachable(again.address!)).toBe(true)

    const off = await second.call('devices:setOn', false)
    expect(off.address).toBeNull()
    expect(await reachable(again.address!)).toBe(false)
  })

  it('is not listening after Off, even when Off comes while it is still starting', async () => {
    const { call } = open(mkdtempSync(join(tmpdir(), 'rs-cipc-')))
    const on = call('devices:setOn', true)
    const off = await call('devices:setOn', false)
    const started = await on
    expect(off.address).toBeNull()
    expect(started.on).toBe(false)
    expect(await call('devices:status')).toMatchObject({ on: false, address: null })
  })

  it('closes the pairing code once a phone uses it, and lists the phone', async () => {
    const { call, pushed } = open(mkdtempSync(join(tmpdir(), 'rs-cipc-')))
    const s = await call('devices:pair', 'phone', false)
    const url = new URL(s.pairing!.url)
    const f = parsePairingFragment(url.hash)!
    const res = await fetch(`${url.origin}/api/pair`, {
      method: 'POST',
      headers: { origin: url.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ pairing: f.pairing, name: 'iPhone', sig: sign(fromHex(f.secret, 32)!, pairMessage(f.pairing, 'iPhone')) })
    })
    expect(res.status).toBe(200)
    await expect.poll(() => pushed.at(-1)?.devices.length).toBe(1)
    const last = pushed.at(-1)!
    expect(last.pairing).toBeNull()
    expect(last.devices[0]).toMatchObject({ name: 'iPhone', kind: 'phone', scopes: ['view'] })
  })
})
