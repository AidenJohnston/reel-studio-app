// The INSTALLED app, run the way its owner runs it: real user data, real Documents\Reel Studio, the
// speech model downloaded through the first-run screen, the bundled engine. Skipped unless asked for:
//   REELSTUDIO_E2E_INSTALLED=<path to the installed Reel Studio.exe>
//   REELSTUDIO_E2E_TAKES_LIST=<take.mp4>;<take.mp4>   real takes, read in place
//   REELSTUDIO_E2E_NOTES=<JSON array, one note per take>   REELSTUDIO_E2E_MUSIC=<song>;<song> (Library, first take)
//   REELSTUDIO_E2E_OUT=<results folder>   REELSTUDIO_E2E_EXPECT_AI=claude-cli|none (none also skips the note)
//   REELSTUDIO_E2E_MANUAL=1   after the note: "Edit it myself" > Subtitles > yellow > make a version (render only)
//   REELSTUDIO_E2E_ATTACH=<picture/GIF/clip>   first take, after the note: drop it on the note box with "put this over my face"
//     (the AI must ask when), then name a kept word in a second note (it must place the file there), read back from project.json
//   REELSTUDIO_E2E_PHONE=1    after Export: "Send to my phone", fetch the page + video like a phone, expect "Sent!"
//     (the installed app is not a test build, so the link binds to the real Wi-Fi address: a firewall prompt
//     may appear; a desktop screenshot is taken right after the panel opens)
//   REELSTUDIO_E2E_PROFILE=<dir>  optional: a throwaway profile (user data + Reel Studio folder) instead of the
//     real one, with REELSTUDIO_E2E_MODELS=<models dir> to reuse an already downloaded speech model
// Verify uses the installed engine exactly as the app spawns it: <resources>\python\python.exe -s -E -B -X utf8
// -m reelengine verify, cwd <resources>\engine. Leaves what it made in Documents\Reel Studio for a person to
// look at; cleaning up is the caller's job.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { attachMemeFlow, chooseClaudeCode, dropFiles, passMacStage } from './helpers'

const EXE = process.env.REELSTUDIO_E2E_INSTALLED
const TAKES = (process.env.REELSTUDIO_E2E_TAKES_LIST ?? '').split(';').filter(Boolean)
const NOTES: string[] = process.env.REELSTUDIO_E2E_NOTES ? JSON.parse(process.env.REELSTUDIO_E2E_NOTES) : ['make the captions smaller']
const OUT = process.env.REELSTUDIO_E2E_OUT ?? join(homedir(), 'rs-installed-e2e')
const EXPECT_AI = process.env.REELSTUDIO_E2E_EXPECT_AI ?? 'claude-cli'
const PROFILE = process.env.REELSTUDIO_E2E_PROFILE
const ATTACH = process.env.REELSTUDIO_E2E_ATTACH
const ROOT = PROFILE ? join(PROFILE, 'Reel Studio') : join(homedir(), 'Documents', 'Reel Studio')

test.skip(!EXE, 'set REELSTUDIO_E2E_INSTALLED to run')
test.describe.configure({ mode: 'serial' })

const resources = (): string => join(dirname(EXE!), 'resources')

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const env: Record<string, string> = {}
  // Nothing from a dev shell: no REELSTUDIO_* overrides, no ELECTRON_RUN_AS_NODE, no PYTHON*.
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || /^(REELSTUDIO_|REELENGINE_|PYTHON|ELECTRON_)/i.test(k)) continue
    env[k] = v
  }
  if (PROFILE) {
    env.REELSTUDIO_USER_DATA = join(PROFILE, 'user data')
    env.REELSTUDIO_ROOT = ROOT
    if (process.env.REELSTUDIO_E2E_MODELS) env.REELSTUDIO_MODELS_DIR = process.env.REELSTUDIO_E2E_MODELS
  }
  const app = await electron.launch({ executablePath: EXE!, args: [], env })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Is the element inside the window without scrolling the page? */
async function inView(page: Page, testId: string): Promise<{ top: number; bottom: number; viewport: number; inView: boolean } | null> {
  const box = await page.getByTestId(testId).boundingBox().catch(() => null)
  const vh = page.viewportSize()?.height ?? 0
  return box ? { top: Math.round(box.y), bottom: Math.round(box.y + box.height), viewport: vh, inView: box.y >= 0 && box.y + box.height <= vh } : null
}

async function snap(page: Page, name: string): Promise<void> {
  mkdirSync(join(OUT, 'shots'), { recursive: true })
  await page.waitForTimeout(250)
  await page.screenshot({ path: join(OUT, 'shots', `${name}.png`) })
}

/** The whole desktop (a Windows Firewall prompt is a separate window the app's screenshot cannot see). */
function desktopShot(png: string): void {
  if (process.platform !== 'win32') return
  const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
    `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); ` +
    `$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${png.replace(/'/g, "''")}')`
  try { execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 30_000 }) } catch { /* best effort */ }
}

function newest(dir: string, filter: (n: string) => boolean): string | null {
  if (!existsSync(dir)) return null
  const all = readdirSync(dir).filter(filter).map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t)
  return all.length ? join(dir, all[0].n) : null
}

function engineEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(e)) if (/^(PYTHON|ELECTRON_RUN_AS_NODE)/i.test(k)) delete e[k]
  return {
    ...e,
    REELENGINE_FFMPEG: join(resources(), 'ffmpeg', 'ffmpeg.exe'),
    REELENGINE_FFPROBE: join(resources(), 'ffmpeg', 'ffprobe.exe'),
    REELENGINE_FONTS: join(resources(), 'fonts')
  }
}

test('first run: speech model + AI', async () => {
  test.setTimeout(30 * 60_000)
  mkdirSync(OUT, { recursive: true })
  const { app, page } = await open()
  const info: Record<string, unknown> = {}
  try {
    const welcome = page.getByTestId('get-started')
    await expect(welcome.or(page.getByText('Your videos'))).toBeVisible()
    info.freshProfile = await welcome.isVisible()
    await snap(page, '00-welcome')
    if (info.freshProfile) {
      await welcome.click()
      await passMacStage(page)
      await snap(page, '01-download')
      const t0 = Date.now()
      const dl = page.getByTestId('download-model')
      if (await dl.isVisible()) await dl.click()
      else await page.getByTestId('model-next').click()
      const connect = page.getByText('Connect your AI editor')
      while (!(await connect.isVisible())) {
        if (Date.now() - t0 > 25 * 60_000) throw new Error('model download took over 25 minutes')
        await page.waitForTimeout(1000)
      }
      info.modelSec = Math.round((Date.now() - t0) / 1000)
      await page.waitForTimeout(2000)
      await snap(page, '02-connect')
      info.connectButtons = await page.locator('.setup-panel button').allInnerTexts()
      // Nothing picks the Claude Code app on its own: this run chooses it, like a person would.
      const picked = EXPECT_AI === 'claude-cli' && (await chooseClaudeCode(page))
      const c = page.getByTestId('ai-connected')
      info.connectAi = picked ? 'claude-cli' : (await c.isVisible()) ? await c.innerText() : 'none'
      if (!picked) await page.getByTestId('skip').click()
    }
    await expect(page.getByText('Your videos')).toBeVisible()
    await page.getByTestId('nav-settings').click()
    const c = page.getByTestId('ai-connected')
    await c.waitFor({ timeout: 10_000 }).catch(() => {})
    info.settingsAi = (await c.isVisible()) ? await c.innerText() : 'none'
    info.settingsButtons = await page.locator('.panel').first().locator('button').allInnerTexts()
    info.about = await page.locator('.panel', { has: page.locator('h2', { hasText: /^About$/ }) }).innerText()
    await snap(page, '03-settings')
    writeFileSync(join(OUT, 'firstrun.json'), JSON.stringify(info, null, 2))
    if (EXPECT_AI === 'claude-cli') expect(String(info.settingsAi)).toContain('your Claude Code app')
    else expect(String(info.settingsAi)).toBe('none')
  } finally {
    await app.close().catch(() => {})
  }
})

TAKES.forEach((take, i) => {
  test(`take ${i}: ${basename(take)}`, async () => {
    test.setTimeout(90 * 60_000)
    const out = join(OUT, String(i))
    mkdirSync(out, { recursive: true })
    const timings: Record<string, number> = {}
    const result: Record<string, unknown> = { take, note: NOTES[i % NOTES.length], timings }
    const save = () => writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2))
    const { app, page } = await open()
    try {
      await expect(page.getByText('Your videos')).toBeVisible()
      const music = (process.env.REELSTUDIO_E2E_MUSIC ?? '').split(';').filter(Boolean)
      if (music.length && i === 0) {
        await page.getByTestId('nav-library').click()
        await page.getByTestId('file-input').setInputFiles(music)
        await page.waitForTimeout(4000)
      }
      await page.getByTestId('nav-home').click()
      await page.getByTestId('new-video').click()
      const t0 = Date.now()
      await dropFiles(page, 'drop-zone', [take])
      await expect(page.getByText('Making your reel')).toBeVisible()
      let n = 0
      const look = page.getByTestId('first-look')
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
          await snap(page, `${i}-01-first-look`)
          save()
        }
        if (n % 60 === 0) await snap(page, `${i}-01-working-${n / 60}`)
        n++
        await page.waitForTimeout(1000)
      }
      timings.firstEditSec = Math.round((Date.now() - t0) / 1000)
      await snap(page, `${i}-02-reel`)
      result.firstSummary = await page.locator('.bubble.editor:not(.working):not(.reply-pending)').last().innerText().catch(() => '')
      save()

      if (EXPECT_AI !== 'none') {
        const replies = page.locator('.bubble.editor:not(.working):not(.reply-pending)')
        const before = await replies.count()
        const t1 = Date.now()
        await page.getByTestId('note-input').fill(String(result.note))
        await page.keyboard.press('Enter')
        if (await page.getByTestId('note-progress').waitFor({ timeout: 30_000 }).then(() => true, () => false)) {
          await page.waitForTimeout(1500)
          result.noteProgressInView = await inView(page, 'note-progress')
          await snap(page, `${i}-03a-note-progress`)
        }
        await expect(replies).toHaveCount(before + 1, { timeout: 40 * 60_000 })
        await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 5 * 60_000 })
        timings.noteSec = Math.round((Date.now() - t1) / 1000)
        result.noteReply = await replies.last().innerText()
        await snap(page, `${i}-03-after-note`)
        save()
      }

      if (ATTACH && EXPECT_AI !== 'none' && i === 0) {
        const projects = join(ROOT, 'Projects')
        const newest = readdirSync(projects).filter((s) => !s.startsWith('.')).sort((a, b) => statSync(join(projects, b)).mtimeMs - statSync(join(projects, a)).mtimeMs)[0]
        result.attach = await attachMemeFlow(page, join(projects, newest), ATTACH, (name) => snap(page, `${i}-${name}`))
        save()
      }

      if (process.env.REELSTUDIO_E2E_MANUAL === '1') {
        const tm = Date.now()
        await page.getByTestId('edit-myself').click()
        await page.getByTestId('tab-captions').click()
        await expect(page.getByTestId('caption-controls')).toBeVisible()
        await page.getByTestId('cap-look-yellow').click()
        await page.getByTestId('make-version').click()
        await expect(page.getByTestId('note-progress')).toContainText('Updating your subtitles')
        result.manualLabel = await page.getByTestId('note-progress').innerText()
        result.manualProgressInView = await inView(page, 'note-progress')
        await expect(page.getByTestId('change-preview')).toBeVisible({ timeout: 5 * 60_000 })
        timings.manualPreviewSec = Math.round((Date.now() - tm) / 1000)
        await snap(page, `${i}-03b-manual-preview`)
        await expect(page.getByTestId('note-progress')).toHaveCount(0, { timeout: 20 * 60_000 })
        timings.manualSec = Math.round((Date.now() - tm) / 1000)
        result.manualReply = await page.locator('.bubble.editor:not(.working):not(.reply-pending)').last().innerText()
        await snap(page, `${i}-03c-manual-done`)
        save()
      }

      const t2 = Date.now()
      await page.getByTestId('export').click()
      await expect(page.getByText('Saved to your computer')).toBeVisible({ timeout: 30 * 60_000 })
      timings.exportSec = Math.round((Date.now() - t2) / 1000)
      result.exportDialog = await page.getByTestId('export-dialog').innerText().catch(() => '')
      await snap(page, `${i}-04-exported`)
      if (process.env.REELSTUDIO_E2E_PHONE === '1') {
        await page.getByTestId('export-caption').fill('Reel Studio installed-app test').catch(() => {})
        await page.getByTestId('send-to-phone').click()
        const qr = page.getByTestId('phone-qr')
        await expect(qr).toBeVisible()
        const url = (await qr.getAttribute('data-url'))!
        result.phoneUrlShape = url.replace(/\/[A-Za-z0-9_-]{43}\/$/, '/<token>/')
        await page.waitForTimeout(3000)
        desktopShot(join(OUT, 'shots', `${i}-05-desktop-after-phone-panel.png`))
        await snap(page, `${i}-05-phone-waiting`)
        const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
        const pageRes = await fetch(url, { headers: { 'User-Agent': ua } })
        const html = await pageRes.text()
        const vid = await fetch(url + 'video.mp4', { headers: { Range: 'bytes=0-1023', 'User-Agent': ua } })
        const head = Buffer.from(await vid.arrayBuffer())
        result.phone = {
          page: pageRes.status, hasVideoTag: html.includes('video.mp4'), hasCaption: html.includes('Reel Studio installed-app test'),
          video: vid.status, type: vid.headers.get('content-type'), range: vid.headers.get('content-range'), ftyp: head.subarray(4, 8).toString('latin1')
        }
        save()
        expect(pageRes.status).toBe(200)
        expect(vid.status).toBe(206)
        expect(head.subarray(4, 8).toString('latin1')).toBe('ftyp')
        await expect(page.getByTestId('phone-sent')).toHaveText('Sent! Check your phone.')
        await snap(page, `${i}-06-phone-sent`)
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('export-dialog')).toHaveCount(0)
      } else {
        await page.getByRole('button', { name: 'Done' }).click()
      }

      const exportFile = newest(join(ROOT, 'Library', 'Exports'), (f) => f.endsWith('.mp4'))
      const project = newest(join(ROOT, 'Projects'), (f) => existsSync(join(ROOT, 'Projects', f, 'project.json')))
      expect(exportFile).toBeTruthy()
      result.exportFile = exportFile
      result.project = project

      // verify, exactly the way the app runs its engine
      const py = join(resources(), 'python', 'python.exe')
      let stdout = ''
      try {
        stdout = execFileSync(py, ['-s', '-E', '-B', '-X', 'utf8', '-u', '-m', 'reelengine', 'verify', '--project', project!, exportFile!], {
          cwd: join(resources(), 'engine'),
          env: engineEnv(),
          maxBuffer: 64 * 1024 * 1024
        }).toString('utf8')
      } catch (e) {
        stdout = String((e as { stdout?: Buffer }).stdout ?? e)
      }
      const events = stdout.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
      const verify = events.reverse().find((ev: any) => ev.event === 'done' || ev.event === 'error')
      result.verify = verify
      // frames + music level (dev tool), with the installed python
      const check = execFileSync(py, ['-s', '-B', join(__dirname, 'tools', 'check_export.py'), '--project', project!, '--export', exportFile!, '--out', join(out, 'frames')], {
        cwd: join(resources(), 'engine'),
        env: { ...engineEnv(), PYTHONPATH: join(resources(), 'engine'), PYTHONUTF8: '1' },
        maxBuffer: 64 * 1024 * 1024
      }).toString('utf8')
      result.check = JSON.parse(check.trim().split('\n').pop()!)
      save()
      appendFileSync(join(OUT, 'results.jsonl'), JSON.stringify(result) + '\n')
      expect((verify as any)?.event, 'verify finished').toBe('done')
      expect((verify as any)?.result?.ok, 'verify ok').toBe(true)
    } catch (e) {
      result.error = String((e as Error)?.stack ?? e)
      save()
      appendFileSync(join(OUT, 'results.jsonl'), JSON.stringify(result) + '\n')
      await snap(page, `${i}-99-failed`).catch(() => {})
      throw e
    } finally {
      await app.close().catch(() => {})
    }
  })
})
