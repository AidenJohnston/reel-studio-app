// Insights > Your recent reels, end to end with the stand-in engine: three reels with saved post results (written as
// the result readers save them, outcomes.json), the report on request, and "Try this edit" opening the reel with the
// note written and unsent. One reel's render is given a long tail so the edit offered is known.
//
// Run: npm run build && npx playwright test e2e/recent-reels.spec.ts
import { test, expect } from '@playwright/test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, makeReel, openSettings, passFirstRun, SHOTS } from './helpers'

const MINE = mkdtempSync(join(BASE, 'recent-'))
const ROOT = join(MINE, 'Documents', 'Reel Studio')
const projects = (): string[] => readdirSync(join(ROOT, 'Projects')).filter((s) => !s.startsWith('.'))

function saveResults(slug: string, n: number, m: { plays: number; watchMs: number; shares: number }): void {
  const publishedAt = `2026-10-${String(10 + n).padStart(2, '0')}T10:00:00.000Z`
  const post = {
    version: 1, postId: `1789${n}`, accountId: '17841', platform: 'instagram', apiVersion: 'v26.0', publishedAt,
    observedAt: '2026-10-30T10:00:00.000Z',
    metrics: { plays: m.plays, reach: m.plays, averageWatchTimeMs: m.watchMs, shares: m.shares, saves: 2, comments: 1 }
  }
  writeFileSync(join(ROOT, 'Projects', slug, 'outcomes.json'), JSON.stringify({ schemaVersion: 1, versions: { v1: { [post.postId]: post } } }))
}

test('the recent reels report names the shared reel, and Try this edit writes the note without sending it', async () => {
  test.setTimeout(15 * 60_000)
  const media = makeMedia()
  // The mock plays a connected Claude Code app: the note box only shows with an editor connected.
  const { app, page } = await launch({ REELSTUDIO_ROOT: ROOT, REELSTUDIO_USER_DATA: join(MINE, 'user data'), REELSTUDIO_MOCK_CLAUDE: 'ready', FAKE_ENGINE_SLOW: '1' })
  try {
    test.skip((await page.evaluate(() => window.reel.app.info())).ai !== 'mock', 'the mock plays the connected AI')
    await passFirstRun(page)
    await openSettings(page)
    await page.getByTestId('use-claude-code').click()
    await expect(page.getByTestId('ai-connected')).toBeVisible()
    const made: string[] = []
    for (let i = 0; i < 3; i++) {
      const before = projects()
      await page.getByTestId('nav-home').click()
      await makeReel(page, media.video)
      made.push(projects().find((s) => !before.includes(s))!)
    }
    saveResults(made[0], 1, { plays: 1200, watchMs: 6000, shares: 3 })
    saveResults(made[1], 2, { plays: 900, watchMs: 2500, shares: 45 })
    saveResults(made[2], 3, { plays: 1500, watchMs: 7000, shares: 4 })
    const render = join(ROOT, 'Projects', made[1], 'versions', 'v1', 'render.json')
    const r = JSON.parse(readFileSync(render, 'utf8'))
    writeFileSync(render, JSON.stringify({ ...r, duration: r.duration + 3 }))

    await page.getByTestId('nav-insights').click()
    await expect(page.getByTestId('recent-reels')).toContainText('Nothing is sent anywhere')
    await page.getByTestId('recent-look').click()
    const report = page.getByTestId('recent-report')
    await expect(report).toBeVisible()
    await expect(report).toContainText('People pass on')
    await expect(report).toContainText('45 shares from 900 plays')
    await page.screenshot({ path: join(SHOTS, 'recent-reels-01-report.png') })

    // The second reel's render runs 3 s past its last word (its render.json says so, as a render with a long tail
    // would), and people watched least of it, so its edit is "End on your last word".
    const edit = page.getByTestId('recent-edit')
    await expect(edit).toContainText('after your last word')
    const note = await page.evaluate(() => window.reel.wrapped.report().then((r) => (r.state === 'ready' && r.edit ? r.edit.note : null)))
    expect(note).toMatch(/^End the reel on my last word: cut the [\d.]+ s after it\.$/)
    await page.getByTestId('recent-try').click()
    await expect(page.getByTestId('note-input')).toHaveValue(note!)
    await page.screenshot({ path: join(SHOTS, 'recent-reels-02-try-this-edit.png') })
    // written, not sent: the note isn't in the reel's chat or project, and nothing is running
    await expect(page.getByTestId('chat')).not.toContainText('End the reel on my last word')
    expect(readFileSync(join(ROOT, 'Projects', made[1], 'project.json'), 'utf8')).not.toContain('End the reel on my last word')
    await expect(page.getByTestId('note-progress')).toHaveCount(0)
  } finally {
    await app.close()
  }
})
