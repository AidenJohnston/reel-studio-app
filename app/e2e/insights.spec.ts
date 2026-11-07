// Insights end to end: two reels made in the app, their posts recorded the way publishing records them (outcomes.json),
// results read from stand-in platforms (REELSTUDIO_TEST_RESULTS, main/results-test-source.ts), then the page: the
// readout, each reel's numbers, a Try 1 / Try 2 verdict, who's watching, opening the posted version, and a rate limit.
//
// Run: npx playwright test e2e/insights.spec.ts (after npm run build). Screenshots: e2e/screenshots/insights-*.png
import { test, expect } from '@playwright/test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, newProjectFolder, passFirstRun, projectFolders, root, shot } from './helpers'

const FIXTURE = join(BASE, 'insights-platforms.json')
const DAY = 86_400_000

/** What publishing saves for each post (results-1106 CONTRACT.md); the numbers come later, from the refresh. */
function recordPosts(dir: string, posts: { version: number; platform: 'instagram' | 'tiktok'; postId: string; accountId: string; trial?: { graduation: 'MANUAL'; try: 1 | 2; group: string } }[]) {
  const publishedAt = new Date(Date.now() - 3 * DAY).toISOString()
  const versions: Record<string, Record<string, unknown>> = {}
  for (const p of posts) {
    versions[`v${p.version}`] ??= {}
    versions[`v${p.version}`][p.platform === 'tiktok' ? `tiktok:${p.postId}` : p.postId] = {
      version: p.version, platform: p.platform, postId: p.postId, accountId: p.accountId, apiVersion: p.platform === 'tiktok' ? 'v2' : 'v26.0',
      publishedAt, observedAt: null, metrics: null, ...(p.trial ? { trial: p.trial } : {})
    }
  }
  writeFileSync(join(dir, 'outcomes.json'), JSON.stringify({ schemaVersion: 1, versions }, null, 2))
}

test('Insights: results read, explained and opened at the posted version', async () => {
  test.setTimeout(15 * 60_000)
  if (existsSync(FIXTURE)) rmSync(FIXTURE)
  const media = makeMedia()
  // REELSTUDIO_MOCK_NOTE connects the practice editor, so a note makes Version 2
  const { app, page } = await launch({ REELSTUDIO_TEST_RESULTS: FIXTURE, REELSTUDIO_MOCK_NOTE: '300' })
  try {
    await passFirstRun(page)

    // ---- nothing connected: the page says what it will show and where to connect ----
    // fails if the empty page loses its way to Settings › Posting
    await page.getByTestId('nav-insights').click()
    await expect(page.getByTestId('insights-empty')).toContainText('Connect Instagram, TikTok or Facebook first.')
    await shot(page, 'insights-01-empty')
    await page.getByTestId('insights-connect').click()
    await expect(page.locator('#sec-posting')).toBeInViewport()

    // ---- two reels; the first gets a Version 2 from a note, so its posted Version 1 is an older one ----
    let before = projectFolders(root())
    await makeReel(page, media.video)
    const first = newProjectFolder(root(), before)
    await page.getByTestId('note-input').fill('make the subtitles bigger')
    await page.getByTestId('send').click()
    await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 4 * 60_000 })
    before = projectFolders(root())
    await makeReel(page, media.video)
    const second = newProjectFolder(root(), before)
    // the name Insights shows: the reel's title, or its folder's name before it has one (main index.ts describe)
    const title = (dir: string) => (JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')).title as string) || basename(dir)

    // Version 1 of the first reel went to Instagram as two trial reels (Try 1 and Try 2, the tag Instagram publishing
    // saves) and to TikTok; the second reel to Instagram.
    recordPosts(first, [
      { version: 1, platform: 'instagram', postId: '9001', accountId: '17', trial: { graduation: 'MANUAL', try: 1, group: 'cap-test' } },
      { version: 1, platform: 'instagram', postId: '9002', accountId: '17', trial: { graduation: 'MANUAL', try: 2, group: 'cap-test' } },
      { version: 1, platform: 'tiktok', postId: '7001', accountId: 'tt-1' }
    ])
    recordPosts(second, [{ version: 1, platform: 'instagram', postId: '9101', accountId: '17' }])
    const followers = {
      age: [{ key: '25-34', value: 410 }, { key: '18-24', value: 300 }], gender: [{ key: 'F', value: 620 }, { key: 'M', value: 330 }],
      country: [{ key: 'US', value: 500 }, { key: 'GB', value: 200 }, { key: 'CA', value: 100 }], city: []
    }
    const platforms = {
      instagram: { accountId: '17', followers, posts: {
        '9001': { plays: 410, reach: 380, averageWatchTimeMs: 4200, skipRatePercent: 31, shares: 3, saves: 5 },
        '9002': { plays: 640, reach: 600, averageWatchTimeMs: 5100, skipRatePercent: 24, shares: 9, saves: 12 },
        '9101': { plays: 2300, reach: 2100, averageWatchTimeMs: 7000, skipRatePercent: 18, shares: 40, saves: 61 }
      } },
      tiktok: { accountId: 'tt-1', posts: { '7001': { plays: 980, likes: 70, comments: 4, shares: 6 } } }
    }
    writeFileSync(FIXTURE, JSON.stringify(platforms))
    // usage data with Post results on: each read past a snapshot age becomes one views line (main/usage.ts postViews)
    await page.evaluate(() => window.reel.app.setSharing({ asked: true, on: true, usage: false, quality: false, posts: true }))

    // ---- opening Insights reads the results on its own (connected, never read) ----
    // fails if a connected account's first visit shows "Connect" or no numbers until the hourly read
    await page.getByTestId('nav-insights').click()
    const rows = page.getByTestId('insights-reel')
    await expect(rows).toHaveCount(2, { timeout: 30_000 })
    await expect(page.getByTestId('insights-fresh')).toContainText('Updated just now')
    // fails if the readout stops naming the reel that did best, by views, in words
    await expect(page.getByTestId('insights-readout')).toContainText(`${title(second)} did best, with 2,300 views.`)
    const firstRow = page.locator(`[data-testid="insights-reel"][data-project="${basename(first)}"]`)
    // Instagram's two tries and TikTok add up on the version that was posted
    await expect(firstRow).toContainText('Version 1 · Instagram and TikTok')
    await expect(firstRow).toContainText('2,030')
    // fails if a posted version's edit checks don't sit beside its results, with what failed named (the stand-in engine's
    // score reports its unnormalized sound as off target: app/dev/fake-engine score)
    await expect(firstRow.getByTestId('insights-checks')).toHaveText(' · 2 of 3 checks pass')
    await expect(firstRow.getByTestId('insights-checks-off')).toHaveText('In the edit: loudness −19.6 LUFS, off target.')
    // fails if the trial's verdict isn't the trial rule's, or its reason isn't shown
    const trial = page.getByTestId('insights-trial')
    await expect(trial.getByTestId('insights-verdict')).toHaveText('Try 2 won')
    await expect(trial).toContainText('Try 1 got 410 views and Try 2 got 640.')
    await expect(trial).toContainText('tap Share to everyone')
    await expect(page.getByTestId('insights-audience')).toContainText('Most of your Instagram followers are 25-34')
    await expect(page.getByTestId('insights-audience')).toContainText('Top places: United States, United Kingdom and Canada.')
    await shot(page, 'insights-02-results')
    // fails if post results stop reaching usage data, or a line carries a post or account id
    const views = (await page.evaluate(() => window.reel.app.usage())).filter((l) => l.name === 'views')
    expect(views.map((l) => 'views' in l && l.views).sort()).toEqual([2300, 410, 640, 980].sort())
    for (const l of views) expect(Object.keys(l).sort()).toEqual(['app', 'day', 'hours', 'install', 'name', 'os', 'part', 'platform', 'views'])
    // the trial tag survives the read, so the pair stays a pair on the next visit
    const saved = JSON.parse(readFileSync(join(first, 'outcomes.json'), 'utf8'))
    expect(saved.versions.v1['9002']).toMatchObject({ trial: { group: 'cap-test', try: 2 }, metrics: { plays: 640 } })

    // ---- a row opens its reel at the posted version, not the newest ----
    // fails if Insights opens Version 2 when Version 1 is the one with these results
    await firstRow.getByTestId('insights-open').click()
    await expect(page.getByTestId('version-on-screen')).toHaveText('Version 1')
    await expect(page.getByTestId('version-latest')).toBeVisible()

    // ---- a rate limit: the page says when it tries again, and the numbers it has stay ----
    writeFileSync(FIXTURE, JSON.stringify({ ...platforms, instagram: { ...platforms.instagram, rateLimited: true } }))
    await page.getByTestId('nav-insights').click()
    await expect(rows).toHaveCount(2)
    await page.getByTestId('insights-refresh').click()
    await expect(page.getByTestId('insights-note-instagram')).toContainText('Instagram asked to slow down. Reading again after')
    await expect(page.getByTestId('insights-readout')).toContainText('2,300 views')
    await shot(page, 'insights-03-rate-limited')
  } finally {
    await app.close()
  }
})

// No results yet: the page says so at the top, and Your recent reels sits right under it on the same edge (it was left at
// the window's foot with half a screen of nothing above it).
test('fails if, on an empty Insights page, Your recent reels is not right under the empty state on its left edge', async () => {
  // a profile of its own: the file's shared one has the first test's posted reels, so its page is not empty
  const dirs = { REELSTUDIO_USER_DATA: join(BASE, 'insights-empty', 'data'), REELSTUDIO_ROOT: join(BASE, 'insights-empty', 'Reel Studio') }
  const { app, page } = await launch(dirs, { realViewport: true })
  try {
    await passFirstRun(page)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900))
    await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual([1440, 900])
    await page.getByTestId('nav-insights').click()
    const empty = page.getByTestId('insights-empty')
    const recent = page.getByTestId('recent-reels')
    await expect(empty).toBeVisible()
    await expect(recent).toBeVisible()
    // what is drawn, not the boxes (a box can stretch over empty space): each heading's left, the message's last line
    const heading = (el: typeof empty) => el.locator('h2').evaluate((h) => h.getBoundingClientRect().left)
    const lastLine = await empty.evaluate((el) => (el.lastElementChild as HTMLElement).getBoundingClientRect().bottom)
    const recentTop = await recent.locator('h2').evaluate((h) => h.getBoundingClientRect().top)
    expect(Math.abs((await heading(empty)) - (await heading(recent)))).toBeLessThan(2)
    expect(recentTop - lastLine).toBeLessThan(80)
  } finally {
    await app.close()
  }
})
