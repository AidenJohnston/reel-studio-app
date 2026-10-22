// Which files the reel-media: protocol serves and drag-out hands to the OS (main/inside-folder.ts).
import { describe, expect, it } from 'vitest'
import { isInsideFolder } from '../src/main/inside-folder'

describe('isInsideFolder', () => {
  const root = 'C:\\Users\\Zoë\\Documents\\Reel Studio'

  it('on Windows, accepts the same folder in any letter case or slash style, as NTFS does', () => {
    expect(isInsideFolder('c:\\users\\zoë\\documents\\reel studio\\Projects\\a\\export.mp4', root, 'win32')).toBe(true)
    expect(isInsideFolder('C:/Users/Zoë/Documents/Reel Studio/Projects/a/export.mp4', root, 'win32')).toBe(true)
    expect(isInsideFolder('C:\\USERS\\ZOË\\DOCUMENTS\\REEL STUDIO', root, 'win32')).toBe(true)
  })

  it('on Windows, still refuses a sibling with the same prefix and a path that climbs out', () => {
    expect(isInsideFolder('C:\\Users\\Zoë\\Documents\\Reel StudioEvil\\a.mp4', root, 'win32')).toBe(false)
    expect(isInsideFolder('c:\\users\\zoë\\documents\\reel studio evil\\a.mp4', root, 'win32')).toBe(false)
    expect(isInsideFolder('C:\\Users\\Zoë\\Documents\\Reel Studio\\..\\secret.txt', root, 'win32')).toBe(false)
    expect(isInsideFolder('D:\\Users\\Zoë\\Documents\\Reel Studio\\a.mp4', root, 'win32')).toBe(false)
  })

  it('elsewhere, letter case still counts', () => {
    expect(isInsideFolder('/Users/zoe/Reel Studio/a.mp4', '/Users/zoe/Reel Studio', 'darwin')).toBe(true)
    expect(isInsideFolder('/users/zoe/reel studio/a.mp4', '/Users/zoe/Reel Studio', 'linux')).toBe(false)
    expect(isInsideFolder('/Users/zoe/Reel Studio/../x', '/Users/zoe/Reel Studio', 'linux')).toBe(false)
  })
})
