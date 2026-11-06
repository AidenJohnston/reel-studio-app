// One call to a Meta Graph API (Facebook Pages, Threads), with Meta's error codes turned into plain words that name
// the platform. Instagram keeps its own (instagram-http.ts), whose codes the learning loop already reads.
// Errors: https://developers.facebook.com/docs/graph-api/guides/error-handling
export class SocialError extends Error {
  constructor(readonly code: string, readonly userMessage: string) {
    super(userMessage)
  }
}

export type MetaFetch = (url: string, init: RequestInit) => Promise<Response>

/** `prefix` starts every error code (FB_, TH_); `name` is the platform as the person knows it. */
export function metaApi(name: string, prefix: string) {
  const fail = (code: string, message: string): never => { throw new SocialError(`${prefix}${code}`, message) }
  const invalid = (): never => fail('RESPONSE', `${name} returned incomplete data. Try again later.`)
  const object = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid()
    return v as Record<string, unknown>
  }
  const text = (v: unknown): string => {
    if (typeof v !== 'string' || !v || v.length > 10_000) return invalid()
    return v
  }
  const id = (v: unknown): string => {
    const t = typeof v === 'number' && Number.isSafeInteger(v) ? String(v) : text(v)
    if (!/^\d{1,32}$/.test(t)) return invalid()
    return t
  }
  async function request(fetcher: MetaFetch, url: string, init: RequestInit, signal: AbortSignal, onDispatch?: () => void): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    let res: Response
    try {
      onDispatch?.()
      res = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) })
    } catch {
      signal.throwIfAborted()
      return fail('NETWORK', `${name} could not be reached. Check your connection and try again.`)
    }
    let data: unknown = null
    try { data = await res.json() } catch { /* handled below */ }
    const err = data && typeof data === 'object' && 'error' in data ? (data as { error: unknown }).error : undefined
    if (res.ok && data && typeof data === 'object' && !err) return data as Record<string, unknown>
    const code = err && typeof err === 'object' ? (err as Record<string, unknown>).code : undefined
    if (res.status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || code === 80001)
      return fail('RATE_LIMIT', `${name} has reached a request limit. Wait a few minutes before trying again.`)
    if (res.status === 401 || code === 190) return fail('TOKEN', `Your ${name} connection has ended. Connect ${name} again in Settings.`)
    if (code === 10 || code === 200 || res.status === 403) return fail('PERMISSION', `${name} did not allow this. Connect ${name} again in Settings and allow posting.`)
    if (code === 100 || code === 6000) return fail('INPUT', `${name} could not use this video or text. Check its length and try again.`)
    return fail('API', `${name} could not finish this request. Try again later.`)
  }
  return { fail, invalid, object, text, id, request }
}
