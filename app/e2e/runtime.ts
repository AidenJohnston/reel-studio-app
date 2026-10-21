// Where an installed Reel Studio keeps its bundled runtime (packaging/README.md, "What the installed app looks
// like"), worked out from the path of its executable. No Playwright import, so unit tests can check it.
import { posix, win32 } from 'node:path'

export interface InstalledRuntime {
  resources: string
  python: string
  ffmpeg: string
  ffprobe: string
  engine: string
  fonts: string
}

export function installedRuntime(exe: string, platform: NodeJS.Platform = process.platform): InstalledRuntime {
  const p = platform === 'win32' ? win32 : posix
  let resources: string
  if (platform === 'darwin') {
    // <Name>.app/Contents/MacOS/<Name>  ->  <Name>.app/Contents/Resources
    const macos = p.dirname(exe)
    if (p.basename(macos) !== 'MacOS' || p.basename(p.dirname(macos)) !== 'Contents') {
      throw new Error(`expected the executable inside <Name>.app/Contents/MacOS, got ${exe}`)
    }
    resources = p.join(p.dirname(macos), 'Resources')
  } else {
    resources = p.join(p.dirname(exe), 'resources')
  }
  const ext = platform === 'win32' ? '.exe' : ''
  return {
    resources,
    python: platform === 'win32' ? p.join(resources, 'python', 'python.exe') : p.join(resources, 'python', 'bin', 'python3'),
    ffmpeg: p.join(resources, 'ffmpeg', `ffmpeg${ext}`),
    ffprobe: p.join(resources, 'ffmpeg', `ffprobe${ext}`),
    engine: p.join(resources, 'engine'),
    fonts: p.join(resources, 'fonts')
  }
}
