// X (main/x.ts): X API v2, signed in through the sign-in service.
export type XSession = { connected: false } | { connected: true; accountId: string; username: string }

export interface XPublishInput {
  slug: string
  version: number
  /** At most 280 characters. */
  text: string
}

export interface XPost {
  version: number
  accountId: string
  postId: string
  publishedAt: string
}

export interface XApi {
  session(): Promise<XSession>
  connect(): Promise<XSession>
  cancelConnect(): Promise<void>
  disconnect(): Promise<void>
  publish(input: XPublishInput): Promise<XPost>
}
