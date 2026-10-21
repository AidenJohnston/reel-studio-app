import { expect, it } from 'vitest'
import { installedRuntime } from '../e2e/runtime'

it.each<['darwin' | 'win32', string, string, string]>([
  ['darwin', '/tmp/apps test/Reel Studio.app/Contents/MacOS/Reel Studio',
    '/tmp/apps test/Reel Studio.app/Contents/Resources/python/bin/python3',
    '/tmp/apps test/Reel Studio.app/Contents/Resources/ffmpeg/ffmpeg'],
  ['win32', 'C:\\Apps test\\Reel Studio\\Reel Studio.exe',
    'C:\\Apps test\\Reel Studio\\resources\\python\\python.exe',
    'C:\\Apps test\\Reel Studio\\resources\\ffmpeg\\ffmpeg.exe']
])('fails if the %s installed runtime uses the wrong bundled executables', (platform, exe, python, ffmpeg) => {
  expect(installedRuntime(exe, platform)).toMatchObject({ python, ffmpeg })
})

it('fails if a macOS path outside Contents/MacOS is accepted', () => {
  expect(() => installedRuntime('/tmp/Reel Studio.app', 'darwin')).toThrow(/Contents\/MacOS/)
})
