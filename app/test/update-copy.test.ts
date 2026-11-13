import { expect, it } from 'vitest'
import { initialUpdateState, type UpdateMode, type UpdateState } from '../src/shared/update'
import { noteBlocks, noteDay, updateButtonLabel, updateIcon, updateSubline, updateSummary } from '../src/renderer/src/components/update-copy'

const offered = (mode: UpdateMode, patch: Partial<UpdateState> = {}): UpdateState => ({
  ...initialUpdateState('0.1.2', mode, true, null),
  status: 'available',
  availableVersion: '0.1.3',
  ...patch
})

it('fails if page mode promises a download, or install mode stops offering one', () => {
  const rejected = offered('page', {
    status: 'error',
    errorContext: 'download',
    message: 'The downloaded update did not pass its check, so it was not installed. Get Reel Studio 0.1.3 from its download page instead.'
  })
  for (const s of [offered('page'), rejected]) {
    expect(updateButtonLabel(s)).toBe('Open download page')
    expect(updateIcon(s)).toBe('available')
    for (const line of [updateSummary(s), updateSubline(s)]) {
      expect(line).toContain('download page')
      expect(line).not.toMatch(/Download update|try again/i)
    }
  }
  expect(updateButtonLabel(offered('install'))).toBe('Download update')
  expect(updateSummary(offered('install'))).toBe('Reel Studio 0.1.3 is ready to download.')
})

it("fails if a release note's bullets show as one paragraph, keep their markdown, or its date shifts a day", () => {
  const text = "## What's new\n\n- **Updates install themselves.** Say yes.\n* Captions you can drag\n\nThanks for the reports.\n- One more"
  expect(noteBlocks(text)).toEqual([
    { kind: 'p', text: "What's new" },
    { kind: 'list', items: ['Updates install themselves. Say yes.', 'Captions you can drag'] },
    { kind: 'p', text: 'Thanks for the reports.' },
    { kind: 'list', items: ['One more'] }
  ])
  // A calendar day, whatever the time zone: read as midnight UTC it would show November 3 west of UTC.
  const tz = process.env.TZ
  process.env.TZ = 'America/Chicago'
  try {
    expect(noteDay('2026-11-04')).toBe(new Date(2026, 10, 4).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))
    expect(noteDay('2026-11-04')).not.toBe(new Date(2026, 10, 3).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }))
  } finally {
    if (tz === undefined) delete process.env.TZ
    else process.env.TZ = tz
  }
  expect(noteDay('soon')).toBeNull()
})
