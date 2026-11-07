// "Send to my phone" (main/phone-ipc.ts): one link at a time, however the starts and stops overlap.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'

import { registerPhoneIpc, stopPhoneShare } from '../src/main/phone-ipc'

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, ShareMenu: class {}, shell: {} }))

const root = mkdtempSync(join(tmpdir(), 'rs-phone-ipc-'))
const video = join(root, 'Family time.mp4')
writeFileSync(video, Buffer.alloc(10_000))
process.env.REELSTUDIO_PHONE_HOST = '127.0.0.1'

type Fn = (e: unknown, ...a: unknown[]) => unknown
const handlers = new Map<string, Fn>()
registerPhoneIpc({
  handle: (c, fn) => handlers.set(c, fn as Fn),
  roots: () => [root],
  plan: async () => {
    throw new Error('no plan')
  },
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
