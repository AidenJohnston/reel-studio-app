import { describe, expect, it } from 'vitest'
import { applicationsDestination, moveReason, offerMoveToApplications, type MoveContext, type MoveDeps, type Question } from '../src/main/move-to-applications'

const fromDisk: MoveContext = {
  platform: 'darwin', isPackaged: true, test: false, inApplications: false,
  exePath: '/Volumes/Reel Studio Installer/Reel Studio.app/Contents/MacOS/Reel Studio',
  writeError: () => 'EROFS'
}
const translocated = '/private/var/folders/test/AppTranslocation/id/d/Reel Studio.app/Contents/MacOS/Reel Studio'

describe('moveReason', () => {
  it.each<[string | null, 'installer-disk' | null]>([
    ['EROFS', 'installer-disk'], [null, null], ['EACCES', null]
  ])('fails if disk detection confuses %s with a read-only installer', (code, expected) => {
    expect(moveReason({ ...fromDisk, writeError: () => code })).toBe(expected)
  })

  it('fails if a translocated app on a writable volume is missed', () => {
    expect(moveReason({ ...fromDisk, exePath: translocated, writeError: () => null })).toBe('temporary-copy')
  })

  it.each<Partial<MoveContext>>([
    { isPackaged: false }, { test: true }, { platform: 'win32' }, { inApplications: true },
    { exePath: '/Users/test/Downloads/Reel Studio.app/Contents/MacOS/Reel Studio' }
  ])('fails if an intentional location or automated run gets a move prompt: %j', (change) => {
    expect(moveReason({ ...fromDisk, ...change })).toBe(null)
  })
})

describe('offerMoveToApplications', () => {
  it('fails if a translocated copy is described as an installer disk', async () => {
    const deps: MoveDeps = {
      destinationExists: () => false,
      ask: async (question) => {
        expect(question.detail).toContain('temporary copy')
        return 1
      },
      askNow: () => 0, move: () => true, log: () => {}
    }
    expect(await offerMoveToApplications({ ...fromDisk, exePath: translocated }, deps)).toBe('declined')
  })

  it('fails if declining the move still copies the app', async () => {
    const deps: MoveDeps = {
      destinationExists: () => false,
      ask: async () => 1, askNow: () => { throw new Error('unexpected replacement prompt') },
      move: () => { throw new Error('copied after declining') }, log: () => {}
    }
    expect(await offerMoveToApplications(fromDisk, deps)).toBe('declined')
  })

  it.each<[number, boolean]>([[0, true], [1, false]])('fails if a move starts without replacement consent %s', async (answer, allowed) => {
    let moved = false
    const deps: MoveDeps = {
      destinationExists: () => true,
      ask: async (question) => question.message.startsWith('Replace') ? answer : 0,
      askNow: () => { throw new Error('the privileged mover never calls conflictHandler') },
      move: () => { moved = true; return true },
      log: () => {}
    }
    expect(await offerMoveToApplications(fromDisk, deps)).toBe(allowed ? 'moving' : 'declined')
    expect(moved).toBe(allowed)
  })

  it('fails if the replace check looks for a different app name than the running bundle', async () => {
    const checked: string[] = []
    const deps: MoveDeps = {
      destinationExists: (path) => { checked.push(path); return false },
      ask: async () => 0, askNow: () => 0, move: () => true, log: () => {}
    }
    const renamed = '/Volumes/Reel Studio Installer/Reel Studio Beta.app/Contents/MacOS/Reel Studio Beta'
    await offerMoveToApplications({ ...fromDisk, exePath: renamed }, deps)
    expect(checked).toEqual(['/Applications/Reel Studio Beta.app'])
  })

  it('fails if the replace check has no destination when the path holds no bundle', () => {
    expect(applicationsDestination('/private/var/folders/test/AppTranslocation/id/d/reel-studio')).toBe(
      '/Applications/Reel Studio.app'
    )
  })

  it('fails if a copy failure leaves the user without recovery instructions', async () => {
    const questions: Question[] = []
    const deps: MoveDeps = {
      destinationExists: () => false,
      ask: async (question) => { questions.push(question); return 0 }, askNow: () => 0,
      move: () => { throw new Error('disk full') }, log: () => {}
    }
    expect(await offerMoveToApplications(fromDisk, deps)).toBe('failed')
    expect(questions.at(-1)?.detail).toContain('into Applications in Finder')
  })
})
