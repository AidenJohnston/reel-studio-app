// The UI climb's screenshot set: the same named scenes every run, from a first run to a shared reel, at a laptop
// window and the smallest window the app allows, each with the consistency audit (layout-audit/consistency.ts) and
// the Space metrics beside it. Not a behaviour test; skipped unless asked for.
//
//   REELSTUDIO_CLIMB_OUT=<folder>       where <scene>@<w>x<h>.png, audit.json and metrics.json go
//   REELSTUDIO_CLIMB_SCENES=a,b         only these scenes (the path to them still runs)
//
// Every scene comes from the stand-in engine and the practice editor, so two runs of one build show the same screens.
// The take is the first run's sample (someone talking about bread, assets/sample/raw.mp4) with its own words and cuts,
// and the practice editor makes the first edit an editor makes: the screens read as they do for a person, not a test.
import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TRANSCRIPT } from '../src/renderer/src/components/first-run/sample'
import { SIZE_PER_EM } from '../src/shared/caption-fit'
import { createHash } from 'node:crypto'
import { BASE, expectViewport, launch, makeMedia, modelReady, startReel, toEditorStep } from './helpers'
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
  /** A state the shot must keep (focus, the pointer over something): set again after each resize, in place of the
   * blur and the pointer parked in the corner every other shot gets. */
  pose?: (page: Page) => Promise<void>
}

async function setSize(c: Ctx, [w, h]: [number, number]): Promise<void> {
  await c.app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win.isFullScreen()) win.setFullScreen(false)
    win.setContentSize(s.w, s.h)
  }, { w, h })
  await expectViewport(c.page, w, h, 5000)
  await settle(c.page)
}

/**
 * The pointer out of the way, with nothing under it. A resize can leave a row hovered (the share panel's first row
 * kept its wash at 1100 px with the pointer parked in the corner), so it moves again until no control is hovered,
 * and the shot fails loudly rather than judging a hover nobody asked for.
 */
async function parkPointer(page: Page, [w, h]: [number, number]): Promise<void> {
  const hovered = () => page.evaluate(() => document.querySelector(':is(button, a, input, select, textarea, label, [role="button"], [role="menuitem"], [role="tab"], [role="option"], [role="radio"], [role="checkbox"], [role="switch"], [role="link"]):hover')?.outerHTML.slice(0, 120) ?? null)
  for (const [x, y] of [[w - 2, h - 2], [w - 3, h - 3], [w - 2, h - 40], [2, h - 2]]) {
    await page.mouse.move(x, y)
    // checked once what the move set off has settled: the stray hover came back after the move, not before it
    await settle(page)
    if (!(await hovered())) return
  }
  throw new Error(`a control stays hovered with the pointer parked: ${await hovered()}`)
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
  // a menu opened with the pointer keeps focus on its trigger, where Escape does not reach it: its trigger closes it
  for (const trigger of ['view-menu', 'more']) {
    const t = page.getByTestId(trigger)
    if ((await t.count()) && (await t.getAttribute('aria-expanded')) === 'true') await t.click()
  }
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
/** Where the climb's note is made and its change looked at: a line the reel keeps, with its subtitle on screen. */
const MOMENT = 7.5
/** The player paused at `t`, as a person stops it to look. */
async function pauseAt(page: Page, t: number): Promise<void> {
  // A new version's video loads as a second layer over the one on screen and plays from its start once it is in
  // (Player.tsx FADE_MS): hold every player video at `t` until none is loading and all stay there.
  const hold = () =>
    page.evaluate((at) => {
      const vs = Array.from(document.querySelectorAll<HTMLVideoElement>('video[data-testid=player]'))
      if (!vs.length || document.querySelector('video.layer.loading')) return false
      for (const v of vs) {
        if (!v.paused) v.pause()
        if (Math.abs(v.currentTime - at) > 0.05) v.currentTime = at
      }
      return vs.every((v) => v.paused && v.readyState >= 2 && Math.abs(v.currentTime - at) <= 0.05)
    }, t)
  await expect.poll(hold, { timeout: 20_000 }).toBe(true)
  await page.waitForTimeout(300)
  await expect.poll(hold, { timeout: 5_000 }).toBe(true)
}
async function note(page: Page, text: string): Promise<void> {
  // at a moment in the reel, as a creator makes one, clear of the reel's start
  await pauseAt(page, MOMENT)
  await page.getByTestId('note-input').fill(text)
  await expect(page.getByTestId('send')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('note-input').press('Enter')
}
/**
 * The stand-in plays the take as it is and draws no text (its ffmpeg may have no font filter), so a reel would show no
 * subtitles. Each line is drawn once here, in the app's own subtitle face and look (Player.tsx SubtitleSample, default
 * style) at the 1080 px export width, for every size the climb's reels use; the stand-in lays them over its renders
 * (FAKE_ENGINE_SUBTITLES) at their words' times. Lines: the kept words, three to a line, as it makes them.
 */
async function drawSubtitles(page: Page, dir: string, lines: string[], sizes: number[]): Promise<void> {
  // only the line is drawn: the page under it hidden and see-through while the pictures are taken, then put back
  await page.evaluate(() => {
    for (const el of [document.documentElement, document.body]) el.style.setProperty('background', 'transparent', 'important')
    document.body.style.visibility = 'hidden'
  })
  for (const size of sizes) {
    mkdirSync(join(dir, String(size)), { recursive: true })
    for (const text of lines) {
      const line = await page.evaluateHandle(async ({ text, px, lh }) => {
        await document.fonts.load("600 16px 'Reel Subtitles'")
        const d = document.createElement('div')
        d.textContent = text
        d.style.cssText = `position:fixed;left:0;top:0;z-index:2147483647;white-space:pre;padding:8px;color:#FFFFFF;
          visibility:visible;background:transparent;
          font:600 ${px}px/${lh} 'Reel Subtitles',Montserrat,sans-serif;-webkit-text-stroke:16px #000000;paint-order:stroke fill`
        document.body.append(d)
        return d
      }, { text, px: size / SIZE_PER_EM, lh: SIZE_PER_EM })
      await line.screenshot({ path: join(dir, String(size), `${createHash('sha1').update(text).digest('hex').slice(0, 12)}.png`), omitBackground: true, scale: 'css' })
      await line.evaluate((d) => d.remove())
    }
  }
  await page.evaluate(() => {
    for (const el of [document.documentElement, document.body]) el.style.removeProperty('background')
    document.body.style.visibility = ''
  })
}
/**
 * Motion as a frame strip (Craft, goal 4): the page's animations at a tenth of their speed (DevTools Animation domain),
 * `go` starts one, and FRAMES pictures of `clip` are taken across it, left to right in one PNG, so a judge sees how it
 * moves. Twice: as it is, and with reduced motion asked for.
 */
const FRAMES = 6
async function motionStrip(page: Page, name: string, clip: () => Promise<{ x: number; y: number; width: number; height: number }>, go: () => Promise<void>, reset: () => Promise<void>): Promise<void> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Animation.enable')
  for (const reduced of [false, true]) {
    await page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' })
    await reset()
    await page.mouse.move(2, 2)
    const box = await clip()
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 })
    const frames: string[] = []
    const start = Date.now()
    await go()
    for (let i = 0; i < FRAMES; i++) {
      // 0, 15, 30, 50 and 80 ms of the animation's own time (an ease-out does most of its moving early), and the last
      // once it has ended
      const at = i === FRAMES - 1 ? 4000 : [0, 150, 300, 500, 800][i]
      await page.waitForTimeout(Math.max(0, start + at - Date.now()))
      const f = join(OUT!, `.frame-${i}.png`)
      await page.screenshot({ path: f, clip: box, scale: 'css', animations: 'allow' })
      frames.push(f)
    }
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 })
    const out = join(OUT!, `motion-${name}${reduced ? '-reduced' : ''}.png`)
    const inputs = frames.flatMap((f) => ['-i', f])
    const pad = frames.map((_, i) => `[${i}]pad=iw+12:ih:0:0:white[p${i}]`).join(';')
    execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', `${pad};${frames.map((_, i) => `[p${i}]`).join('')}hstack=inputs=${frames.length}`, out])
    for (const f of frames) rmSync(f, { force: true })
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await reset()
  await cdp.detach()
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
      await page.getByTestId('use-claude-code').click()
      await expect(page.getByTestId('ai-connected')).toHaveText('Connected')
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
      await pauseAt(page, MOMENT)
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
    // Add now (note-add.spec): a second note written while the first is made waits in a row that can join it
    id: 'reel-add-now',
    enter: async ({ page }) => {
      await page.getByTestId('note-input').fill('and keep them white')
      await page.getByTestId('send').click()
      await expect(page.getByTestId('queue-row')).toHaveCount(1)
    },
    ready: byTestId('queue-add')
  },
  {
    id: 'reel-versions',
    enter: async ({ page, gate }) => {
      // the waiting note joins the one being made, as a person who wrote it would have it
      if (await page.getByTestId('queue-add').isVisible()) {
        await page.getByTestId('queue-add').click()
        await expect(page.getByTestId('note-added')).toBeVisible()
      }
      for (const n of [2, 3, 4, 5, 6]) gate(n)
      await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 240_000 })
      await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 120_000 })
      // stopped where the note asked for the change, to look at it
      await pauseAt(page, MOMENT)
    },
    ready: byTestId('log-play-2')
  },
  {
    id: 'reel-compare',
    enter: async ({ page }) => {
      if (!(await page.getByTestId('done-compare').isVisible())) await page.getByTestId(/^compare-\d+$/).last().click()
      await pauseAt(page, MOMENT)
    },
    ready: byTestId('done-compare')
  },
  {
    // Compare › Side by side (side-by-side.spec): both versions at once, opened where the compare was paused
    id: 'reel-side-by-side',
    enter: async ({ page }) => {
      if (!(await page.getByTestId('side-by-side').isVisible())) await page.getByTestId('compare-side-by-side').click()
      await expect
        .poll(() => page.evaluate(() => Array.from(document.querySelectorAll<HTMLVideoElement>('[data-testid^="sbs-video-"]')).every((v) => v.paused && v.readyState >= 2)), { timeout: 20_000 })
        .toBe(true)
    },
    ready: byTestId('side-by-side')
  },
  {
    // the Versions view (version-tree.spec), a row's actions shown as the pointer finds them
    id: 'reel-version-tree',
    enter: async ({ page }) => {
      // back to one player (the layout is remembered), then keep the newest and switch the column
      if (await page.getByTestId('sbs-one').isVisible()) await page.getByTestId('sbs-one').click()
      if (await page.getByTestId('done-compare').isVisible()) await page.getByTestId('done-compare').click()
      await page.getByTestId('notes-view-versions').click()
    },
    ready: byTestId('version-tree'),
    pose: async (page) => {
      await page.mouse.move(2, 2)
      await page.getByTestId('vt-1').hover()
      await expect(page.getByTestId('vt-change-1')).toBeVisible()
    }
  },
  {
    id: 'reel-combine',
    enter: async ({ page }) => {
      await page.getByTestId('vt-2').hover()
      await page.getByTestId('vt-combine-2').click()
      await expect(page.getByTestId('combine-reading')).toHaveCount(0, { timeout: 30_000 })
    },
    ready: byTestId('combine')
  },
  {
    // an older version on screen: the title bar names it and offers the way back and a note on it
    id: 'reel-older-version',
    enter: async ({ page }) => {
      if (await page.getByTestId('combine').isVisible()) await page.getByTestId('combine-cancel').click()
      await page.getByTestId('vt-play-1').click()
      await pauseAt(page, MOMENT)
    },
    ready: byTestId('version-change-this')
  },
  {
    id: 'reel-change-older',
    enter: async ({ page }) => {
      await page.getByTestId('version-change-this').click()
      await expect(page.getByTestId('note-input')).toHaveAttribute('placeholder', /Version 1/)
    },
    ready: byTestId('note-base')
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
  // Cut's other two ways of changing the cut (CutTab.tsx MODES): each pace's rows, and how each join plays
  ...(['pace', 'joins'] as const).map(
    (mode): Scene => ({
      id: `edit-cut-${mode}`,
      enter: async ({ page }) => {
        if (await page.getByTestId('done-compare').isVisible()) await page.getByTestId('done-compare').click()
        await openTab(page, 'cut')
        await page.getByTestId(`cut-mode-${mode}`).click()
      },
      ready: byTestId(mode === 'pace' ? 'pace' : 'joins')
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
  // Library › Videos, with Reels in your footage (the footage lane's ArchiveReels.tsx)
  { id: 'library-videos', enter: async ({ page }) => page.getByTestId('library-tab-videos').click(), ready: byTestId('archive-reels') },
  { id: 'my-style', enter: async ({ page }) => page.getByTestId('nav-style').click(), ready: (page) => page.locator('main.main') },
  { id: 'insights', enter: async ({ page }) => page.getByTestId('nav-insights').click(), ready: (page) => page.locator('main.main') },
  { id: 'settings-editor', enter: async ({ page }) => settingsAt(page, 'editor'), ready: (page) => page.locator('[data-testid="settings-nav-editor"][aria-current="true"]') },
  { id: 'settings-reels', enter: async ({ page }) => settingsAt(page, 'reels'), ready: (page) => page.locator('[data-testid="settings-nav-reels"][aria-current="true"]') },
  { id: 'settings-about', enter: async ({ page }) => settingsAt(page, 'about'), ready: (page) => page.locator('[data-testid="settings-nav-about"][aria-current="true"]') },
  // Craft (goal 4): the states a still screen hides. The View menu and the reel's menu open, a keyboard focus ring,
  // a row under the pointer.
  {
    id: 'menu-view',
    enter: async ({ page }) => openReel(page),
    ready: byTestId('view-menu'),
    pose: async (page) => {
      if ((await page.getByTestId('view-menu').getAttribute('aria-expanded')) !== 'true') await page.getByTestId('view-menu').click()
      await expect(page.getByTestId('view-menu-list')).toBeVisible()
    }
  },
  {
    id: 'menu-more',
    enter: async ({ page }) => openReel(page),
    ready: byTestId('more'),
    pose: async (page) => {
      if ((await page.getByTestId('more').getAttribute('aria-expanded')) !== 'true') await page.getByTestId('more').click()
      await expect(page.getByRole('menu', { name: 'More for this reel' })).toBeVisible()
    }
  },
  {
    id: 'focus-ring',
    enter: async ({ page }) => (await closeAll(page), await openReel(page)),
    ready: byTestId('share'),
    // reached from the keyboard, as focus rings are drawn only then
    pose: async (page) => {
      await page.getByTestId('edit-myself').focus()
      await page.keyboard.press('Tab')
      await expect(page.locator('[data-testid="share"]:focus-visible')).toBeVisible()
    }
  },
  {
    // a sidebar row under the pointer (a card's hover is a 2 px lift a still does not show)
    id: 'hover-row',
    enter: async ({ page }) => (await closeAll(page), await page.getByTestId('nav-home').click()),
    ready: byTestId('nav-library'),
    pose: async (page) => {
      await page.mouse.move(600, 600)
      await page.getByTestId('nav-library').hover()
      // the wash fades in: shoot once it is painted (one run caught the row before it)
      await expect.poll(() => page.getByTestId('nav-library').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)')
      await page.waitForTimeout(200)
    }
  }
]

let MEDIA: ReturnType<typeof makeMedia>
let SILENT = ''

test('climb scenes at two sizes', async () => {
  test.setTimeout(30 * 60_000)
  const files = join(BASE, 'my files ü')
  mkdirSync(files, { recursive: true })
  // makeMedia reads its take from the environment: set for that one call, then put back, so no other spec in this
  // worker picks up the sample
  const priorVideo = process.env.REELSTUDIO_E2E_VIDEO
  process.env.REELSTUDIO_E2E_VIDEO = join(files, 'my first take.mp4')
  // the sample has no sound of its own (the first run plays it muted), and a take with none is refused: a quiet tone
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', join(__dirname, '../src/renderer/src/assets/sample/raw.mp4'), '-f', 'lavfi', '-i', 'sine=frequency=180:duration=24',
    '-filter:a', 'volume=0.05', '-c:v', 'copy', '-c:a', 'aac', '-shortest', process.env.REELSTUDIO_E2E_VIDEO])
  // the sample's words, each line's words spread over its time; the filler, the false starts and the weaker take cut
  const words = TRANSCRIPT.flatMap((seg) => {
    const ws = seg.text?.split(' ') ?? []
    const step = (seg.e - seg.s) / Math.max(1, ws.length)
    return ws.map((w, i) => ({ w, s: +(seg.s + i * step).toFixed(3), e: +(seg.s + (i + 0.85) * step).toFixed(3), cut: seg.kind !== 'keep' }))
  })
  const heard = join(BASE, 'climb-transcript.json')
  writeFileSync(heard, JSON.stringify(words))
  MEDIA = makeMedia()
  if (priorVideo === undefined) delete process.env.REELSTUDIO_E2E_VIDEO
  else process.env.REELSTUDIO_E2E_VIDEO = priorVideo
  // another take of the same scene, filmed with the microphone off: the sample as it is, which has no sound track
  SILENT = join(BASE, 'my files ü', 'kitchen take 2.mp4')
  copyFileSync(join(__dirname, '../src/renderer/src/assets/sample/raw.mp4'), SILENT)
  const gateDir = join(BASE, 'moments-gate')
  mkdirSync(gateDir, { recursive: true })
  const { app, page } = await launch({
    REELSTUDIO_MOCK_CLAUDE: 'ready', REELSTUDIO_MOCK_NOTE: '400', REELSTUDIO_MOCK_MOMENTS: '1', REELSTUDIO_MOCK_FIRST_EDIT: 'editor',
    FAKE_ENGINE_SLOW: '1', FAKE_ENGINE_MOMENTS_GATE: gateDir, FAKE_ENGINE_MOMENTS_AT: String(MOMENT), FAKE_ENGINE_TRANSCRIPT: heard,
    // a real render's voice is brought to -14 LUFS (engine render.py), so its loudness check passes
    FAKE_ENGINE_NORMALIZED: '1'
  }, { realViewport: true })
  const ctx: Ctx = { app, page, gate: (n) => writeFileSync(join(gateDir, `go-${n}`), '') }
  const kept = words.filter((w) => !w.cut).map((w) => w.w)
  // three to a line, in capitals: the engine's default look (captions.py, case "upper"), as the stand-in names them
  const lines = Array.from({ length: Math.ceil(kept.length / 3) }, (_, i) => kept.slice(i * 3, i * 3 + 3).join(' ').toUpperCase())
  await expect(page.getByTestId('get-started')).toBeVisible()
  const subtitles = join(BASE, 'climb-subtitles')
  // the default size, and the bigger one the climb's note asks for (ai-mock.ts slowNote)
  await drawSubtitles(page, subtitles, lines, [105, 125])
  await engineEnv(app, { FAKE_ENGINE_SUBTITLES: subtitles })
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
        if (scene.pose) await scene.pose(page)
        else {
          // the text caret blinks: keep it out of the picture so two runs match
          await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
          await parkPointer(page, size)
        }
        await settle(page)
        // measured before the picture: taking one can let the Mac's own cursor hover what lies under it (the share
        // panel's first row at 1100 px), which the audit then read as a painted box the picture never showed
        audit[name] = await page.evaluate(auditConsistency, { allow: CONSISTENCY_ALLOW.filter((a) => !a.scenes || a.scenes.includes(scene.id)), scale: SCALE })
        metrics[name] = await page.evaluate(spaceMetrics)
        await page.screenshot({ path: join(OUT!, `${name}.png`), scale: 'css' })
      }
    }
    if (!ONLY || ONLY.has('motion')) {
      await setSize(ctx, SIZES[0])
      await openReel(page)
      const around = (testid: string, w: number, h: number, dx = 0, dy = 0) => async () => {
        const b = (await page.getByTestId(testid).boundingBox())!
        return { x: Math.max(0, b.x + b.width / 2 - w / 2 + dx), y: Math.max(0, b.y + dy), width: w, height: h }
      }
      // a menu opening from its trigger, above the transport
      await motionStrip(page, 'view-menu', around('view-menu', 360, 560, -120, -520), () => page.getByTestId('view-menu').click(), () => closeAll(page))
      // Share's panel dropping from its button
      await motionStrip(page, 'share', around('share', 420, 480, -150, -12), () => page.getByTestId('share').click(), () => openReel(page))
      // the hands-on drawer taking the notes column
      await motionStrip(page, 'drawer', async () => ({ x: 560, y: 0, width: 880, height: 900 }), () => page.getByTestId('edit-myself').click(), () => openReel(page))
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
