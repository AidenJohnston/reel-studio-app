// The UI climb's screenshot set: the same named scenes every run, from a first run to a shared reel, at a laptop
// window and the smallest window the app allows, each with the consistency audit (layout-audit/consistency.ts) and
// the Space metrics beside it. Not a behaviour test; skipped unless asked for.
//
//   REELSTUDIO_CLIMB_OUT=<folder>       where <scene>@<w>x<h>.png, audit.json and metrics.json go
//   REELSTUDIO_CLIMB_SCENES=a,b         only these scenes (the path to them still runs)
//
// Every scene comes from the stand-in engine, the practice editor and one generated take, so two runs of one build
// show the same screens.
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BASE, launch, makeMedia, modelReady, startReel, toEditorStep } from './helpers'
import { auditConsistency, type ConsistencyFinding } from './layout-audit/consistency'
import { CONSISTENCY_ALLOW, SCALE } from './layout-audit/consistency-allow'

const OUT = process.env.REELSTUDIO_CLIMB_OUT
const ONLY = process.env.REELSTUDIO_CLIMB_SCENES ? new Set(process.env.REELSTUDIO_CLIMB_SCENES.split(',')) : null
/** A creator's laptop, and the window's minimum (main/window.ts MIN). */
const SIZES: [number, number][] = [
  [1440, 900],
  [1100, 720]
]

test.skip(!OUT, 'set REELSTUDIO_CLIMB_OUT to run')

type Ctx = { app: ElectronApplication; page: Page; gate: (n: number) => void }
interface Scene {
  id: string
  enter: (c: Ctx) => Promise<void>
  /** On screen when the scene is: checked after each resize, and the scene is entered again if it went away. */
  ready: (page: Page) => Locator
}

async function setSize(c: Ctx, [w, h]: [number, number]): Promise<void> {
  await c.app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win.isFullScreen()) win.setFullScreen(false)
    win.setContentSize(s.w, s.h)
  }, { w, h })
  await expect.poll(() => c.page.evaluate(() => [innerWidth, innerHeight]), { timeout: 5000 }).toEqual([w, h])
  await settle(c.page)
}

/** Until finite animations end (at most 1.5 s), then two frames: measure what the person ends up seeing. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    await frame()
    const end = Date.now() + 1500
    while (Date.now() < end) {
      const running = document.getAnimations().filter((a) => {
        const t = a.effect?.getComputedTiming()
        return a.playState === 'running' && !!t && Number.isFinite(t.endTime as number) && (t.endTime as number) < 5000
      })
      if (!running.length) break
      await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => null))), new Promise((r) => setTimeout(r, 300))])
    }
    await frame()
    await frame()
  })
}

/** Space metrics: how much of the window the video gets, the widest band that carries nothing, and the scale in use. */
function spaceMetrics(): Record<string, unknown> {
  const W = innerWidth
  const H = innerHeight
  const video = Array.from(document.querySelectorAll('video')).map((v) => v.getBoundingClientRect()).filter((r) => r.width > 40 && r.height > 40)
  const biggest = video.sort((a, b) => b.width * b.height - a.width * a.height)[0]
  // content: text, controls, media and painted surfaces; the page and sidebar backgrounds are not content
  const content: DOMRect[] = []
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const s = getComputedStyle(el)
    if (s.visibility === 'hidden' || s.display === 'none' || parseFloat(s.opacity) === 0) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= W || r.top >= H) continue
    if (r.width >= W * 0.9 && r.height >= H * 0.9) continue
    const text = Array.from(el.childNodes).some((n) => n.nodeType === 3 && /\S/.test(n.textContent ?? ''))
    const media = /^(VIDEO|IMG|CANVAS|svg|INPUT|BUTTON|TEXTAREA|SELECT)$/.test(el.tagName)
    const bg = s.backgroundColor
    const fill = bg && bg !== 'transparent' && !/rgba\(\d+, \d+, \d+, 0\)/.test(bg) && !(r.height >= H * 0.8 && r.width < W * 0.3)
    if (text || media || fill) content.push(r)
  }
  const band = (n: number, along: (r: DOMRect) => [number, number]) => {
    const used = new Uint8Array(n)
    for (const r of content) {
      const [a, b] = along(r)
      for (let i = Math.max(0, Math.floor(a)); i < Math.min(n, Math.ceil(b)); i++) used[i] = 1
    }
    let best = 0
    let run = 0
    for (let i = 0; i < n; i++) {
      run = used[i] ? 0 : run + 1
      best = Math.max(best, run)
    }
    return best
  }
  return {
    window: [W, H],
    videoShareOfWindow: biggest ? Math.round(((biggest.width * biggest.height) / (W * H)) * 1000) / 1000 : null,
    videoHeightShare: biggest ? Math.round((biggest.height / H) * 1000) / 1000 : null,
    widestEmptyColumn: band(W, (r) => [r.left, r.right]),
    widestEmptyRow: band(H, (r) => [r.top, r.bottom])
  }
}

const byTestId = (id: string) => (page: Page) => page.getByTestId(id).first()
async function closeAll(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[role="menu"], [aria-modal="true"], [data-testid="full-stage"], [data-testid="share-pop"], [data-testid="drawer"]').count())) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
  }
}
async function openReel(page: Page, failed = false): Promise<void> {
  await closeAll(page)
  if (!failed && (await page.getByTestId('log-play-2').isVisible())) return
  await page.getByTestId('nav-home').click()
  // a card's button carries its title and state in its name and data-state (Home.tsx), not in its text
  await page.locator(failed ? '[data-testid="project-card"][data-state="failed"]' : '[data-testid="project-card"][aria-label*="My first take"]').first().click()
}
async function openTab(page: Page, key: string): Promise<void> {
  await openReel(page)
  if (!(await page.getByTestId('drawer').isVisible())) await page.getByTestId('edit-myself').click()
  await page.getByTestId(`tab-${key}`).click()
}
async function settingsAt(page: Page, key: string): Promise<void> {
  await closeAll(page)
  if (!(await page.getByTestId('settings-search').isVisible())) await page.getByTestId('account').click()
  await page.getByTestId(`settings-nav-${key}`).click()
}
async function note(page: Page, text: string): Promise<void> {
  await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement | null)?.pause())
  await page.getByTestId('note-input').fill(text)
  await expect(page.getByTestId('send')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('note-input').press('Enter')
}
/** The main process's environment reaches every engine run it starts (main/engine.ts cfg.env). */
async function engineEnv(app: ElectronApplication, patch: Record<string, string>): Promise<void> {
  await app.evaluate((_e, p) => Object.assign(process.env, p), patch)
}

const SCENES: Scene[] = [
  { id: 'first-run-welcome', enter: async () => {}, ready: byTestId('get-started') },
  {
    id: 'first-run-sample',
    enter: async ({ page }) => {
      await page.getByTestId('get-started').click()
      await page.waitForTimeout(4000)
    },
    ready: byTestId('sample-phone')
  },
  {
    id: 'first-run-editor',
    enter: async ({ page }) => {
      if (await page.getByTestId('demo-skip').isVisible()) await page.getByTestId('demo-skip').click()
      await toEditorStep(page)
      await modelReady(page)
    },
    ready: byTestId('ai-picker')
  },
  {
    id: 'new-reel',
    enter: async ({ page }) => {
      await page.getByTestId('not-now').or(page.getByTestId('editor-continue')).click()
    },
    ready: byTestId('planned-stage')
  },
  {
    id: 'home-empty',
    enter: async ({ page }) => {
      await page.getByTestId('nav-home').click()
      await page.evaluate(async () => {
        for (const p of await window.reel.projects.list()) await window.reel.projects.remove(p.slug)
      })
      await page.reload()
    },
    ready: byTestId('reels-empty')
  },
  {
    // Sam's screenshot (uiclimb-runs/sam-feedback/01): the first edit running, the step list open
    id: 'reel-first-edit',
    enter: async ({ app, page }) => {
      await engineEnv(app, { FAKE_ENGINE_SLOW_RENDER: '40' })
      await startReel(page, MEDIA.video)
      await expect(page.getByTestId('steps-list')).toBeVisible({ timeout: 120_000 })
      await expect(page.locator('.heard, [data-testid=heard]').first()).toBeVisible({ timeout: 120_000 }).catch(() => {})
      await page.waitForTimeout(6000)
    },
    ready: byTestId('steps-list')
  },
  {
    id: 'reel-draft',
    enter: async ({ app, page }) => {
      await engineEnv(app, { FAKE_ENGINE_SLOW_RENDER: '0' })
      await expect(page.getByTestId('log-play-1')).toBeVisible({ timeout: 240_000 })
      await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement | null)?.pause())
    },
    ready: byTestId('log-play-1')
  },
  {
    id: 'reel-note-running',
    enter: async ({ page, gate }) => {
      await note(page, 'make the subtitles bigger here')
      gate(0)
      await expect(page.getByTestId('change-tag')).toBeVisible({ timeout: 90_000 })
      gate(1)
      await page.waitForTimeout(1500)
    },
    ready: byTestId('note-progress')
  },
  {
    id: 'reel-versions',
    enter: async ({ page, gate }) => {
      for (const n of [2, 3, 4, 5, 6]) gate(n)
      await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 240_000 })
      await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 120_000 })
      await page.evaluate(() => (document.querySelector('[data-testid=player]') as HTMLVideoElement | null)?.pause())
    },
    ready: byTestId('log-play-2')
  },
  {
    id: 'reel-compare',
    enter: async ({ page }) => {
      if (!(await page.getByTestId('done-compare').isVisible())) await page.getByTestId(/^compare-\d+$/).last().click()
    },
    ready: byTestId('done-compare')
  },
  ...(['cut', 'captions', 'music', 'broll', 'cover'] as const).map(
    (key): Scene => ({
      id: `edit-${key}`,
      enter: async ({ page }) => {
        if (await page.getByTestId('done-compare').isVisible()) await page.getByTestId('done-compare').click()
        await openTab(page, key)
      },
      ready: (page) => page.locator(`[data-testid="tab-${key}"][aria-selected="true"], [data-testid="tab-${key}"].active`).first()
    })
  ),
  {
    id: 'share',
    enter: async ({ page }) => {
      await openReel(page)
      if (!(await page.getByTestId('share-pop').isVisible())) await page.getByTestId('share').click()
    },
    ready: byTestId('share-pop')
  },
  {
    id: 'share-other',
    enter: async ({ page }) => {
      if (!(await page.getByTestId('share-pop').isVisible())) {
        await openReel(page)
        await page.getByTestId('share').click()
      }
      const toggle = page.getByTestId('share-platforms-toggle')
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    },
    ready: byTestId('share-platforms')
  },
  {
    // a take with no sound: the engine refuses it, and Reels shows why
    id: 'home-reels',
    enter: async ({ page }) => {
      await closeAll(page)
      await startReel(page, SILENT)
      await expect(page.getByTestId('stage-failed')).toBeVisible({ timeout: 120_000 })
      await page.getByTestId('nav-home').click()
    },
    ready: byTestId('project-card')
  },
  {
    id: 'reel-failed',
    enter: async ({ page }) => openReel(page, true),
    ready: byTestId('stage-failed')
  },
  { id: 'library', enter: async ({ page }) => (await closeAll(page), await page.getByTestId('nav-library').click()), ready: (page) => page.locator('[data-testid^="library-tab-"]').first() },
  { id: 'my-style', enter: async ({ page }) => page.getByTestId('nav-style').click(), ready: (page) => page.locator('main.main') },
  { id: 'insights', enter: async ({ page }) => page.getByTestId('nav-insights').click(), ready: (page) => page.locator('main.main') },
  { id: 'settings-editor', enter: async ({ page }) => settingsAt(page, 'editor'), ready: (page) => page.locator('[data-testid="settings-nav-editor"][aria-current="true"]') },
  { id: 'settings-reels', enter: async ({ page }) => settingsAt(page, 'reels'), ready: (page) => page.locator('[data-testid="settings-nav-reels"][aria-current="true"]') },
  { id: 'settings-about', enter: async ({ page }) => settingsAt(page, 'about'), ready: (page) => page.locator('[data-testid="settings-nav-about"][aria-current="true"]') }
]

let MEDIA: ReturnType<typeof makeMedia>
let SILENT = ''

test('climb scenes at two sizes', async () => {
  test.setTimeout(30 * 60_000)
  MEDIA = makeMedia()
  SILENT = join(BASE, 'my files ü', 'no sound.mp4')
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=540x960:rate=30:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', SILENT])
  const gateDir = join(BASE, 'moments-gate')
  mkdirSync(gateDir, { recursive: true })
  const { app, page } = await launch({ REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_MOCK_NOTE: '400', REELSTUDIO_MOCK_MOMENTS: '1', FAKE_ENGINE_SLOW: '1', FAKE_ENGINE_MOMENTS_GATE: gateDir }, { realViewport: true })
  const ctx: Ctx = { app, page, gate: (n) => writeFileSync(join(gateDir, `go-${n}`), '') }
  const audit: Record<string, { findings: ConsistencyFinding[]; allowed: number; distinct: unknown }> = {}
  const metrics: Record<string, unknown> = {}
  const unreached: Record<string, string> = {}
  mkdirSync(OUT!, { recursive: true })
  try {
    for (const scene of SCENES) {
      try {
        await setSize(ctx, SIZES[0])
        await scene.enter(ctx)
        await expect(scene.ready(page)).toBeVisible({ timeout: 30_000 })
      } catch (e) {
        unreached[scene.id] = String(e instanceof Error ? e.message : e).replace(/\u001b\[\d+m/g, '').split('\n').filter((l) => /\S/.test(l)).slice(0, 3).join(' ').slice(0, 300)
        continue
      }
      if (ONLY && !ONLY.has(scene.id)) continue
      for (const size of SIZES) {
        await setSize(ctx, size)
        if (!(await scene.ready(page).isVisible())) {
          unreached[`${scene.id}@${size.join('x')}`] = 'went away after the resize'
          continue
        }
        const name = `${scene.id}@${size[0]}x${size[1]}`
        // the text caret blinks: keep it out of the picture so two runs match
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
        await page.mouse.move(size[0] - 2, size[1] - 2)
        await settle(page)
        await page.screenshot({ path: join(OUT!, `${name}.png`), scale: 'css' })
        audit[name] = await page.evaluate(auditConsistency, { allow: CONSISTENCY_ALLOW.filter((a) => !a.scenes || a.scenes.includes(scene.id)), scale: SCALE })
        metrics[name] = await page.evaluate(spaceMetrics)
      }
    }
  } finally {
    writeFileSync(join(OUT!, 'audit.json'), JSON.stringify(audit, null, 1))
    writeFileSync(join(OUT!, 'metrics.json'), JSON.stringify(metrics, null, 1))
    writeFileSync(join(OUT!, 'unreached.json'), JSON.stringify(unreached, null, 1))
    await app.close()
  }
  const total = Object.values(audit).reduce((n, a) => n + a.findings.length, 0)
  console.log(`climb: ${Object.keys(audit).length} shots, ${total} consistency findings, ${Object.keys(unreached).length} unreached`)
  // the gate before any judging: every scene reached, nothing off the system that the allowlist doesn't explain
  expect(unreached, 'scenes not reached').toEqual({})
  expect(total, 'consistency findings (audit.json)').toBe(0)
})
