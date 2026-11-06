// Connect and post to Instagram and TikTok, end to end in the real app, through the real sign-in service
// (src/server/signin) with Instagram, TikTok and the video storage played by this file. The app's https calls go to a
// stand-in on 127.0.0.1 (REELSTUDIO_TEST_PLATFORMS, main/test-platforms.ts); a test run never opens the browser, so
// the test reads the sign-in link the app would have opened and plays the person clicking Allow.
//
// Run: npx playwright test e2e/social.spec.ts (after npm run build).
import { test, expect, type ElectronApplication } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { configFromEnv } from '../src/server/signin/config.ts'
import { createSigninHandler } from '../src/server/signin/handler.ts'
import { launch, makeMedia, openSettings, passFirstRun, shot, startReel } from './helpers'

const SIGNIN = 'https://signin.e2e.test'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

interface Seen {
  stored: number
  containers: URLSearchParams[]
  published: number
  tiktokInit: Record<string, unknown> | null
  tiktokBytes: number
}

/** Instagram, TikTok and the storage, as they answer the app and the sign-in service. */
function platforms(seen: Seen) {
  return async (url: string, init: RequestInit): Promise<Response> => {
    const u = new URL(url)
    const at = u.host + u.pathname
    const json = (v: unknown, status = 200) => Response.json(v, { status })
    // Instagram's sign-in exchange, from the sign-in service
    if (at === 'api.instagram.com/oauth/access_token') return json({ data: [{ access_token: 'ig-short', user_id: '42', permissions: 'instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights' }] })
    if (at === 'graph.instagram.com/access_token') return json({ access_token: 'ig-long', token_type: 'bearer', expires_in: 5_184_000 })
    // Instagram's Graph API, from the app (and /me from the service before it makes upload links)
    if (at === 'graph.instagram.com/v26.0/me') {
      return json({ user_id: '42', username: 'e2e_creator', account_type: 'MEDIA_CREATOR', profile_picture_url: 'https://cdn.e2e.test/me.png' })
    }
    if (at === 'cdn.e2e.test/me.png') return new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(PNG.length) } })
    if (u.host === 'media.e2e.test' && init.method === 'PUT') {
      seen.stored += (await new Response(init.body).arrayBuffer()).byteLength
      return new Response(null, { status: 200 })
    }
    if (at === 'graph.instagram.com/v26.0/42/media') {
      seen.containers.push(new URLSearchParams(String(init.body)))
      return json({ id: '900' })
    }
    if (at === 'graph.instagram.com/v26.0/900') return json({ status_code: 'FINISHED' })
    if (at === 'graph.instagram.com/v26.0/42/media_publish') {
      seen.published++
      return json({ id: '789' })
    }
    // TikTok
    if (at === 'open.tiktokapis.com/v2/oauth/token/')
      return json({ access_token: 'tt-token', refresh_token: 'tt-refresh', token_type: 'Bearer', expires_in: 86400, refresh_expires_in: 31536000, open_id: 'tt-open-id', scope: 'user.info.basic,video.list,video.upload,video.publish' })
    const ok = (data: unknown) => json({ data, error: { code: 'ok', message: '' } })
    if (at === 'open.tiktokapis.com/v2/user/info/') return ok({ user: { open_id: 'tt-open-id', display_name: 'E2E Creator' } })
    if (at === 'open.tiktokapis.com/v2/post/publish/creator_info/query/')
      return ok({ creator_nickname: 'E2E Creator', privacy_level_options: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'], comment_disabled: false, duet_disabled: true, stitch_disabled: false, max_video_post_duration_sec: 600 })
    if (at === 'open.tiktokapis.com/v2/post/publish/video/init/') {
      seen.tiktokInit = JSON.parse(String(init.body))
      return ok({ publish_id: 'pub-1', upload_url: 'https://open-upload.tiktokapis.com/upload/?id=1' })
    }
    if (at === 'open-upload.tiktokapis.com/upload/') {
      seen.tiktokBytes += (await new Response(init.body).arrayBuffer()).byteLength
      const range = new Headers(init.headers).get('content-range') ?? ''
      const [, end, total] = /bytes \d+-(\d+)\/(\d+)/.exec(range) ?? []
      return new Response(null, { status: Number(end) + 1 === Number(total) ? 201 : 206 })
    }
    if (at === 'open.tiktokapis.com/v2/post/publish/status/fetch/')
      return ok(seen.tiktokBytes && seen.tiktokBytes === (seen.tiktokInit?.source_info as { video_size?: number } | undefined)?.video_size
        ? { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [] }
        : { status: 'PROCESSING_UPLOAD', uploaded_bytes: seen.tiktokBytes })
    return json({ error: { code: 'not_faked', at } }, 404)
  }
}

async function world(): Promise<{ server: Server; url: string; seen: Seen }> {
  const seen: Seen = { stored: 0, containers: [], published: 0, tiktokInit: null, tiktokBytes: 0 }
  let fake!: (url: string, init: RequestInit) => Promise<Response>
  const handler = createSigninHandler(configFromEnv({
    SIGNIN_PUBLIC_URL: SIGNIN, SIGNIN_SECRET: randomBytes(32).toString('base64url'),
    INSTAGRAM_APP_ID: '1111', INSTAGRAM_APP_SECRET: 'ig-secret',
    TIKTOK_CLIENT_KEY: 'tt-key', TIKTOK_CLIENT_SECRET: 'tt-secret', TIKTOK_DIRECT_POST: '1',
    MEDIA_BUCKET_URL: 'https://media.e2e.test/reels', MEDIA_ACCESS_KEY_ID: 'AKID', MEDIA_SECRET_ACCESS_KEY: 'media-secret'
  }, (u, init) => fake(u, init)))
  fake = withSignin(platforms(seen), handler)
  // the stand-in: /<host>/<path> is https://<host>/<path>
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', async () => {
      const [, host, ...rest] = (req.url ?? '/').split('/')
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && k !== 'host') headers.set(k, v)
      const body = Buffer.concat(chunks)
      const r = await fake(`https://${host}/${rest.join('/')}`, { method: req.method, headers, body: body.length ? body : undefined })
      const out: Record<string, string> = {}
      r.headers.forEach((v, k) => (out[k] = v))
      res.writeHead(r.status, out)
      res.end(Buffer.from(await r.arrayBuffer()))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

function withSignin(platform: (url: string, init: RequestInit) => Promise<Response>, handler: (req: Request) => Promise<Response>) {
  return (url: string, init: RequestInit) => (url.startsWith(`${SIGNIN}/`) ? handler(new Request(url, init)) : platform(url, init))
}

/** The sign-in link the app would have opened in the browser (main/index.ts openSignin). */
async function opened(app: ElectronApplication): Promise<URL> {
  let link = ''
  await expect.poll(async () => (link = (await app.evaluate(() => (globalThis as { __reelstudioOpened?: string }).__reelstudioOpened ?? '')))).not.toBe('')
  await app.evaluate(() => { delete (globalThis as { __reelstudioOpened?: string }).__reelstudioOpened })
  return new URL(link)
}

test('connect Instagram in Settings, see the account in the preview, and post a trial reel from Share', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { server, url, seen } = await world()
  const { app, page } = await launch({ REELSTUDIO_SIGNIN_URL: SIGNIN, REELSTUDIO_TEST_PLATFORMS: url })
  try {
    await passFirstRun(page)
    await openSettings(page)
    const row = page.locator('[data-setting="instagram"]')
    await expect(row).toContainText('Meta hasn’t approved Reel Studio yet')
    await shot(page, 'social-1-settings')
    await row.getByTestId('instagram-connect').click()
    await expect(row).toContainText('Finish signing in to Instagram in your browser')

    // the person clicks Allow on Instagram's page: Instagram sends them to the sign-in service, which sends them on
    const link = await opened(app)
    expect(link.origin + link.pathname).toBe('https://www.instagram.com/oauth/authorize')
    expect(link.searchParams.get('redirect_uri')).toBe(`${SIGNIN}/v1/instagram/callback`)
    const back = await fetch(`${url}/signin.e2e.test/v1/instagram/callback?${new URLSearchParams({ code: 'ig-code', state: link.searchParams.get('state')! })}`, { redirect: 'manual' })
    expect(back.status).toBe(302)
    expect((await fetch(back.headers.get('location')!)).status).toBe(200)

    await expect(row).toContainText('Connected as @e2e_creator')
    await expect(row.getByTestId('instagram-review')).toBeVisible()
    await shot(page, 'social-2-connected')

    // the preview names the connected account
    await startReel(page, media.video)
    await expect(page.getByTestId('ig-handle').first()).toHaveText('e2e_creator')
    await expect(page.getByTestId('share')).toBeEnabled({ timeout: 10 * 60_000 })
    await page.getByTestId('share').click()
    const pop = page.getByTestId('share-pop')
    await expect(pop.getByTestId('share-post-instagram')).toContainText('To @e2e_creator')
    await pop.getByTestId('share-post-instagram').click()
    const sheet = page.getByTestId('social-sheet')
    await expect(sheet).toHaveAttribute('data-state', 'form', { timeout: 5 * 60_000 })
    await expect(page.getByTestId('social-account')).toHaveText('Posting to @e2e_creator')
    // the first frame as cover: the stand-in engine's cover image is not a real picture (the image cover is in instagram.test.ts)
    if (await page.getByTestId('social-cover-frame').count()) await page.getByTestId('social-cover-frame').check()
    await page.getByTestId('social-trial').check()
    await shot(page, 'social-3-instagram-form')
    await page.getByTestId('social-submit').click()
    await expect(sheet).toHaveAttribute('data-state', 'done', { timeout: 3 * 60_000 })
    await expect(page.getByTestId('social-done')).toContainText('trial reel')
    await shot(page, 'social-4-instagram-done')
    expect(seen.stored).toBeGreaterThan(1000)
    expect(seen.containers).toHaveLength(1)
    expect(seen.containers[0].get('media_type')).toBe('REELS')
    expect(seen.containers[0].get('trial_params')).toBe('{"graduation_strategy":"MANUAL"}')
    expect(new URL(seen.containers[0].get('video_url')!).host).toBe('media.e2e.test')
    expect(seen.published).toBe(1)
    await page.getByTestId('social-done-close').click()

    // Disconnect asks first, then forgets the account
    await openSettings(page)
    await row.getByTestId('instagram-disconnect').click()
    await page.getByRole('button', { name: 'Disconnect', exact: true }).last().click()
    await expect(row.getByTestId('instagram-connect')).toBeVisible()
  } finally {
    await app.close()
    server.close()
  }
})

test('connect TikTok from Share and post with the choices TikTok requires', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { server, url, seen } = await world()
  const { app, page } = await launch({ REELSTUDIO_SIGNIN_URL: SIGNIN, REELSTUDIO_TEST_PLATFORMS: url })
  try {
    await passFirstRun(page)
    await startReel(page, media.video)
    await expect(page.getByTestId('share')).toBeEnabled({ timeout: 10 * 60_000 })
    await page.getByTestId('share').click()
    await page.getByTestId('share-pop').getByTestId('share-post-tiktok').click()
    const sheet = page.getByTestId('social-sheet')
    await expect(sheet).toHaveAttribute('data-state', 'not_connected', { timeout: 5 * 60_000 })
    await expect(sheet).toContainText('TikTok hasn’t reviewed Reel Studio yet')
    await page.getByTestId('social-connect').click()
    await expect(sheet).toHaveAttribute('data-state', 'connecting')

    // TikTok sends a desktop app's sign-in straight back to it on this computer
    const link = await opened(app)
    expect(link.origin + link.pathname).toBe('https://www.tiktok.com/v2/auth/authorize/')
    const back = new URL(link.searchParams.get('redirect_uri')!)
    back.search = new URLSearchParams({ code: 'tt-code', state: link.searchParams.get('state')! }).toString()
    expect((await fetch(back)).status).toBe(200)

    await expect(sheet).toHaveAttribute('data-state', 'form')
    await expect(page.getByTestId('social-account')).toHaveText('Posting to E2E Creator')
    // nothing is picked for who can see it until the person picks; unaudited, Only me is the one choice
    await expect(page.getByTestId('social-submit')).toBeDisabled()
    await expect(page.getByTestId('social-privacy-PUBLIC_TO_EVERYONE')).toHaveCount(0)
    await expect(page.getByTestId('social-allow-duet')).toBeDisabled()
    await expect(page.getByTestId('social-allow-comment')).not.toBeChecked()
    await page.getByTestId('social-privacy-SELF_ONLY').check()
    await shot(page, 'social-5-tiktok-form')
    await page.getByTestId('social-submit').click()
    await expect(sheet).toHaveAttribute('data-state', 'done', { timeout: 3 * 60_000 })
    await shot(page, 'social-6-tiktok-done')
    expect(seen.tiktokInit).toMatchObject({ post_info: { privacy_level: 'SELF_ONLY', disable_comment: true, disable_duet: true, disable_stitch: true, brand_content_toggle: false } })
    expect(seen.tiktokBytes).toBe((seen.tiktokInit!.source_info as { video_size: number }).video_size)
  } finally {
    await app.close()
    server.close()
  }
})
