// "Move Reel Studio to Applications?": who is asked, and what each answer does (main/move-to-applications.ts).
import { describe, expect, it } from 'vitest'
import {
  MOVE_FAILED,
  MOVE_QUESTION,
  REPLACE_QUESTION,
  offerMoveToApplications,
  shouldOfferMove,
  type MoveContext,
  type MoveDeps,
  type Question
} from '../src/main/move-to-applications'

const FROM_DMG: MoveContext = {
  platform: 'darwin',
  isPackaged: true,
  test: false,
  inApplications: false,
  exePath: '/Volumes/Reel Studio 0.1.3 Installer/Reel Studio.app/Contents/MacOS/Reel Studio'
}

describe('shouldOfferMove', () => {
  it('asks a packaged Mac app running from a mounted disk', () => {
    expect(shouldOfferMove(FROM_DMG)).toBe(true)
    expect(shouldOfferMove({ ...FROM_DMG, exePath: '/Volumes/Reel Studio/Reel Studio.app/Contents/MacOS/Reel Studio' })).toBe(true)
  })

  it.each<[string, Partial<MoveContext>]>([
    ['already in Applications', { inApplications: true, exePath: '/Applications/Reel Studio.app/Contents/MacOS/Reel Studio' }],
    ['in ~/Applications', { inApplications: true, exePath: '/Users/sam/Applications/Reel Studio.app/Contents/MacOS/Reel Studio' }],
    ['unzipped in Downloads', { exePath: '/Users/sam/Downloads/Reel Studio.app/Contents/MacOS/Reel Studio' }],
    ['a test folder', { exePath: '/Users/sam/reel-studio-build/Applications-test/Reel Studio.app/Contents/MacOS/Reel Studio' }],
    ['a folder merely named Volumes', { exePath: '/Users/sam/Volumes/Reel Studio.app/Contents/MacOS/Reel Studio' }],
    ['dev (not packaged)', { isPackaged: false }],
    ['an automated test run', { test: true }],
    ['Windows', { platform: 'win32', exePath: 'C:\\Users\\sam\\AppData\\Local\\Programs\\reel-studio\\Reel Studio.exe' }],
    ['Linux, even under /Volumes', { platform: 'linux' }]
  ])('never asks when %s', (_why, change) => {
    expect(shouldOfferMove({ ...FROM_DMG, ...change })).toBe(false)
  })
})

/** Fake dialogs and mover. `answers` are the buttons pressed, in order; `conflict` is what moving runs into. */
function world(answers: number[], mover: { result?: boolean; conflict?: 'exists' | 'existsAndRunning'; error?: Error } = {}) {
  const asked: Question[] = []
  const log: string[] = []
  let moved = 0
  let conflictAnswer: boolean | null = null
  const answer = (q: Question): number => {
    asked.push(q)
    const a = answers.shift()
    if (a === undefined) throw new Error(`unexpected question: ${q.message}`)
    return a
  }
  const deps: MoveDeps = {
    ask: async (q) => answer(q),
    askNow: answer,
    move: ({ conflictHandler }) => {
      moved++
      if (mover.error) throw mover.error
      if (mover.conflict) {
        conflictAnswer = conflictHandler(mover.conflict)
        if (!conflictAnswer) return false
      }
      return mover.result ?? true
    },
    log: (l) => log.push(l)
  }
  return { deps, asked, log, moves: () => moved, conflictAnswer: () => conflictAnswer }
}

describe('offerMoveToApplications', () => {
  it('does nothing outside a mounted disk', async () => {
    const w = world([])
    expect(await offerMoveToApplications({ ...FROM_DMG, inApplications: true }, w.deps)).toBe('not-offered')
    expect(w.asked).toEqual([])
    expect(w.moves()).toBe(0)
  })

  it('moves on Move', async () => {
    const w = world([0])
    expect(await offerMoveToApplications(FROM_DMG, w.deps)).toBe('moving')
    expect(w.asked).toEqual([MOVE_QUESTION])
    expect(w.moves()).toBe(1)
  })

  it('keeps running from the disk on Not now', async () => {
    const w = world([1])
    expect(await offerMoveToApplications(FROM_DMG, w.deps)).toBe('declined')
    expect(w.moves()).toBe(0)
  })

  it('asks before replacing an older copy in Applications, and replaces it on Replace', async () => {
    const w = world([0, 0], { conflict: 'exists' })
    expect(await offerMoveToApplications(FROM_DMG, w.deps)).toBe('moving')
    expect(w.asked).toEqual([MOVE_QUESTION, REPLACE_QUESTION])
    expect(w.conflictAnswer()).toBe(true)
  })

  it('leaves the copy in Applications alone on Not now', async () => {
    const w = world([0, 1], { conflict: 'exists' })
    expect(await offerMoveToApplications(FROM_DMG, w.deps)).toBe('cancelled')
    expect(w.conflictAnswer()).toBe(false)
  })

  it('switches to the copy in Applications when it is already open, without another question', async () => {
    const w = world([0], { conflict: 'existsAndRunning' })
    expect(await offerMoveToApplications(FROM_DMG, w.deps)).toBe('moving')
    expect(w.asked).toEqual([MOVE_QUESTION])
    expect(w.conflictAnswer()).toBe(true)
  })

  it('reports a cancelled password prompt as cancelled', async () => {
    const w = world([0], { result: false })
    expect(await offerMoveToApplications(FROM_DMG, w.deps)).toBe('cancelled')
  })

  it('says what to do when the copy fails, and logs why', async () => {
    const w = world([0, 0], { error: new Error('Failed to copy: disk full') })
    expect(await offerMoveToApplications(FROM_DMG, w.deps)).toBe('failed')
    expect(w.asked).toEqual([MOVE_QUESTION, MOVE_FAILED])
    expect(w.log.join('\n')).toContain('disk full')
  })

  it('uses plain words and no em dashes', () => {
    for (const q of [MOVE_QUESTION, REPLACE_QUESTION, MOVE_FAILED]) {
      expect([q.message, q.detail, ...q.buttons].join(' ')).not.toMatch(/[—–]/)
    }
  })
})
