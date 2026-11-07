// Connect and post to every platform, end to end in the real app, through the real sign-in service
// (src/server/signin) with the platforms and the video storage played by this file. The app's https calls go to a
// stand-in on 127.0.0.1 (REELSTUDIO_TEST_PLATFORMS, main/test-platforms.ts); a test run never opens the browser, so
// the test reads the sign-in link the app would have opened and plays the person clicking Allow.
//
// Run: npx playwright test e2e/social.spec.ts (after npm run build).
import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { configFromEnv } from '../src/server/signin/config.ts'
import { createSigninHandler } from '../src/server/signin/handler.ts'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, openSettings, passFirstRun, shot, startReel } from './helpers'

const SIGNIN = 'https://signin.e2e.test'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

interface Seen {
  stored: number
  containers: URLSearchParams[]
  published: number
  tiktokInit: Record<string, unknown> | null
  tiktokBytes: number
  facebookBytes: number
  facebookFinish: URLSearchParams | null
  threadsContainer: URLSearchParams | null
  threadsPublished: number
  xBytes: number
  tweet: Record<string, unknown> | null
  linkedinBytes: number
  linkedinPost: Record<string, unknown> | null
}

/** Every platform and the storage, as they answer the app and the sign-in service. */
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
      return json({ id: `90${seen.containers.length}` })
    }
    if (/^graph\.instagram\.com\/v26\.0\/90\d$/.test(at)) return json({ status_code: 'FINISHED' })
    if (at === 'graph.instagram.com/v26.0/42/media_publish') {
      seen.published++
      return json({ id: `78${seen.published}` })
    }
    // Facebook: the sign-in service's exchange, then the app's Graph calls
    const fb = 'graph.facebook.com/v26.0'
    if (at === `${fb}/oauth/access_token`) return json({ access_token: u.searchParams.get('code') ? 'fb-short' : 'fb-long', token_type: 'bearer', expires_in: 5_000_000 })
    if (at === `${fb}/me/permissions`)
      return init.method === 'DELETE' ? json({ success: true }) : json({ data: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'].map((permission) => ({ permission, status: 'granted' })) })
    if (at === `${fb}/me`) return json({ name: 'E2E Person' })
    if (at === `${fb}/me/accounts`) return json({ data: [{ id: '77', name: 'E2E Page', access_token: 'page-token', tasks: ['CREATE_CONTENT'] }, { id: '78', name: 'Second Page', access_token: 'page-token-2', tasks: ['CREATE_CONTENT'] }] })
    if (at === `${fb}/78/video_reels`) {
      const f = new URLSearchParams(String(init.body))
      if (f.get('upload_phase') === 'start') return json({ video_id: '555', upload_url: 'https://rupload.facebook.com/video-upload/555' })
      seen.facebookFinish = f
      return json({ success: true })
    }
    if (at === `${fb}/555`) return json({ status: { video_status: 'uploading', uploading_phase: { status: 'not_started', bytes_transfered: 0 } } })
    if (at === 'rupload.facebook.com/video-upload/v26.0/555') {
      seen.facebookBytes += (await new Response(init.body).arrayBuffer()).byteLength
      return json({ success: true })
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
    // Threads: the sign-in service's exchange, then the app's calls (and /me from the service before upload links)
    const th = 'graph.threads.com/v1.0'
    if (at === 'graph.threads.com/oauth/access_token') return json({ access_token: 'th-short', user_id: 4242 })
    if (at === 'graph.threads.com/access_token') return json({ access_token: 'th-long', token_type: 'bearer', expires_in: 5_184_000 })
    if (at === `${th}/me`) return json({ id: '4242', username: 'e2e.threads' })
    if (at === `${th}/4242/threads`) {
      seen.threadsContainer = new URLSearchParams(String(init.body))
      return json({ id: '600' })
    }
    if (at === `${th}/600`) return json({ status: 'FINISHED' })
    if (at === `${th}/4242/threads_publish`) {
      seen.threadsPublished++
      return json({ id: '700' })
    }
    // X: the sign-in service's token call, then the app's
    const x = 'api.x.com/2'
    if (at === `${x}/oauth2/token`)
      return json({ access_token: 'x-token', refresh_token: 'x-refresh', token_type: 'bearer', expires_in: 7200, scope: 'tweet.read tweet.write users.read media.write offline.access' })
    if (at === `${x}/users/me`) return json({ data: { id: '99', username: 'e2e_x', name: 'E2E' } })
    if (at === `${x}/media/upload/initialize`) return json({ data: { id: '1234', media_key: '13_1234' } })
    if (at === `${x}/media/upload/1234/append`) {
      seen.xBytes += (await new Response(init.body).arrayBuffer()).byteLength
      return new Response(null, { status: 204 })
    }
    if (at === `${x}/media/upload/1234/finalize`) return json({ data: { id: '1234' } })
    if (at === `${x}/tweets`) {
      seen.tweet = JSON.parse(String(init.body))
      return json({ data: { id: '5555', text: seen.tweet!.text } }, 201)
    }
    // LinkedIn: the sign-in service's exchange, then the app's Videos and Posts calls
    if (at === 'www.linkedin.com/oauth/v2/accessToken') return json({ access_token: 'li-token', expires_in: 5_184_000, scope: 'openid,profile,w_member_social' })
    if (at === 'api.linkedin.com/v2/userinfo') return json({ sub: 'AbC123', name: 'E2E Member' })
    if (at === 'api.linkedin.com/rest/videos' && u.searchParams.get('action') === 'initializeUpload') {
      const size = (JSON.parse(String(init.body)) as { initializeUploadRequest: { fileSizeBytes: number } }).initializeUploadRequest.fileSizeBytes
      return json({ value: { video: 'urn:li:video:C5505', uploadToken: 'tok', uploadInstructions: [{ uploadUrl: 'https://www.linkedin.com/dms-uploads/C5505/part1', firstByte: 0, lastByte: size - 1 }] } })
    }
    if (at === 'www.linkedin.com/dms-uploads/C5505/part1') {
      seen.linkedinBytes += (await new Response(init.body).arrayBuffer()).byteLength
      return new Response(null, { status: 200, headers: { etag: 'etag-1' } })
    }
    if (at === 'api.linkedin.com/rest/videos' && u.searchParams.get('action') === 'finalizeUpload') return new Response(null, { status: 200 })
    if (decodeURIComponent(at) === 'api.linkedin.com/rest/videos/urn:li:video:C5505') return json({ status: 'AVAILABLE' })
    if (at === 'api.linkedin.com/rest/posts') {
      seen.linkedinPost = JSON.parse(String(init.body))
      return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:777' } })
    }
    return json({ error: { code: 'not_faked', at } }, 404)
  }
}

async function world(): Promise<{ server: Server; url: string; seen: Seen }> {
  const seen: Seen = {
    stored: 0, containers: [], published: 0, tiktokInit: null, tiktokBytes: 0, facebookBytes: 0, facebookFinish: null,
    threadsContainer: null, threadsPublished: 0, xBytes: 0, tweet: null, linkedinBytes: 0, linkedinPost: null
  }
  let fake!: (url: string, init: RequestInit) => Promise<Response>
  const handler = createSigninHandler(configFromEnv({
    SIGNIN_PUBLIC_URL: SIGNIN, SIGNIN_SECRET: randomBytes(32).toString('base64url'),
    INSTAGRAM_APP_ID: '1111', INSTAGRAM_APP_SECRET: 'ig-secret',
    FACEBOOK_APP_ID: '2222', FACEBOOK_APP_SECRET: 'fb-secret',
    THREADS_APP_ID: '3333', THREADS_APP_SECRET: 'th-secret',
    X_CLIENT_ID: 'x-client', X_CLIENT_SECRET: 'x-secret',
    LINKEDIN_CLIENT_ID: 'li-client', LINKEDIN_CLIENT_SECRET: 'li-secret',
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

/** Settings › Posting › Connect Instagram, with the test playing the person clicking Allow. */
async function connectInstagram(app: ElectronApplication, page: Page, url: string): Promise<void> {
  await openSettings(page)
  const row = page.locator('[data-setting="instagram"]')
  await row.getByTestId('instagram-connect').click()
  const link = await opened(app)
  const back = await fetch(`${url}/signin.e2e.test/v1/instagram/callback?${new URLSearchParams({ code: 'ig-code', state: link.searchParams.get('state')! })}`, { redirect: 'manual' })
  expect((await fetch(back.headers.get('location')!)).status).toBe(200)
  await expect(row).toContainText('Connected as @e2e_creator')
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
    // connected: who else may connect no longer matters to this account
    await expect(row.getByTestId('instagram-review')).toHaveCount(0)
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

test('connect Facebook, choose the Page and post a reel to it', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { server, url, seen } = await world()
  const { app, page } = await launch({ REELSTUDIO_SIGNIN_URL: SIGNIN, REELSTUDIO_TEST_PLATFORMS: url })
  try {
    await passFirstRun(page)
    await openSettings(page)
    const row = page.locator('[data-setting="facebook"]')
    await row.getByTestId('facebook-connect').click()
    const link = await opened(app)
    expect(link.origin + link.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth')
    const back = await fetch(`${url}/signin.e2e.test/v1/facebook/callback?${new URLSearchParams({ code: 'fb-code', state: link.searchParams.get('state')! })}`, { redirect: 'manual' })
    expect((await fetch(back.headers.get('location')!)).status).toBe(200)
    await expect(row).toContainText('Posting to E2E Page')
    // two Pages: choose where reels go
    await row.getByTestId('facebook-page').selectOption('78')
    await expect(row).toContainText('Posting to Second Page')
    await shot(page, 'social-7-facebook-settings')

    await startReel(page, media.video)
    await expect(page.getByTestId('share')).toBeEnabled({ timeout: 10 * 60_000 })
    await page.getByTestId('share').click()
    await page.getByTestId('share-pop').getByTestId('share-post-facebook').click()
    const sheet = page.getByTestId('social-sheet')
    await expect(sheet).toHaveAttribute('data-state', 'form', { timeout: 5 * 60_000 })
    await expect(page.getByTestId('social-account')).toHaveText('Posting to Second Page')
    await page.getByTestId('social-caption').fill('From the e2e #reel')
    await page.getByTestId('social-submit').click()
    await expect(sheet).toHaveAttribute('data-state', 'done', { timeout: 3 * 60_000 })
    await expect(page.getByTestId('social-done')).toContainText('Second Page')
    await shot(page, 'social-8-facebook-done')
    expect(seen.facebookBytes).toBeGreaterThan(1000)
    expect(seen.facebookFinish?.get('video_state')).toBe('PUBLISHED')
    expect(seen.facebookFinish?.get('description')).toBe('From the e2e #reel')
  } finally {
    await app.close()
    server.close()
  }
})

test('post Try 1 and Try 2 to Instagram as two trial reels from Other platforms', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { server, url, seen } = await world()
  const mine = mkdtempSync(join(BASE, 'trial-pair-'))
  // the practice editor proposes Try 2 (e2e/try-two-versions.spec.ts)
  const { app, page } = await launch({ REELSTUDIO_SIGNIN_URL: SIGNIN, REELSTUDIO_TEST_PLATFORMS: url, REELSTUDIO_MOCK_NOTE: '800',
    REELSTUDIO_ROOT: join(mine, 'Reel Studio'), REELSTUDIO_USER_DATA: join(mine, 'user data') })
  try {
    await passFirstRun(page)
    await connectInstagram(app, page, url)
    await startReel(page, media.video)
    await expect(page.getByTestId('share')).toBeEnabled({ timeout: 10 * 60_000 })
    await page.getByTestId('share').click()
    await page.getByTestId('share-platforms-toggle').click()
    const platforms = page.getByTestId('share-platforms')
    await expect(platforms.getByRole('checkbox', { name: 'Instagram Reels' })).toBeChecked()
    await expect(platforms.getByTestId('try-two-use')).toBeVisible({ timeout: 60_000 })
    await platforms.getByTestId('try-two-use').click()
    await platforms.getByTestId('export-selected').click()
    await expect(platforms.getByTestId('export-saved')).toBeVisible({ timeout: 120_000 })
    await shot(page, 'social-9-trial-pair')
    await platforms.getByTestId('trial-pair-post').click()
    await expect(platforms.getByTestId('trial-pair-done')).toBeVisible({ timeout: 3 * 60_000 })
    await shot(page, 'social-10-trial-pair-done')
    expect(seen.containers).toHaveLength(2)
    for (const c of seen.containers) expect(c.get('trial_params')).toBe('{"graduation_strategy":"MANUAL"}')
    expect(seen.containers[0].get('caption')).not.toBe(seen.containers[1].get('caption') ?? '')
    expect(seen.published).toBe(2)
  } finally {
    await app.close()
    server.close()
  }
})

/** Settings › Posting › Connect <platform>, with the test playing the person clicking Allow on the platform's page. */
async function connectInSettings(app: ElectronApplication, page: Page, url: string, id: 'threads' | 'x' | 'linkedin', authorize: string, connected: string): Promise<void> {
  const row = page.locator(`[data-setting="${id}"]`)
  await row.getByTestId(`${id}-connect`).click()
  const link = await opened(app)
  expect(link.origin + link.pathname).toBe(authorize)
  expect(link.searchParams.get('redirect_uri')).toBe(`${SIGNIN}/v1/${id}/callback`)
  const back = await fetch(`${url}/signin.e2e.test/v1/${id}/callback?${new URLSearchParams({ code: `${id}-code`, state: link.searchParams.get('state')! })}`, { redirect: 'manual' })
  expect(back.status).toBe(302)
  expect((await fetch(back.headers.get('location')!)).status).toBe(200)
  await expect(row).toContainText(connected)
}

test('connect Threads, X and LinkedIn in Settings and post the reel to each from Share', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  const { server, url, seen } = await world()
  const { app, page } = await launch({ REELSTUDIO_SIGNIN_URL: SIGNIN, REELSTUDIO_TEST_PLATFORMS: url })
  try {
    await passFirstRun(page)
    await openSettings(page)
    // every platform the service has an app for gets its own row; none is left in Other platforms
    await expect(page.locator('[data-setting="social-closed"]')).toHaveCount(0)
    await connectInSettings(app, page, url, 'threads', 'https://threads.com/oauth/authorize', 'Connected as @e2e.threads')
    await connectInSettings(app, page, url, 'x', 'https://x.com/i/oauth2/authorize', 'Connected as @e2e_x')
    await connectInSettings(app, page, url, 'linkedin', 'https://www.linkedin.com/oauth/v2/authorization', 'Connected as E2E Member')
    await page.locator('[data-setting="threads"]').scrollIntoViewIfNeeded()
    await shot(page, 'social-11-threads-x-linkedin-settings')

    await startReel(page, media.video)
    await expect(page.getByTestId('share')).toBeEnabled({ timeout: 10 * 60_000 })
    const sheet = page.getByTestId('social-sheet')
    const post = async (id: 'threads' | 'x' | 'linkedin', account: string, words: string, n: number) => {
      const pop = page.getByTestId('share-pop')
      if (!(await pop.isVisible())) await page.getByTestId('share').click()
      await pop.getByTestId(`share-post-${id}`).click()
      await expect(sheet).toHaveAttribute('data-state', 'form', { timeout: 5 * 60_000 })
      await expect(page.getByTestId('social-account')).toHaveText(`Posting to ${account}`)
      // the caption as the sheet opens, before the person changes it
      await shot(page, `social-${n}-${id}-form`)
      await page.getByTestId('social-caption').fill(words)
      await page.getByTestId('social-submit').click()
      await expect(sheet).toHaveAttribute('data-state', 'done', { timeout: 3 * 60_000 })
      await shot(page, `social-${n + 1}-${id}-done`)
      await page.getByTestId('social-done-close').click()
      await expect(sheet).toHaveCount(0)
    }

    const stored = seen.stored
    await post('threads', '@e2e.threads', 'On Threads #reel', 12)
    expect(seen.stored - stored).toBeGreaterThan(1000)
    expect(seen.threadsContainer?.get('media_type')).toBe('VIDEO')
    expect(seen.threadsContainer?.get('text')).toBe('On Threads #reel')
    expect(new URL(seen.threadsContainer!.get('video_url')!).host).toBe('media.e2e.test')
    expect(seen.threadsPublished).toBe(1)

    await post('x', '@e2e_x', 'On X #reel', 14)
    expect(seen.xBytes).toBeGreaterThan(1000)
    expect(seen.tweet).toEqual({ text: 'On X #reel', media: { media_ids: ['1234'] } })

    await post('linkedin', 'E2E Member', 'On LinkedIn', 16)
    expect(seen.linkedinBytes).toBeGreaterThan(1000)
    expect(seen.linkedinPost).toMatchObject({ author: 'urn:li:person:AbC123', commentary: 'On LinkedIn', content: { media: { id: 'urn:li:video:C5505' } }, lifecycleState: 'PUBLISHED' })
  } finally {
    await app.close()
    server.close()
  }
})
