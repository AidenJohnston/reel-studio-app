// social:status for Settings › Posting and Share: for Instagram, TikTok and Facebook, whether each can be connected now
// (main/signin-config.ts) and the account connected, if any. Never a token.
import type { InstagramSession } from '../shared/instagram'
import type { SocialStatus } from '../shared/social'
import type { TikTokSession } from '../shared/tiktok'
import type { FacebookSession } from '../shared/facebook'
import type { ThreadsSession } from '../shared/threads'
import { availability, type SigninDirectory } from './signin-config'

type Handle = (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void

export function registerSocialIpc(d: {
  handle: Handle
  directory: SigninDirectory
  instagram: { session(): Promise<InstagramSession> }
  tiktok: { session(): Promise<TikTokSession> }
  facebook: { session(): Promise<FacebookSession> }
  threads: { session(): Promise<ThreadsSession> }
  /** A developer's own app is in use for this platform (REELSTUDIO_DEV=1 and saved settings). */
  own(): Promise<{ instagram: boolean; tiktok: boolean }>
}): void {
  d.handle('social:status', async (_event, fresh) => {
    const [dir, own] = await Promise.all([d.directory.get(fresh === true), d.own()])
    // a session that can't be read (a damaged credentials file) shows as not connected; connecting again fixes it
    const [instagram, tiktok, facebook, threads] = await Promise.all([
      d.instagram.session().catch((): InstagramSession => ({ connected: false })),
      d.tiktok.session().catch((): TikTokSession => ({ connected: false })),
      d.facebook.session().catch((): FacebookSession => ({ connected: false })),
      d.threads.session().catch((): ThreadsSession => ({ connected: false }))
    ])
    const status: SocialStatus = {
      instagram: { availability: availability(dir, 'instagram', own.instagram), session: instagram },
      tiktok: { availability: availability(dir, 'tiktok', own.tiktok), session: tiktok },
      facebook: { availability: availability(dir, 'facebook', false), session: facebook },
      threads: { availability: availability(dir, 'threads', false), session: threads }
    }
    return status
  })
}
