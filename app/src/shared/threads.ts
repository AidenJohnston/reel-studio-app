// Threads (main/threads.ts): Threads API v1.0, signed in through the sign-in service.
// Posts: https://developers.facebook.com/docs/threads/posts
import type { InstagramMetrics } from './instagram'

export type ThreadsSession = { connected: false } | { connected: true; accountId: string; username: string; expiresAt: number }

export interface ThreadsPublishInput {
  slug: string
  version: number
  /** At most 500 characters. */
  text: string
}

export interface ThreadsPost {
  version: number
  accountId: string
  postId: string
  publishedAt: string
}

export interface ThreadsOutcome extends ThreadsPost {
  platform: 'threads'
  apiVersion: 'v1.0'
  observedAt: string | null
  metrics: InstagramMetrics | null
}

export interface ThreadsApi {
  session(): Promise<ThreadsSession>
  connect(): Promise<ThreadsSession>
  cancelConnect(): Promise<void>
  disconnect(): Promise<void>
  publish(input: ThreadsPublishInput): Promise<ThreadsPost>
}
