// Instagram API v26.0: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login
// Errors: https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/error-codes
export const INSTAGRAM_VERSION = 'v26.0'
export const INSTAGRAM_GRAPH = `https://graph.instagram.com/${INSTAGRAM_VERSION}`
export const INSTAGRAM_SCOPES = ['instagram_business_basic', 'instagram_business_content_publish', 'instagram_business_manage_insights']

export class InstagramError extends Error {
  constructor(readonly code: string, readonly userMessage: string) {
    super(userMessage)
  }
}

export function invalidResponse(): never {
  throw new InstagramError('IG_RESPONSE', 'Instagram returned incomplete data. Try again later.')
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidResponse()
  return Object.fromEntries(Object.entries(value))
}

export function text(value: unknown): string {
  if (typeof value !== 'string' || !value.length || value.length > 10_000) return invalidResponse()
  return value
}

export function id(value: unknown): string {
  const result = text(value)
  if (!/^\d+$/.test(result)) return invalidResponse()
  return result
}

export function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return invalidResponse()
  return value
}

export function httpsUrl(value: unknown): URL {
  let url: URL
  try { url = new URL(text(value)) } catch { return invalidResponse() }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return invalidResponse()
  return url
}

/** An https origin, or http on this computer (a sign-in service or storage run locally, docs/signin.md). */
export function serviceOrigin(value: unknown): string {
  let url: URL
  try { url = new URL(text(value)) } catch { return invalidResponse() }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost'
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.hash || url.search || url.pathname !== '/')
    return invalidResponse()
  return url.origin
}

export type InstagramFetch = (url: string, init: RequestInit) => Promise<Response>

export async function request(fetcher: InstagramFetch, url: string, init: RequestInit, signal: AbortSignal, onDispatch?: () => void): Promise<unknown> {
  signal.throwIfAborted()
  let response: Response
  try {
    onDispatch?.()
    response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]) })
  } catch {
    signal.throwIfAborted()
    throw new InstagramError('IG_NETWORK', 'Instagram could not be reached. Check your connection and try again.')
  }
  let data: unknown
  try { data = await response.json() } catch { data = null }
  if (response.ok && !(data && typeof data === 'object' && 'error' in data)) return data
  const error = data && typeof data === 'object' && 'error' in data ? object(data.error) : {}
  const code = error.code
  if (response.status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || code === 80002)
    throw new InstagramError('IG_RATE_LIMIT', 'Instagram has reached a request limit. Wait a few minutes before trying again.')
  if (response.status === 401 || code === 190)
    throw new InstagramError('IG_TOKEN', 'Your Instagram connection has expired. Connect Instagram again in Settings.')
  if (code === 10 || code === 200 || response.status === 403)
    throw new InstagramError('IG_PERMISSION', 'Instagram did not allow this action. Check the account permissions and app approval in Settings.')
  if (code === 100)
    throw new InstagramError('IG_INPUT', 'Instagram could not use this video, cover or request. Check the export and try again.')
  throw new InstagramError('IG_API', 'Instagram could not finish this request. Try again later.')
}

export function jsonPost(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}
