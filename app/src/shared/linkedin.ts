// LinkedIn (main/linkedin.ts): posts as the signed-in member, through the sign-in service.
export type LinkedInSession = { connected: false } | { connected: true; accountId: string; name: string; expiresAt: number }

export interface LinkedInPublishInput {
  slug: string
  version: number
  /** At most 3,000 characters. */
  text: string
}

export interface LinkedInPost {
  version: number
  /** The member's id. */
  accountId: string
  /** urn:li:share:<id> or urn:li:ugcPost:<id> */
  postId: string
  publishedAt: string
}

export interface LinkedInApi {
  session(): Promise<LinkedInSession>
  connect(): Promise<LinkedInSession>
  cancelConnect(): Promise<void>
  disconnect(): Promise<void>
  publish(input: LinkedInPublishInput): Promise<LinkedInPost>
}
