// "Send to my phone" help on networks that block it (school, work, hotel Wi-Fi): the wait timer, the
// order of the other ways per platform, and the copy. The panel itself has no DOM harness here, so the
// last block checks that SendToPhone.tsx actually uses these (a helper with no caller proves nothing).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fallbackOrder, PHONE_HELP, PHONE_WAIT_MS, waitForPhone } from '../src/shared/phone-help'

describe('waitForPhone', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('waits about 20 seconds', () => {
    expect(PHONE_WAIT_MS).toBe(20_000)
  })

  it('fires once, only after the wait', () => {
    const hint = vi.fn()
    waitForPhone(PHONE_WAIT_MS, hint)
    vi.advanceTimersByTime(PHONE_WAIT_MS - 1)
    expect(hint).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hint).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10 * PHONE_WAIT_MS)
    expect(hint).toHaveBeenCalledTimes(1)
  })

  it('never fires when cancelled first (page opened, link stopped, new code, panel closed)', () => {
    const hint = vi.fn()
    const cancel = waitForPhone(PHONE_WAIT_MS, hint)
    vi.advanceTimersByTime(PHONE_WAIT_MS / 2)
    cancel()
    vi.advanceTimersByTime(10 * PHONE_WAIT_MS)
    expect(hint).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancelling twice, or after it fired, is harmless', () => {
    const hint = vi.fn()
    const cancel = waitForPhone(1000, hint)
    vi.advanceTimersByTime(1000)
    cancel()
    cancel()
    expect(hint).toHaveBeenCalledTimes(1)
  })

  it('a new code restarts the wait from zero', () => {
    const hint = vi.fn()
    const first = waitForPhone(PHONE_WAIT_MS, hint)
    vi.advanceTimersByTime(PHONE_WAIT_MS - 1000)
    first() // "Make a new code" / another network: the old timer goes with the old link
    waitForPhone(PHONE_WAIT_MS, hint)
    vi.advanceTimersByTime(PHONE_WAIT_MS - 1)
    expect(hint).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(hint).toHaveBeenCalledTimes(1)
  })
})

describe('fallbackOrder', () => {
  it('Mac: AirDrop first', () => {
    expect(fallbackOrder(true)).toEqual(['airdrop', 'cloud', 'email', 'cable'])
  })
  it('Windows: a drive first, then email, and no AirDrop', () => {
    expect(fallbackOrder(false)).toEqual(['cloud', 'email', 'cable'])
  })
})

describe('copy', () => {
  const all = Object.values(PHONE_HELP).join(' ')
  it('says it in plain words', () => {
    expect(PHONE_HELP.title).toBe('Not opening on your phone?')
    expect(PHONE_HELP.why).toBe('School, work and hotel Wi-Fi often block this. Use one of these instead:')
  })
  it('no jargon, no em dashes', () => {
    expect(all).not.toMatch(/isolation|client|LAN|firewall|network/i)
    expect(all).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('SendToPhone.tsx uses it', () => {
  const src = readFileSync(join(__dirname, '../src/renderer/src/components/SendToPhone.tsx'), 'utf8')
  it('the timer, cancelled by the effect cleanup', () => {
    expect(src).toMatch(/return waitForPhone\(share\.waitMs,/)
    expect(src).toMatch(/if \(!share \|\| sent \|\| stopped\) return/)
  })
  it('the order and the copy', () => {
    expect(src).toContain('fallbackOrder(IS_MAC).map(')
    expect(src).toContain('{PHONE_HELP.why}')
    expect(src).not.toMatch(/drive below/) // a drive can now be above email
  })
  it('the "Phone can\'t open it?" link still opens the other ways without waiting', () => {
    expect(src).toMatch(/onClick=\{\(\) => setHelp\(true\)\} data-testid="phone-cant"/)
  })
})
