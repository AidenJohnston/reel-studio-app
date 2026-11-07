// TikTok API v2: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post/
import { fail } from './tiktok-http'
import { TikTokService, tiktokSettings } from './tiktok'
import type { TikTokSettings } from '../shared/tiktok'

type Handle = (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void
export function registerTikTokIpc(d: {
  handle: Handle; service: TikTokService; dev: boolean; saveSettings: (settings: TikTokSettings) => Promise<unknown>
}): void {
  d.handle('tiktok:configure', async (_event, value) => {
    if (!d.dev) return fail('TT_DISABLED', 'Your own TikTok app can be set only in developer mode.')
    const settings = tiktokSettings(value)
    await d.service.disconnect(); await d.saveSettings(settings)
  })
  d.handle('tiktok:session', () => d.service.session())
  d.handle('tiktok:connect', () => d.service.connect())
  d.handle('tiktok:cancelConnect', () => d.service.cancelConnect())
  d.handle('tiktok:disconnect', () => d.service.disconnect())
  d.handle('tiktok:creator', () => d.service.creator())
  d.handle('tiktok:publish', (_event, input) => d.service.publish(input))
  d.handle('tiktok:insights', (_event, slug, version, postId) => {
    if (typeof slug !== 'string' || typeof version !== 'number' || typeof postId !== 'string')
      return fail('TT_INPUT', 'Choose a project version and TikTok video.')
    return d.service.insights(slug, version, postId)
  })
}
