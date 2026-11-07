// Layout audit: visits every screen and state at the four window sizes and runs the detectors in
// e2e/layout-audit/detect.ts (text overflow, clipping, sideways scrolling, nested scroll areas, overlap, text
// collisions, small targets, popover placement, imbalance, button shape). One test per screen, so each screen passes
// or fails on its own. P1 and P2 findings fail it; P3 is reported only.
//
//   REELSTUDIO_AUDIT_SCREENS=first-run,home   only these screens (names below)
//   REELSTUDIO_AUDIT_SIZES=1100x720,1920x1080 only these sizes
//   REELSTUDIO_AUDIT_SHOTS=all                a screenshot of every state and size, not only those with findings
//   REELSTUDIO_AUDIT_OUT=<folder>             where findings.json, FINDINGS.md and the shots go
//                                             (default app/test-results/layout-audit)
//
// Accepted exceptions live in e2e/layout-audit/allowlist.ts, each with a state, a selector and a reason.
import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_DIR, expectViewport, makeMedia, makeReel, passFirstRun, toEditorStep } from './helpers'
import { makePastEditsHome, videoFolder } from './past-edits-home'
import { detectLayout, type RawFinding } from './layout-audit/detect'
import { ALLOW } from './layout-audit/allowlist'
import { OUT, commit, counts, outlinedShot, sourceFor, writeScreen, type Finding, type ScreenResult } from './layout-audit/report'
import { FakeHub } from '../../ai/test/fakeHub'

const ALL_SIZES: [number, number][] = [
  [1100, 720],
  [1280, 820],
  [1512, 982],
  [1920, 1080]
]
const sizeName = ([w, h]: [number, number]): string => `${w}x${h}`
const pick = (env: string | undefined): Set<string> | null => (env ? new Set(env.split(',').map((s) => s.trim()).filter(Boolean)) : null)
const ONLY_SCREENS = pick(process.env.REELSTUDIO_AUDIT_SCREENS)
const ONLY_SIZES = pick(process.env.REELSTUDIO_AUDIT_SIZES)
const SIZES = ALL_SIZES.filter((s) => !ONLY_SIZES || ONLY_SIZES.has(sizeName(s)))
const ALL_SHOTS = process.env.REELSTUDIO_AUDIT_SHOTS === 'all'
const FAIL_ON = new Set((process.env.REELSTUDIO_AUDIT_FAIL_ON ?? 'P1,P2').split(','))

type Ctx = { app: ElectronApplication; page: Page; media: ReturnType<typeof makeMedia> }
interface State {
  id: string
  /** Gets there from wherever the previous state left the app. */
  enter(ctx: Ctx): Promise<void>
  /** Shows the state is on screen; checked after each resize, and the state is entered again if it went away. */
  ready(page: Page): Locator
  /** The screen's focal object and its column, for the imbalance check. */
  focal?: string
  column?: string
}
interface Screen {
  id: string
  /** fresh: the first run. ready: past the first run, no reels. reel: past the first run, with one reel. */
  profile: 'fresh' | 'ready' | 'reel'
  env?: Record<string, string>
  /** Runs before the screen's profile is made; what it returns joins `env` (the fake CLIProxyAPI's config folder). */
  before?: () => Promise<Record<string, string>>
  states: State[]
}

/** The practice editor: connected, and answers notes from a script (REELSTUDIO_MOCK_NOTE is its delay in ms). */
const EDITOR = { REELSTUDIO_MOCK_NOTE: '400' }

// ---- launching -------------------------------------------------------------------------------------------
// Profiles outside BASE survive Playwright restarting the worker after a failed screen (BASE goes with the worker);
// the cleanup reporter removes REELSTUDIO_E2E_TMP at the end of the run.
const RUN_DIR = join(process.env.REELSTUDIO_E2E_TMP ?? tmpdir(), `layout-audit-${process.ppid}`)

async function launchIn(dir: string, extra: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[k]
  Object.assign(env, {
    REELSTUDIO_TEST: '1',
    REELSTUDIO_USER_DATA: join(dir, 'user data'),
    REELSTUDIO_ROOT: join(dir, 'Documents', 'Reel Studio'),
    REELENGINE_CACHE: join(dir, 'engine-cache'),
    REELSTUDIO_MODELS_DIR: join(dir, 'models'),
    HF_HUB_CACHE: join(dir, 'hf-cache'),
    REELSTUDIO_MOCK_AI: '1',
    REELSTUDIO_ENGINE_DIR: join(APP_DIR, 'dev', 'fake-engine'),
    FAKE_ENGINE_SLOW: '1',
    ...extra
  })
  mkdirSync(dir, { recursive: true })
  const app = await electron.launch({ args: [APP_DIR], cwd: APP_DIR, env })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    return { app, page }
  } catch (error) {
    await app.close().catch(() => {})
    throw error
  }
}

/** The profile a screen starts from. `reel` is made once per run and reused, since a reel takes a while to make. */
async function profileFor(screen: Screen, media: Ctx['media']): Promise<string> {
  if (screen.profile === 'fresh') return join(RUN_DIR, `fresh-${screen.id}-${Date.now()}`)
  if (screen.profile === 'ready') {
    const dir = join(RUN_DIR, `ready-${screen.id}-${Date.now()}`)
    const { app, page } = await launchIn(dir, screen.env)
    try {
      await passFirstRun(page)
    } finally {
      await app.close()
    }
    return dir
  }
  const dir = join(RUN_DIR, 'reel-profile')
  if (!existsSync(join(dir, '.made'))) {
    const { app, page } = await launchIn(dir, EDITOR)
    try {
      await passFirstRun(page)
      await makeReel(page, media.video)
      // a second version, so the notes have two version lines and Compare is offered
      await page.getByTestId('note-input').fill('Make the subtitles bigger')
      await page.keyboard.press('Enter')
      await expect(page.getByTestId('log-play-2')).toBeVisible({ timeout: 240_000 })
    } finally {
      await app.close()
    }
    writeFileSync(join(dir, '.made'), '')
  }
  return dir
}

async function setSize(app: ElectronApplication, page: Page, [w, h]: [number, number]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, s) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win.isFullScreen()) win.setFullScreen(false)
    win.setContentSize(s.w, s.h)
  }, { w, h })
  await expectViewport(page, w, h, 5000)
  await settle(page)
}

/** Two frames, then until finite animations end and scrolling stops (each at most 1.5 s): measure what the person ends up seeing. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    await frame()
    await frame()
    const end = Date.now() + 1500
    while (Date.now() < end) {
      const running = document.getAnimations().filter((a) => {
        if (a.playState !== 'running') return false
        const t = a.effect?.getComputedTiming()
        return !!t && Number.isFinite(t.endTime as number) && (t.endTime as number) < 5000
      })
      if (!running.length) break
      await Promise.race([Promise.all(running.map((a) => a.finished.catch(() => null))), new Promise((r) => setTimeout(r, 300))])
    }
    // smooth scrolling (a section link, scrollIntoView) is not an animation: wait until no scroll area moves for 3 frames
    const scrollers = Array.from(document.querySelectorAll('*')).filter((e) => /auto|scroll/.test(getComputedStyle(e).overflowY + getComputedStyle(e).overflowX))
    const where = () => scrollers.map((e) => `${e.scrollTop},${e.scrollLeft}`).join('|') + document.documentElement.scrollTop
    let last = where()
    let still = 0
    while (still < 3 && Date.now() < end + 1500) {
      await frame()
      const now = where()
      still = now === last ? still + 1 : 0
      last = now
    }
    await frame()
  })
}

// ---- running one screen ----------------------------------------------------------------------------------
async function audit(screen: Screen): Promise<void> {
  if (screen.before) screen.env = { ...screen.env, ...(await screen.before()) }
  const media = makeMedia()
  const dir = await profileFor(screen, media)
  const { app, page } = await launchIn(dir, screen.env)
  const result: ScreenResult = { screen: screen.id, commit: commit(), at: new Date().toISOString(), sizes: SIZES.map(sizeName), states: [], unreached: [], allowed: 0, findings: [] }
  const ctx: Ctx = { app, page, media }
  try {
    for (const state of screen.states) {
      const reached = await test.step(`${screen.id}/${state.id}`, async () => {
        try {
          await setSize(app, page, SIZES[0])
          await state.enter(ctx)
          await expect(state.ready(page)).toBeVisible({ timeout: 30_000 })
        } catch (e) {
          result.unreached.push({ state: state.id, why: String(e instanceof Error ? e.message : e).replace(/\u001b\[\d+m/g, '').split('\n').filter((l) => /\S/.test(l)).slice(0, 2).join(' ').slice(0, 240) })
          // what the window showed instead, so an unreached state can be put down to its cause on a machine nobody watches
          await page.screenshot({ path: join(OUT, 'unreached', `${state.id}.png`) }).catch(() => {})
          return false
        }
        result.states.push(state.id)
        for (const size of SIZES) {
          await setSize(app, page, size)
          if (!(await state.ready(page).isVisible())) {
            await state.enter(ctx)
            await expect(state.ready(page)).toBeVisible({ timeout: 15_000 })
            await settle(page)
          }
          const allow = ALLOW.filter((a) => a.states.includes(state.id)).map(({ detector, selector, with: w }) => ({ detector, selector, with: w }))
          const { findings, allowed } = await page.evaluate(detectLayout, { allow, focal: state.focal, column: state.column })
          result.allowed += allowed
          let shot: string | null = null
          if (findings.length || ALL_SHOTS) {
            shot = join('shots', `${state.id}@${sizeName(size)}.png`)
            await outlinedShot(page, findings, join(OUT, shot))
          }
          result.findings.push(...findings.map((f: RawFinding): Finding => ({ ...f, screen: screen.id, state: state.id, size: sizeName(size), source: sourceFor(f.hints), shot })))
        }
        return true
      })
      if (!reached) continue
    }
  } finally {
    await app.close().catch(() => {})
    writeScreen(result)
  }
  const failing = result.findings.filter((f) => FAIL_ON.has(f.severity))
  const c = counts(result.findings)
  const summary = `${screen.id}: ${c.P1} P1, ${c.P2} P2, ${c.P3} P3 (see ${join(OUT, 'FINDINGS.md')})\n` + failing.slice(0, 40).map((f) => `  ${f.severity} ${f.state}@${f.size} ${f.detector}: ${f.detail} [${f.selector}]`).join('\n')
  expect(result.unreached, `${screen.id}: states not reached`).toEqual([])
  expect(failing.length, summary).toBe(0)
}

// ---- states ----------------------------------------------------------------------------------------------
const byTestId = (id: string) => (page: Page) => page.getByTestId(id).first()
const click = (id: string) => async ({ page }: Ctx) => {
  await page.getByTestId(id).first().click()
}

const SCREENS: Screen[] = [
  {
    id: 'first-run',
    profile: 'fresh',
    states: [
      { id: 'first-run-welcome', enter: async () => {}, ready: byTestId('get-started'), focal: '.fr-welcome h1', column: '.fr' },
      {
        id: 'first-run-sample-playing',
        enter: click('get-started'),
        ready: byTestId('sample-phone'),
        focal: '[data-testid="sample-phone"]'
      },
      {
        id: 'first-run-editor',
        enter: async ({ page }) => {
          if (await page.getByTestId('demo-skip').isVisible()) await page.getByTestId('demo-skip').click()
          await toEditorStep(page)
        },
        ready: byTestId('ai-picker')
      },
      {
        id: 'first-run-editor-advanced',
        enter: async ({ page }) => {
          if ((await page.getByTestId('ai-advanced').getAttribute('aria-expanded')) !== 'true') await page.getByTestId('ai-advanced').click()
          await page.getByTestId('own-server-toggle').click()
        },
        ready: byTestId('connection-address')
      },
      {
        id: 'first-run-last',
        enter: async ({ page }) => {
          if (await page.getByTestId('connection-cancel').isVisible()) await page.getByTestId('connection-cancel').click()
          await page.getByTestId('not-now').or(page.getByTestId('editor-continue')).click()
        },
        ready: byTestId('planned-stage')
      }
    ]
  },
  {
    // a Mac's first run has a Your Mac step; test builds stand in for a Mac (main/permissions.ts parseFakes)
    id: 'first-run-mac',
    profile: 'fresh',
    env: { REELSTUDIO_TEST_PERMISSIONS: 'platform=darwin' },
    states: [
      {
        id: 'first-run-mac-ask',
        enter: async ({ page }) => {
          await page.getByTestId('get-started').click()
          await page.getByTestId('demo-skip').click()
          await page.getByTestId('demo-next').click()
        },
        ready: byTestId('perm-notify-allow')
      },
      { id: 'first-run-mac-on', enter: click('perm-notify-allow'), ready: byTestId('mac-continue') }
    ]
  }
]

// The nightly's update offer: the app is a dev build at 0.1.2 with the updater off in tests, so its state is sent over
// the same channel main uses (update:state), as the nightly 0.1.3-nightly.20261028.8 would see 20261028.9.
const NIGHTLY = '0.1.3-nightly.20261028.8'
const NEXT_NIGHTLY = '0.1.3-nightly.20261028.9'
async function sendUpdate(app: ElectronApplication, patch: Record<string, unknown>): Promise<void> {
  const state = {
    status: 'available',
    mode: 'page',
    autoCheck: true,
    currentVersion: NIGHTLY,
    availableVersion: NEXT_NIGHTLY,
    downloadedVersion: null,
    releaseNotes: [{ version: NEXT_NIGHTLY, items: ['The update note no longer covers the AI status.', 'Subtitles keep their case.'], totalItems: 2 }],
    olderNotes: 0,
    releases: [],
    releaseUrl: `https://github.com/example/reel-studio-nightly/releases/tag/v${NEXT_NIGHTLY}`,
    downloadPercent: null,
    message: null,
    errorContext: null,
    snoozed: false,
    ...patch
  }
  await app.evaluate(({ BrowserWindow }, st) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:state', st)
  }, state)
}

SCREENS.push({
  id: 'update',
  profile: 'ready',
  states: [
    {
      id: 'update-offer-page',
      enter: async ({ app, page }) => {
        await page.mouse.move(5, 400)
        if (!(await page.getByTestId('planned-stage').isVisible())) await page.getByTestId('new-reel').click()
        await expect(page.getByTestId('planned-stage')).toBeVisible()
        await sendUpdate(app, {})
      },
      ready: byTestId('update-button')
    },
    {
      id: 'update-popover-open',
      enter: async ({ app, page }) => {
        if (!(await page.getByTestId('update-button').isVisible())) await sendUpdate(app, {})
        // over its icon: the pointer, not Playwright's hover, which refuses a button something else covers
        const box = (await page.getByTestId('update-button').boundingBox())!
        await page.mouse.move(box.x + 18, box.y + box.height / 2)
      },
      ready: (page) => page.locator('[data-testid="update-popover"][data-open="true"]')
    },
    {
      id: 'update-downloading',
      enter: async ({ app, page }) => {
        await page.mouse.move(700, 5)
        await sendUpdate(app, { status: 'downloading', mode: 'install', downloadPercent: 42 })
      },
      ready: byTestId('update-button')
    }
  ]
})

SCREENS.push({
  id: 'sidebar',
  profile: 'ready',
  states: [
    {
      id: 'sidebar-collapsed',
      enter: async ({ page }) => {
        if ((await page.getByTestId('sidebar-toggle').getAttribute('aria-expanded')) !== 'false') await page.getByTestId('sidebar-toggle').click()
      },
      ready: (page) => page.locator('[data-testid="sidebar-toggle"][aria-expanded="false"]')
    }
  ]
})

/** Closes whatever menu, popover or dialog a previous state left open. */
async function closeAll(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('[role="menu"], [aria-modal="true"], [data-testid="full-stage"]').count())) return
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
}
const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
const openReel = async (page: Page): Promise<void> => {
  await closeAll(page)
  if (await page.getByTestId('timeline').isVisible()) return
  await page.getByTestId('nav-home').click()
  await page.getByTestId('project-card').first().click()
  await expect(page.getByTestId('timeline')).toBeVisible()
}
const MAIN = 'main.main'

SCREENS.push({
  id: 'home',
  profile: 'ready',
  states: [{ id: 'home-empty', enter: click('nav-home'), ready: byTestId('reels-empty'), focal: '[data-testid="reels-empty"]', column: MAIN }]
})

// New reel: the base shows a plan form with no editor (heading "Plan this reel") and its drop card as .planned-frame;
// r12-plan shows one "Connect your editor" step and the card as the drop zone. Either marker counts.
const DROP_CARD = '[data-testid="drop-zone"], [data-testid="planned-stage"] .planned-frame'
async function say(page: Page, text: string): Promise<void> {
  await page.getByTestId('note-input').fill(text)
  // the box takes words while the editor answers, but sends only once it has
  await expect(page.getByTestId('send')).toBeEnabled({ timeout: 30_000 })
  await page.getByTestId('note-input').press('Enter')
}

SCREENS.push({
  id: 'new-reel',
  profile: 'ready',
  states: [
    {
      id: 'new-reel-no-editor',
      enter: click('new-reel'),
      ready: (page) => page.getByRole('heading', { name: 'Plan this reel' }).or(page.getByRole('button', { name: 'Connect your editor' })).first(),
      focal: DROP_CARD,
      column: '[data-testid="planned-stage"]'
    },
    {
      // a toast over the screen: a file that is not a video, given to the stage's file picker
      id: 'new-reel-toast',
      enter: async ({ page, media }) => {
        await page.getByTestId('planned-stage').getByTestId('file-input').setInputFiles([media.doc])
      },
      ready: byTestId('toast')
    }
  ]
})

SCREENS.push({
  id: 'new-reel-editor',
  profile: 'ready',
  env: EDITOR,
  states: [
    {
      id: 'new-reel-editor',
      enter: click('new-reel'),
      ready: (page) => page.getByRole('heading', { name: 'Plan with your editor' }),
      focal: DROP_CARD,
      column: '[data-testid="planned-stage"]'
    },
    {
      id: 'new-reel-editor-chat',
      enter: async ({ page }) => {
        if (!(await page.getByTestId('plan-question').count())) await say(page, 'How I make sourdough without a mixer')
      },
      ready: byTestId('plan-question')
    },
    {
      // the practice editor asks two questions, then proposes the plan: its card in the chat (base) or on the stage
      // beside the drop zone (r12-plan)
      id: 'new-reel-proposed-plan',
      enter: async ({ page }) => {
        if (await page.getByTestId('plan-card').count()) return
        const questions = page.getByTestId('plan-question')
        if (!(await questions.count())) await say(page, 'How I make sourdough without a mixer')
        await expect(questions.first()).toBeVisible({ timeout: 30_000 })
        if ((await questions.count()) < 2) {
          await say(page, 'People who have never baked bread')
          await expect(questions.nth(1)).toBeVisible({ timeout: 30_000 })
        }
        await say(page, 'You do not need fancy gear')
      },
      ready: byTestId('plan-card')
    }
  ]
})

SCREENS.push({
  id: 'reel',
  profile: 'reel',
  env: EDITOR,
  states: [
    { id: 'home-with-reels', enter: click('nav-home'), ready: byTestId('project-card') },
    { id: 'reel-notes-timeline', enter: async ({ page }) => openReel(page), ready: byTestId('timeline'), focal: 'section.stage [data-testid="phone"]', column: 'section.stage' },
    {
      id: 'reel-moment-chip',
      enter: async ({ page }) => {
        await openReel(page)
        await blur(page)
        await page.keyboard.press('c')
      },
      ready: byTestId('moment-chip')
    },
    {
      id: 'reel-speed-menu',
      enter: async ({ page }) => {
        await openReel(page)
        await page.getByTestId('speed').first().click()
      },
      ready: (page) => page.getByRole('menu').first()
    },
    {
      id: 'reel-shape-menu',
      enter: async ({ page }) => {
        await openReel(page)
        await page.getByTestId('view-menu').first().click()
      },
      ready: (page) => page.getByRole('menu').first()
    },
    {
      id: 'reel-compare',
      enter: async ({ page }) => {
        await openReel(page)
        if (!(await page.getByTestId('done-compare').isVisible())) await page.getByTestId(/^compare-\d+$/).last().click()
      },
      ready: byTestId('done-compare')
    },
    {
      id: 'reel-full-stage',
      enter: async ({ page }) => {
        if (await page.getByTestId('done-compare').isVisible()) await page.getByTestId('done-compare').click()
        await openReel(page)
        await page.getByTestId('full-screen').first().click()
      },
      ready: byTestId('full-stage')
    }
  ]
})

const openEdit = async (page: Page): Promise<void> => {
  await openReel(page)
  if (!(await page.getByTestId('drawer').isVisible())) await page.getByTestId('edit-myself').click()
  await expect(page.getByTestId('drawer')).toBeVisible()
}
SCREENS.push({
  id: 'edit',
  profile: 'reel',
  env: EDITOR,
  states: [
    {
      id: 'edit-subtitles',
      enter: async ({ page }) => {
        await openEdit(page)
        await page.getByTestId('tab-captions').click()
      },
      ready: byTestId('drawer')
    },
    {
      id: 'edit-sounds',
      enter: async ({ page }) => {
        await openEdit(page)
        await page.getByRole('tab', { name: /^Sound/ }).first().click()
      },
      ready: (page) => page.getByRole('tab', { name: /^Sound/, selected: true }).first()
    }
  ]
})

SCREENS.push({
  id: 'share',
  profile: 'reel',
  env: EDITOR,
  states: [
    {
      id: 'share-open',
      enter: async ({ page }) => {
        await openReel(page)
        await page.getByTestId('share').click()
      },
      ready: byTestId('share-pop')
    },
    {
      id: 'share-try-two',
      enter: async ({ page }) => {
        if (!(await page.getByTestId('share-pop').isVisible())) {
          await openReel(page)
          await page.getByTestId('share').click()
        }
        await page.getByTestId('share-platforms-toggle').click()
      },
      ready: (page) => page.getByRole('radiogroup', { name: 'What Try 2 changes' })
    },
    {
      id: 'more-reels',
      enter: async ({ page }) => {
        await openReel(page)
        if (await page.getByTestId('share-pop').isVisible()) await page.keyboard.press('Escape')
        await page.getByTestId('more').click()
        await page.getByTestId('more-reels').click()
      },
      ready: (page) => page.getByRole('region', { name: 'Reels in this video' })
    }
  ]
})

SCREENS.push({
  id: 'library',
  profile: 'reel',
  env: EDITOR,
  states: (['images', 'videos', 'music', 'sfx'] as const).map((tab) => ({
    id: `library-${tab}`,
    enter: async ({ page }: Ctx) => {
      await closeAll(page)
      await page.getByTestId('nav-library').click()
      await page.getByTestId(`library-tab-${tab}`).click()
    },
    ready: (page: Page) => page.locator(`[data-testid="library-tab-${tab}"][aria-selected="true"]`)
  }))
})

const STYLE_HOME = join(RUN_DIR, 'my-style-home')
SCREENS.push({
  id: 'my-style',
  profile: 'ready',
  env: { REELSTUDIO_TEST_PAST_EDITS_HOME: STYLE_HOME },
  states: [
    { id: 'my-style-empty', enter: click('nav-style'), ready: byTestId('style-empty'), focal: '[data-testid="style-empty"]', column: MAIN },
    {
      id: 'my-style-rules',
      enter: async ({ page }) => {
        await page.getByTestId('style-add').click()
        await page.getByTestId('style-add-input').fill('Always use big subtitles')
        await page.keyboard.press('Enter')
      },
      ready: byTestId('style-rule')
    },
    {
      // Learn from my past edits looks in this folder instead of the home folder (REELSTUDIO_TEST_PAST_EDITS_HOME):
      // empty first, then holding an edit of each kind
      id: 'my-style-learn-none',
      enter: async ({ page }) => {
        mkdirSync(STYLE_HOME, { recursive: true })
        await page.getByTestId('style-learn').click()
      },
      ready: byTestId('learn-none')
    },
    {
      id: 'my-style-learn-found',
      enter: async ({ page }) => {
        await closeAll(page)
        if (!existsSync(join(STYLE_HOME, videoFolder()))) makePastEditsHome(STYLE_HOME)
        await page.getByTestId('style-learn').click()
        // the timeline counts have arrived
        await expect(page.getByTestId('learn-item').first()).toContainText('timeline')
      },
      ready: byTestId('learn-item')
    },
    {
      id: 'my-style-learn',
      enter: async ({ page }) => {
        if (!(await page.getByTestId('learn-go').count())) {
          await closeAll(page)
          await page.getByTestId('style-learn').click()
        }
        await page.getByTestId('learn-go').click()
      },
      ready: byTestId('style-lesson')
    }
  ]
})

SCREENS.push({
  id: 'insights',
  profile: 'ready',
  states: [{ id: 'insights-empty', enter: click('nav-insights'), ready: byTestId('insights-empty'), focal: '[data-testid="insights-empty"]', column: MAIN }]
})

const SETTINGS_SECTIONS = ['editor', 'privacy', 'reels', 'posting', 'about', 'advanced'] as const
SCREENS.push({
  id: 'settings',
  profile: 'ready',
  states: [
    ...SETTINGS_SECTIONS.map((k) => ({
      id: `settings-${k}`,
      enter: async ({ page }: Ctx) => {
        await closeAll(page)
        if (!(await page.getByTestId('settings-search').isVisible())) await page.getByTestId('account').click()
        await page.getByTestId(`settings-nav-${k}`).click()
      },
      ready: (page: Page) => page.locator(`[data-testid="settings-nav-${k}"][aria-current="true"]`)
    })),
    {
      // your own server lives in the editor component's Advanced, under Settings › Editor (r12-editor)
      id: 'settings-advanced-server-form',
      enter: async ({ page }) => {
        if (!(await page.getByTestId('settings-search').isVisible())) await page.getByTestId('account').click()
        await page.getByTestId('settings-nav-editor').click()
        if ((await page.getByTestId('ai-advanced').getAttribute('aria-expanded')) !== 'true') await page.getByTestId('ai-advanced').click()
        if (!(await page.getByTestId('connection-address').isVisible())) await page.getByTestId('own-server-toggle').click()
      },
      ready: byTestId('connection-address')
    },
    {
      id: 'confirm-reset-first-run',
      enter: async ({ page }) => {
        await closeAll(page)
        if (!(await page.getByTestId('settings-search').isVisible())) await page.getByTestId('account').click()
        await page.getByTestId('settings-nav-advanced').click()
        await page.getByRole('button', { name: 'Reset…' }).click()
      },
      ready: (page) => page.getByRole('dialog', { name: 'Reset the first run?' })
    }
  ]
})

// ---- the editor with CLIProxyAPI (connect.tsx): a fake hub on a random port and the real AI package, so the rows,
// accounts, limits and picker are the ones a person sees. Claude Code and Codex see a throwaway home.
let hub: FakeHub | null = null
async function hubEnv(): Promise<Record<string, string>> {
  if (!hub) {
    hub = new FakeHub()
    await hub.start()
  }
  const dir = mkdtempSync(join(RUN_DIR.replace(/[^/]+$/, ''), 'hub-config-'))
  writeFileSync(join(dir, 'config.yaml'), `port: ${hub.port}\napi-keys:\n  - ${hub.key}\n`)
  return { REELSTUDIO_MOCK_AI: '0', REELSTUDIO_TEST_HUB_CONFIG: dir, REELSTUDIO_TEST_VENDOR_HOME: mkdtempSync(join(dir, 'vendor-home-')) }
}
test.afterAll(async () => {
  await hub?.stop()
})
const lookAgain = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('focus')))
const hubReady = (page: Page) => page.locator('[data-testid="hub-row"][data-state="ready"]')
async function connectHub(page: Page): Promise<void> {
  hub!.rejectKey = false
  hub!.limited = null
  if (!(await page.locator('[data-testid="hub-row"][data-state="connected"]').isVisible())) {
    await lookAgain(page)
    await hubReady(page).getByTestId('hub-use').click()
  }
  const mgmt = page.getByTestId('hub-management-key')
  await expect(mgmt.or(page.getByTestId('editor-accounts'))).toBeVisible()
  if (await mgmt.isVisible()) {
    await mgmt.fill(hub!.managementKey)
    await page.getByTestId('hub-management-add').click()
  }
}
async function openPicker(page: Page): Promise<void> {
  if ((await page.getByTestId('stage-models-toggle').getAttribute('aria-expanded')) !== 'true') await page.getByTestId('stage-models-toggle').click()
  if (!(await page.getByTestId('model-picker').isVisible())) await page.getByTestId('model-checker').click()
}
const toEditor = async ({ page }: Ctx) => {
  if (await page.getByTestId('get-started').isVisible()) await page.getByTestId('get-started').click()
  if (await page.getByTestId('demo-skip').isVisible()) await page.getByTestId('demo-skip').click()
  if (await page.getByTestId('demo-next').isVisible()) await toEditorStep(page)
}
SCREENS.push({
  id: 'editor-hub',
  profile: 'fresh',
  before: hubEnv,
  states: [
    { id: 'first-run-hub-found', enter: toEditor, ready: hubReady },
    {
      id: 'first-run-hub-key-needed',
      enter: async ({ page }) => {
        hub!.rejectKey = true
        await lookAgain(page)
      },
      ready: (page) => page.locator('[data-testid="hub-row"][data-state="needs-key"]')
    },
    { id: 'first-run-hub-accounts', enter: async ({ page }) => connectHub(page), ready: byTestId('editor-accounts') },
    {
      id: 'first-run-hub-limit',
      enter: async ({ page }) => {
        await connectHub(page)
        hub!.limited = { family: 'claude', resetSeconds: 2 * 3600 + 14 * 60 }
        await page.getByTestId('editor-test').click()
      },
      ready: byTestId('editor-use-other')
    },
    {
      id: 'first-run-model-picker',
      enter: async ({ page }) => {
        hub!.limited = null
        await openPicker(page)
      },
      ready: byTestId('model-picker')
    }
  ]
})
SCREENS.push({
  id: 'settings-hub',
  profile: 'ready',
  before: hubEnv,
  states: [
    {
      id: 'settings-editor-hub',
      enter: async ({ page }) => {
        await closeAll(page)
        if (!(await page.getByTestId('settings-search').isVisible())) await page.getByTestId('account').click()
        await page.getByTestId('settings-nav-editor').click()
        await connectHub(page)
      },
      ready: byTestId('editor-accounts')
    },
    { id: 'settings-editor-picker', enter: async ({ page }) => openPicker(page), ready: byTestId('model-picker') },
    {
      id: 'settings-editor-own-server',
      enter: async ({ page }) => {
        await page.keyboard.press('Escape')
        if ((await page.getByTestId('ai-advanced').getAttribute('aria-expanded')) !== 'true') await page.getByTestId('ai-advanced').click()
        if (!(await page.getByTestId('connection-address').isVisible())) await page.getByTestId('own-server-toggle').click()
      },
      ready: byTestId('connection-address')
    }
  ]
})

for (const screen of SCREENS) {
  test(`layout: ${screen.id}`, async () => {
    test.skip(!!ONLY_SCREENS && !ONLY_SCREENS.has(screen.id), 'not in REELSTUDIO_AUDIT_SCREENS')
    test.setTimeout(10 * 60_000)
    await audit(screen)
  })
}
