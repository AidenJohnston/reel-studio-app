// Presigned object-storage links (AWS Signature Version 4, query-string form), for the temporary copy of a video that
// Instagram and Threads fetch by URL (docs/signin.md, "Staging a video"). Works with any S3-compatible store; the
// deploy note uses Cloudflare R2. Spec: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
// WebCrypto only, so it runs wherever the service runs.

const enc = new TextEncoder()

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')

async function hmac(key: Uint8Array<ArrayBuffer> | ArrayBuffer, text: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, enc.encode(text))
}

/** RFC 3986 encoding, as SigV4 wants it: everything but unreserved characters. */
const rfc3986 = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

export interface PresignInput {
  method: 'GET' | 'PUT'
  /** The object's full URL (path-style or virtual-hosted), without a query. */
  url: string
  accessKeyId: string
  secretAccessKey: string
  /** "auto" for R2. */
  region: string
  expiresSec: number
  now: Date
  /** Headers the uploader must send with exactly these values (lower-case names), such as content-length. */
  headers?: Record<string, string>
}

export async function presign(p: PresignInput): Promise<string> {
  if (!Number.isInteger(p.expiresSec) || p.expiresSec < 1 || p.expiresSec > 604_800) throw new Error('expiresSec must be 1 to 604800')
  const u = new URL(p.url)
  if (u.search || u.hash) throw new Error('presign takes a URL without a query')
  const amzDate = p.now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const scope = `${day}/${p.region}/s3/aws4_request`
  const headers: Record<string, string> = { host: u.host }
  for (const [k, v] of Object.entries(p.headers ?? {})) headers[k.toLowerCase()] = v
  const names = Object.keys(headers).sort()
  const signedHeaders = names.join(';')
  const query: [string, string][] = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${p.accessKeyId}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(p.expiresSec)],
    ['X-Amz-SignedHeaders', signedHeaders]
  ]
  const canonicalQuery = query
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  // URL's pathname is already percent-encoded once, as SigV4 wants (object keys here are plain ASCII)
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim()}\n`).join('')
  const canonical = [p.method, u.pathname, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n')
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(await crypto.subtle.digest('SHA-256', enc.encode(canonical)))].join('\n')
  let key = await hmac(enc.encode(`AWS4${p.secretAccessKey}`), day)
  key = await hmac(key, p.region)
  key = await hmac(key, 's3')
  key = await hmac(key, 'aws4_request')
  const signature = hex(await hmac(key, toSign))
  return `${u.origin}${u.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`
}
