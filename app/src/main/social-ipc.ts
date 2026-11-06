// social:status for Settings › Posting and Share: for Instagram and TikTok, whether each can be connected now
// (main/signin-config.ts) and the account connected, if any. Never a token.
import type { InstagramSession } from '../shared/instagram'
import type { SocialStatus } from '../shared/social'
import type { TikTokSession } from '../shared/tiktok'
import { availability, type SigninDirectory } from './signin-config'

type Handle = (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void

export function registerSocialIpc(d: {
  handle: Handle
  directory: SigninDirectory
  instagram: { session(): Promise<InstagramSession> }
  tiktok: { session(): Promise<TikTokSession> }
  /** A developer's own app is in use for this platform (REELSTUDIO_DEV=1 and saved settings). */
  own(): Promise<{ instagram: boolean; tiktok: boolean }>
}): void {
  d.handle('social:status', async (_event, fresh) => {
    const [dir, own] = await Promise.all([d.directory.get(fresh === true), d.own()])
    // a session that can't be read (a damaged credentials file) shows as not connected; connecting again fixes it
    const [instagram, tiktok] = await Promise.all([
      d.instagram.session().catch((): InstagramSession => ({ connected: false })),
      d.tiktok.session().catch((): TikTokSession => ({ connected: false }))
    ])
    const status: SocialStatus = {
      instagram: { availability: availability(dir, 'instagram', own.instagram), session: instagram },
      tiktok: { availability: availability(dir, 'tiktok', own.tiktok), session: tiktok }
    }
    return status
  })
}
