import { describe, expect, it } from 'vitest'
import { isMacVolumePath, logDuration } from '../src/main/diagnostics'

describe('isMacVolumePath', () => {
  it.each([
    ['/Volumes/Reel Studio/Reel Studio.app/Contents/MacOS/Reel Studio', 'darwin', true],
    ['/Volumes/External Drive/Reel Studio.app/Contents/MacOS/Reel Studio', 'darwin', true],
    ['/Applications/Reel Studio.app/Contents/MacOS/Reel Studio', 'darwin', false],
    ['/Volumes-backup/Reel Studio', 'darwin', false],
    ['/Volumes/../Applications/Reel Studio', 'darwin', false],
    ['/Volumes/Reel Studio', 'linux', false],
    ['C:\\Program Files\\Reel Studio.exe', 'win32', false]
  ] satisfies [string, NodeJS.Platform, boolean][])('checks %s on %s', (execPath, platform, expected) => {
    expect(isMacVolumePath(execPath, platform)).toBe(expected)
  })
})

describe('logDuration', () => {
  it('logs the request before starting and completion after returning the result', async () => {
    const logs: string[] = []
    const result = await logDuration('[dialog] Pick a song', (line) => logs.push(line), async () => {
      expect(logs).toEqual(['[dialog] Pick a song started'])
      return { canceled: true, filePaths: [] }
    })
    expect(result).toEqual({ canceled: true, filePaths: [] })
    expect(logs[1]).toMatch(/^\[dialog\] Pick a song completed durationMs=\d+$/)
  })

  it('logs failures without exposing the error or changing the rejection', async () => {
    const logs: string[] = []
    const error = new Error('/private/path/song.mp3')
    await expect(logDuration('[library] classify fileCount=1', (line) => logs.push(line), async () => {
      throw error
    })).rejects.toBe(error)
    expect(logs).toHaveLength(2)
    expect(logs[1]).toMatch(/^\[library\] classify fileCount=1 failed durationMs=\d+$/)
    expect(logs.join('\n')).not.toContain(error.message)
  })
})
