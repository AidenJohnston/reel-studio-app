import { describe, expect, it } from 'vitest'
import { installedRuntime } from '../e2e/runtime'

describe('installedRuntime', () => {
  it('finds the Windows install layout next to the exe', () => {
    expect(installedRuntime('C:\\Users\\Zoë\\AppData\\Local\\Programs\\Reel Studio\\Reel Studio.exe', 'win32')).toEqual({
      resources: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\Reel Studio\\resources',
      python: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\Reel Studio\\resources\\python\\python.exe',
      ffmpeg: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\Reel Studio\\resources\\ffmpeg\\ffmpeg.exe',
      ffprobe: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\Reel Studio\\resources\\ffmpeg\\ffprobe.exe',
      engine: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\Reel Studio\\resources\\engine',
      fonts: 'C:\\Users\\Zoë\\AppData\\Local\\Programs\\Reel Studio\\resources\\fonts'
    })
  })

  it('finds the macOS bundle layout from Contents/MacOS', () => {
    expect(installedRuntime('/tmp/apps test/Reel Studio.app/Contents/MacOS/Reel Studio', 'darwin')).toEqual({
      resources: '/tmp/apps test/Reel Studio.app/Contents/Resources',
      python: '/tmp/apps test/Reel Studio.app/Contents/Resources/python/bin/python3',
      ffmpeg: '/tmp/apps test/Reel Studio.app/Contents/Resources/ffmpeg/ffmpeg',
      ffprobe: '/tmp/apps test/Reel Studio.app/Contents/Resources/ffmpeg/ffprobe',
      engine: '/tmp/apps test/Reel Studio.app/Contents/Resources/engine',
      fonts: '/tmp/apps test/Reel Studio.app/Contents/Resources/fonts'
    })
  })

  it('refuses a macOS path that is not inside a bundle', () => {
    expect(() => installedRuntime('/tmp/Reel Studio.app', 'darwin')).toThrow(/Contents\/MacOS/)
  })
})
