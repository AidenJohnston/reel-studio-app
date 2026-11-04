// EngineHost.renderAnimation: renders an HTML animation template into a transparent video layer.
//
// One path for everything: templates/animations/render.mjs (owned by the animations templates) does
// the template contract (meta.json params, __setup/__seek), the frame loop and the encode
// (QuickTime Animation .mov, qtrle/argb, 1080x1920, plus a `.anim.json` sidecar the engine reads).
// This file only supplies Electron: an offscreen, transparent BrowserWindow via render.mjs's
// createElectronAdapter, reused across renders, and the bundled ffmpeg.
import { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ffmpegPath, templatesDir, testAnimationDir } from './paths'

interface Adapter {
  close(): Promise<void>
}
interface RenderModule {
  renderAnimation(opts: Record<string, unknown>): Promise<{ path: string; duration: number; frames: number }>
  createElectronAdapter(bw: typeof BrowserWindow): Adapter
}

/** The test template ships with the app (resources/test-animation/animations/self-test). */
export const TEST_TEMPLATE = 'self-test'

let modPromise: Promise<RenderModule> | null = null
function renderModule(): Promise<RenderModule> {
  const file = join(templatesDir(), 'animations', 'render.mjs')
  if (!existsSync(file)) {
    return Promise.reject({
      code: 'TEMPLATE_MISSING',
      userMessage: 'The animation styles are missing. Try reinstalling Reel Studio.',
      message: file
    })
  }
  modPromise ??= import(/* @vite-ignore */ pathToFileURL(file).href) as Promise<RenderModule>
  return modPromise
}

// One offscreen window, reused (creating one costs ~1 s), one render at a time.
let adapter: Adapter | null = null
let queue: Promise<unknown> = Promise.resolve()

export function renderAnimation(template: string, params: Record<string, unknown>, outPath: string, fps = 30): Promise<string> {
  const run = async (): Promise<string> => {
    const mod = await renderModule()
    adapter ??= mod.createElectronAdapter(BrowserWindow)
    try {
      const r = await mod.renderAnimation({
        template,
        params,
        outPath,
        fps,
        adapter,
        ffmpeg: ffmpegPath(),
        templatesRoot: template === TEST_TEMPLATE ? testAnimationDir() : templatesDir()
      })
      return r.path
    } catch (e) {
      // After a timeout or crash the window may be stuck: start fresh next time.
      await adapter?.close().catch(() => {})
      adapter = null
      throw e
    }
  }
  const p = queue.then(run, run)
  queue = p.catch(() => {})
  return p
}

export async function closeAnimationRenderer(): Promise<void> {
  await adapter?.close().catch(() => {})
  adapter = null
}
