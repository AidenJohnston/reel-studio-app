import { describe, expect, it } from 'vitest'
import { coverMoments, coverReason } from '../src/shared/cover'
import { createCoverScans } from '../src/main/cover-scan'
import type { RunEngine } from '../src/main/engine'

describe('cover suggestions', () => {
  it('says the first two signals the engine found the frame standing out on, else that it won overall', () => {
    expect(coverReason(['eyesOpen', 'sharp', 'still'])).toBe('Eyes open, face in focus')
    expect(coverReason(['betweenWords'])).toBe('Between words')
    expect(coverReason([])).toBe('Clearest face nearby')
  })

  it('spreads moments over the kept words of one source, never closer than the engine search windows', () => {
    const words = Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, w: 'x', s: i * 0.5, e: i * 0.5 + 0.4, source: 's1' }))
    const kept = new Set(words.filter((w) => w.s < 2 || w.s >= 6).map((w) => w.id))
    words.push({ id: 'b0', w: 'y', s: 3, e: 3.4, source: 's2' })
    kept.add('b0')
    expect(coverMoments(words, kept, 's1')).toEqual([0.5, 6.5, 8.5, 10, 12, 14])
    // fewer words than moments: every word, minus the ones too close to the last
    expect(coverMoments(words.slice(0, 4), kept, 's1')).toEqual([0, 1.5])
  })
})

describe('cover scans', () => {
  const settle = () => new Promise((r) => setTimeout(r, 5))

  it('runs one per project, and stopping waits for the engine to exit', async () => {
    const calls: { signal: AbortSignal; exit: () => void }[] = []
    const runEngine: RunEngine = (_cmd, _args, _progress, signal, exit) => {
      calls.push({ signal: signal!, exit: exit! })
      return new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject({ code: 'CANCELLED' })))
    }
    const scans = createCoverScans(runEngine)

    void scans.scan('a', ['--at', '1']).catch(() => undefined)
    void scans.scan('a', ['--at', '2']).catch(() => undefined)
    await settle()
    expect(calls).toHaveLength(1)

    let stopped = false
    const stopping = scans.stop('a').then(() => (stopped = true))
    await settle()
    expect(calls[0].signal.aborted).toBe(true)
    expect(stopped).toBe(false) // the process has not exited yet
    calls[0].exit()
    await stopping

    void scans.scan('a', ['--at', '3']).catch(() => undefined)
    await settle()
    expect(calls).toHaveLength(2)
  })
})
