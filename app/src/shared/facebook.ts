// Facebook Reels on a Page (main/facebook.ts): Graph API v26.0, Facebook Login through the sign-in service.
// Reels publishing: https://developers.facebook.com/docs/video-api/guides/reels-publishing
import type { InstagramMetrics } from './instagram'

export interface FacebookPage {
  id: string
  name: string
}

export type FacebookSession =
  | { connected: false }
  /** `page`: where posts go; `pages`: every Page this account can post to. */
  | { connected: true; userName: string; page: FacebookPage; pages: FacebookPage[]; expiresAt: number }

export interface FacebookPublishInput {
  slug: string
  version: number
  description: string
}

export interface FacebookPost {
  version: number
  /** The Page it was posted to. */
  accountId: string
  /** The reel's video id. */
  postId: string
  publishedAt: string
}

export interface FacebookOutcome extends FacebookPost {
  platform: 'facebook'
  apiVersion: 'v26.0'
  observedAt: string | null
  metrics: InstagramMetrics | null
}

export interface FacebookApi {
  session(): Promise<FacebookSession>
  connect(): Promise<FacebookSession>
  cancelConnect(): Promise<void>
  disconnect(): Promise<void>
  /** Posts go to this Page from now on. */
  choosePage(pageId: string): Promise<FacebookSession>
  publish(input: FacebookPublishInput): Promise<FacebookPost>
}
