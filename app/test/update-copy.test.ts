import { expect, it } from 'vitest'
import { initialUpdateState, type UpdateMode, type UpdateState } from '../src/shared/update'
import { aboutButton, updateButtonLabel, updateIcon, updateSubline, updateSummary } from '../src/renderer/src/components/update-copy'

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
    expect(aboutButton(s)).toBe('Open download page')
    expect(updateIcon(s)).toBe('available')
    for (const line of [updateSummary(s), updateSubline(s)]) {
      expect(line).toContain('download page')
      expect(line).not.toMatch(/Download update|try again/i)
    }
  }
  expect(updateButtonLabel(offered('install'))).toBe('Download update')
  expect(aboutButton(offered('install'))).toBe('Download')
  expect(updateSummary(offered('install'))).toBe('Reel Studio 0.1.3 is ready to download.')
})
