// The INSTALLED macOS app (a .app copied out of the sealed dmg), driven like a person on a Mac. Skipped unless asked for:
//   REELSTUDIO_E2E_EXE=<.../Reel Studio.app/Contents/MacOS/Reel Studio>   REELSTUDIO_E2E_USE_CLAUDE=0 (no AI: skip the Claude pick + note)
//   REELSTUDIO_E2E_PROFILE=<throwaway dir: user data, Reel Studio folder, engine cache>
//   REELSTUDIO_E2E_MODELS=<speech models dir>   REELSTUDIO_E2E_TAKES_LIST=<take.mp4>;<take.mp4>   (read in place)
//   REELSTUDIO_E2E_NOTES=<JSON array, one note per take>   REELSTUDIO_E2E_MUSIC=<song> (Library, first take)
//   REELSTUDIO_E2E_OUT=<results folder>   REELSTUDIO_E2E_ATTACH=<meme file> (first take: "put this over my face", then the word)
// NOT a test build: REELSTUDIO_TEST is unset, so the phone link binds the real LAN address, notifications are real and
// "Show in Finder" really opens Finder. PATH is what Finder gives an app, so the app must find the Claude Code app on its own
// (the run then clicks "Use Claude (your Claude Code app)": nothing picks it automatically). Verify uses the installed engine + ffmpeg exactly as the app spawns them.
// Per take: drop -> first look -> first edit -> AI note -> manual yellow subtitles -> Export -> Send to my phone.
// Plus the macOS chrome: the app menu, Edit > Paste into the Claude key, File > New Video, Settings, the title bar.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { CLAUDE_CODE_MISNAMED, attachMemeFlow, chooseClaudeCode, dropFiles } from './helpers'

const EXE = process.env.REELSTUDIO_E2E_EXE
const USE_CLAUDE = process.env.REELSTUDIO_E2E_USE_CLAUDE !== '0'
/** shot / result name prefix */
const TAG = USE_CLAUDE ? 'claude' : 'no-ai'
const PROFILE = process.env.REELSTUDIO_E2E_PROFILE ?? ''
const ATTACH = process.env.REELSTUDIO_E2E_ATTACH
const TAKES = (process.env.REELSTUDIO_E2E_TAKES_LIST ?? '').split(';').filter(Boolean)
const NOTES: string[] = process.env.REELSTUDIO_E2E_NOTES ? JSON.parse(process.env.REELSTUDIO_E2E_NOTES) : ['make the captions smaller']
const OUT = process.env.REELSTUDIO_E2E_OUT ?? join(PROFILE, 'results')
const ROOT = join(PROFILE, 'Documents', 'Reel Studio')
const CACHE = join(PROFILE, 'engine cache')
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'

test.skip(!EXE || !PROFILE || process.platform !== 'darwin', 'macOS only: set REELSTUDIO_E2E_EXE and REELSTUDIO_E2E_PROFILE')
test.describe.configure({ mode: 'serial' })

// The app window, never the hidden off-screen window the AI's animation cards are drawn in (getAllWindows()[0]
// can be that one once a card has been made). Used inside app.evaluate as BrowserWindow.getAllWindows().find(...).
const RES = (): string => join(dirname(dirname(EXE!)), 'Resources')

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(REELSTUDIO_|REELENGINE_|PYTHON|ELECTRON_|NODE_|npm_)/i.test(k)) continue
    env[k] = v
  }
  Object.assign(env, {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin', // what launchd gives an app opened from Finder
    REELSTUDIO_USER_DATA: join(PROFILE, 'user data'),
    REELSTUDIO_ROOT: ROOT,
    REELENGINE_CACHE: CACHE // the encoder probe; otherwise ~/Library/Application Support/Reel Studio
  })
  if (process.env.REELSTUDIO_E2E_MODELS) env.REELSTUDIO_MODELS_DIR = process.env.REELSTUDIO_E2E_MODELS
  mkdirSync(CACHE, { recursive: true })
  const app = await electron.launch({ executablePath: EXE!, args: [], cwd: PROFILE, env })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function snap(page: Page, name: string): Promise<void> {
  mkdirSync(join(OUT, 'shots'), { recursive: true })
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, 'shots', `${name}.png`) })
}

function newest(dir: string, filter: (n: string) => boolean): string | null {
  if (!existsSync(dir)) return null
  const all = readdirSync(dir).filter(filter).map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)
  return all.length ? join(dir, all[0].n) : null
}

/** First run on a fresh profile: welcome -> speech model (already there) -> Connect. Returns what Connect showed. */
async function firstRun(page: Page): Promise<Record<string, unknown>> {
  const info: Record<string, unknown> = {}
  const welcome = page.getByTestId('get-started')
  await expect(welcome.or(page.getByText('Your videos'))).toBeVisible({ timeout: 60_000 })
  if (!(await welcome.isVisible())) return info
  await snap(page, `${TAG}-00-welcome`)
  await welcome.click()
  const connect = page.getByText('Connect your AI editor')
  const ready = page.getByTestId('model-next')
  await expect(connect.or(ready).or(page.getByTestId('download-model'))).toBeVisible()
  if (!(await connect.isVisible())) await ((await ready.isVisible()) ? ready : page.getByTestId('later')).click()
  await expect(connect).toBeVisible()
  await page.waitForTimeout(2500) // the Claude choice shows once the app has looked for the Claude Code app
  await snap(page, `${TAG}-01-connect`)
  info.connectButtons = await page.locator('.first-card button').allInnerTexts()
  info.connectText = await page.locator('.first-card').innerText()
  info.claudeCode = await page.evaluate(() => (window as any).reel.ai.claudeCodeStatus())
  const picked = USE_CLAUDE && (await chooseClaudeCode(page))
  info.connectAi = picked ? (await page.evaluate(() => (window as any).reel.ai.active())).label : 'none'
  if (!picked) await page.getByTestId('skip').click()
  await expect(page.getByText('Your videos')).toBeVisible()
  return info
}

function menuItem(app: ElectronApplication, top: string, label: string): Promise<{ found: boolean; accelerator?: string }> {
  return app.evaluate(({ Menu, BrowserWindow }, [top, label]) => {
    const m = Menu.getApplicationMenu()
    const t = m?.items.find((i) => i.label === top)
    const it = t?.submenu?.items.find((i) => i.label === label || i.role?.toLowerCase() === label.toLowerCase())
    if (!it) return { found: false }
    const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.isOffscreen())!
    w.show()
    w.focus()
    it.click(undefined, w, w.webContents)
    return { found: true, accelerator: it.accelerator ?? (it as unknown as { getDefaultRoleAccelerator?: () => string }).getDefaultRoleAccelerator?.() }
  }, [top, label] as const)
}

/** A real key press through the window server (needs Accessibility for the ssh session; recorded when refused). */
function osKeystroke(key: string): string {
  try {
    execFileSync('osascript', ['-e', `tell application "System Events" to keystroke "${key}" using command down`], { timeout: 10_000, stdio: 'pipe' })
    return 'sent'
  } catch (e) {
    return 'refused: ' + String((e as { stderr?: Buffer }).stderr ?? e).trim().slice(0, 160)
  }
}

test(`${TAG}: first run + macOS chrome`, async () => {
  test.setTimeout(10 * 60_000)
  mkdirSync(OUT, { recursive: true })
  const { app, page } = await open()
  const info: Record<string, unknown> = {}
  try {
    Object.assign(info, await firstRun(page))
    info.appInfo = await page.evaluate(() => (window as any).reel.app.info())
    info.providers = ((await page.evaluate(() => (window as any).reel.ai.providers())) as { id: string }[]).map((p) => p.id).sort()

    // ---- the application menu ----
    info.menu = await app.evaluate(({ Menu }) =>
      (Menu.getApplicationMenu()?.items ?? []).map((i) => ({ label: i.label, items: (i.submenu?.items ?? []).filter((s) => s.type !== 'separator').map((s) => s.label || s.role) }))
    )
    expect((info.menu as { label: string }[]).map((m) => m.label)).toEqual(['Reel Studio', 'File', 'Edit', 'View', 'Window', 'Help'])

    // ---- Settings (Reel Studio > Settings…, ⌘,) and New Video (File > New Video, ⌘N) ----
    await page.getByTestId('nav-home').click()
    info.settingsItem = await menuItem(app, 'Reel Studio', 'Settings…')
    await expect(page.getByTestId('root-display')).toBeVisible()
    info.rootDisplay = await page.getByTestId('root-display').innerText()
    await snap(page, `${TAG}-02-settings-from-menu`)
    info.newVideoItem = await menuItem(app, 'File', 'New Video')
    await expect(page.getByTestId('drop-zone')).toBeVisible()
    // the same two through real key presses, when this session may send them
    await page.getByTestId('nav-home').click()
    await app.evaluate(({ app: a }) => a.focus({ steal: true }))
    await page.waitForTimeout(800)
    info.osCmdComma = osKeystroke(',')
    info.osCmdCommaWorked = await page.getByTestId('root-display').isVisible({ timeout: 3000 }).catch(() => false)
    info.osCmdN = osKeystroke('n')
    info.osCmdNWorked = await page.getByTestId('drop-zone').isVisible({ timeout: 3000 }).catch(() => false)

    // ---- Edit > Paste into the Claude key box (the reason the Edit menu exists) ----
    await page.getByTestId('nav-settings').click()
    const other = page.getByTestId('use-different-ai')
    if (await other.isVisible()) await other.click()
    await page.getByTestId('claude-key-toggle').click()
    const key = page.getByTestId('claude-key-input')
    await key.fill('')
    const fake = 'sk-ant-paste-check-' + Date.now()
    await app.evaluate(({ clipboard }, t) => clipboard.writeText(t), fake)
    await key.focus()
    info.pasteItem = await menuItem(app, 'Edit', 'paste')
    // On macOS, Edit > Paste is a native Cocoa item: MenuItem.click() does nothing for it; what the menu (and ⌘V)
    // really does is send paste: to the first responder of the key window. Send exactly that.
    info.pasteKeyWindow = await app.evaluate(({ app: a, BrowserWindow, Menu }) => {
      a.focus({ steal: true })
      const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.isOffscreen())!
      w.show()
      w.focus()
      w.webContents.focus()
      Menu.sendActionToFirstResponder('paste:')
      return !!BrowserWindow.getFocusedWindow()
    })
    await expect(key).toHaveValue(fake)
    info.pasteMenuWorked = true
    await key.fill('')
    await key.focus()
    info.osCmdV = osKeystroke('v')
    await page.waitForTimeout(800)
    info.osCmdVWorked = (await key.inputValue()) === fake
    await snap(page, `${TAG}-03-key-pasted`)
    await key.fill('') // never saved: the field is cleared and "Use this key" is not pressed

    // ---- the title bar: traffic lights vs the sidebar logo ----
    await page.getByTestId('nav-home').click()
    info.trafficLights = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.isOffscreen())! as unknown as { getWindowButtonPosition?: () => { x: number; y: number } | null; getMediaSourceId: () => string }
      return { pos: w.getWindowButtonPosition?.() ?? null, source: w.getMediaSourceId() }
    })
    info.brand = await page.evaluate(() => {
      const r = document.querySelector('.brand')!.getBoundingClientRect()
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    })
    await snap(page, `${TAG}-04-home`)
    // the native window, buttons included (screencapture needs Screen Recording; recorded either way)
    const wid = String((info.trafficLights as { source: string }).source).split(':')[1]
    try {
      execFileSync('screencapture', ['-x', '-o', `-l${wid}`, join(OUT, 'shots', `${TAG}-05-native-window.png`)], { timeout: 15_000, stdio: 'pipe' })
      info.nativeShot = 'taken'
    } catch (e) {
      info.nativeShot = 'refused: ' + String((e as { stderr?: Buffer }).stderr ?? e).trim().slice(0, 160)
    }
    const tl = (info.trafficLights as { pos: { x: number; y: number } | null }).pos
    // the three buttons are 14 px tall at (x, y): the logo must start below them
    if (tl) expect((info.brand as { top: number }).top).toBeGreaterThanOrEqual(tl.y + 14 + 6)

    // ---- what the one build offers ----
    expect(info.providers).toEqual(['chatgpt', 'claude', 'claude-cli', 'none'])
    expect(String(info.connectText)).not.toMatch(CLAUDE_CODE_MISNAMED)
    if (USE_CLAUDE) expect(String(info.connectAi)).toBe('Claude (your Claude Code app)')
    else expect(info.connectAi).toBe('none')
  } finally {
    writeFileSync(join(OUT, `${TAG}-chrome.json`), JSON.stringify(info, null, 2))
    await app.close().catch(() => {})
  }
})

function verifyInstalled(project: string, file: string, frames: string): any {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (/^(PYTHON|ELECTRON_RUN_AS_NODE|REELENGINE_)/i.test(k)) delete env[k]
  Object.assign(env, {
    PYTHONPATH: join(RES(), 'engine'),
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1', // never write .pyc into the sealed app
    REELENGINE_FFMPEG: join(RES(), 'ffmpeg', 'ffmpeg'),
    REELENGINE_FFPROBE: join(RES(), 'ffmpeg', 'ffprobe'),
    REELENGINE_CACHE: CACHE
  })
  let stdout = ''
  try {
    stdout = execFileSync(join(RES(), 'python', 'bin', 'python3'), ['-s', '-E', '-B', '-X', 'utf8', '-u', '-m', 'reelengine', 'verify', '--project', project, file], {
      cwd: join(RES(), 'engine'),
      env: { ...env, PYTHONPATH: undefined }, // -E ignores it anyway; cwd is the engine
      maxBuffer: 64 * 1024 * 1024
    }).toString('utf8')
  } catch (e) {
    stdout = String((e as { stdout?: Buffer }).stdout ?? e)
  }
  const events = stdout.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const verify = events.reverse().find((ev: any) => ev.event === 'done' || ev.event === 'error')
  const check = execFileSync(join(RES(), 'python', 'bin', 'python3'), ['-s', '-B', join(__dirname, 'tools', 'check_export.py'), '--project', project, '--export', file, '--out', frames], {
    cwd: join(RES(), 'engine'),
    env,
    maxBuffer: 64 * 1024 * 1024
  })
  return { verify, check: check.toString('utf8') }
}

function encoderOf(file: string): string {
  try {
    return execFileSync(join(RES(), 'ffmpeg', 'ffprobe'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_tags=encoder:stream=codec_name,width,height', '-of', 'compact=p=0:nk=0', file]).toString().trim()
  } catch (e) {
    return 'ffprobe failed: ' + String(e).slice(0, 120)
  }
}

TAKES.forEach((take, i) => {
  test(`${TAG} take ${i}: ${basename(take)}`, async () => {
    test.setTimeout(90 * 60_000)
    const out = join(OUT, String(i))
    mkdirSync(out, { recursive: true })
    const timings: Record<string, number> = {}
    const result: Record<string, unknown> = { take, ai: TAG, timings }
    const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2))
    const { app, page } = await open()
    // record every notification macOS is asked to show (and that showing it did not throw)
    await app.evaluate(({ Notification, app: a, BrowserWindow }) => {
      const g = globalThis as { __shown?: string[] }
      g.__shown = []
      // the Dock bounce, and every change of focused/minimized, so a missing notification can be explained
      const bounce = a.dock!.bounce.bind(a.dock)
      ;(a.dock as unknown as { bounce: typeof bounce }).bounce = (t) => {
        g.__shown!.push('dock bounce')
        return bounce(t)
      }
      let last = ''
      setInterval(() => {
        const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.isOffscreen())!
        const now = w ? `window focused=${w.isFocused()} minimized=${w.isMinimized()}` : 'no window'
        if (now !== last) g.__shown!.push(now)
        last = now
      }, 250)
      const orig = Notification.prototype.show
      Notification.prototype.show = function (this: any) {
        try {
          orig.call(this)
          g.__shown!.push('shown: ' + this.title)
        } catch (e) {
          g.__shown!.push('THREW: ' + String(e))
          throw e
        }
      }
    })
    page.on('console', (m) => {
      if (m.text().startsWith('JOB ')) appendFileSync(join(out, 'events.log'), `${new Date().toISOString()} ${m.text().slice(4)}\n`)
    })
    try {
      await firstRun(page)
      await page.evaluate(() => (window as any).reel.jobs.onEvent((e: unknown) => console.log('JOB ' + JSON.stringify(e))))
      const music = (process.env.REELSTUDIO_E2E_MUSIC ?? '').split(';').filter(Boolean)
      if (music.length && i === 0) {
        await page.getByTestId('nav-library').click()
        await page.getByTestId('file-input').setInputFiles(music)
        await page.waitForTimeout(4000)
      }

      // ---- drop -> first look -> first edit ----
      await page.getByTestId('nav-home').click()
      await page.getByTestId('new-video').click()
      const t0 = Date.now()
      await dropFiles(page, 'drop-zone', [take])
      await expect(page.getByText('Making your reel')).toBeVisible()
      const look = page.getByTestId('first-look')
      let n = 0
      while (!(await page.getByTestId('player').isVisible())) {
        if (await page.getByTestId('screen-error').isVisible()) throw new Error('screen error: ' + (await page.getByTestId('screen-error').innerText()))
        if (Date.now() - t0 > 60 * 60_000) throw new Error('first edit took over an hour')
        if (timings.firstLookSec === undefined && (await look.isVisible())) {
          timings.firstLookSec = Math.round((Date.now() - t0) / 1000)
          result.firstLookLabel = await look.innerText()
          await page.waitForTimeout(2500)
          result.firstLookVideo = await page.evaluate(() => {
            const v = document.querySelector('[data-testid=first-look-video]') as HTMLVideoElement | null
            return v ? { src: v.currentSrc, readyState: v.readyState, t: v.currentTime, w: v.videoWidth, h: v.videoHeight } : null
          })
          await snap(page, `${TAG}-${i}-01-first-look`)
          save()
        }
        if (n % 60 === 0) await snap(page, `${TAG}-${i}-01-working-${n / 60}`)
        n++
        await page.waitForTimeout(1000)
      }
      timings.firstEditSec = Math.round((Date.now() - t0) / 1000)
      await snap(page, `${TAG}-${i}-02-reel`)
      result.firstSummary = await page.locator('.bubble.editor:not(.working):not(.reply-pending)').last().innerText().catch(() => '')
      const project = newest(join(ROOT, 'Projects'), (f) => existsSync(join(ROOT, 'Projects', f, 'project.json')))!
      result.project = project
      const live = join(project, 'work', 'live', 'first-look.mp4')
      result.firstLookEncoder = existsSync(live) ? encoderOf(live) : 'no first-look.mp4'
      save()

      // ---- one AI note (Claude through the Claude Code app chosen at first run) ----
      const replies = page.locator('.bubble.editor:not(.working):not(.reply-pending)')
      if (USE_CLAUDE) {
        const before = await replies.count()
        const t1 = Date.now()
        result.note = NOTES[i % NOTES.length]
        await page.getByTestId('note-input').fill(String(result.note))
        await page.keyboard.press('Enter')
        // a note can add more than one bubble (a quick reply, then what was done): wait for at least one
        await expect.poll(() => replies.count(), { timeout: 40 * 60_000, intervals: [1000] }).toBeGreaterThan(before)
        await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 10 * 60_000 })
        timings.noteSec = Math.round((Date.now() - t1) / 1000)
        result.noteReply = await replies.last().innerText()
        await snap(page, `${TAG}-${i}-03-after-note`)
        save()
      }

      // ---- 0.1.2: a meme on a note, real AI: it asks when, then places it on the named word ----
      if (USE_CLAUDE && ATTACH && i === 0) {
        result.attach = await attachMemeFlow(page, project, ATTACH, (name) => snap(page, `${TAG}-${i}-${name}`))
        save()
      }

      // ---- manual: yellow subtitles; the window goes to the background so "ready" is a real notification ----
      await page.getByTestId('edit-myself').click()
      await page.getByTestId('tab-captions').click()
      await page.getByTestId('cap-look-yellow').click()
      await snap(page, `${TAG}-${i}-04-yellow-picked`)
      const t3 = Date.now()
      await page.getByTestId('make-version').click()
      await expect(page.getByTestId('note-progress')).toContainText('Updating your subtitles')
      result.manualLabel = await page.getByTestId('note-progress').innerText()
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => !x.webContents.isOffscreen())!.minimize())
      await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 20 * 60_000 })
      timings.yellowSec = Math.round((Date.now() - t3) / 1000)
      await page.waitForTimeout(1500)
      result.notifications = await app.evaluate(() => (globalThis as { __shown?: string[] }).__shown)
      await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => !x.webContents.isOffscreen())!
        w.restore()
        w.show()
      })
      const style = JSON.parse(readFileSync(join(project, 'project.json'), 'utf8')).captions?.style ?? {}
      result.subtitleStyle = style
      expect(style.color).toBe('#FFD60A')
      result.yellowReply = await page.getByTestId('bubble-editor').last().innerText()
      await snap(page, `${TAG}-${i}-05-yellow-done`)
      save()

      // ---- Export ----
      const t2 = Date.now()
      await page.getByTestId('export').click()
      await expect(page.getByText('Saved to your computer')).toBeVisible({ timeout: 30 * 60_000 })
      timings.exportSec = Math.round((Date.now() - t2) / 1000)
      const dialog = await page.getByTestId('export-dialog').innerText()
      result.exportDialog = dialog
      expect(dialog).toContain('Show in Finder')
      expect(dialog).not.toMatch(/Explorer|taskbar|Phone Link/)
      await snap(page, `${TAG}-${i}-06-exported`)

      // ---- Send to my phone: the real LAN link, fetched from this Mac like a phone would ----
      await page.getByTestId('send-to-phone').click()
      const qr = page.getByTestId('phone-qr')
      await expect(qr).toBeVisible()
      const url = (await qr.getAttribute('data-url'))!
      result.phoneUrlShape = url.replace(/\/[A-Za-z0-9_-]{43}\/$/, '/<token>/')
      expect(url).toMatch(/^http:\/\/(10|172|192)\.\d+\.\d+\.\d+:\d+\/[A-Za-z0-9_-]{43}\/$/)
      await expect(page.getByTestId('phone-waiting')).toContainText('Waiting for your phone')
      await snap(page, `${TAG}-${i}-07-phone-waiting`)
      const pageRes = await fetch(url, { headers: { 'User-Agent': IPHONE_UA } })
      expect(pageRes.status).toBe(200)
      expect(await pageRes.text()).toContain('video.mp4')
      const vid = await fetch(url + 'video.mp4', { headers: { Range: 'bytes=0-1023', 'User-Agent': IPHONE_UA } })
      expect(vid.status).toBe(206)
      expect(vid.headers.get('content-range')).toMatch(/^bytes 0-1023\/\d+$/)
      const head = Buffer.from(await vid.arrayBuffer())
      expect(head.subarray(4, 8).toString('latin1')).toBe('ftyp')
      const whole = await fetch(url + 'video.mp4', { headers: { 'User-Agent': IPHONE_UA } })
      result.phoneFullBytes = (await whole.arrayBuffer()).byteLength
      await expect(page.getByTestId('phone-sent')).toHaveText('Sent! Check your phone.')
      await snap(page, `${TAG}-${i}-08-phone-sent`)
      await page.keyboard.press('Escape')
      await expect.poll(() => fetch(url).then((r) => r.status, () => 'closed')).toBe('closed')

      // ---- verify with the INSTALLED engine + ffmpeg ----
      const exportFile = newest(join(ROOT, 'Library', 'Exports'), (f) => f.endsWith('.mp4'))!
      result.exportFile = exportFile
      expect(result.phoneFullBytes).toBe(statSync(exportFile).size)
      const v = verifyInstalled(project, exportFile, join(out, 'frames'))
      result.verify = v.verify
      result.check = JSON.parse(v.check.trim().split('\n').pop()!)
      const probe = join(CACHE, 'encoder-probe.json')
      result.encoderProbe = existsSync(probe) ? JSON.parse(readFileSync(probe, 'utf8')) : 'none'
      result.exportEncoder = encoderOf(exportFile)
      save()
      appendFileSync(join(OUT, 'results.jsonl'), JSON.stringify(result) + '\n')
      expect(v.verify?.event, 'verify finished').toBe('done')
      expect(v.verify?.result?.ok, 'verify ok').toBe(true)
    } catch (e) {
      result.error = String((e as Error)?.stack ?? e)
      save()
      appendFileSync(join(OUT, 'results.jsonl'), JSON.stringify(result) + '\n')
      await snap(page, `${TAG}-${i}-99-failed`).catch(() => {})
      throw e
    } finally {
      await app.close().catch(() => {})
    }
  })
})
