import { describe, expect, it } from 'vitest'
import { failingRows, scoreLine, scoreRows, type EditScore } from '../src/shared/edit-score'

const score = (checks: EditScore['checks']): EditScore => ({ version: 2, checks, passed: checks.filter((c) => c.ok).length, measured: checks.length })

describe("a version's edit checks", () => {
  it('fails if a failing check is not listed first, or a check from a newer engine breaks the list', () => {
    const s = score([
      { id: 'videoFile', ok: true, count: 0, failed: [] },
      { id: 'loudness', ok: false, lufs: -19.64, target: -14 },
      { id: 'futureCheck' as never, ok: false }
    ])
    expect(scoreRows(s).map((r) => [r.label, r.after])).toEqual([
      ['Loudness', '−19.6 LUFS, off target'],
      ['Video file', 'Plays as expected']
    ])
    expect(scoreLine(s)).toBe('1 of 2 checks pass')
    // Insights lists only what to fix
    expect(failingRows(s).map((r) => r.label)).toEqual(['Loudness'])
  })

  it('fails if a version with nothing measured claims its checks pass', () => {
    expect(scoreLine(score([]))).toBe('Nothing to check on this version.')
    expect(scoreLine(score([{ id: 'deadAir', ok: true, count: 0, allowed: 0.4, longest: 0.2 }]))).toBe('The one check passes')
  })
})
