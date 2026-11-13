// Deleting a video from the Reel or Working screen (shared/delete-video.ts, renderer screens/remove.ts).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { deleteThenLeave } from '../src/shared/delete-video'

describe('deleting a video', () => {
  it('goes home once the video is gone', async () => {
    const leave = vi.fn()
    const refused = vi.fn()
    expect(await deleteThenLeave(async () => undefined, leave, refused)).toBe(true)
    expect(leave).toHaveBeenCalledOnce()
    expect(refused).not.toHaveBeenCalled()
  })

  it('fails if a refused delete leaves the screen, which clears the message saying why', async () => {
    const still = { code: 'BUSY', userMessage: 'Still stopping a background job on this video. Try again in a moment.' }
    const leave = vi.fn()
    const refused = vi.fn()
    expect(await deleteThenLeave(async () => { throw still }, leave, refused)).toBe(false)
    expect(refused).toHaveBeenCalledWith(still)
    expect(leave).not.toHaveBeenCalled()
  })

  it('fails if a screen deletes a video without it', () => {
    for (const screen of ['Reel.tsx', 'Working.tsx']) {
      const src = readFileSync(join(__dirname, '../src/renderer/src/screens', screen), 'utf8')
      expect(src).toContain('removeVideo(slug, go, notify)')
      expect(src).not.toMatch(/projects\.remove\(/)
    }
  })
})
