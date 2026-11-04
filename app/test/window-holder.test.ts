import { describe, expect, it } from 'vitest'
import { createWindowHolder, type ClosableWindow } from '../src/main/window-holder'

class FakeWindow implements ClosableWindow {
  destroyed = false
  private closed: (() => void) | null = null

  isDestroyed(): boolean { return this.destroyed }
  once(_event: 'closed', listener: () => void): void { this.closed = listener }
  close(): void { this.destroyed = true; this.closed?.() }
}

describe('window holder', () => {
  it('clears only the window that is still current and recreates after close', () => {
    const holder = createWindowHolder<FakeWindow>()
    const first = holder.track(new FakeWindow())
    const second = holder.track(new FakeWindow())

    first.close()
    expect(holder.getLive()).toBe(second)

    second.close()
    expect(holder.getLive()).toBeNull()
    const recreated = holder.getLive() ?? holder.track(new FakeWindow())
    expect(recreated).not.toBe(second)
    expect(holder.getLive()).toBe(recreated)
  })

  it('does not return a destroyed window', () => {
    const holder = createWindowHolder<FakeWindow>()
    const first = holder.track(new FakeWindow())
    first.destroyed = true
    const recreated = holder.getLive() ?? holder.track(new FakeWindow())
    expect(recreated).not.toBe(first)
  })
})
