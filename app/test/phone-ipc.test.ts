// "Send to my phone" (main/phone-ipc.ts): one link at a time, however the starts and stops overlap.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

import type { ReelPlan } from '../src/shared/api'
import { registerPhoneIpc, stopPhoneShare } from '../src/main/phone-ipc'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, ShareMenu: class {}, shell: {} }))

const root = mkdtempSync(join(tmpdir(), 'rs-phone-ipc-'))
const video = join(root, 'Family time.mp4')
writeFileSync(video, Buffer.alloc(10_000))
process.env.REELSTUDIO_PHONE_HOST = '127.0.0.1'

let planRead: Promise<{ title: string; plan: ReelPlan }> = Promise.reject(new Error('no plan'))
planRead.catch(() => {})
type Fn = (e: unknown, ...a: unknown[]) => unknown
const handlers = new Map<string, Fn>()
registerPhoneIpc({
  handle: (c, fn) => handlers.set(c, fn as Fn),
  roots: () => [root],
  plan: () => planRead,
  send: () => {},
  log: () => {},
  test: true
})
const call = (c: string, ...a: unknown[]): Promise<{ url: string }> => Promise.resolve(handlers.get(c)!({}, ...a)) as Promise<{ url: string }>
afterAll(() => stopPhoneShare())

const answers = (url: string): Promise<boolean> => fetch(url).then(() => true, () => false)

it('fails if two quick "Make a new code" clicks leave the first new link open after Stop', async () => {
  const [a, b] = await Promise.all([call('phone:start', video, ''), call('phone:start', video, '')])
  await call('phone:stop')
  expect(await answers(a.url)).toBe(false)
  expect(await answers(b.url)).toBe(false)
})

it("fails if Stop, sent while a plan link is still reading the reel's plan, leaves that link open", async () => {
  let release!: (v: { title: string; plan: ReelPlan }) => void
  planRead = new Promise((r) => (release = r))
  const started = call('phone:startPlan', 'family-time')
  const stopped = call('phone:stop')
  release({ title: 'Family time', plan: { topic: 'Bread', hooks: ['You can bake this'], hook: 0, beats: [], shots: [] } })
  const { url } = await started
  await stopped
  expect(await answers(url)).toBe(false)
})
