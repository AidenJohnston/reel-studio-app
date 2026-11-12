// Manifesto gate 1: the choices from a fresh install to an exported reel, three or fewer. The walk goes from a new
// profile to a saved reel the shortest way a person would, and stops wherever the screen waits on them. A stop with
// more than one way on, or a video to pick, is a decision; a stop with one button is a press; waiting is neither.
// The ways are read off the screen at each stop, so a new button on the way shows up in the list.
import { test, expect, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, SHOTS, launch, makeMedia, shot } from './helpers'

type Stop = { name: string; kind: 'decision' | 'press'; ways: string[] }

/** The enabled controls a person can see in these places, by their names. */
async function waysIn(page: Page, selectors: string[]): Promise<string[]> {
  return page.evaluate((sels) => {
    const seen = new Set<Element>()
    const out: string[] = []
    for (const sel of sels)
      for (const box of Array.from(document.querySelectorAll(sel))) {
        const all = box.matches('button, a[href], textarea, input') ? [box] : Array.from(box.querySelectorAll('button, a[href], textarea, input:not([type=hidden]):not([type=file])'))
        for (const el of all) {
          if (seen.has(el)) continue
          seen.add(el)
          const h = el as HTMLElement
          if (h.closest('[inert], [aria-hidden="true"], [hidden]') || (h as HTMLButtonElement).disabled) continue
          if (!h.getClientRects().length || getComputedStyle(h).visibility === 'hidden') continue
          out.push((h.getAttribute('aria-label') || h.innerText || h.getAttribute('placeholder') || h.tagName).replace(/\s+/g, ' ').trim())
        }
      }
    return out
  }, selectors)
}

const shown = (page: Page, sel: string) =>
  page
    .locator(sel)
    .first()
    .isVisible()
    .catch(() => false)

/** Where the walk is: the first of these the window shows. */
async function where(page: Page): Promise<string> {
  if (await shown(page, '[data-testid="share-pop"]')) return 'share'
  if (await shown(page, '[data-testid="log-play-1"]')) return 'ready'
  if (await shown(page, '[data-testid="planned-stage"]')) return 'pick'
  if (await shown(page, '[data-testid="ai-setup"]')) return 'ai-setup'
  if (await shown(page, '.fr-welcome:not(.leaving)')) return 'welcome'
  if (await shown(page, '[data-testid="first-run-mac"]')) return 'mac'
  if ((await shown(page, '[data-testid="not-now"]')) || (await shown(page, '[data-testid="editor-continue"]'))) return 'editor'
  if (await shown(page, '[data-testid="demo-next"]')) return 'sample-done'
  if (await shown(page, '[data-testid="demo-skip"]')) return 'sample'
  return 'waiting'
}

function freshProfile(name: string): { root: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(BASE, `first-reel-${name}-`))
  const root = join(dir, 'Zoë Müller', 'Documents', 'Reel Studio')
  return { root, env: { REELSTUDIO_USER_DATA: join(dir, 'user data'), REELSTUDIO_ROOT: root, REELSTUDIO_MODELS_DIR: join(dir, 'models') } }
}

/** Walks from a fresh install to an exported reel and returns every stop on the way. */
async function walk(variant: string, env: Record<string, string>, size: { width: number; height: number }): Promise<Stop[]> {
  const media = makeMedia()
  const profile = freshProfile(variant)
  const { app, page } = await launch({ ...profile.env, ...env })
  await page.setViewportSize(size)
  const stops: Stop[] = []
  const stop = async (name: string, selectors: string[], kind?: Stop['kind']) => {
    const ways = await waysIn(page, selectors)
    stops.push({ name, kind: kind ?? (ways.length > 1 ? 'decision' : 'press'), ways })
    await shot(page, `first-reel-${variant}-${stops.length}-${name.replace(/[^a-z]+/gi, '-').toLowerCase()}`)
  }
  const exports = join(profile.root, 'Library', 'Exports')
  const saved = () => existsSync(exports) && readdirSync(exports).some((f) => f.endsWith('.mp4'))
  try {
    const deadline = Date.now() + 280_000
    let last = ''
    while (!saved()) {
      expect(Date.now(), `stuck at "${last}" after ${stops.map((s) => s.name).join(', ')}`).toBeLessThan(deadline)
      const at = await where(page)
      last = at
      if (at === 'welcome') {
        const pick = page.locator('.fr-welcome input[type=file]')
        if (await pick.count()) {
          await stop('Pick the video', ['.fr-welcome'], 'decision')
          await pick.setInputFiles([media.video])
        } else {
          await stop('Welcome', ['.fr-welcome'])
          await page.getByTestId('get-started').click()
        }
      } else if (at === 'sample') {
        // the sample plays on its own and ends by itself; Skip only saves the wait
        await page.getByTestId('demo-skip').click()
      } else if (at === 'sample-done') {
        await stop('After the sample', ['.fr-foot'])
        await page.getByTestId('demo-next').click()
      } else if (at === 'mac') {
        await stop('Notifications', ['.fr-col'], 'decision')
        await page.getByTestId('mac-skip').or(page.getByTestId('mac-continue')).click()
      } else if (at === 'editor') {
        await stop('Choose your editor', ['.fr-col'])
        await page.getByTestId('editor-continue').or(page.getByTestId('not-now')).click()
      } else if (at === 'pick') {
        await stop('Pick the video', ['[data-testid="drop-zone"]', '[data-testid="plan-connect-step"]'], 'decision')
        await page.getByTestId('planned-stage').getByTestId('file-input').setInputFiles([media.video])
      } else if (at === 'ready') {
        const share = page.getByTestId('share')
        await expect(share).toBeEnabled({ timeout: 120_000 })
        await stop('Keep the draft or say what to change', ['[data-testid="share"]', '[data-testid="edit-myself"]', '[data-testid="note-input"]', '[data-testid="composer-connect"]'], 'decision')
        await share.click()
      } else if (at === 'share') {
        await stop('Post it or save it', ['[data-testid="share-pop"] .sp-main ul'], 'decision')
        await page.getByTestId('share-finder').click()
        await expect(page.getByTestId('share-pop')).toContainText('.mp4', { timeout: 120_000 })
      } else if (at === 'ai-setup') {
        throw new Error('AI setup showed on the way to a first reel; it belongs where it first helps, such as the first typed note')
      } else {
        await page.waitForTimeout(250)
      }
    }
  } finally {
    await app.close().catch(() => {})
  }
  return stops
}

function record(variant: string, stops: Stop[]): void {
  mkdirSync(SHOTS, { recursive: true })
  writeFileSync(join(SHOTS, `first-reel-${variant}.json`), JSON.stringify(stops, null, 2))
  const decisions = stops.filter((s) => s.kind === 'decision')
  console.log(`[first-reel ${variant}] ${decisions.length} decisions, ${stops.length - decisions.length} presses`)
  for (const [i, s] of stops.entries()) console.log(`[first-reel ${variant}] ${i + 1}. ${s.kind}: ${s.name} (ways: ${s.ways.join(' | ') || 'none'})`)
}

test.describe('decisions to a first reel', () => {
  test.setTimeout(320_000)

  test('with no AI connected, at 1440 x 900', async () => {
    const stops = await walk('no-ai', {}, { width: 1440, height: 900 })
    record('no-ai', stops)
    expect(stops.filter((s) => s.kind === 'decision').map((s) => s.name)).toEqual(['Pick the video', 'Keep the draft or say what to change', 'Post it or save it'])
    expect(stops.filter((s) => s.kind === 'press').map((s) => s.name)).toEqual([])
  })

  test('with an AI connected, at the smallest window', async () => {
    const stops = await walk('ai', { REELSTUDIO_MOCK_NOTE: '400', REELSTUDIO_MOCK_FIRST_EDIT: 'editor' }, { width: 1100, height: 720 })
    record('ai', stops)
    expect(stops.filter((s) => s.kind === 'decision').map((s) => s.name)).toEqual(['Pick the video', 'Keep the draft or say what to change', 'Post it or save it'])
    expect(stops.filter((s) => s.kind === 'press').map((s) => s.name)).toEqual([])
  })
})
